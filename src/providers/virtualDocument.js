'use strict';

const vscode = require('vscode');
const path = require('path');
const { glueUri, parseGlueUri } = require('../util/uri');

function descriptorArgCount(descriptor) {
  const m = /^\((.*)\)/.exec(descriptor || '');
  if (!m || !m[1]) return 0;
  let count = 0;
  let i = 0;
  while (i < m[1].length) {
    const ch = m[1][i];
    if (ch === 'L') { const end = m[1].indexOf(';', i); i = end < 0 ? m[1].length : end + 1; count++; }
    else if (ch === '[') { i++; continue; }
    else { i++; count++; }
  }
  return count;
}

function render(defs, parsed) {
  const groups = new Map();
  for (const def of defs) {
    const key = [def.methodName, def.descriptor, def.annotation, def.kind].join('#');
    if (!groups.has(key)) groups.set(key, { defs: [], key });
    groups.get(key).defs.push(def);
  }
  const sorted = Array.from(groups.values()).sort((a, b) => {
    const ka = `${a.defs[0].methodName}#${a.defs[0].descriptor}#${a.defs[0].annotation}`;
    const kb = `${b.defs[0].methodName}#${b.defs[0].descriptor}#${b.defs[0].annotation}`;
    return ka.localeCompare(kb);
  });

  const lines = [];
  const byLine = new Map();
  const add = (text, defsForLine, character) => {
    const line = lines.length;
    lines.push(text);
    if (defsForLine) for (const def of defsForLine) byLine.set(def.id, { uri: glueUri(parsed.jarPath, parsed.entryName), line, character });
  };

  add('// Cucumber Glue 声明视图：从 JAR 内的 .class 元数据生成，未反编译方法体。');
  add(`// JAR: ${parsed.jarPath}`);
  add(`// Entry: ${parsed.entryName}`);
  add('// 只读视图。修改 Glue 请改源码；此处仅用于跳转与查找引用。');
  add('');

  const fullClass = defs[0].className || parsed.entryName.replace(/\.class$/, '').replace(/\//g, '.');
  const dot = fullClass.lastIndexOf('.');
  const pkg = dot >= 0 ? fullClass.slice(0, dot) : '';
  const simple = dot >= 0 ? fullClass.slice(dot + 1) : fullClass;
  if (pkg) { add(`package ${pkg};`); add(''); }
  add(`public class ${simple} {`);
  add('');

  for (const group of sorted) {
    const first = group.defs[0];
    const patterns = group.defs.flatMap(d => d.patterns || []);
    const value = Array.from(new Set(patterns)).map(p => JSON.stringify(p)).join(', ');
    add(`    // @${first.annotation.replace(/^L/, '').replace(/;$/, '').replace(/\//g, '.')}(${value})`, null);
    const args = descriptorArgCount(first.descriptor);
    const signature = `    public void ${first.methodName}(${args ? `/* ${args} args */` : ''}) { /* ... */ }`;
    const character = signature.indexOf(first.methodName);
    add(signature, group.defs, character);
    add('');
  }
  add('}');

  return { text: lines.join('\n'), byLine, lineToDefs: groupLines(sorted, byLine) };
}

function groupLines(groups, byLine) {
  const map = new Map();
  for (const g of groups) {
    const first = g.defs[0];
    const loc = byLine.get(first.id);
    if (loc) map.set(loc.line, g.defs);
  }
  return map;
}

class GlueVirtualDocumentProvider {
  constructor(index) {
    this.index = index;
    this.layouts = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeContent = this.emitter.event;
  }

  layoutFor(uri) {
    const key = uri.toString();
    if (this.layouts.has(key)) return this.layouts.get(key);
    const parsed = parseGlueUri(uri);
    if (!parsed) return undefined;
    const defs = this.index.allDefinitions().filter(d =>
      d.source === 'jar' && d.jarPath === parsed.jarPath && d.entryName === parsed.entryName
    );
    if (!defs.length) return undefined;
    const layout = render(defs, parsed);
    this.layouts.set(key, layout);
    return layout;
  }

  provideTextDocumentContent(uri) {
    const parsed = parseGlueUri(uri);
    if (!parsed) return '// Invalid Cucumber glue URI';
    const layout = this.layoutFor(uri);
    return layout ? layout.text : '// Glue class is no longer indexed. Refresh the Cucumber Glue index.';
  }

  locationFor(def) {
    const uri = glueUri(def.jarPath, def.entryName);
    const layout = this.layoutFor(uri);
    if (!layout) return { uri, range: new vscode.Range(0, 0, 0, 0) };
    const loc = layout.byLine.get(def.id) || { line: 0, character: 0 };
    const lineText = layout.text.split('\n')[loc.line] || '';
    const range = new vscode.Range(loc.line, loc.character, loc.line, Math.max(loc.character + 1, lineText.length));
    return { uri, range };
  }

  definitionAt(uri, line) {
    const layout = this.layoutFor(uri);
    if (!layout) return undefined;
    const defs = layout.lineToDefs.get(line);
    return defs && defs[0];
  }

  refresh() {
    this.layouts.clear();
    this.emitter.fire();
  }

  dispose() {
    this.emitter.dispose();
  }
}

module.exports = { GlueVirtualDocumentProvider, render };
