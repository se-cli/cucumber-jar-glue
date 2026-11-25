'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClassFile, decodeModifiedUtf8, asStrings } = require('../src/glue/classFile');
const { buildClassFile, encodeMutf8 } = require('./helpers');

test('parses method annotations, multiple values and hooks', () => {
  const bytes = buildClassFile({
    className: 'com/acme/MyGlue',
    methods: [
      {
        name: 'iHaveCukes',
        descriptor: '(I)V',
        annotations: [
          { descriptor: 'Lio/cucumber/java/en/Given;', value: 'I have {int} cukes' },
          { descriptor: 'Lio/cucumber/java/zh_cn/假如;', value: ['用户存在', '账号有效'] }
        ]
      },
      {
        name: 'beforeEach',
        descriptor: '()V',
        annotations: [{ descriptor: 'Lio/cucumber/java/Before;', elements: { value: '@fast' } }]
      }
    ]
  });
  const cls = parseClassFile(bytes);
  assert.equal(cls.className, 'com/acme/MyGlue');
  assert.equal(cls.major, 61);
  assert.equal(cls.methods.length, 2);
  assert.equal(cls.methods[0].annotations[0].type, 'Lio/cucumber/java/en/Given;');
  assert.equal(cls.methods[0].annotations[0].elements.value, 'I have {int} cukes');
  assert.deepEqual(asStrings(cls.methods[0].annotations[1].elements.value), ['用户存在', '账号有效']);
  assert.equal(cls.methods[1].annotations[0].type, 'Lio/cucumber/java/Before;');
});

test('decodes Java modified UTF-8 including CJK and surrogate pairs', () => {
  assert.equal(decodeModifiedUtf8(encodeMutf8('假如用户')), '假如用户');
  assert.equal(decodeModifiedUtf8(Buffer.from([0x41, 0xc0, 0x80, 0x42])), 'A\0B');
  assert.equal(decodeModifiedUtf8(Buffer.from([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80])), '😀');
});
