'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { getClasspath } = require('./classpath');
const { identityOf, identityMatches } = require('./cache');
const {
  scanWorkspaceSources, SOURCE_EXCLUDE_GLOB, isIgnoredPath
} = require('./sourceScanner');
const { stepTextFromLine } = require('./matcher');

class RefreshCoordinator {
  constructor(context, configRef, index, cache, pool, log, onUpdated) {
    this.context = context;
    this.configRef = configRef;
    this.index = index;
    this.cache = cache;
    this.pool = pool;
    this.log = log;
    this.onUpdated = onUpdated;
    this.disposables = [];
    this.timer = undefined;
    this.running = false;
    this.queued = false;
  }

  async rebuildUsages() {
    const uris = await vscode.workspace.findFiles('**/*.feature', SOURCE_EXCLUDE_GLOB, 5000);
    const usages = [];
    for (const uri of uris) {
      try {
        const text = await fs.promises.readFile(uri.fsPath, 'utf8');
        text.split(/\r?\n/).forEach((line, i) => {
          const step = stepTextFromLine(line);
          if (step && step.text) {
            usages.push({ uri: uri.toString(), line: i, text: step.text, keyword: step.keyword });
          }
        });
      } catch (err) {
        this.log.warn(uri.fsPath, `cannot read feature file: ${err.message}`);
      }
    }
    this.index.setUsages(usages);
  }

  async refresh(options = {}) {
    if (this.running) { this.queued = true; return; }
    this.running = true;
    const started = Date.now();
    const token = options.token;
    const config = this.configRef();
    try {
      const folders = vscode.workspace.workspaceFolders || [];
      const wanted = new Map();
      for (const folder of folders) {
        const cp = await getClasspath(
          folder, config, this.context.globalStorageUri.fsPath, this.log,
          { force: !!options.force, timeoutMs: 60000 }
        );
        for (const w of cp.warnings) this.log.warn(folder.name, w);
        for (const jar of cp.jars) wanted.set(jar, folder);
      }

      for (const existing of Array.from(this.index.jarStatus.keys())) {
        if (!wanted.has(existing)) {
          this.index.removeJar(existing);
          await this.cache.remove(existing).catch(err => this.log.warn(existing, err.message));
        }
      }

      const toScan = [];
      for (const jarPath of wanted.keys()) {
        if (token && token.isCancellationRequested) break;
        let stat;
        try { stat = await fs.promises.stat(jarPath); }
        catch (err) { this.log.warn(jarPath, `stat failed: ${err.message}`); continue; }
        const identity = identityOf(stat);
        const status = this.index.jarStatus.get(jarPath);
        if (!options.force && status && identityMatches(status.identity, identity)) continue;

        const cached = options.force ? undefined : await this.cache.load(jarPath, identity);
        if (cached) {
          this.index.replaceJar(jarPath, cached);
          this.log.trace(`cache hit ${jarPath}: ${cached.definitions.length} definitions`);
          continue;
        }
        toScan.push(jarPath);
      }

      const results = await this.pool.scanAll(toScan, () => !!(token && token.isCancellationRequested));
      for (const result of results) {
        if (!result.identity) {
          try { result.identity = identityOf(await fs.promises.stat(result.jarPath)); }
          catch (_) { result.identity = { size: 0, mtimeMs: 0 }; }
        }
        this.index.replaceJar(result.jarPath, result);
        if (result.warnings && result.warnings.length) {
          this.log.warn(path.basename(result.jarPath), result.warnings.join(' | '));
        }
        await this.cache.save(result.jarPath, result.identity, result).catch(err => {
          this.log.warn(result.jarPath, `cache write failed: ${err.message}`);
        });
      }

      const seenSources = new Set();
      for (const folder of folders) {
        if (token && token.isCancellationRequested) break;
        const scanned = await scanWorkspaceSources(folder, config, this.log, token);
        const grouped = new Map();
        for (const def of scanned.definitions) {
          if (!grouped.has(def.fsPath)) grouped.set(def.fsPath, []);
          grouped.get(def.fsPath).push(def);
        }
        for (const uri of await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, '**/*.java'), SOURCE_EXCLUDE_GLOB, 20000
        )) {
          if (isIgnoredPath(uri.fsPath)) continue;
          seenSources.add(uri.fsPath);
          this.index.replaceSourceFile(uri.fsPath, uri, {
            definitions: grouped.get(uri.fsPath) || [],
            customTypes: Object.fromEntries(scanned.customTypes)
          });
        }
      }
      for (const oldSource of Array.from(this.index.sourceFiles.keys())) {
        if (!seenSources.has(oldSource)) this.index.removeSourceFile(oldSource);
      }

      await this.rebuildUsages();
      this.log.info(`index refresh complete in ${Date.now() - started} ms: ${JSON.stringify(this.index.stats())}`);
    } finally {
      this.running = false;
      if (this.onUpdated) this.onUpdated();
      if (this.queued) {
        this.queued = false;
        setImmediate(() => this.refresh(options));
      }
    }
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh().catch(err => this.log.error('refresh', err));
    }, 800);
  }

  startWatching() {
    const globs = [
      '**/pom.xml', '**/build.gradle', '**/build.gradle.kts',
      '**/settings.gradle', '**/settings.gradle.kts', '**/gradle.lockfile', '**/.classpath'
    ];
    const scheduleIfIndexed = uri => {
      if (!isIgnoredPath(uri.fsPath)) this.schedule();
    };
    for (const glob of globs) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      watcher.onDidChange(scheduleIfIndexed);
      watcher.onDidCreate(scheduleIfIndexed);
      watcher.onDidDelete(scheduleIfIndexed);
      this.disposables.push(watcher);
    }
    const featureWatcher = vscode.workspace.createFileSystemWatcher('**/*.feature');
    featureWatcher.onDidCreate(scheduleIfIndexed);
    featureWatcher.onDidDelete(scheduleIfIndexed);
    this.disposables.push(featureWatcher);

    const javaWatcher = vscode.workspace.createFileSystemWatcher('**/*.java');
    javaWatcher.onDidChange(uri => {
      if (isIgnoredPath(uri.fsPath)) return;
      const result = require('./sourceScanner').scanJavaSource(uri.fsPath, uri, this.configRef());
      this.index.replaceSourceFile(uri.fsPath, uri, result);
      if (this.onUpdated) this.onUpdated();
    });
    javaWatcher.onDidDelete(uri => {
      if (isIgnoredPath(uri.fsPath)) return;
      this.index.removeSourceFile(uri.fsPath);
      if (this.onUpdated) this.onUpdated();
    });
    this.disposables.push(javaWatcher);

    const period = this.configRef().periodicCheckMs;
    if (period > 0) {
      this.interval = setInterval(() => {
        this.refresh().catch(err => this.log.error('periodic refresh', err));
      }, period);
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

module.exports = { RefreshCoordinator };
