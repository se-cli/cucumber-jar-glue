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

function pathKey(p) {
  return String(p).replace(/[\\/]+$/, '').replace(/[\\/]/g, '/').toLowerCase();
}

// A multi-module build reports one Java project URI per module. Those projects
// live *inside* the workspace folder, so matching only "project is an ancestor
// of the folder" misses them. Collect every project that belongs to this folder:
// the root, nested modules, and (for a nested workspace folder) an enclosing project.
function projectUrisForFolder(folder, projects) {
  const root = pathKey(folder.uri.fsPath);
  const seen = new Set();
  const matches = [];
  for (const raw of projects) {
    let fsPath;
    try { fsPath = pathKey(vscode.Uri.parse(raw).fsPath); }
    catch (_) { continue; }
    if (!fsPath) continue;
    const inside = fsPath === root || fsPath.startsWith(`${root}/`);
    const enclosing = root.startsWith(`${fsPath}/`);
    if (!inside && !enclosing) continue;
    if (seen.has(fsPath)) continue;
    seen.add(fsPath);
    matches.push({ raw, fsPath });
  }
  matches.sort((a, b) => a.fsPath.length - b.fsPath.length || a.fsPath.localeCompare(b.fsPath));
  return matches.map(m => m.raw);
}

function projectUriForFolder(folder, projects) {
  return projectUrisForFolder(folder, projects)[0];
}

async function fromJavaLanguageServer(folder, log) {
  const projects = await getJavaProjectUris(log);
  const uris = projectUrisForFolder(folder, projects);
  if (!uris.length) {
    log.trace(`no Java project URI matches ${folder.uri.toString()}`);
    return undefined;
  }
  // "test" includes runtime + test-scope glue jars, which is what we want.
  // Query every matching project and merge the results: stopping at the first
  // module with jars drops glue coming from sibling modules.
  const jars = [];
  const sourcePaths = [];
  const details = [];
  for (const uri of uris) {
    let picked;
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
        const projectJars = filterJars(normalizeEntries(result));
        log.trace(`java.project.getClasspaths (${scope}, ${uri}) returned ${projectJars.length} jars`);
        if (projectJars.length) { picked = { result, projectJars, scope }; break; }
      } catch (err) {
        log.trace(`java.project.getClasspaths (${scope}, ${uri}) failed: ${err.message}`);
      }
    }
    if (!picked) continue;
    jars.push(...picked.projectJars);
    sourcePaths.push(...filterSourcePaths(
      picked.result && picked.result.sourcePaths ? picked.result.sourcePaths : []
    ));
    details.push({ projectUri: uri, scope: picked.scope, raw: picked.result });
  }
  if (!details.length) return undefined;

  const mergedJars = filterJars(jars);
  const mergedSources = filterSourcePaths(sourcePaths);
  return {
    jars: mergedJars,
    sourcePaths: mergedSources,
    raw: { classpaths: mergedJars, sourcePaths: mergedSources, projects: details },
    scope: details.every(d => d.scope === 'test') ? 'test' : 'mixed',
    projectUris: uris,
    matchedProjectUris: details.map(d => d.projectUri),
    command: 'java.execute.workspaceCommand'
  };
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
    const uris = projectUrisForFolder(folder, report.projects);
    report.projectUris = uris;
    const targets = uris.length ? uris : [folder.uri.toString()];
    let total = 0;
    for (const uri of targets) {
      for (const scope of ['test', 'runtime']) {
        report.phase = `attempt-${i}-${scope}-${uri}`;
        progress();
        try {
          const raw = await withTimeout(
            vscode.commands.executeCommand(
              'java.execute.workspaceCommand',
              'java.project.getClasspaths',
              uri,
              JSON.stringify({ scope })
            ),
            15000,
            `probe getClasspaths(${scope})`
          );
          report.attempts.push({ uri, scope, ok: true, keys: raw ? Object.keys(raw) : [], raw });
          if (raw && Array.isArray(raw.classpaths) && raw.classpaths.length) {
            total += raw.classpaths.length;
            report.success = { scope, uri, count: total, projects: targets.length };
          }
        } catch (err) {
          report.attempts.push({
            uri, scope, ok: false, error: err && err.message ? err.message : String(err)
          });
        }
        progress();
      }
    }
    if (report.success) return report;
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

const SKIP_DIRS = new Set([
  'target', 'build', 'out', '.gradle', '.git', 'node_modules', '.idea'
]);
const MAX_WALK_DEPTH = 12;

// Bounded filesystem walk: Maven writes the classpath file relative to each
// module's basedir, so we need every module directory under the workspace folder.
async function findFilesByName(folder, name) {
  const root = folder.uri.fsPath;
  const found = [];
  async function walk(dir, depth) {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.name === name) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  return found.sort();
}

function mavenMarker(folder) {
  return `.cucumber-glue-classpath-${hashString(folder.uri.fsPath)}.txt`;
}

async function fromMaven(folder, storageDir, log, timeoutMs) {
  const marker = mavenMarker(folder);
  // Do not let outputs from an interrupted previous run count as fresh data.
  for (const stale of await findFilesByName(folder, marker)) {
    await fs.promises.unlink(stale).catch(() => {});
  }

  let commandError;
  try {
    // Relative outputFile is resolved against each module's basedir, so a
    // reactor build produces one file per module instead of overwriting one file.
    await runShellCommand('mvn', [
      '-q', 'dependency:build-classpath',
      `-Dmdep.outputFile=${marker}`,
      '-Dmdep.includeScope=runtime'
    ], folder.uri.fsPath, timeoutMs);
  } catch (err) {
    commandError = err;
  }

  const outputs = await findFilesByName(folder, marker);
  if (!outputs.length && commandError) throw commandError;
  if (commandError) {
    log.warn(folder.name, `Maven exited with an error, using ${outputs.length} partial output(s): ${commandError.message}`);
  }

  const jars = [];
  for (const out of outputs) {
    try {
      const text = await fs.promises.readFile(out, 'utf8');
      jars.push(...filterJars(text.split(path.delimiter)));
    } catch (err) {
      log.warn(out, `cannot read Maven classpath output: ${err.message}`);
    }
    await fs.promises.unlink(out).catch(() => {});
  }
  const merged = filterJars(jars);
  log.info(`maven classpath: ${merged.length} jars from ${outputs.length} module(s)`);
  return { jars: merged, sourcePaths: [] };
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

async function descriptorState(folder) {
  const names = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.lockfile', '.classpath'];
  const poms = await findFilesByName(folder, 'pom.xml');
  const candidates = [...poms, ...names.map(name => path.join(folder.uri.fsPath, name))];
  const state = {};
  for (const p of candidates) {
    try {
      const s = fs.statSync(p);
      const key = path.relative(folder.uri.fsPath, p).replace(/[\\/]/g, '/');
      state[key] = `${s.size}:${Math.round(s.mtimeMs)}`;
    } catch (_) { /* absent */ }
  }
  return hashString(JSON.stringify(state));
}

async function getClasspath(folder, config, storageDir, log, options = {}) {
  const provider = config.classpathProvider || 'auto';
  const warnings = [];
  const snapshotFile = path.join(storageDir, 'classpath', `${hashString(folder.uri.fsPath)}.json`);
  const state = await descriptorState(folder);

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
  fromJavaLanguageServer, fromMaven, probeJavaClasspath, getJavaProjectUris,
  projectUriForFolder, projectUrisForFolder
};
