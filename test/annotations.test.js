'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../src/glue/annotations');

test('recognizes v1, v2+ and localized step annotations', () => {
  const cases = [
    ['Lcucumber/api/java/en/Given;', 'step', '1.x', 'Given'],
    ['Lio/cucumber/java/en/When;', 'step', '2.x+', 'When'],
    ['Lio/cucumber/java/zh_cn/假如;', 'step', '2.x+', '假如'],
    ['Lcucumber/api/java/fr/Soit;', 'step', '1.x', 'Soit'],
    ['Lio/cucumber/java/Before;', 'hook', '2.x+', 'Before'],
    ['Lcucumber/api/java/AfterStep;', 'hook', '1.x', 'AfterStep'],
    ['Lio/cucumber/java/ParameterType;', 'ParameterType', '2.x+', 'ParameterType'],
    ['Lio/cucumber/java/en/Unrelated;', 'step', '2.x+', 'Unrelated']
  ];
  for (const [descriptor, kind, version, keyword] of cases) {
    const info = classify(descriptor);
    assert.ok(info, descriptor);
    assert.equal(info.kind, kind, descriptor);
    assert.equal(info.version, version, descriptor);
    assert.equal(info.keyword, keyword, descriptor);
  }
});

test('ignores unrelated annotations and supports configured prefixes', () => {
  assert.equal(classify('Lorg/junit/Test;'), undefined);
  const info = classify('Lcom/acme/glue/en/Custom;', ['com/acme/glue/']);
  assert.equal(info.kind, 'step');
  assert.equal(info.keyword, 'Custom');
});
