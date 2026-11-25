'use strict';

const vscode = require('vscode');
const { stepTextFromLine } = require('../glue/matcher');

function severityOf(value, fallback) {
  if (value === 'off') return undefined;
  if (value === 'warning') return vscode.DiagnosticSeverity.Warning;
  if (value === 'error') return vscode.DiagnosticSeverity.Error;
  return fallback;
}

class Diagnostics {
  constructor(index, configRef) {
    this.index = index;
    this.configRef = configRef;
    this.collection = vscode.languages.createDiagnosticCollection('cucumber-glue');
    this.timer = undefined;
  }

  updateDocument(document) {
    if (document.languageId !== 'gherkin' || !document.uri.fsPath.endsWith('.feature')) return;
    const config = this.configRef();
    const undefinedSeverity = severityOf(config.diagnostics.undefined, vscode.DiagnosticSeverity.Warning);
    const ambiguousSeverity = severityOf(config.diagnostics.ambiguous, vscode.DiagnosticSeverity.Information);
    const diagnostics = [];
    const partial = Array.from(this.index.jarStatus.values()).some(s => s.skipped);

    for (let line = 0; line < document.lineCount; line++) {
      const step = stepTextFromLine(document.lineAt(line).text);
      if (!step || !step.text) continue;
      const matches = this.index.findDefinitions(step.text);
      const range = new vscode.Range(
        line, step.textStart, line, step.textStart + step.text.length
      );
      if (!matches.length && undefinedSeverity !== undefined) {
        const d = new vscode.Diagnostic(
          range,
          `未找到匹配的 Cucumber Glue 定义${partial ? '（部分 JAR 未扫描，结果可能不完整）' : ''}`,
          undefinedSeverity
        );
        d.source = 'Cucumber Glue';
        diagnostics.push(d);
      } else if (matches.length > 1 && matches[1].score === matches[0].score && ambiguousSeverity !== undefined) {
        const d = new vscode.Diagnostic(
          range,
          `存在 ${matches.length} 个等价 Glue 定义：${matches.slice(0, 3).map(m => m.definition.className + '.' + m.definition.methodName).join(', ')}`,
          ambiguousSeverity
        );
        d.source = 'Cucumber Glue';
        diagnostics.push(d);
      }
    }
    this.collection.set(document.uri, diagnostics);
  }

  schedule(document) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (document) this.updateDocument(document);
      else this.updateAll();
    }, 250);
  }

  updateAll() {
    for (const document of vscode.workspace.textDocuments) this.updateDocument(document);
  }

  clear() {
    this.collection.clear();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.collection.dispose();
  }
}

module.exports = { Diagnostics };
