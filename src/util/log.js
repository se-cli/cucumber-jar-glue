'use strict';

const vscode = require('vscode');

class Log {
  constructor(name = 'Cucumber Jar Glue') {
    this.channel = vscode.window.createOutputChannel(name);
    this.traceEnabled = false;
    this.warnings = [];
  }

  setTrace(on) {
    this.traceEnabled = !!on;
  }

  info(message) {
    this.channel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  trace(message) {
    if (this.traceEnabled) this.info(`TRACE ${message}`);
  }

  warn(scope, message) {
    const text = `${scope}: ${message}`;
    this.warnings.push(text);
    if (this.warnings.length > 200) this.warnings.shift();
    this.info(`WARN ${text}`);
  }

  error(scope, err) {
    const text = err && err.stack ? err.stack : String(err);
    this.info(`ERROR ${scope}: ${text}`);
  }

  show() {
    this.channel.show(true);
  }

  dispose() {
    this.channel.dispose();
  }
}

module.exports = { Log };
