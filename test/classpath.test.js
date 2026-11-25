'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

function fakeUri(raw) {
  let value = String(raw);
  if (value.startsWith('file:///')) value = value.slice('file:///'.length);
  value = decodeURIComponent(value).replace(/^\//, '');
  return { toString: () => raw, fsPath: value };
}

// Each test needs its own vscode / child_process stubs, so bust the module cache.
function loadClasspath(stubs) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return stubs.vscode || {};
    if (request === 'child_process' && stubs.childProcess) return stubs.childProcess;
    return originalLoad.call(this, request, parent, isMain);
  };
  const id = require.resolve('../src/glue/classpath');
  delete require.cache[id];
  const loaded = require('../src/glue/classpath');
  Module._load = originalLoad;
  return loaded;
}

function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) removeTree(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cucumber-cp-${label}-`));
}

function uriFor(fsPath) {
  return `file:///${fsPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, '$1:')}`;
}

test('fromJavaLanguageServer uses project URI from java.project.getAll', async () => {
  const dir = tempDir('single');
  const jar = path.join(dir, 'glue.jar');
  fs.writeFileSync(jar, '');

  const projectUri = uriFor('d:/code/cucumber-glue-fixture');
  const calls = [];
  const vscodeStub = {
    commands: {
      executeCommand: async (command, ...args) => {
        calls.push([command, ...args]);
        if (command === 'java.execute.workspaceCommand' && args[0] === 'java.project.getAll') {
          return [projectUri];
        }
        if (command === 'java.execute.workspaceCommand' && args[0] === 'java.project.getClasspaths') {
          return { classpaths: [jar], sourcePaths: [dir] };
        }
        return undefined;
      }
    },
    Uri: { parse: fakeUri },
    workspace: {}
  };

  const { fromJavaLanguageServer } = loadClasspath({ vscode: vscodeStub });
  const folder = { uri: fakeUri(projectUri), name: 'cucumber-glue-fixture' };
  const log = { trace() {}, info() {}, warn() {} };
  const result = await fromJavaLanguageServer(folder, log);

  assert.deepEqual(calls[0], ['java.execute.workspaceCommand', 'java.project.getAll']);
  assert.equal(calls[1][0], 'java.execute.workspaceCommand');
  assert.equal(calls[1][1], 'java.project.getClasspaths');
  assert.equal(calls[1][2], projectUri, 'must pass a Java project URI, not the workspace root');
  assert.equal(calls[1][3], JSON.stringify({ scope: 'test' }));
  assert.equal(result.scope, 'test');
  assert.ok(result.jars.includes(jar));

  removeTree(dir);
});

test('fromJavaLanguageServer merges every module project classpath', async () => {
  const rootDir = tempDir('multi');
  for (const name of ['module-a', 'module-b']) fs.mkdirSync(path.join(rootDir, name));
  const jars = {
    root: path.join(rootDir, 'root.jar'),
    a: path.join(rootDir, 'module-a', 'a.jar'),
    b: path.join(rootDir, 'module-b', 'b.jar')
  };
  for (const jar of Object.values(jars)) fs.writeFileSync(jar, '');

  const root = uriFor(rootDir);
  const moduleA = uriFor(path.join(rootDir, 'module-a'));
  const moduleB = uriFor(path.join(rootDir, 'module-b'));
  const outside = uriFor('d:/code/unrelated-project');
  const calls = [];

  const vscodeStub = {
    commands: {
      executeCommand: async (command, ...args) => {
        calls.push([command, ...args]);
        if (args[0] === 'java.project.getAll') return [root, moduleA, moduleB, outside];
        if (args[0] !== 'java.project.getClasspaths') return undefined;
        const uri = args[1];
        const scope = JSON.parse(args[2]).scope;
        assert.notEqual(uri, outside, 'projects outside the workspace folder must be ignored');
        if (uri === root) return { classpaths: [jars.root], sourcePaths: [rootDir] };
        if (uri === moduleA) {
          // A dependency shared by two modules must appear only once.
          return { classpaths: [jars.a, jars.root], sourcePaths: [path.dirname(jars.a)] };
        }
        if (uri === moduleB) {
          return scope === 'test'
            ? { classpaths: [], sourcePaths: [] }
            : { classpaths: [jars.b], sourcePaths: [path.dirname(jars.b)] };
        }
        throw new Error(`unexpected project uri ${uri}`);
      }
    },
    Uri: { parse: fakeUri },
    workspace: {}
  };

  const { fromJavaLanguageServer } = loadClasspath({ vscode: vscodeStub });
  const folder = { uri: fakeUri(root), name: 'multi' };
  const log = { trace() {}, info() {}, warn() {} };
  const result = await fromJavaLanguageServer(folder, log);

  const queried = calls.filter(c => c[1] === 'java.project.getClasspaths');
  assert.deepEqual(queried.map(c => c[2]), [root, moduleA, moduleB, moduleB]);
  assert.deepEqual(queried.map(c => JSON.parse(c[3]).scope), ['test', 'test', 'test', 'runtime']);
  assert.deepEqual(result.jars, [jars.root, jars.a, jars.b]);
  assert.equal(result.sourcePaths.length, 3);
  assert.equal(result.scope, 'mixed');
  assert.deepEqual(result.projectUris, [root, moduleA, moduleB]);
  assert.deepEqual(result.matchedProjectUris, [root, moduleA, moduleB]);
  assert.equal(result.raw.projects.length, 3);

  removeTree(rootDir);
});

test('fromMaven merges classpath outputs from all reactor modules', async () => {
  const rootDir = tempDir('mvn');
  for (const name of ['module-a', 'module-b']) fs.mkdirSync(path.join(rootDir, name));
  const jars = {
    root: path.join(rootDir, 'root.jar'),
    a: path.join(rootDir, 'module-a', 'a.jar'),
    b: path.join(rootDir, 'module-b', 'b.jar')
  };
  for (const jar of Object.values(jars)) fs.writeFileSync(jar, '');

  let markerFromCommand;
  const spawn = (line, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const match = /-Dmdep\.outputFile=([^\s"]+)/.exec(line);
    assert.ok(match, 'outputFile must be passed to maven');
    markerFromCommand = match[1];
    // Emulate maven-dependency-plugin resolving a relative outputFile per module.
    for (const rel of ['', 'module-a', 'module-b']) {
      const dir = path.join(opts.cwd, rel);
      const jar = jars[rel === '' ? 'root' : rel === 'module-a' ? 'a' : 'b'];
      fs.writeFileSync(path.join(dir, markerFromCommand), jar);
    }
    setImmediate(() => child.emit('close', 0));
    return child;
  };

  const { fromMaven } = loadClasspath({
    vscode: { Uri: { parse: fakeUri }, workspace: {}, commands: {} },
    childProcess: { spawn }
  });
  const folder = { uri: fakeUri(uriFor(rootDir)), name: 'mvn' };
  const warnings = [];
  const log = { trace() {}, info() {}, warn: (...args) => warnings.push(args.join(' ')) };
  const result = await fromMaven(folder, path.join(rootDir, 'storage'), log, 60000);

  assert.ok(!path.isAbsolute(markerFromCommand), 'relative outputFile avoids per-module overwrite');
  assert.deepEqual([...result.jars].sort(), [jars.a, jars.b, jars.root].sort());
  assert.equal(warnings.length, 0);
  assert.equal(fs.existsSync(path.join(rootDir, markerFromCommand)), false, 'marker files are cleaned up');
  assert.equal(fs.existsSync(path.join(rootDir, 'module-a', markerFromCommand)), false);

  removeTree(rootDir);
});

test('descriptorState tracks pom.xml changes in submodules', async () => {
  const rootDir = tempDir('state');
  fs.writeFileSync(path.join(rootDir, 'pom.xml'), '<project>root</project>');
  fs.mkdirSync(path.join(rootDir, 'module-a'));
  const nested = path.join(rootDir, 'module-a', 'pom.xml');
  fs.writeFileSync(nested, '<project>a</project>');

  const { descriptorState } = loadClasspath({
    vscode: { Uri: { parse: fakeUri }, workspace: {}, commands: {} }
  });
  const folder = { uri: fakeUri(uriFor(rootDir)), name: 'state' };
  const before = await descriptorState(folder);
  fs.writeFileSync(nested, '<project>a with new dependency</project>');
  const after = await descriptorState(folder);

  assert.notEqual(before, after, 'submodule pom changes must invalidate the classpath snapshot');
  removeTree(rootDir);
});
