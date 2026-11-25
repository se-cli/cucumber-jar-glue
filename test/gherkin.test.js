'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LANGUAGE_IDS, DOCUMENT_SELECTOR, isGherkinDocument } = require('../src/util/gherkin');

test('recognizes both gherkin and cucumber language ids', () => {
  assert.ok(LANGUAGE_IDS.includes('gherkin'));
  assert.ok(LANGUAGE_IDS.includes('cucumber'));
  assert.equal(isGherkinDocument({ languageId: 'cucumber', uri: {} }), true);
  assert.equal(isGherkinDocument({ languageId: 'gherkin', uri: {} }), true);
});

test('falls back to .feature extension for other language ids', () => {
  assert.equal(isGherkinDocument({ languageId: 'plaintext', uri: { fsPath: 'D:/x/probe.FEATURE' } }), true);
  assert.equal(isGherkinDocument({ languageId: 'java', uri: { fsPath: 'D:/x/App.java' } }), false);
  assert.equal(isGherkinDocument(undefined), false);
});

test('document selector covers both ids and the file pattern', () => {
  const ids = DOCUMENT_SELECTOR.filter(s => s.language).map(s => s.language);
  assert.deepEqual(ids, ['gherkin', 'cucumber']);
  assert.ok(DOCUMENT_SELECTOR.some(s => s.pattern === '**/*.feature'));
  assert.ok(DOCUMENT_SELECTOR.every(s => s.scheme === 'file'));
});
