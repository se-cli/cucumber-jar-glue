'use strict';

const zlib = require('zlib');

function u1(n) { const b = Buffer.alloc(1); b.writeUInt8(n & 0xff, 0); return b; }
function u2(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff, 0); return b; }
function u4(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function u2le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; }
function u4le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function cat(...parts) { return Buffer.concat(parts.flat()); }

function encodeMutf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0x01 && c <= 0x7f) out.push(c);
    else if (c <= 0x7ff) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(out);
}

class ConstPool {
  constructor() { this.items = []; this.map = new Map(); }
  _add(key, entry, slots = 1) {
    if (this.map.has(key)) return this.map.get(key);
    const index = this.items.length + 1;
    this.items.push(entry);
    for (let i = 1; i < slots; i++) this.items.push(null);
    this.map.set(key, index);
    return index;
  }
  utf8(value) {
    return this._add(`u:${value}`, { tag: 1, value: encodeMutf8(value) });
  }
  classRef(name) {
    const nameIndex = this.utf8(name);
    return this._add(`c:${name}`, { tag: 7, nameIndex });
  }
  serialize() {
    const parts = [u2(this.items.length + 1)];
    for (const item of this.items) {
      if (!item) continue;
      if (item.tag === 1) parts.push(u1(1), u2(item.value.length), item.value);
      else if (item.tag === 7) parts.push(u1(7), u2(item.nameIndex));
    }
    return cat(parts);
  }
}

function elementValueBytes(cp, value) {
  if (Array.isArray(value)) {
    return cat(u1('['.charCodeAt(0)), u2(value.length), ...value.map(v => elementValueBytes(cp, v)));
  }
  return cat(u1('s'.charCodeAt(0)), u2(cp.utf8(String(value))));
}

function annotationBytes(cp, annotations) {
  const parts = [u2(annotations.length)];
  for (const ann of annotations) {
    parts.push(u2(cp.utf8(ann.descriptor)));
    const pairs = ann.elements
      ? Object.entries(ann.elements)
      : (ann.value === undefined || ann.value === null ? [] : [['value', ann.value]]);
    parts.push(u2(pairs.length));
    for (const [name, value] of pairs) {
      parts.push(u2(cp.utf8(name)), elementValueBytes(cp, value));
    }
  }
  return cat(parts);
}

function attributesBytes(cp, attributes) {
  const parts = [u2(attributes.length)];
  for (const attr of attributes) {
    parts.push(u2(cp.utf8(attr.name)), u4(attr.body.length), attr.body);
  }
  return cat(parts);
}

function buildClassFile({ className = 'com/acme/Glue', methods = [], classAnnotations = [] } = {}) {
  const cp = new ConstPool();
  const thisClass = cp.classRef(className);
  const superClass = cp.classRef('java/lang/Object');

  const memberData = [];
  for (const method of methods) {
    const annotations = method.annotations || [];
    const attrs = annotations.length
      ? [{ name: 'RuntimeVisibleAnnotations', body: annotationBytes(cp, annotations) }]
      : [];
    // Reserve UTF8 constants before serialization; indexes are stable.
    const nameIndex = cp.utf8(method.name);
    const descIndex = cp.utf8(method.descriptor || '()V');
    for (const attr of attrs) cp.utf8(attr.name);
    memberData.push(cat(u2(0x0001), u2(nameIndex), u2(descIndex), attributesBytes(cp, attrs)));
  }

  const classAttrs = classAnnotations.length
    ? [{ name: 'RuntimeVisibleAnnotations', body: annotationBytes(cp, classAnnotations) }]
    : [];
  for (const attr of classAttrs) cp.utf8(attr.name);

  return cat(
    u4(0xcafebabe), u2(0), u2(61),
    cp.serialize(),
    u2(0x0021), u2(thisClass), u2(superClass), u2(0),
    u2(0),
    u2(memberData.length), ...memberData,
    attributesBytes(cp, classAttrs)
  );
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildJar(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.compression === 8 ? 8 : 0;
    const raw = entry.data;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = cat(
      u4le(0x04034b50), u2le(20), u2le(0), u2le(method), u2le(0), u2le(0),
      u4le(crc), u4le(data.length), u4le(raw.length), u2le(name.length), u2le(0), name, data
    );
    const central = cat(
      u4le(0x02014b50), u2le(20), u2le(20), u2le(0), u2le(method), u2le(0), u2le(0),
      u4le(crc), u4le(data.length), u4le(raw.length),
      u2le(name.length), u2le(0), u2le(0), u2le(0), u2le(0), u4le(0), u4le(offset), name
    );
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = cat(centrals);
  const eocd = cat(
    u4le(0x06054b50), u2le(0), u2le(0), u2le(entries.length), u2le(entries.length),
    u4le(cd.length), u4le(offset), u2le(0)
  );
  return cat(...locals, cd, eocd);
}

module.exports = { buildClassFile, buildJar, encodeMutf8, u1, u2, u4, cat };
