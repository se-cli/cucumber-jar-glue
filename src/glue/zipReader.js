'use strict';

// Minimal ZIP/JAR reader: reads the central directory, then inflates selected
// entries in memory. Nothing is ever extracted to disk.
const zlib = require('zlib');

const SIG = {
  EOCD: 0x06054b50,
  ZIP64_EOCD: 0x06064b50,
  ZIP64_LOCATOR: 0x07064b50,
  CENTRAL: 0x02014b50,
  LOCAL: 0x04034b50
};

class ZipError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG.EOCD) return i;
  }
  throw new ZipError('End of central directory not found', 'NO_EOCD');
}

function readZip64(buf, eocd) {
  const loc = eocd - 20;
  if (loc < 0 || buf.readUInt32LE(loc) !== SIG.ZIP64_LOCATOR) {
    throw new ZipError('ZIP64 fields present but locator missing', 'ZIP64_LOCATOR_MISSING');
  }
  const off = Number(buf.readBigUInt64LE(loc + 8));
  if (off < 0 || off + 56 > buf.length || buf.readUInt32LE(off) !== SIG.ZIP64_EOCD) {
    throw new ZipError('ZIP64 end of central directory not found', 'ZIP64_EOCD_MISSING');
  }
  return {
    totalEntries: Number(buf.readBigUInt64LE(off + 32)),
    cdSize: Number(buf.readBigUInt64LE(off + 40)),
    cdOffset: Number(buf.readBigUInt64LE(off + 48))
  };
}

function parseZip64Extra(data, entry) {
  let p = 0;
  while (p + 4 <= data.length) {
    const id = data.readUInt16LE(p);
    const size = data.readUInt16LE(p + 2);
    const start = p + 4;
    const end = start + size;
    if (end > data.length) break;
    if (id === 0x0001) {
      let q = start;
      if (entry.uncompressedSize === 0xffffffff) { entry.uncompressedSize = Number(data.readBigUInt64LE(q)); q += 8; }
      if (entry.compressedSize === 0xffffffff) { entry.compressedSize = Number(data.readBigUInt64LE(q)); q += 8; }
      if (entry.localHeaderOffset === 0xffffffff) { entry.localHeaderOffset = Number(data.readBigUInt64LE(q)); q += 8; }
      return;
    }
    p = end;
  }
}

class ZipReader {
  constructor(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new ZipError('buffer required', 'BAD_BUFFER');
    this.buf = buffer;
    this.entries = [];
    this._readCentralDirectory();
  }

  _readCentralDirectory() {
    const buf = this.buf;
    const eocd = findEocd(buf);
    let total = buf.readUInt16LE(eocd + 10);
    let cdSize = buf.readUInt32LE(eocd + 12);
    let cdOffset = buf.readUInt32LE(eocd + 16);

    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const z = readZip64(buf, eocd);
      total = z.totalEntries;
      cdSize = z.cdSize;
      cdOffset = z.cdOffset;
    }

    if (!Number.isSafeInteger(total) || cdOffset < 0 || cdOffset + cdSize > buf.length) {
      throw new ZipError('Invalid central directory bounds', 'BAD_CD');
    }

    let p = cdOffset;
    for (let i = 0; i < total; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG.CENTRAL) {
        throw new ZipError(`Central directory entry ${i} has bad signature`, 'BAD_CEN');
      }
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const entry = {
        name: buf.toString('utf8', p + 46, p + 46 + nameLen),
        compression: buf.readUInt16LE(p + 10),
        compressedSize: buf.readUInt32LE(p + 20),
        uncompressedSize: buf.readUInt32LE(p + 24),
        localHeaderOffset: buf.readUInt32LE(p + 42)
      };
      if (
        entry.compressedSize === 0xffffffff ||
        entry.uncompressedSize === 0xffffffff ||
        entry.localHeaderOffset === 0xffffffff
      ) {
        parseZip64Extra(buf.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen), entry);
      }
      if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize)) {
        throw new ZipError('ZIP64 entry size is not a safe integer', 'ZIP64_OVERFLOW');
      }
      this.entries.push(entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  readEntry(entry, maxOutputBytes = 8 * 1024 * 1024) {
    const buf = this.buf;
    const off = entry.localHeaderOffset;
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== SIG.LOCAL) {
      throw new ZipError(`Bad local header: ${entry.name}`, 'BAD_LOC');
    }
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const start = off + 30 + nameLen + extraLen;
    const end = start + entry.compressedSize;
    if (start < 0 || end > buf.length) {
      throw new ZipError(`Truncated data for ${entry.name}`, 'TRUNCATED');
    }
    if (entry.uncompressedSize > maxOutputBytes) {
      throw new ZipError(`Entry too large (${entry.uncompressedSize} bytes): ${entry.name}`, 'ENTRY_TOO_LARGE');
    }
    const raw = buf.slice(start, end);
    if (entry.compression === 0) return raw;
    if (entry.compression === 8) {
      const out = zlib.inflateRawSync(raw, { maxOutputLength: maxOutputBytes });
      if (out.length !== entry.uncompressedSize) {
        throw new ZipError(`Size mismatch for ${entry.name}`, 'SIZE_MISMATCH');
      }
      return out;
    }
    throw new ZipError(`Unsupported compression ${entry.compression}: ${entry.name}`, 'UNSUPPORTED_COMPRESSION');
  }

  // filter(name) decides whether an entry should be read; onEntry gets the bytes.
  forEachEntry({ filter, onEntry, maxEntries = Infinity, maxOutputBytes = 8 * 1024 * 1024 } = {}) {
    const stats = { total: this.entries.length, read: 0, filtered: 0, truncated: false, warnings: [] };
    for (const entry of this.entries) {
      if (entry.name.endsWith('/')) continue;
      if (stats.read >= maxEntries) { stats.truncated = true; break; }
      if (filter && !filter(entry)) { stats.filtered++; continue; }
      try {
        onEntry(entry, this.readEntry(entry, maxOutputBytes));
        stats.read++;
      } catch (err) {
        stats.warnings.push(`${entry.name}: ${err.message}`);
      }
    }
    return stats;
  }
}

module.exports = { ZipReader, ZipError };
