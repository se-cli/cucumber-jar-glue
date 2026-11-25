'use strict';

const vscode = require('vscode');
const fs = require('fs');
const { classify, descriptorFromQualifiedName, HOOKS, META } = require('./annotations');
const { STEP_KEYWORDS } = require('./matcher');

const KNOWN_STEP_KEYWORDS = new Set(STEP_KEYWORDS.flat());

function unescapeJavaString(body) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, g) => {
    if (g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[g] !== undefined
      ? ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[g]
      : g;
  });
}

function stringValues(args) {
  const values = [];
  const re = /"(?:\\.|[^"\\])*"/g;
  let m;
  while ((m = re.exec(args))) values.push(unescapeJavaString(m[0].slice(1, -1)));
  return values;
}

function annotationCalls(text) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf('@', i)) >= 0) {
    let j = i + 1;
    while (j < text.length && /[\w.$]/.test(text[j])) j++;
    const name = text.slice(i + 1, j);
    if (!name || !/^[A-Za-z_$]/.test(name)) { i = Math.max(j, i + 1); continue; }
    let k = j;
    while (k < text.length && /\s/.test(text[k]) && text[k] !== '\n') k++;
    let args = '';
    let end = j;
    if (text[k] === '(') {
      let depth = 0;
      let quote = false;
      let escaped = false;
      for (let p = k; p < text.length; p++) {
        const ch = text[p];
        if (quote) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') quote = false;
          continue;
        }
        if (ch === '"') { quote = true; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) { args = text.slice(k + 1, p); end = p + 1; break; }
        }
      }
    }
    out.push({ name, args, start: i, end });
    i = Math.max(end, j, i + 1);
  }
  return out;
}

function importsOf(text) {
  const map = new Map();
  const re = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm;
  let m;
  while ((m = re.exec(text))) {
    const value = m[1];
    if (value.endsWith('.*')) {
      map.set('*', [...(map.get('*') || []), value.replace(/\.\*$/, '')]);
      continue;
    }
    const parts = value.split('.');
    map.set(parts[parts.length - 1], value);
  }
  return map;
}

function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function resolveAnnotation(name, imports, extraPrefixes) {
  const candidates = [];
  const hookOrMeta = HOOKS.has(name) || META.has(name);

  if (name.includes('.')) candidates.push(name);
  else if (!hookOrMeta && !KNOWN_STEP_KEYWORDS.has(name) && !imports.has(name) && !imports.has('*')) {
    // Do not turn arbitrary annotations such as @Override into step definitions.
    return undefined;
  }

  if (imports.has(name)) candidates.push(imports.get(name));
  for (const prefix of imports.get('*') || []) {
    if (hookOrMeta && prefix !== 'io.cucumber.java' && prefix !== 'cucumber.api.java') continue;
    candidates.push(`${prefix}.${name}`);
  }
  if (!name.includes('.') && hookOrMeta) {
    candidates.push(`io.cucumber.java.${name}`, `cucumber.api.java.${name}`);
  } else if (!name.includes('.')) {
    candidates.push(`io.cucumber.java.en.${name}`, `cucumber.api.java.en.${name}`);
  }

  for (const candidate of candidates) {
    const info = classify(descriptorFromQualifiedName(candidate), extraPrefixes);
    if (info) return info;
  }
  return undefined;
}

function methodAfter(text, offset) {
  const tail = text.slice(offset, offset + 1200);
  const m = /(?:\b(?:public|private|protected|static|final|synchronized|default)\s+)*[\w.<>\[\],?\s]+\s+([A-Za-z_$][\w$]*)\s*\([^;{)]*\)\s*(?:throws\s+[\w.,\s]+)?\{/.exec(tail);
  if (!m) return { name: '<unknown>', descriptor: '', offset };
  const paren = tail.indexOf('(', m.index);
  let depth = 0;
  let end = paren;
  for (; end < tail.length; end++) {
    if (tail[end] === '(') depth++;
    else if (tail[end] === ')') { depth--; if (depth === 0) { end++; break; } }
  }
  const params = tail.slice(paren + 1, end - 1).replace(/\s+/g, '');
  const descriptor = `(${params.split(',').filter(Boolean).map(() => 'Ljava/lang/Object;').join('')})V`;
  return { name: m[1], descriptor, offset: offset + paren };
}

function scanJavaSource(filePath, uri, options = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const imports = importsOf(text);
  const definitions = [];
  const customTypes = new Map();
  const warnings = [];
  const className = (text.match(/\b(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)/) || [])[1] || filePath;
  const calls = annotationCalls(text);

  for (const call of calls) {
    const info = resolveAnnotation(call.name, imports, options.extraAnnotationPrefixes);
    if (!info) continue;
    const values = stringValues(call.args);
    if (info.kind === 'ParameterType') {
      if (values.length >= 2) customTypes.set(values[0], values[1].replace(/^\^/, '').replace(/\$$/, ''));
      continue;
    }
    const method = methodAfter(text, call.end);
    if (info.kind === 'step' && !values.length) {
      warnings.push(`${filePath}:${lineAt(text, call.start)} empty step annotation`);
      continue;
    }
    const patterns = info.kind === 'step' ? values : [];
    const list = patterns.length ? patterns : [undefined];
    for (let i = 0; i < list.length; i++) {
      definitions.push({
        id: [uri.toString(), call.start, info.type, i, list[i] || ''].join('#'),
        source: 'source',
        uri: uri.toString(),
        fsPath: filePath,
        line: lineAt(text, call.start),
        character: call.start - (text.lastIndexOf('\n', call.start - 1) + 1),
        className,
        methodName: method.name,
        descriptor: method.descriptor,
        kind: info.kind,
        annotation: info.type,
        language: info.language,
        keyword: info.keyword,
        hook: info.hook,
        version: info.version,
        patterns: list[i] === undefined ? [] : [list[i]],
        tags: info.kind === 'hook' ? values : []
      });
    }
  }
  return { definitions, customTypes: Object.fromEntries(customTypes), warnings };
}

async function scanWorkspaceSources(folder, config, log, token) {
  const pattern = new vscode.RelativePattern(folder, '**/*.java');
  const uris = await vscode.workspace.findFiles(pattern, '**/{target,build,out,.gradle}/**', 20000);
  const definitions = [];
  const customTypes = new Map();
  const warnings = [];
  let files = 0;
  for (const uri of uris) {
    if (token && token.isCancellationRequested) break;
    try {
      const result = scanJavaSource(uri.fsPath, uri, config);
      definitions.push(...result.definitions);
      for (const [k, v] of Object.entries(result.customTypes)) customTypes.set(k, v);
      warnings.push(...result.warnings);
      files++;
    } catch (err) {
      warnings.push(`${uri.fsPath}: ${err.message}`);
    }
  }
  log.trace(`workspace source scan: ${files} java files, ${definitions.length} glue definitions`);
  return { definitions, customTypes, warnings, files };
}

module.exports = { scanJavaSource, annotationCalls, stringValues, resolveAnnotation, scanWorkspaceSources };
