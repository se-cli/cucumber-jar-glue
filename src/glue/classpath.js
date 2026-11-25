'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function hashString(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 20);
}

function normalizeEntries(value) {
  const out = [];
  const push = entry => {
    if (typeof entry === 'string') out.push(entry);
    else if (entry && typeof entry.path === 'string') out.push(entry.path);
    else if (entry && typeof entry.sourcePath === 'string') out.push(entry.sourcePath);
  };
  if (Array.isArray(value)) value.forEach(push);
  else if (value && Array.isArray(value.classpaths)) value.classpaths.forEach(push);
  else if (value && Array.isArray(value.classpath)) value.classpath.forEach(push);
  else if (value && Array.isArray(value.sourcePaths)) value.sourcePaths.forEach(push);
  else if (typeof value === 'string') value.split(path.delimiter).forEach(push);
  return out;
}

function filterJars(entries) {
  const seen = new Set();
  const jars = [];
  for (const raw of entries) {
    if (typeof raw !== 'string' || !raw) continue;
    const p = path.resolve(raw);
    if (!p.toLowerCase().endsWith('.jar') || seen.has(p)) continue;
    seen.add(p);
    if (fs.existsSync(p)) jars.push(p);
  }
  return jars;
}

function filterSourcePaths(entries) {
  const seen = new Set();
  const out = [];
  for (const raw of normalizeEntries(entries)) {
    const p = path.resolve(raw);
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

function runShellCommand(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const line = [command, ...args].map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
    const child = spawn(line, { shell: true, cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* already gone */ }
      reject(new Error(`Command timed out after ${timeoutMs} ms: ${command}`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} exited with ${code}: ${stderr.slice(-800)}`));
      else resolve({ stdout, stderr });
    });
  });
}

// Verified against redhat.java 1.58.0 dist/extension.js and a live run:
//   java.execute.workspaceCommand('java.project.getAll') -> string[] of project URIs
//   java.execute.workspaceCommand('java.project.getClasspaths',
//       projectUriString, JSON.stringify({ scope })) -> { classpaths: string[], sourcePaths?: string[] }
// Passing a workspace-folder URI instead of a Java project URI yields
// "Given URI does not belong to any Java project."
async function getJavaProjectUris(log) {
  try {
    const raw = await withTimeout(
      vscode.commands.executeCommand('java.execute.workspaceCommand', 'java.project.getAll'),
      15000,
      'java.project.getAll'
    );
    const projects = normalizeEntries(raw)
      .map(String)
      .filter(u => u.startsWith('file:'));
    log.trace(`java.project.getAll returned ${projects.length} projects`);
    return projects;
  } catch (err) {
    log.trace(`java.project.getAll unavailable: ${err.message}`);
    return [];
  }
}

function projectUriForFolder(folder, projects) {
  const root = String(folder.uri.fsPath).replace(/[\\/]$/, '').toLowerCase();
  let best;
  let bestLength = -1;
  for (const raw of projects) {
    let fsPath;
    try { fsPath = String(vscode.Uri.parse(raw).fsPath).replace(/[\\/]$/, '').toLowerCase(); }
    catch (_) { continue; }
    if (root === fsPath || root.startsWith(`${fsPath}\\`) || root.startsWith(`${fsPath}/`)) {
      if (fsPath.length > bestLength) { best = raw; bestLength = fsPath.length; }
    }
  }
  return best;
}

async function fromJavaLanguageServer(folder, log) {
  const projects = await getJavaProjectUris(log);
  const uri = projectUriForFolder(folder, projects);
  if (!uri) {
    log.trace(`no Java project URI matches ${folder.uri.toString()}`);
    return undefined;
  }
  // "test" includes runtime + test-scope glue jars, which is what we want.
  for (const scope of ['test', 'runtime']) {
    try {
      const result = await withTimeout(
        vscode.commands.executeCommand(
          'java.execute.workspaceCommand',
          'java.project.getClasspaths',
          uri,
          JSON.stringify({ scope })
        ),
        15000,
        `java.project.getClasspaths(${scope})`
      );
      const jars = filterJars(normalizeEntries(result));
      log.trace(`java.project.getClasspaths (${scope}, ${uri}) returned ${jars.length} jars`);
      if (jars.length) {
        return {
          jars,
          sourcePaths: filterSourcePaths(result && result.sourcePaths ? result.sourcePaths : []),
          raw: result,
          scope,
          projectUri: uri,
          command: 'java.execute.workspaceCommand'
        };
      }
    } catch (err) {
      log.trace(`java.project.getClasspaths (${scope}, ${uri}) failed: ${err.message}`);
    }
  }
  return undefined;
}

// Diagnostic probe used by the real-VSCode verification run.
async function probeJavaClasspath(folder, attempts = 3, onProgress) {
  const report = {
    uri: folder.uri.toString(),
    at: new Date().toISOString(),
    phase: 'start',
    projects: [],
    attempts: []
  };
  const progress = () => { if (onProgress) onProgress(report); };
  progress();
  for (let i = 0; i < attempts; i++) {
    report.phase = `attempt-${i}-getAll`;
    progress();
    report.projects = await getJavaProjectUris({ trace: () => {} });
    const uri = projectUriForFolder(folder, report.projects);
    report.projectUri = uri;
    for (const scope of ['test', 'runtime']) {
      report.phase = `attempt-${i}-${scope}`;
      progress();
      try {
        const raw = await withTimeout(
          vscode.commands.executeCommand(
            'java.execute.workspaceCommand',
            'java.project.getClasspaths',
            uri || folder.uri.toString(),
            JSON.stringify({ scope })
          ),
          15000,
          `probe getClasspaths(${scope})`
        );
        report.attempts.push({ scope, ok: true, keys: raw ? Object.keys(raw) : [], raw });
        if (raw && Array.isArray(raw.classpaths) && raw.classpaths.length) {
          report.success = { scope, count: raw.classpaths.length };
          return report;
        }
      } catch (err) {
        report.attempts.push({ scope, ok: false, error: err && err.message ? err.message : String(err) });
      }
      progress();
    }
    if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
  }
  report.phase = 'done';
  progress();
  return report;
}

const GRADLE_INIT = `
allprojects { p ->
  p.tasks.register('__cucumberGlueClasspath') {
    doLast {
      if (p.plugins.hasPlugin('java')) {
        def jars = p.sourceSets.main.runtimeClasspath.files.findAll { it.name.endsWith('.jar') }
        println 'CUCUMBER_CP=' + jars.collect { it.absolutePath }.join(File.pathSeparator)
      }
    }
  }
}
`;

async function fromMaven(folder, storageDir, log, timeoutMs) {
  const out = path.join(storageDir, 'classpath', `${hashString(folder.uri.fsPath)}.txt`);
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  try { await fs.promises.unlink(out); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  await runShellCommand('mvn', [
    '-q', 'dependency:build-classpath',
    `-Dmdep.outputFile=${out}`,
    '-Dmdep.includeScope=runtime'
  ], folder.uri.fsPath, timeoutMs);
  const text = await fs.promises.readFile(out, 'utf8');
  const jars = filterJars(text.split(path.delimiter));
  log.info(`maven classpath: ${jars.length} jars`);
  return { jars, sourcePaths: [] };
}

async function fromGradle(folder, storageDir, log, timeoutMs) {
  const init = path.join(storageDir, 'classpath', 'cucumber-glue-init.gradle');
  await fs.promises.mkdir(path.dirname(init), { recursive: true });
  await fs.promises.writeFile(init, GRADLE_INIT, 'utf8');
  const root = folder.uri.fsPath;
  const wrapper = path.join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const command = fs.existsSync(wrapper) ? wrapper : 'gradle';
  const { stdout } = await runShellCommand(command, [
    '-q', '-I', init, '__cucumberGlueClasspath', '--no-daemon'
  ], root, timeoutMs);
  const jars = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('CUCUMBER_CP=')) {
      jars.push(...filterJars(line.slice('CUCUMBER_CP='.length).split(path.delimiter)));
    }
  }
  log.info(`gradle classpath: ${jars.length} jars`);
  return { jars, sourcePaths: [] };
}

async function fromManualRoots(roots) {
  const jars = new Set();
  for (const glob of roots || []) {
    const abs = path.resolve(glob.replace(/[\\/]+$/, ''));
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        if (name.endsWith('.jar')) jars.add(path.join(abs, name));
      }
      continue;
    }
    const matches = await vscode.workspace.findFiles(glob, undefined, 2000);
    for (const uri of matches) if (uri.fsPath.endsWith('.jar')) jars.add(uri.fsPath);
  }
  return { jars: filterJars([...jars]), sourcePaths: [] };
}

function descriptorState(folder) {
  const names = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.lockfile', '.classpath'];
  const state = {};
  for (const name of names) {
    const p = path.join(folder.uri.fsPath, name);
    try {
      const s = fs.statSync(p);
      state[name] = `${s.size}:${Math.round(s.mtimeMs)}`;
    } catch (_) { /* absent */ }
  }
  return hashString(JSON.stringify(state));
}

async function getClasspath(folder, config, storageDir, log, options = {}) {
  const provider = config.classpathProvider || 'auto';
  const warnings = [];
  const snapshotFile = path.join(storageDir, 'classpath', `${hashString(folder.uri.fsPath)}.json`);
  const state = descriptorState(folder);

  let result;
  if (provider !== 'manual' && (provider === 'java' || provider === 'auto')) {
    result = await fromJavaLanguageServer(folder, log);
  }
  if (!result && !options.force && config.buildClasspath !== false && provider !== 'manual' && provider !== 'java') {
    try {
      const cached = JSON.parse(await fs.promises.readFile(snapshotFile, 'utf8'));
      if (cached.state === state) {
        result = { jars: filterJars(cached.jars), sourcePaths: filterSourcePaths(cached.sourcePaths || []) };
        log.trace(`classpath snapshot reused (${result.jars.length} jars)`);
      }
    } catch (_) { /* no snapshot */ }
  }
  if (!result) {
    if (provider === 'maven' || (provider === 'auto' && fs.existsSync(path.join(folder.uri.fsPath, 'pom.xml')))) {
      try { result = await fromMaven(folder, storageDir, log, options.timeoutMs || 60000); }
      catch (err) { warnings.push(`Maven classpath failed: ${err.message}`); }
    } else if (provider === 'gradle' || (provider === 'auto' && (
      fs.existsSync(path.join(folder.uri.fsPath, 'build.gradle')) ||
      fs.existsSync(path.join(folder.uri.fsPath, 'build.gradle.kts'))))) {
      try { result = await fromGradle(folder, storageDir, log, options.timeoutMs || 60000); }
      catch (err) { warnings.push(`Gradle classpath failed: ${err.message}`); }
    }
  }
  if (!result && (provider === 'manual' || (config.classpathRoots || []).length)) {
    result = await fromManualRoots(config.classpathRoots);
  }
  if (!result) result = { jars: [], sourcePaths: [] };

  if (!result.jars.length && (config.classpathRoots || []).length) {
    const manual = await fromManualRoots(config.classpathRoots);
    result.jars = [...new Set([...result.jars, ...manual.jars])];
  }

  await fs.promises.mkdir(path.dirname(snapshotFile), { recursive: true });
  await fs.promises.writeFile(snapshotFile, JSON.stringify({
    state, jars: result.jars, sourcePaths: result.sourcePaths, at: Date.now()
  }), 'utf8');

  return { ...result, provider, warnings, state };
}

module.exports = {
  getClasspath, descriptorState, filterJars, normalizeEntries,
  fromJavaLanguageServer, probeJavaClasspath, getJavaProjectUris, projectUriForFolder
};
