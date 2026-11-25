'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { buildJar } = require('./helpers');

function uriStub() {
  return {
    file: p => ({
      scheme: 'file',
      fsPath: p,
      toString: () => `file://${String(p).replace(/\\/g, '/')}`
    }),
    from: parts => ({
      ...parts,
      toString: () => `${parts.scheme}:${parts.path}?${parts.query}`
    })
  };
}

function loadModule(vscodeStub) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  const id = require.resolve('../src/glue/decompiledSource');
  delete require.cache[id];
  const loaded = require('../src/glue/decompiledSource');
  Module._load = originalLoad;
  return loaded;
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cucumber-decompile-'));
  const jar = path.join(dir, 'glue.jar');
  const bytes = Buffer.from('fake class bytes for extraction test');
  fs.writeFileSync(jar, buildJar([{ name: 'com/acme/Glue.class', data: bytes }]));
  const def = {
    source: 'jar',
    jarPath: jar,
    entryName: 'com/acme/Glue.class',
    className: 'com.acme.Glue',
    methodName: 'hello'
  };
  return { dir, jar, bytes, def };
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

test('extracts the class and opens decompiled source from java.decompile', async () => {
  const { dir, bytes, def } = makeFixture();
  const calls = [];
  const languages = [];
  const source = 'package com.acme; public class Glue { void hello() {} }';
  const vscodeStub = {
    Uri: uriStub(),
    EventEmitter: class {
      constructor() { this.event = () => ({ dispose() {} }); }
      fire() {}
      dispose() {}
    },
    commands: {
      executeCommand: async (...args) => {
        calls.push(args);
        if (args[0] === 'java.execute.workspaceCommand' && args[1] === 'java.decompile') return source;
        return undefined;
      }
    },
    window: {
      showTextDocument: async uri => ({ document: { uri } }),
      showWarningMessage: () => {}
    },
    languages: {
      setTextDocumentLanguage: async (_doc, lang) => { languages.push(lang); }
    }
  };
  const { DecompiledDocumentProvider } = loadModule(vscodeStub);
  const provider = new DecompiledDocumentProvider();

  try {
    const result = await provider.open(def, dir, { warn() {} });
    assert.equal(result.opened, 'decompiled');
    assert.deepEqual(calls[0].slice(0, 2), ['java.execute.workspaceCommand', 'java.decompile']);
    assert.ok(calls[0][2].startsWith('file://'));
    assert.ok(calls[0][2].endsWith('.class'));
    assert.deepEqual(fs.readFileSync(result.classFile), bytes);
    assert.equal(provider.provideTextDocumentContent(result.uri), source);
    assert.deepEqual(languages, ['java']);
  } finally {
    provider.dispose();
    removeTree(dir);
  }
});

test('locationFor prepares content and caches repeated navigation', async () => {
  const { dir, def } = makeFixture();
  const source = 'package com.acme; public class Glue { void hello() {} }';
  let calls = 0;
  const vscodeStub = {
    Uri: uriStub(),
    Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
    EventEmitter: class {
      constructor() { this.event = () => ({ dispose() {} }); }
      fire() {}
      dispose() {}
    },
    commands: {
      executeCommand: async (...args) => {
        calls++;
        if (args[1] === 'java.decompile') return source;
        return undefined;
      }
    },
    window: {},
    languages: {}
  };
  const { DecompiledDocumentProvider } = loadModule(vscodeStub);
  const provider = new DecompiledDocumentProvider(dir);

  try {
    const first = await provider.locationFor(def, { warn() {} });
    const second = await provider.locationFor(def, { warn() {} });
    assert.ok(first && first.uri);
    assert.equal(first.uri, second.uri);
    assert.equal(provider.provideTextDocumentContent(first.uri), source);
    assert.equal(calls, 1, 'repeated navigation must reuse the cached decompilation');
  } finally {
    provider.dispose();
    removeTree(dir);
  }
});

test('falls back to opening the class file when no decompiler is available', async () => {
  const { dir, def } = makeFixture();
  const calls = [];
  const warnings = [];
  const vscodeStub = {
    Uri: uriStub(),
    EventEmitter: class {
      constructor() { this.event = () => ({ dispose() {} }); }
      fire() {}
      dispose() {}
    },
    commands: {
      executeCommand: async (...args) => {
        calls.push(args);
        if (args[0] === 'java.execute.workspaceCommand' && args[1] === 'java.decompile') {
          throw new Error('Unsupported command');
        }
        return undefined;
      }
    },
    window: {
      showTextDocument: async () => ({}),
      showWarningMessage: msg => { warnings.push(msg); }
    },
    languages: {}
  };
  const { DecompiledDocumentProvider } = loadModule(vscodeStub);
  const provider = new DecompiledDocumentProvider();

  try {
    const result = await provider.open(def, dir, { warn() {} });
    assert.equal(result.opened, 'class');
    assert.ok(calls.some(c => c[0] === 'vscode.open'));
    assert.ok(warnings.some(w => w.includes('没有拿到反编译源码')));
  } finally {
    provider.dispose();
    removeTree(dir);
  }
});
