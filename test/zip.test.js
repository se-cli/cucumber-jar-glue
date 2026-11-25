'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ZipReader, ZipError } = require('../src/glue/zipReader');
const { buildJar } = require('./helpers');

test('reads STORE and DEFLATE entries from the central directory', () => {
  const jar = buildJar([
    { name: 'com/acme/Stored.class', data: Buffer.from('stored-bytes'), compression: 0 },
    { name: 'com/acme/Deflated.class', data: Buffer.from('A'.repeat(5000)), compression: 8 }
  ]);
  const zip = new ZipReader(jar);
  assert.equal(zip.entries.length, 2);
  const found = {};
  zip.forEachEntry({
    onEntry: (entry, data) => { found[entry.name] = data.toString(); }
  });
  assert.equal(found['com/acme/Stored.class'], 'stored-bytes');
  assert.equal(found['com/acme/Deflated.class'], 'A'.repeat(5000));
});

test('filter and maxEntries bound the work and report truncation', () => {
  const jar = buildJar([
    { name: 'a.class', data: Buffer.from('1') },
    { name: 'b.class', data: Buffer.from('2') },
    { name: 'skip.txt', data: Buffer.from('3') }
  ]);
  const zip = new ZipReader(jar);
  const stats = zip.forEachEntry({
    filter: e => e.name.endsWith('.class'),
    maxEntries: 1,
    onEntry: () => {}
  });
  assert.equal(stats.read, 1);
  assert.equal(stats.truncated, true);
  assert.equal(stats.filtered, 0);
});

test('rejects a buffer without a central directory', () => {
  assert.throws(() => new ZipReader(Buffer.from('not a jar')), ZipError);
});
