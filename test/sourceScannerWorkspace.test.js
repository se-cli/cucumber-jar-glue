'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function loadSourceScanner(stubs) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return stubs;
    return originalLoad.call(this, request, parent, isMain);
  };
  const id = require.resolve('../src/glue/sourceScanner');
  delete require.cache[id];
  const loaded = require('../src/glue/sourceScanner');
  Module._load = originalLoad;
  return loaded;
}

test('source scan excludes historical run snapshots', async () => {
  let captured;
  const vscodeStub = {
    RelativePattern: class {
      constructor(folder, pattern) { this.folder = folder; this.pattern = pattern; }
    },
    workspace: {
      findFiles: async (pattern, exclude, max) => {
        captured = { pattern, exclude, max };
        return [];
      }
    }
  };
  const { scanWorkspaceSources, SOURCE_EXCLUDE_GLOB, isIgnoredPath } = loadSourceScanner(vscodeStub);

  assert.ok(SOURCE_EXCLUDE_GLOB.includes('.local-state'));
  assert.ok(isIgnoredPath('/workspace/.local-state/temporal/runs/Steps.java'));
  assert.ok(isIgnoredPath('D:\\workspace\\.local-state\\temporal\\runs\\Steps.java'));
  assert.ok(isIgnoredPath('/workspace/target/generated/Steps.java'));
  assert.equal(isIgnoredPath('/workspace/src/test/java/Steps.java'), false);

  await scanWorkspaceSources({ uri: { fsPath: '/workspace' } }, {}, { trace() {} });
  assert.equal(captured.pattern.pattern, '**/*.java');
  assert.equal(captured.exclude, SOURCE_EXCLUDE_GLOB);
  assert.equal(captured.max, 20000);
});

test('ignored files are skipped even if the host returns them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cucumber-source-exclude-'));
  const real = path.join(dir, 'Steps.java');
  fs.writeFileSync(real, [
    'package com.acme;',
    'import io.cucumber.java.en.Given;',
    'public class Steps {',
    '  @Given("real")',
    '  public void real() {}',
    '}'
  ].join('\n'));
  const ignored = path.join(dir, '.local-state', 'temporal', 'runs', 'Steps.java');

  const vscodeStub = {
    RelativePattern: class {
      constructor(folder, pattern) { this.folder = folder; this.pattern = pattern; }
    },
    workspace: {
      findFiles: async () => [real, ignored].map(p => ({
        fsPath: p,
        toString: () => `file://${p.replace(/\\/g, '/')}`
      }))
    }
  };
  const { scanWorkspaceSources } = loadSourceScanner(vscodeStub);

  try {
    const result = await scanWorkspaceSources(
      { uri: { fsPath: dir } }, {}, { trace() {} }
    );
    assert.equal(result.files, 1);
    assert.equal(result.definitions.length, 1);
    assert.equal(result.definitions[0].patterns[0], 'real');
  } finally {
    fs.unlinkSync(real);
    fs.rmdirSync(dir);
  }
});
