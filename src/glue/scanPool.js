'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { scanJar } = require('./jarScanner');

const WORKER_PATH = path.join(__dirname, 'worker.js');

class ScanPool {
  constructor(config, log) {
    this.configRef = typeof config === 'function' ? config : () => config;
    this.log = log;
  }

  get config() { return this.configRef(); }

  get options() {
    const config = this.config;
    return {
      maxJarSizeMb: config.maxJarSizeMb,
      maxEntrySizeMb: config.maxEntrySizeMb,
      maxClassEntriesPerJar: config.maxClassEntriesPerJar,
      excludePackages: config.excludePackages,
      extraAnnotationPrefixes: config.extraAnnotationPrefixes
    };
  }

  scanOne(jarPath) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(WORKER_PATH);
      } catch (err) {
        scanJar(jarPath, this.options).then(resolve, reject);
        return;
      }
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        if (err) reject(err); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(`scan timed out after ${this.config.scanTimeoutMs} ms`)), this.config.scanTimeoutMs);
      worker.on('message', msg => {
        if (!msg || msg.id !== 1) return;
        if (msg.ok) finish(null, msg.result);
        else {
          const err = new Error(msg.error);
          err.code = msg.code;
          finish(err);
        }
      });
      worker.on('error', err => finish(err));
      worker.on('exit', code => { if (!settled) finish(new Error(`scanner worker exited with ${code}`)); });
      worker.postMessage({ id: 1, type: 'scan', jarPath, options: this.options });
    });
  }

  async scanAll(jarPaths, shouldCancel = () => false) {
    const queue = jarPaths.slice();
    const results = [];
    const limit = Math.min(Math.max(1, this.config.maxWorkers), Math.max(1, queue.length));

    const slot = async () => {
      while (queue.length && !shouldCancel()) {
        const jarPath = queue.shift();
        const started = Date.now();
        try {
          const result = await this.scanOne(jarPath);
          this.log.info(`scanned ${jarPath}: ${(result.definitions || []).length} glue definitions, ${Date.now() - started} ms`);
          results.push(result);
        } catch (err) {
          this.log.warn(jarPath, err.message);
          results.push({
            jarPath,
            identity: undefined,
            skipped: true,
            reason: err.message,
            definitions: [],
            customTypes: {},
            warnings: [err.message],
            stats: {}
          });
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, slot));
    return results;
  }
}

module.exports = { ScanPool };
