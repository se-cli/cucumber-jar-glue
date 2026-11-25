'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ZipReader } = require('./zipReader');

const DECOMPILED_SCHEME = 'cucumber-glue-source';

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
      return { uri: result.uri, range: new vscode.Range(0, 0, 0, 0) };
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
    return { opened: 'decompiled', uri: result.uri, classFile: result.classFile, text: result.text };
  }

  dispose() {
    this.emitter.dispose();
  }
}

module.exports = {
  DECOMPILED_SCHEME, DecompiledDocumentProvider,
  decompiledUri, extractClassFile, requestDecompiledSource
};
