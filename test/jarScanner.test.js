'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanJar } = require('../src/glue/jarScanner');
const { buildClassFile, buildJar } = require('./helpers');

test('scans glue metadata inside a JAR without extracting it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cucumber-glue-test-'));
  const jarPath = path.join(dir, 'glue.jar');
  const jar = buildJar([
    {
      name: 'com/acme/Glue.class',
      compression: 8,
      data: buildClassFile({
        className: 'com/acme/Glue',
        methods: [
          {
            name: 'iHaveCukes',
            descriptor: '(I)V',
            annotations: [{ descriptor: 'Lio/cucumber/java/en/Given;', value: 'I have {int} cukes' }]
          },
          {
            name: 'setUp',
            descriptor: '()V',
            annotations: [{ descriptor: 'Lio/cucumber/java/Before;', elements: { value: '@fast' } }]
          }
        ]
      })
    },
    {
      name: 'com/acme/Params.class',
      data: buildClassFile({
        className: 'com/acme/Params',
        methods: [{
          name: 'moneyType',
          descriptor: '()V',
          annotations: [{
            descriptor: 'Lio/cucumber/java/ParameterType;',
            elements: { value: 'money', regexp: ['\\d+'] }
          }]
        }]
      })
    },
    {
      name: 'java/lang/String.class',
      data: buildClassFile({
        className: 'java/lang/String',
        methods: [{
          name: 'excluded',
          descriptor: '()V',
          annotations: [{ descriptor: 'Lio/cucumber/java/en/Given;', value: 'should be excluded' }]
        }]
      })
    }
  ]);
  fs.writeFileSync(jarPath, jar);

  try {
    const result = await scanJar(jarPath, {
      maxJarSizeMb: 10,
      maxEntrySizeMb: 2,
      excludePackages: ['java/', 'io/cucumber/']
    });
    assert.equal(result.skipped, false);
    assert.ok(result.definitions.some(d => d.kind === 'step' && d.patterns[0] === 'I have {int} cukes'));
    assert.ok(result.definitions.some(d => d.kind === 'hook' && d.methodName === 'setUp'));
    assert.ok(!result.definitions.some(d => d.patterns[0] === 'should be excluded'));
    assert.equal(result.customTypes.money, '\\d+');
    assert.ok(result.definitions.every(d => d.source === 'jar' && d.jarPath === jarPath));
  } finally {
    fs.unlinkSync(jarPath);
    fs.rmdirSync(dir);
  }
});

test('reports oversized JARs as skipped instead of failing the index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cucumber-glue-test-'));
  const jarPath = path.join(dir, 'big.jar');
  fs.writeFileSync(jarPath, buildJar([]));
  try {
    const result = await scanJar(jarPath, { maxJarSizeMb: 0.00001 });
    assert.equal(result.skipped, true);
    assert.match(result.reason, /limit/);
  } finally {
    fs.unlinkSync(jarPath);
    fs.rmdirSync(dir);
  }
});
