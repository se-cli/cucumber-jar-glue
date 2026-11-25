'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CacheStore, identityMatches } = require('../src/glue/cache');

test('cache load requires matching JAR identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cucumber-cache-test-'));
  const store = new CacheStore(dir);
  const identity = { size: 1234, mtimeMs: 1700000000123 };
  await store.save('/tmp/glue.jar', identity, {
    definitions: [{ id: 'a', kind: 'step', patterns: ['hello'] }],
    customTypes: { money: '\\d+' }
  });

  const hit = await store.load('/tmp/glue.jar', identity);
  assert.equal(hit.definitions.length, 1);
  assert.equal(hit.customTypes.money, '\\d+');

  const miss = await store.load('/tmp/glue.jar', { size: 1235, mtimeMs: 1700000000123 });
  assert.equal(miss, undefined);
  assert.equal(identityMatches(identity, { size: 1234, mtimeMs: 1700000000124 }), false);
  assert.equal((await store.list()).length, 1);

  await store.remove('/tmp/glue.jar');
  assert.equal((await store.list()).length, 0);
  fs.rmdirSync(path.join(dir, 'jar-glue', 'v2'));
  fs.rmdirSync(path.join(dir, 'jar-glue'));
  fs.rmdirSync(dir);
});
