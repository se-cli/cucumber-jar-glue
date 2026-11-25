'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readConfig } = require('./util/config');
const { Log } = require('./util/log');
const { CacheStore } = require('./glue/cache');
const { IndexStore } = require('./glue/indexStore');
const { ScanPool } = require('./glue/scanPool');
const { RefreshCoordinator } = require('./glue/refresh');
const { stepTextFromLine } = require('./glue/matcher');
const { probeJavaClasspath } = require('./glue/classpath');
const {
  DecompiledDocumentProvider, DECOMPILED_SCHEME
} = require('./glue/decompiledSource');
const { SCHEME } = require('./util/uri');
const { isGherkinDocument } = require('./util/gherkin');

const { GlueVirtualDocumentProvider } = require('./providers/virtualDocument');
const definition = require('./providers/definitionProvider');
const references = require('./providers/referenceProvider');
const completion = require('./providers/completionProvider');
const { Diagnostics } = require('./providers/diagnostics');

let runtime;

function updateStatus() {
  const s = runtime.index.stats();
  runtime.status.text = `$(database) Glue ${s.jarDefs + s.sourceDefs}`;
  runtime.status.tooltip = [
    `JAR Glue: ${s.jarDefs}`,
    `源码 Glue: ${s.sourceDefs}`,
    `JAR 数: ${s.jars}（跳过 ${s.skippedJars}）`,
    `告警: ${s.warningCount}`,
    `Gherkin 步骤: ${s.usages}`
  ].join('\n');
  runtime.status.show();
}

function usagesFromDocument(document) {
  const out = [];
  const lines = document.getText().split(/\r?\n/);
  lines.forEach((line, i) => {
    const step = stepTextFromLine(line);
    if (step && step.text) out.push({ uri: document.uri.toString(), line: i, text: step.text, keyword: step.keyword });
  });
  return out;
}

function openDefinition(def) {
  if (def.source === 'jar') {
    const loc = runtime.virtual.locationFor(def);
    return vscode.window.showTextDocument(loc.uri, { selection: loc.range, preview: true });
  }
  return vscode.window.showTextDocument(vscode.Uri.parse(def.uri), {
    selection: new vscode.Range(
      Math.max(0, def.line - 1), def.character || 0,
      Math.max(0, def.line - 1), (def.character || 0) + (def.methodName || '').length
    ),
    preview: true
  });
}

async function definitionForDecompile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const doc = editor.document;
  const line = editor.selection.active.line;

  if (doc.uri.scheme === SCHEME) {
    return runtime.virtual.definitionAt(doc.uri, line);
  }
  if (isGherkinDocument(doc)) {
    const step = stepTextFromLine(doc.lineAt(line).text);
    if (!step || !step.text) return undefined;
    const matches = runtime.index.findDefinitions(step.text)
      .filter(m => m.definition.source === 'jar');
    if (!matches.length) return undefined;
    if (matches.length === 1) return matches[0].definition;
    const picked = await vscode.window.showQuickPick(matches.map(m => ({
      label: `${path.basename(m.definition.jarPath)}!${m.definition.className}.${m.definition.methodName}`,
      description: m.definition.annotation,
      definition: m.definition
    })), { placeHolder: '选择要反编译的 JAR Glue 定义' });
    return picked && picked.definition;
  }
  return undefined;
}

function registerCommands(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('cucumberGlue.refresh', async () => {
      await runtime.refresh.refresh({ force: true });
      vscode.window.showInformationMessage(`Cucumber Glue 索引已刷新：${runtime.index.stats().total} 条定义`);
    }),
    vscode.commands.registerCommand('cucumberGlue.clearCache', async () => {
      await runtime.cache.clear();
      await runtime.refresh.refresh({ force: true });
      vscode.window.showInformationMessage('Cucumber Glue 缓存已清空并重建');
    }),
    vscode.commands.registerCommand('cucumberGlue.showIndex', async () => {
      const items = runtime.index.allDefinitions().map(def => ({
        label: def.kind === 'step' ? (def.patterns[0] || def.annotation) : `${def.kind}: ${def.keyword || def.methodName}`,
        description: def.source === 'jar'
          ? `${require('path').basename(def.jarPath)}!${def.className}.${def.methodName}`
          : `${require('path').basename(def.fsPath || '')}:${def.line}`,
        def
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Cucumber Glue 定义索引' });
      if (picked) await openDefinition(picked.def);
    }),
    vscode.commands.registerCommand('cucumberGlue.openDecompiledSource', async () => {
      const def = await definitionForDecompile();
      if (!def) {
        vscode.window.showWarningMessage('请把光标放在 Gherkin 步骤或 Glue 声明视图的方法上，再执行反编译。');
        return;
      }
      try {
        await runtime.decompiled.open(def, context.globalStorageUri.fsPath, runtime.log);
      } catch (err) {
        runtime.log.error('openDecompiledSource', err);
        vscode.window.showErrorMessage(`反编译失败：${err.message}`);
      }
    })
  );
}

// Real-VSCode verification hook: writes the raw java.project.getClasspaths
// response to a deterministic temp file so it can be inspected after launch.
async function writeClasspathProbe(context) {
  const safeName = (vscode.workspace.name || 'workspace').replace(/[^\w\u4e00-\u9fff-]/g, '_').slice(0, 60);
  const target = path.join(os.tmpdir(), `cucumber-glue-probe-${safeName}.json`);
  const report = { at: new Date().toISOString(), status: 'running', folders: [] };
  const flush = () => fs.writeFileSync(target, JSON.stringify(report, null, 2), 'utf8');
  flush();
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const index = report.folders.length;
    report.folders.push({ phase: 'start', uri: folder.uri.toString() });
    const result = await probeJavaClasspath(folder, 3, partial => {
      report.folders[index] = partial;
      flush();
    });
    report.folders[index] = result;
    flush();
  }
  report.status = 'done';
  report.index = runtime.index.stats();
  flush();
  try {
    fs.writeFileSync(path.join(context.globalStorageUri.fsPath, 'classpath-probe.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch (_) { /* globalStorage may not exist yet */ }
  runtime.log.info(`classpath probe written to ${target}`);
}

async function activate(context) {
  const configRef = readConfig;
  const initial = configRef();
  if (!initial.enabled) return;

  const log = new Log();
  log.setTrace(initial.trace);
  const index = new IndexStore();
  const cache = new CacheStore(context.globalStorageUri.fsPath);
  const pool = new ScanPool(configRef, log);
  const virtual = new GlueVirtualDocumentProvider(index);
  const decompiled = new DecompiledDocumentProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const diagnostics = new Diagnostics(index, configRef);
  const refresh = new RefreshCoordinator(context, configRef, index, cache, pool, log, () => {
    virtual.refresh();
    diagnostics.updateAll();
    updateStatus();
  });

  runtime = { configRef, log, index, cache, pool, virtual, decompiled, status, diagnostics, refresh };
  status.command = 'cucumberGlue.showIndex';

  context.subscriptions.push(
    status, log, virtual, decompiled, diagnostics,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, virtual),
    vscode.workspace.registerTextDocumentContentProvider(DECOMPILED_SCHEME, decompiled),
    definition.registerDefinitionProvider(index, virtual),
    definition.registerGlueSelfDefinition(index, virtual),
    references.register(index, virtual),
    completion.register(index),
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (isGherkinDocument(doc)) {
        index.upsertUsages(doc.uri.toString(), usagesFromDocument(doc));
        diagnostics.schedule(doc);
      }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (isGherkinDocument(event.document)) {
        index.upsertUsages(event.document.uri.toString(), usagesFromDocument(event.document));
        diagnostics.schedule(event.document);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('cucumberGlue')) {
        log.setTrace(configRef().trace);
        refresh.schedule();
      }
    })
  );

  registerCommands(context);
  refresh.startWatching();
  // Do not let a slow Maven/Gradle or language-server startup delay the probe.
  writeClasspathProbe(context).catch(err => log.error('classpath probe', err));

  try {
    await refresh.refresh();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === 'gherkin') index.upsertUsages(doc.uri.toString(), usagesFromDocument(doc));
    }
  } catch (err) {
    log.error('activate', err);
    status.text = '$(error) Cucumber Glue';
    status.show();
  }
  updateStatus();
}

function deactivate() {
  if (!runtime) return;
  runtime.refresh.dispose();
}

module.exports = { activate, deactivate };
