'use strict';

const fs = require('fs');
const path = require('path');
const { ZipReader } = require('./zipReader');
const { parseClassFile, asStrings } = require('./classFile');
const { classify } = require('./annotations');

const DEFAULT_EXCLUDES = [
  'java/', 'javax/', 'jdk/', 'kotlin/', 'scala/', 'io/cucumber/', 'cucumber/api/',
  'org/apache/', 'com/fasterxml/', 'org/springframework/', 'io/netty/', 'ch/qos/', 'org/slf4j/'
];

const FAST_MARKERS = [
  Buffer.from('io/cucumber/java/'),
  Buffer.from('cucumber/api/java/')
];

function isExcludedEntry(name, excludes) {
  for (const prefix of excludes || DEFAULT_EXCLUDES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

function hasGlueMarker(bytes, extraPrefixes) {
  for (const marker of FAST_MARKERS) if (bytes.indexOf(marker) >= 0) return true;
  for (const prefix of extraPrefixes || []) {
    if (bytes.indexOf(Buffer.from(String(prefix).replace(/^\//, '').replace(/\.$/, '') + '/')) >= 0) return true;
  }
  return false;
}

function makeId(ctx, methodName, descriptor, type, pattern, index) {
  return [
    ctx.jarPath, ctx.entryName, methodName || '<clinit>', descriptor || '',
    type, index, pattern || ''
  ].join('#');
}

function collectAnnotations(annotations, ctx, member) {
  for (let annIndex = 0; annIndex < annotations.length; annIndex++) {
    const ann = annotations[annIndex];
    const info = classify(ann.type, ctx.extraPrefixes);
    if (!info) continue;
    const values = asStrings(ann.elements.value);

    if (info.kind === 'ParameterType') {
      const regexps = asStrings(ann.elements.regexp);
      const name = values[0];
      const regexp = regexps[0];
      if (name && regexp) {
        ctx.customTypes.set(name, regexp.replace(/^\^/, '').replace(/\$$/, ''));
      }
      continue;
    }

    if (info.kind === 'step' && values.length === 0) {
      ctx.warnings.push(`${ctx.entryName}: ${member.name} has ${ann.type} without a value`);
      continue;
    }

    const patterns = info.kind === 'step' ? values : [];
    const list = patterns.length ? patterns : [undefined];
    for (let i = 0; i < list.length; i++) {
      const pattern = list[i];
      ctx.definitions.push({
        id: makeId(ctx, member.name, member.descriptor, ann.type, pattern, `${annIndex}-${i}`),
        source: 'jar',
        jarPath: ctx.jarPath,
        entryName: ctx.entryName,
        className: ctx.className,
        methodName: member.name,
        descriptor: member.descriptor,
        kind: info.kind,
        annotation: ann.type,
        language: info.language,
        keyword: info.keyword,
        hook: info.hook,
        version: info.version,
        patterns: pattern === undefined ? [] : [pattern],
        tags: info.kind === 'hook' ? asStrings(ann.elements.value) : []
      });
    }
  }
}

function extractGlueFromClass(bytes, ctx) {
  const parsed = parseClassFile(bytes);
  ctx.className = parsed.className || ctx.entryName.replace(/\.class$/, '').replace(/\//g, '.');
  if (parsed.major > 70) {
    ctx.warnings.push(`${ctx.entryName}: class file major version ${parsed.major} is newer than known JVM specs; metadata parsed anyway`);
  }
  collectAnnotations(parsed.annotations, ctx, { name: '<class>', descriptor: '' });
  for (const method of parsed.methods) {
    if (!method.annotations.length) continue;
    collectAnnotations(method.annotations, ctx, method);
  }
  return parsed;
}

async function scanJar(jarPath, options = {}) {
  const maxJarBytes = (options.maxJarSizeMb || 80) * 1024 * 1024;
  const maxEntryBytes = (options.maxEntrySizeMb || 8) * 1024 * 1024;
  const stat = await fs.promises.stat(jarPath);
  if (!stat.isFile()) throw new Error(`Not a file: ${jarPath}`);
  if (stat.size > maxJarBytes) {
    return {
      jarPath,
      identity: { size: stat.size, mtimeMs: stat.mtimeMs },
      skipped: true,
      reason: `JAR is ${(stat.size / 1048576).toFixed(1)} MB (limit ${options.maxJarSizeMb || 80} MB)`,
      definitions: [], customTypes: {}, warnings: [], stats: {}
    };
  }

  const bytes = await fs.promises.readFile(jarPath);
  const zip = new ZipReader(bytes);
  const ctx = {
    jarPath,
    entryName: '',
    className: '',
    extraPrefixes: options.extraAnnotationPrefixes || [],
    definitions: [],
    customTypes: new Map(),
    warnings: []
  };
  const excludes = options.excludePackages || DEFAULT_EXCLUDES;

  const stats = zip.forEachEntry({
    filter: entry => {
      if (options.shouldCancel && options.shouldCancel()) {
        const err = new Error('Scan cancelled');
        err.code = 'CANCELLED';
        throw err;
      }
      return entry.name.endsWith('.class') && !isExcludedEntry(entry.name, excludes);
    },
    maxEntries: options.maxClassEntriesPerJar || 8000,
    maxOutputBytes: maxEntryBytes,
    onEntry: (entry, data) => {
      ctx.entryName = entry.name;
      if (!hasGlueMarker(data, ctx.extraPrefixes)) return;
      try {
        extractGlueFromClass(data, ctx);
      } catch (err) {
        ctx.warnings.push(`${entry.name}: ${err.message}`);
      }
    }
  });

  if (stats.truncated) {
    ctx.warnings.push(`Only the first ${stats.read} class entries were scanned (limit reached)`);
  }
  ctx.warnings.push(...stats.warnings.slice(0, 20));

  return {
    jarPath,
    identity: { size: stat.size, mtimeMs: stat.mtimeMs },
    skipped: false,
    definitions: ctx.definitions,
    customTypes: Object.fromEntries(ctx.customTypes),
    warnings: ctx.warnings,
    stats: { totalEntries: stats.total, readEntries: stats.read, filtered: stats.filtered }
  };
}

function jarDisplayName(jarPath) {
  return path.basename(jarPath);
}

module.exports = { scanJar, extractGlueFromClass, isExcludedEntry, DEFAULT_EXCLUDES, jarDisplayName };
