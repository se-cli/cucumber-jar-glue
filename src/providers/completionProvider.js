'use strict';

const vscode = require('vscode');
const path = require('path');
const { stepTextFromLine } = require('../glue/matcher');

function describe(def) {
  if (def.source === 'jar') {
    return `${path.basename(def.jarPath)}!${def.className}.${def.methodName}`;
  }
  return `${path.basename(def.fsPath || '')}:${def.line || 1} ${def.methodName}`;
}

function register(index) {
  return vscode.languages.registerCompletionItemProvider(
    [{ language: 'gherkin', scheme: 'file' }],
    {
      provideCompletionItems(document, position, token) {
        const line = document.lineAt(position.line).text;
        const step = stepTextFromLine(line);
        if (!step) return undefined;
        const typed = line.slice(step.textStart, position.character).trimStart();
        const replaceRange = new vscode.Range(position.line, step.textStart, position.line, position.character);
        const items = [];
        for (const { definition, pattern } of index.complete(typed, 80)) {
          if (token && token.isCancellationRequested) break;
          const item = new vscode.CompletionItem(pattern, vscode.CompletionItemKind.Method);
          item.detail = describe(definition);
          item.documentation = new vscode.MarkdownString(
            `\`${definition.annotation}\`\n\n来源：${definition.source === 'jar' ? 'JAR Glue 索引' : '工作区源码'}`
          );
          item.range = replaceRange;
          item.insertText = pattern;
          item.sortText = `${definition.source === 'source' ? '0' : '1'}${pattern}`;
          items.push(item);
        }
        return items;
      }
    }
  );
}

module.exports = { register };
