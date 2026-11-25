'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function fakeUri(raw) {
  let value = String(raw);
  if (value.startsWith('file:///')) value = value.slice('file:///'.length);
  value = decodeURIComponent(value).replace(/^\//, '');
  return { toString: () => raw, fsPath: value };
}

test('fromJavaLanguageServer uses project URI from java.project.getAll', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cucumber-cp-test-'));
  const jar = path.join(dir, 'glue.jar');
  fs.writeFileSync(jar, require('./helpers').buildJar([]));

  const projectUri = `file:///${encodeURIComponent('d:/code/cucumber-glue-fixture')}`;
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

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  const { fromJavaLanguageServer } = require('../src/glue/classpath');
  Module._load = originalLoad;

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

  fs.unlinkSync(jar);
  fs.rmdirSync(dir);
});
