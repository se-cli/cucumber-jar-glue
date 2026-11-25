'use strict';

// Java .class parser: constant pool + RuntimeVisible/InvisibleAnnotations.
// Deliberately does not parse method bodies: glue indexing only needs metadata.

class Reader {
  constructor(buf) {
    this.b = buf;
    this.p = 0;
  }
  need(n) {
    if (this.p + n > this.b.length) throw new Error(`Unexpected end of class file at ${this.p}`);
  }
  u1() { this.need(1); return this.b[this.p++]; }
  u2() { this.need(2); const v = this.b.readUInt16BE(this.p); this.p += 2; return v; }
  u4() { this.need(4); const v = this.b.readUInt32BE(this.p); this.p += 4; return v; }
  bytes(n) { this.need(n); const v = this.b.slice(this.p, this.p + n); this.p += n; return v; }
  skip(n) { this.need(n); this.p += n; }
}

// Java's modified UTF-8: 1-byte ASCII, 2-byte for NUL and U+0001..U+07FF,
// 3-byte for U+0800..U+FFFF (surrogate pairs are two 3-byte sequences).
function decodeModifiedUtf8(buf) {
  let out = '';
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b >= 0x01 && b <= 0x7f) { out += String.fromCharCode(b); i++; continue; }
    if (b === 0x00) { out += '\0'; i++; continue; }
    if ((b & 0xe0) === 0xc0 && i + 1 < buf.length) {
      const b2 = buf[i + 1];
      if ((b2 & 0xc0) !== 0x80) throw new Error('Invalid 2-byte modified UTF-8 sequence');
      out += String.fromCharCode(((b & 0x1f) << 6) | (b2 & 0x3f));
      i += 2;
      continue;
    }
    if ((b & 0xf0) === 0xe0 && i + 2 < buf.length) {
      const b2 = buf[i + 1];
      const b3 = buf[i + 2];
      if ((b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) throw new Error('Invalid 3-byte modified UTF-8 sequence');
      out += String.fromCharCode(((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
      i += 3;
      continue;
    }
    throw new Error(`Invalid modified UTF-8 byte 0x${b.toString(16)}`);
  }
  return out;
}

function readConstantPool(r) {
  const count = r.u2();
  const cp = new Array(count);
  for (let i = 1; i < count; i++) {
    const tag = r.u1();
    switch (tag) {
      case 1: { const len = r.u2(); cp[i] = { tag, value: decodeModifiedUtf8(r.bytes(len)) }; break; }
      case 3: cp[i] = { tag, value: r.b.readInt32BE(r.p), raw: r.bytes(4) }; break;
      case 4: cp[i] = { tag, value: r.b.readFloatBE(r.p), raw: r.bytes(4) }; break;
      case 5: cp[i] = { tag, value: Number(r.b.readBigInt64BE(r.p)), raw: r.bytes(8) }; i++; break;
      case 6: cp[i] = { tag, value: r.b.readDoubleBE(r.p), raw: r.bytes(8) }; i++; break;
      case 7: case 8: case 16: case 19: case 20: cp[i] = { tag, value: r.u2() }; break;
      case 9: case 10: case 11: case 12: case 17: case 18: cp[i] = { tag, value: [r.u2(), r.u2()] }; break;
      case 15: cp[i] = { tag, value: [r.u1(), r.u2()] }; break;
      default: throw new Error(`Unknown constant pool tag ${tag} at index ${i}`);
    }
  }
  return cp;
}

function utf8(cp, index) {
  const e = cp[index];
  if (!e || e.tag !== 1) return undefined;
  return e.value;
}

function className(cp, index) {
  const e = cp[index];
  if (!e || e.tag !== 7) return undefined;
  return utf8(cp, e.value);
}

function readElementValue(r, cp) {
  const tag = String.fromCharCode(r.u1());
  switch (tag) {
    case 'B': case 'C': case 'I': case 'S': case 'Z': {
      const e = cp[r.u2()];
      return e && e.tag === 3 ? e.value : undefined;
    }
    case 'J': case 'D': case 'F': {
      const e = cp[r.u2()];
      return e ? e.value : undefined;
    }
    case 's': return utf8(cp, r.u2());
    case 'e': return { enumType: utf8(cp, r.u2()), enumName: utf8(cp, r.u2()) };
    case 'c': {
      const idx = r.u2();
      return { classDescriptor: utf8(cp, idx) };
    }
    case '@': return readAnnotation(r, cp);
    case '[': {
      const n = r.u2();
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(readElementValue(r, cp));
      return arr;
    }
    default: throw new Error(`Unknown annotation element tag '${tag}'`);
  }
}

function readAnnotation(r, cp) {
  const type = utf8(cp, r.u2());
  const pairCount = r.u2();
  const elements = Object.create(null);
  for (let i = 0; i < pairCount; i++) {
    const name = utf8(cp, r.u2());
    elements[name] = readElementValue(r, cp);
  }
  return { type, elements };
}

function parseAnnotations(bytes, cp) {
  if (!bytes) return [];
  const r = new Reader(bytes);
  const count = r.u2();
  const out = [];
  for (let i = 0; i < count; i++) out.push(readAnnotation(r, cp));
  return out;
}

function readMember(r, cp) {
  const accessFlags = r.u2();
  const name = utf8(cp, r.u2());
  const descriptor = utf8(cp, r.u2());
  const attrCount = r.u2();
  const attributes = Object.create(null);
  for (let i = 0; i < attrCount; i++) {
    const attrName = utf8(cp, r.u2());
    const len = r.u4();
    attributes[attrName] = r.bytes(len);
  }
  return { accessFlags, name, descriptor, attributes };
}

function parseClassFile(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('buffer required');
  if (buffer.length < 10 || buffer.readUInt32BE(0) !== 0xcafebabe) throw new Error('Not a Java class file');
  const r = new Reader(buffer);
  r.skip(4);
  const minor = r.u2();
  const major = r.u2();
  const cp = readConstantPool(r);
  r.u2(); // access_flags
  const thisClass = className(cp, r.u2());
  const superClassIndex = r.u2();
  const superClass = superClassIndex === 0 ? undefined : className(cp, superClassIndex);
  const ifaceCount = r.u2();
  r.skip(ifaceCount * 2);

  const fieldCount = r.u2();
  for (let i = 0; i < fieldCount; i++) readMember(r, cp);

  const methods = [];
  const methodCount = r.u2();
  for (let i = 0; i < methodCount; i++) methods.push(readMember(r, cp));

  const classAttributes = Object.create(null);
  const attrCount = r.u2();
  for (let i = 0; i < attrCount; i++) {
    const name = utf8(cp, r.u2());
    const len = r.u4();
    classAttributes[name] = r.bytes(len);
  }

  return {
    minor,
    major,
    className: thisClass,
    superClass,
    methods: methods.map(m => ({
      name: m.name,
      descriptor: m.descriptor,
      accessFlags: m.accessFlags,
      annotations: [
        ...parseAnnotations(m.attributes.RuntimeVisibleAnnotations, cp),
        ...parseAnnotations(m.attributes.RuntimeInvisibleAnnotations, cp)
      ]
    })),
    annotations: [
      ...parseAnnotations(classAttributes.RuntimeVisibleAnnotations, cp),
      ...parseAnnotations(classAttributes.RuntimeInvisibleAnnotations, cp)
    ]
  };
}

function asStrings(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(asStrings);
  if (typeof value === 'string') return [value];
  return [];
}

module.exports = { parseClassFile, decodeModifiedUtf8, asStrings };
