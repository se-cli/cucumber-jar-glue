'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function loadDefinitionProvider() {
  const stub = {
    Range: class {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        Object.assign(this, { startLine, startCharacter, endLine, endCharacter });
      }
    },
    Uri: { parse: value => ({ toString: () => value }) },
    languages: {
      registerDefinitionProvider: (_selector, provider) => {
        stub.provider = provider;
        return { dispose() {} };
      }
    }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return stub;
    return originalLoad.call(this, request, parent, isMain);
  };
  const id = require.resolve('../src/providers/definitionProvider');
  delete require.cache[id];
  const loaded = require('../src/providers/definitionProvider');
  Module._load = originalLoad;
  return { ...loaded, stub };
}

function fakeDef() {
  return {
    id: 'def#1',
    source: 'jar',
    jarPath: '/repo/glue.jar',
    entryName: 'com/acme/Glue.class',
    className: 'com.acme.Glue',
    methodName: 'hello'
  };
}

function document() {
  return { lineAt: () => ({ text: 'Given hello world' }) };
}

test('jarDefinitionView=decompiled links to decompiled source', async () => {
  const { registerDefinitionProvider, stub } = loadDefinitionProvider();
  const decompiledUri = { toString: () => 'cucumber-glue-source:/Glue.java' };
  const declarationUri = { toString: () => 'cucumber-glue:/glue.jar!Glue.class' };
  let decompileCalls = 0;

  registerDefinitionProvider(
    { findDefinitions: () => [{ definition: fakeDef() }] },
    { locationFor: () => ({ uri: declarationUri, range: {} }) },
    {
      configRef: () => ({ jarDefinitionView: 'decompiled' }),
      decompiled: {
        locationFor: async () => {
          decompileCalls++;
          return { uri: decompiledUri, range: {} };
        }
      },
      log: { warn() {} }
    }
  );

  const links = await stub.provider.provideDefinition(document(), { line: 0 });
  assert.equal(decompileCalls, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].targetUri, decompiledUri);
});

test('decompiled view falls back to declaration when unavailable', async () => {
  const { registerDefinitionProvider, stub } = loadDefinitionProvider();
  const declarationUri = { toString: () => 'cucumber-glue:/glue.jar!Glue.class' };

  registerDefinitionProvider(
    { findDefinitions: () => [{ definition: fakeDef() }] },
    { locationFor: () => ({ uri: declarationUri, range: {} }) },
    {
      configRef: () => ({ jarDefinitionView: 'decompiled' }),
      decompiled: { locationFor: async () => undefined },
      log: { warn() {} }
    }
  );

  const links = await stub.provider.provideDefinition(document(), { line: 0 });
  assert.equal(links.length, 1);
  assert.equal(links[0].targetUri, declarationUri);
});

test('jarDefinitionView=declaration keeps the declaration view', async () => {
  const { registerDefinitionProvider, stub } = loadDefinitionProvider();
  const declarationUri = { toString: () => 'cucumber-glue:/glue.jar!Glue.class' };
  let decompileCalls = 0;

  registerDefinitionProvider(
    { findDefinitions: () => [{ definition: fakeDef() }] },
    { locationFor: () => ({ uri: declarationUri, range: {} }) },
    {
      configRef: () => ({ jarDefinitionView: 'declaration' }),
      decompiled: { locationFor: async () => { decompileCalls++; return undefined; } },
      log: { warn() {} }
    }
  );

  const links = await stub.provider.provideDefinition(document(), { line: 0 });
  assert.equal(decompileCalls, 0);
  assert.equal(links[0].targetUri, declarationUri);
});
