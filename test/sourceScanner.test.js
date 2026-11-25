'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { annotationCalls, stringValues, resolveAnnotation, scanJavaSource } = require('../src/glue/sourceScanner');
Module._load = originalLoad;

test('extracts annotation calls with balanced parentheses', () => {
  const calls = annotationCalls('@Given("a (b) \\"c\\"") public void x() {}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'Given');
  assert.deepEqual(stringValues(calls[0].args), ['a (b) "c"']);
});

test('resolves imported and fully qualified glue annotations', () => {
  const imports = new Map([['Given', 'io.cucumber.java.en.Given']]);
  assert.equal(resolveAnnotation('Given', imports).kind, 'step');
  assert.equal(resolveAnnotation('io.cucumber.java.Before', imports).kind, 'hook');
  assert.equal(resolveAnnotation('Given', new Map()).kind, 'step');
  assert.equal(resolveAnnotation('NotGlue', new Map()), undefined);
});

test('indexes workspace Java glue with source positions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cucumber-source-test-'));
  const file = path.join(dir, 'Steps.java');
  fs.writeFileSync(file, [
    'package com.acme;',
    'import io.cucumber.java.en.Given;',
    'public class Steps {',
    '  @Given("hello {string}")',
    '  public void hello(String s) {}',
    '  @io.cucumber.java.Before',
    '  public void setUp() {}',
    '}'
  ].join('\n'));

  try {
    const result = scanJavaSource(file, { toString: () => `file://${file}` });
    assert.ok(result.definitions.some(d => d.kind === 'step' && d.patterns[0] === 'hello {string}'));
    assert.ok(result.definitions.some(d => d.kind === 'hook' && d.methodName === 'setUp'));
    const step = result.definitions.find(d => d.kind === 'step');
    assert.equal(step.line, 4);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test('parses method name when parameter annotations contain nested parentheses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cucumber-source-nested-'));
  const file = path.join(dir, 'ArtifactoryVersionGlue.java');
  fs.writeFileSync(file, [
    'package com.acme;',
    'import io.cucumber.java.en.When;',
    'import io.cucumber.java.Transform;',
    'public class ArtifactoryVersionGlue {',
    '  @When("version is not less than {artVersion}")',
    '  public void assertVersionNotLessThanPersisted(',
    '      @Transform(value = "(^|\\\\.)(\\\\d+)", to = ArtifactVersion.class) String version,',
    '      String expected) {',
    '    if (version == null) { throw new IllegalArgumentException(); }',
    '  }',
    '}'
  ].join('\n'));

  try {
    const result = scanJavaSource(file, { toString: () => `file://${file}` });
    const step = result.definitions.find(d => d.kind === 'step');
    assert.ok(step, 'the @When step must be indexed');
    assert.equal(step.methodName, 'assertVersionNotLessThanPersisted');
    assert.equal(step.descriptor, '(Ljava/lang/Object;Ljava/lang/Object;)V');
    assert.ok(!result.definitions.some(d => d.methodName === 'if'), 'if must not become a method');
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test('skips annotations with nested parentheses before the method declaration', () => {
  const text = '@Given(value = "x", from = foo(bar(1))) public void realMethod(String s) { if (s == null) { return; } }';
  const calls = annotationCalls(text);
  assert.equal(calls.length, 1);
  assert.deepEqual(stringValues(calls[0].args), ['x']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cucumber-source-anno-'));
  const file = path.join(dir, 'Steps.java');
  fs.writeFileSync(file, [
    'package com.acme;',
    'import io.cucumber.java.en.Given;',
    'public class Steps {',
    '  @Given(value = "x", from = foo(bar(1)))',
    '  public void realMethod(String s) { if (s == null) { return; } }',
    '}'
  ].join('\n'));
  try {
    const result = scanJavaSource(file, { toString: () => `file://${file}` });
    assert.equal(result.definitions[0].methodName, 'realMethod');
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
