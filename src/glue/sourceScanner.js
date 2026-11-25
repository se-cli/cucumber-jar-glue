'use strict';

const vscode = require('vscode');
const fs = require('fs');
const { classify, descriptorFromQualifiedName, HOOKS, META } = require('./annotations');
const { STEP_KEYWORDS } = require('./matcher');

const KNOWN_STEP_KEYWORDS = new Set(STEP_KEYWORDS.flat());

// Keep refreshes, explicit scans and file watchers on the same rule set.
// Historical run snapshots (e.g. .local-state/temporal/runs/) contain copies
// of glue sources and would otherwise create duplicate definitions.
const IGNORED_DIRS = [
  'target', 'build', 'out', '.gradle', '.local-state',
  'node_modules', '.git', '.idea', '.vscode', 'bin'
];
const SOURCE_EXCLUDE_GLOB = `**/{${IGNORED_DIRS.join(',')}}/**`;

function isIgnoredPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return normalized.split('/').some(segment => IGNORED_DIRS.includes(segment));
}

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

const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super', 'this',
  'try', 'do', 'else', 'case', 'throw', 'assert', 'instanceof'
]);

function skipQuoted(text, i, limit) {
  const ch = text[i];
  if (ch === '"' && text.slice(i, i + 3) === '"""') {
    i += 3;
    while (i < limit && text.slice(i, i + 3) !== '"""') i++;
    return Math.min(i + 3, limit);
  }
  i++;
  while (i < limit) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === ch) return i + 1;
    i++;
  }
  return i;
}

function skipComment(text, i, limit) {
  if (text[i] === '/' && text[i + 1] === '/') {
    i += 2;
    while (i < limit && text[i] !== '\n') i++;
    return i;
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    i += 2;
    while (i < limit && !(text[i] === '*' && text[i + 1] === '/')) i++;
    return Math.min(i + 2, limit);
  }
  return i;
}

// Consume @Name(...) including nested parentheses, strings and comments.
function skipAnnotation(text, i, limit) {
  i++;
  while (i < limit && /[\w.$]/.test(text[i])) i++;
  while (i < limit && /\s/.test(text[i])) i++;
  if (text[i] !== '(') return i;
  let depth = 0;
  while (i < limit) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(text, i, limit); continue; }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipComment(text, i, limit);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      i++;
      if (depth === 0) break;
      continue;
    }
    i++;
  }
  return i;
}

function balancedEnd(text, open, limit) {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(text, i, limit) - 1; continue; }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipComment(text, i, limit) - 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function splitTopLevel(text, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(text, i, text.length) - 1; continue; }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipComment(text, i, text.length) - 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter(part => part.trim());
}

function descriptorFromParams(params) {
  const count = splitTopLevel(params, ',').length;
  return `(${Array(count).fill('Ljava/lang/Object;').join('')})V`;
}

// Lexical scan from the end of a glue annotation to the following method
// declaration. Annotations and parameter annotations may contain nested
// parentheses; control-flow statements inside the body must never be mistaken
// for the method name.
function methodAfter(text, offset) {
  const limit = Math.min(text.length, offset + 4000);
  let i = offset;
  let token = '';
  while (i < limit) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(text, i, limit); token = ''; continue; }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipComment(text, i, limit);
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '@') { i = skipAnnotation(text, i, limit); token = ''; continue; }
    if (ch === ';' || ch === '{' || ch === '}') break;
    if (ch === '(') {
      const name = token;
      if (!name || CONTROL_KEYWORDS.has(name)) { i++; token = ''; continue; }
      const end = balancedEnd(text, i, limit);
      if (end < 0) break;
      const params = text.slice(i + 1, end - 1);
      let j = end;
      while (j < limit && /\s/.test(text[j])) j++;
      if (text.slice(j, j + 6) === 'throws') {
        j += 6;
        while (j < limit && text[j] !== '{' && text[j] !== ';') j++;
      }
      while (j < limit && /\s/.test(text[j])) j++;
      if (text[j] !== '{' && text[j] !== ';') { i = end; token = ''; continue; }
      return { name, descriptor: descriptorFromParams(params), offset: offset + i };
    }
    if (/[A-Za-z_$0-9]/.test(ch)) {
      let j = i;
      while (j < limit && /[\w$]/.test(text[j])) j++;
      token = text.slice(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return { name: '<unknown>', descriptor: '', offset };
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
  const uris = await vscode.workspace.findFiles(pattern, SOURCE_EXCLUDE_GLOB, 20000);
  const definitions = [];
  const customTypes = new Map();
  const warnings = [];
  let files = 0;
  for (const uri of uris) {
    if (token && token.isCancellationRequested) break;
    if (isIgnoredPath(uri.fsPath)) continue;
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

module.exports = {
  scanJavaSource, annotationCalls, stringValues, resolveAnnotation,
  scanWorkspaceSources, SOURCE_EXCLUDE_GLOB, isIgnoredPath
};
