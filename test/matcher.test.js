'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stepTextFromLine, compileExpression, matchSteps } = require('../src/glue/matcher');

const def = (id, pattern) => ({ id, kind: 'step', patterns: [pattern] });

test('extracts step text for English and Chinese keywords', () => {
  const en = stepTextFromLine('  Given I have 3 cukes');
  assert.equal(en.keyword, 'Given');
  assert.equal(en.text, 'I have 3 cukes');
  assert.equal(en.textStart, 8);
  const zh = stepTextFromLine('假如用户已登录');
  assert.equal(zh.keyword, '假如');
  assert.equal(zh.text, '用户已登录');
  assert.equal(stepTextFromLine('# Given comment'), undefined);
});

test('compiles Cucumber Expression parameters, alternation and optional text', () => {
  const re = new RegExp(`^${compileExpression('I have {int} (cukes|cuke)s?')}$`);
  assert.equal(re.test('I have 3 cukes'), true);
  assert.equal(re.test('I have -2 cuke'), true);
  assert.equal(re.test('I have x cukes'), false);
});

test('matches regex and expression definitions and ranks the more specific one', () => {
  const definitions = [
    def('regex', '^I have (\\d+) cukes$'),
    def('expr', 'I have {int} cukes'),
    def('custom', 'I have {n} cukes'),
    def('other', 'unrelated')
  ];
  const customTypes = new Map([['n', '\\d+']]);
  const matches = matchSteps('I have 3 cukes', definitions, customTypes);
  assert.ok(matches.length >= 2);
  // {int} and a custom {n} resolving to the same width are equally specific.
  assert.ok(['expr', 'custom'].includes(matches[0].definition.id));
  assert.ok(matches.some(m => m.definition.id === 'regex'));
  assert.ok(matches.some(m => m.definition.id === 'custom'));
  assert.ok(!matches.some(m => m.definition.id === 'other'));
});

test('rejects nested quantifier patterns that could hang the host', () => {
  const matches = matchSteps('aaaa', [def('bad', '(a+)+')]);
  assert.equal(matches.length, 0);
});
