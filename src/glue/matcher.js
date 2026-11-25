'use strict';

// Lightweight Gherkin step parsing + Cucumber Expression / Java regex matching.
// This is intentionally a index-level matcher, not a full Cucumber runtime:
// built-in parameter types and discovered ParameterType annotations are
// supported; runtime argument transformation is not.

const STEP_KEYWORDS = [
  ['假如', '假设', '假定', '当', '那么', '则', '而且', '并且', '但是', '同时'],
  ['Given', 'When', 'Then', 'And', 'But'],
  ['Soit', 'Quand', 'Alors', 'Et', 'Mais'],
  ['Angenommen', 'Wenn', 'Dann', 'Und', 'Aber'],
  ['Dado', 'Dada', 'Cuando', 'Entonces', 'Y', 'Pero'],
  ['もし', 'ならば', 'かつ', 'しかし'],
  ['Допустим', 'Дано', 'Когда', 'Тогда', 'И', 'Но']
];

const ALL_KEYWORDS = ['*', ...STEP_KEYWORDS.flat()].sort((a, b) => b.length - a.length);

const BUILTIN_TYPES = {
  '': '.*?',
  int: '[+-]?\\d+',
  integer: '[+-]?\\d+',
  float: '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)',
  double: '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)',
  bigdecimal: '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)',
  biginteger: '[+-]?\\d+',
  word: '[^\\s]+',
  string: '(?:"[^"]*"|\'[^\']*\')'
};

function stepTextFromLine(line) {
  const raw = String(line || '');
  const trimmed = raw.trimStart();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) return undefined;
  const indent = raw.length - trimmed.length;
  for (const kw of ALL_KEYWORDS) {
    if (!trimmed.startsWith(kw)) continue;
    const after = trimmed.slice(kw.length);
    const asciiKeyword = /^[\x20-\x7e]+$/.test(kw);
    // CJK keywords are commonly written without a following space.
    if (kw !== '*' && asciiKeyword && after && !/^\s/.test(after)) continue;
    const text = after.replace(/^\s+/, '').replace(/\s+$/, '');
    return {
      keyword: kw,
      text,
      textStart: indent + kw.length + (after.length - after.replace(/^\s+/, '').length)
    };
  }
  return undefined;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findClosingParen(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function typeRegex(name, customTypes) {
  const key = String(name || '').trim();
  if (Object.prototype.hasOwnProperty.call(BUILTIN_TYPES, key)) return BUILTIN_TYPES[key];
  if (customTypes && customTypes.has && customTypes.has(key)) return customTypes.get(key);
  if (customTypes && Object.prototype.hasOwnProperty.call(customTypes, key)) return customTypes[key];
  return '[^\\s]+';
}

function renderPart(part, customTypes) {
  switch (part.type) {
    case 'literal': return escapeRegExp(part.value);
    case 'group': return `(?:${part.alts.map(a => escapeRegExp(a)).join('|')})`;
    case 'param': return `(?:${typeRegex(part.name, customTypes)})`;
    case 'optional': return `(?:${renderPart(part.token, customTypes)})?`;
    default: return '';
  }
}

// Converts the common Cucumber Expression subset: {type}, {}, (a|b), word?,
// backslash escapes. Regex anchors are handled by the caller.
function compileExpression(expr, customTypes) {
  const parts = [];
  let literal = '';
  const flush = () => { if (literal) { parts.push({ type: 'literal', value: literal }); literal = ''; } };

  for (let i = 0; i < expr.length;) {
    const ch = expr[i];
    if (ch === '\\' && i + 1 < expr.length) { literal += expr[i + 1]; i += 2; continue; }
    if (ch === '{') {
      const end = expr.indexOf('}', i + 1);
      if (end < 0) { literal += ch; i++; continue; }
      flush();
      parts.push({ type: 'param', name: expr.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch === '(') {
      const close = findClosingParen(expr, i);
      if (close < 0) { literal += ch; i++; continue; }
      flush();
      parts.push({ type: 'group', alts: expr.slice(i + 1, close).split('|').map(a => a.trim()) });
      i = close + 1;
      continue;
    }
    if (ch === '?') {
      const m = literal.match(/([^\s]+)$/);
      if (m) {
        literal = literal.slice(0, literal.length - m[1].length);
        parts.push({ type: 'optional', token: { type: 'literal', value: m[1] } });
      } else if (parts.length) {
        parts.push({ type: 'optional', token: parts.pop() });
      }
      i++;
      continue;
    }
    literal += ch;
    i++;
  }
  flush();
  return parts.map(p => renderPart(p, customTypes)).join('');
}

function looksUnsafe(pattern) {
  if (!pattern || pattern.length > 512) return true;
  // Reject obvious nested-quantifier shapes that can hang the extension host.
  if (/(\([^)]*[+*][^)]*\))[+*{]/.test(pattern)) return true;
  if (/\(\.\*\)[*+]/.test(pattern) || /\(\.\+\)[*+]/.test(pattern)) return true;
  return false;
}

function compilePatterns(pattern, customTypes) {
  if (looksUnsafe(pattern)) return [];
  const out = [];
  const seen = new Set();
  const add = (source, mode, bonus) => {
    if (seen.has(source)) return;
    seen.add(source);
    try { out.push({ regex: new RegExp(source), source, mode, bonus }); } catch (_) { /* invalid pattern */ }
  };

  const exprSource = `^${compileExpression(pattern, customTypes)}$`;
  add(exprSource, 'expression', 20);

  if (pattern.startsWith('^') && pattern.endsWith('$') && pattern.length > 2) {
    add(pattern, 'regex', 0);
  } else if (/[\\\[\]|]|\\[dwsDWS]|\^|\$/.test(pattern)) {
    add(`^${pattern}$`, 'regex', 0);
  }
  return out;
}

function literalWeight(pattern) {
  const cleaned = pattern.replace(/\{[^}]*\}/g, '');
  const matches = cleaned.match(/[\p{L}\p{N} ]/gu);
  return matches ? matches.length : 0;
}

function parameterCount(pattern) {
  return (pattern.match(/\{[^}]*\}/g) || []).length;
}

// Returns matches sorted by descending specificity, at most one per definition.
function matchSteps(stepText, definitions, customTypes) {
  const text = String(stepText || '').trim();
  if (!text) return [];
  const found = [];
  const bestByDef = new Map();

  for (const def of definitions || []) {
    if (def.kind !== 'step' || !def.patterns || !def.patterns.length) continue;
    for (const pattern of def.patterns) {
      for (const compiled of compilePatterns(pattern, customTypes)) {
        if (!compiled.regex.test(text)) continue;
        const score = 100 + literalWeight(pattern) * 4 - parameterCount(pattern) * 12 + compiled.bonus;
        const candidate = {
          definition: def,
          pattern,
          score,
          mode: compiled.mode,
          regex: compiled.source
        };
        const prev = bestByDef.get(def.id);
        if (!prev || score > prev.score) bestByDef.set(def.id, candidate);
        break;
      }
    }
  }
  for (const value of bestByDef.values()) found.push(value);
  found.sort((a, b) => b.score - a.score || a.definition.id.localeCompare(b.definition.id));
  return found;
}

module.exports = {
  STEP_KEYWORDS,
  BUILTIN_TYPES,
  stepTextFromLine,
  compileExpression,
  compilePatterns,
  matchSteps,
  escapeRegExp
};
