'use strict';

const { parentPort } = require('worker_threads');
const { scanJar } = require('./jarScanner');

if (parentPort) {
  parentPort.on('message', async msg => {
    if (!msg || msg.type !== 'scan') return;
    try {
      const result = await scanJar(msg.jarPath, msg.options || {});
      parentPort.postMessage({ id: msg.id, ok: true, result });
    } catch (err) {
      parentPort.postMessage({
        id: msg.id,
        ok: false,
        error: err && err.message ? err.message : String(err),
        code: err && err.code ? err.code : undefined
      });
    }
  });
}
