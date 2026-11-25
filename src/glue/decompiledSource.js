'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ZipReader } = require('./zipReader');

const DECOMPILED_SCHEME = 'cucumber-glue-source';

// Words that can immediately precede a call but never a method declaration.
const NON_TYPE_KEYWORDS = new Set([
  'return', 'throw', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'catch', 'try', 'finally', 'new', 'assert', 'yield', 'await', 'instanceof',
  'synchronized', 'this', 'super', 'null', 'true', 'false', 'var'
]);

const PRIMITIVES = {
  B: 'byte', C: 'char', D: 'double', F: 'float',
  I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void'
};

// Parses "(Ljava/lang/String;J)V" into [{ name: 'String', dims: 0 }, ...].
// Returns null when the descriptor cannot be understood.
function descriptorParams(descriptor) {
  if (typeof descriptor !== 'string' || descriptor.charAt(0) !== '(') return null;
  const out = [];
  let i = 1;
  while (i < descriptor.length && descriptor.charAt(i) !== ')') {
    let dims = 0;
    while (descriptor.charAt(i) === '[') { dims++; i++; }
    const tag = descriptor.charAt(i);
    if (tag === 'L') {
      const end = descriptor.indexOf(';', i);
      if (end < 0) return null;
      const owner = descriptor.slice(i + 1, end).replace(/\//g, '.');
      out.push({ name: owner.split('.').filter(Boolean).pop() || '', dims });
      i = end + 1;
    } else if (PRIMITIVES[tag]) {
      out.push({ name: PRIMITIVES[tag], dims });
      i++;
    } else {
      return null;
    }
  }
  return descriptor.charAt(i) === ')' ? out : null;
}

function splitParams(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

// Reduces a parameter declaration to a comparable simple type name.
// "@NotNull final java.util.Map<String, Integer> args" -> "Map"
function paramTypeName(raw) {
  let s = String(raw)
    .replace(/@[\w$.]+(\s*\((?:[^()]|\([^()]*\))*\))?/g, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\bfinal\b/g, ' ')
    .replace(/\.\.\./g, '[]')
    .replace(/\s+/g, ' ')
    .trim();
  const segments = s.split(' ').filter(Boolean);
  if (segments.length > 1) segments.pop();
  const type = segments.join(' ').replace(/\s+/g, '');
  const isArray = /\[\]/.test(type);
  const simple = type.replace(/\[\]/g, '').split('.').filter(Boolean).pop() || '';
  return { name: simple, isArray };
}

function offsetToPosition(text, offset) {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

function declarationToken(text, nameStart) {
  const head = text.slice(0, nameStart);
  const match = /([\w$>\]\.]+)[ \t]+$/.exec(head);
  if (!match) return null;
  const token = match[1];
  if (/[>\]]$/.test(token)) return token;
  if (NON_TYPE_KEYWORDS.has(token)) return null;
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(token)) return null;
  return token;
}

function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Locates a method declaration inside decompiled source and returns its
// position so navigation can reveal the method instead of the file top.
function findMethodLocation(text, def) {
  if (typeof text !== 'string' || !def || !def.methodName) return undefined;
  const name = String(def.methodName);
  if (!name || name === '<clinit>' || name === '<init>') return undefined;

  const expected = descriptorParams(def.descriptor);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\w$.:])${escaped}[ \\t]*\\(`, 'g');

  let best;
  let match;
  while ((match = pattern.exec(text))) {
    const nameStart = match.index;
    if (!declarationToken(text, nameStart)) continue;

    const open = text.indexOf('(', nameStart);
    const close = matchingParen(text, open);
    if (open < 0 || close < 0) continue;

    const params = splitParams(text.slice(open + 1, close));
    if (expected && params.length !== expected.length) continue;

    let score = 0;
    if (expected) {
      for (let i = 0; i < params.length; i++) {
        const actual = paramTypeName(params[i]);
        if (actual.name === expected[i].name) score += 2;
        if (actual.isArray === (expected[i].dims > 0)) score += 1;
      }
    }
    // Prefer the best signature match, then the earliest declaration in the file.
    if (!best || score > best.score) {
      best = { score, nameStart };
      if (!expected) break;
    }
  }

  if (!best) return undefined;
  const pos = offsetToPosition(text, best.nameStart);
  return { line: pos.line, character: pos.character, length: name.length };
}

function rangeFor(text, def) {
  if (typeof vscode.Range !== 'function') return undefined;
  const loc = findMethodLocation(text, def);
  if (!loc) return undefined;
  return new vscode.Range(loc.line, loc.character, loc.line, loc.character + loc.length);
}

function hashString(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 20);
}

function sourceFileName(def) {
  const className = def.className || String(def.entryName || 'Glue')
    .replace(/\.class$/, '')
    .replace(/[\\/]/g, '.');
  const simple = className.split('.').filter(Boolean).pop() || 'Glue';
  return `${simple}.java`;
}

function decompiledUri(def) {
  return vscode.Uri.from({
    scheme: DECOMPILED_SCHEME,
    path: `/${sourceFileName(def)}`,
    query: `jar=${encodeURIComponent(def.jarPath)}&entry=${encodeURIComponent(def.entryName)}`
  });
}

function extractClassFile(def, storageDir) {
  const zip = new ZipReader(fs.readFileSync(def.jarPath));
  const entry = zip.entries.find(e => e.name === def.entryName);
  if (!entry) {
    throw new Error(`class entry not found in JAR: ${def.entryName}`);
  }
  const data = zip.readEntry(entry);
  const dir = path.join(storageDir, 'decompiled');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${hashString(`${def.jarPath}!${def.entryName}`)}.class`);
  fs.writeFileSync(target, data);
  return target;
}

async function requestDecompiledSource(classFilePath) {
  const uri = vscode.Uri.file(classFilePath).toString();
  return vscode.commands.executeCommand(
    'java.execute.workspaceCommand', 'java.decompile', uri
  );
}

class DecompiledDocumentProvider {
  constructor(storageDir) {
    this.storageDir = storageDir;
    this.contents = new Map();
    this.cache = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeContent = this.emitter.event;
  }

  keyFor(def) {
    return `${def.jarPath}!${def.entryName}`;
  }

  set(uri, text) {
    const key = uri.toString();
    this.contents.set(key, text);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri) {
    const key = uri.toString();
    return this.contents.has(key)
      ? this.contents.get(key)
      : '// 没有可用的反编译源码。\n// 请安装 Java 反编译器扩展，或为依赖附加 sources JAR。';
  }

  async prepare(def, log) {
    const classFile = extractClassFile(def, this.storageDir || os.tmpdir());
    let text;
    try {
      text = await requestDecompiledSource(classFile);
    } catch (err) {
      if (log && log.warn) log.warn(def.jarPath, `java.decompile failed: ${err.message}`);
    }
    return { classFile, text };
  }

  async ensure(def, log) {
    if (!def || def.source !== 'jar') {
      throw new Error('只能反编译 JAR 中的 Glue 定义');
    }
    const key = this.keyFor(def);
    if (this.cache.has(key)) return this.cache.get(key);

    const prepared = await this.prepare(def, log);
    if (typeof prepared.text !== 'string' || !prepared.text.trim()) {
      const err = new Error('no decompiler output');
      err.classFile = prepared.classFile;
      throw err;
    }
    const uri = decompiledUri(def);
    this.set(uri, prepared.text);
    const result = { uri, text: prepared.text, classFile: prepared.classFile };
    this.cache.set(key, result);
    return result;
  }

  // Used by the definition provider: prepare content without forcing an editor.
  // Returns undefined when no decompiler is available so navigation can fall
  // back to the declaration view.
  async locationFor(def, log) {
    try {
      const result = await this.ensure(def, log);
      const range = rangeFor(result.text, def) || new vscode.Range(0, 0, 0, 0);
      return { uri: result.uri, range };
    } catch (err) {
      if (log && log.warn) log.warn(def.jarPath, `decompile unavailable: ${err.message}`);
      return undefined;
    }
  }

  async open(def, storageDir, log) {
    if (storageDir) this.storageDir = storageDir;
    let result;
    try {
      result = await this.ensure(def, log);
    } catch (err) {
      const classFile = err.classFile || extractClassFile(def, this.storageDir || os.tmpdir());
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(classFile));
      if (vscode.window.showWarningMessage) {
        vscode.window.showWarningMessage(
          '没有拿到反编译源码：请安装/配置 Java 反编译器，或为依赖附加 sources JAR。已打开 .class 文件。'
        );
      }
      return { opened: 'class', classFile };
    }

    const editor = await vscode.window.showTextDocument(result.uri, { preview: true });
    if (editor && vscode.languages && vscode.languages.setTextDocumentLanguage) {
      await vscode.languages.setTextDocumentLanguage(editor.document, 'java');
    }
    // setTextDocumentLanguage can recreate the document, so re-read the active
    // editor before selecting, and reveal the method instead of the file top.
    const target = vscode.window.activeTextEditor || editor;
    const range = rangeFor(result.text, def);
    if (range && target) {
      if (typeof vscode.Selection === 'function') {
        target.selection = new vscode.Selection(
          range.start.line, range.start.character, range.end.line, range.end.character
        );
      }
      if (typeof target.revealRange === 'function') {
        const reveal = vscode.TextEditorRevealType
          ? vscode.TextEditorRevealType.InCenterIfOutsideViewport
          : 2;
        target.revealRange(range, reveal);
      }
    }
    return { opened: 'decompiled', uri: result.uri, classFile: result.classFile, text: result.text };
  }

  dispose() {
    this.emitter.dispose();
  }
}

module.exports = {
  DECOMPILED_SCHEME, DecompiledDocumentProvider,
  decompiledUri, extractClassFile, requestDecompiledSource,
  descriptorParams, findMethodLocation
};
