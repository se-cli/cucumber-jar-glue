'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_VERSION = 2;

function identityOf(stat) {
  return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

function identityMatches(a, b) {
  if (!a || !b) return false;
  return a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs);
}

class CacheStore {
  constructor(storageDir) {
    this.dir = path.join(storageDir, 'jar-glue', `v${CACHE_VERSION}`);
  }

  keyFor(jarPath) {
    return crypto.createHash('sha256').update(path.resolve(jarPath)).digest('hex').slice(0, 24);
  }

  fileFor(jarPath) {
    return path.join(this.dir, `${this.keyFor(jarPath)}.json`);
  }

  async load(jarPath, identity) {
    try {
      const raw = await fs.promises.readFile(this.fileFor(jarPath), 'utf8');
      const data = JSON.parse(raw);
      if (data.version !== CACHE_VERSION) return undefined;
      if (!identityMatches(data.identity, identity)) return undefined;
      if (!Array.isArray(data.definitions)) return undefined;
      return data;
    } catch (_) {
      return undefined;
    }
  }

  async save(jarPath, identity, payload) {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const target = this.fileFor(jarPath);
    const tmp = `${target}.${process.pid}.tmp`;
    const data = JSON.stringify({
      version: CACHE_VERSION,
      jarPath: path.resolve(jarPath),
      identity: identityOf(identity),
      indexedAt: Date.now(),
      definitions: payload.definitions || [],
      customTypes: payload.customTypes || {},
      warnings: payload.warnings || [],
      stats: payload.stats || {},
      skipped: !!payload.skipped,
      reason: payload.reason
    });
    await fs.promises.writeFile(tmp, data, 'utf8');
    try { await fs.promises.unlink(target); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    await fs.promises.rename(tmp, target);
  }

  async remove(jarPath) {
    try { await fs.promises.unlink(this.fileFor(jarPath)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }

  async clear() {
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }

  async list() {
    try { return (await fs.promises.readdir(this.dir)).filter(f => f.endsWith('.json')); }
    catch (_) { return []; }
  }
}

module.exports = { CacheStore, CACHE_VERSION, identityOf, identityMatches };
