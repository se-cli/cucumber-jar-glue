'use strict';

const vscode = require('vscode');

function cfg(name, fallback) {
  const value = vscode.workspace.getConfiguration('cucumberGlue').get(name, fallback);
  return value === undefined || value === null ? fallback : value;
}

function readConfig() {
  return {
    enabled: cfg('enabled', true),
    classpathProvider: cfg('classpathProvider', 'auto'),
    jarDefinitionView: cfg('jarDefinitionView', 'declaration'),
    classpathRoots: cfg('classpathRoots', []),
    buildClasspath: cfg('buildClasspath', true),
    maxJarSizeMb: Math.max(1, Number(cfg('maxJarSizeMb', 80))),
    maxClassEntriesPerJar: Math.max(1, Number(cfg('maxClassEntriesPerJar', 8000))),
    maxEntrySizeMb: Math.max(1, Number(cfg('maxEntrySizeMb', 8))),
    maxWorkers: Math.min(16, Math.max(1, Number(cfg('maxWorkers', 4)))),
    scanTimeoutMs: Math.max(1000, Number(cfg('scanTimeoutMs', 20000))),
    excludePackages: cfg('excludePackages', []),
    extraAnnotationPrefixes: cfg('extraAnnotationPrefixes', []),
    diagnostics: {
      undefined: cfg('diagnostics.undefined', 'warning'),
      ambiguous: cfg('diagnostics.ambiguous', 'information')
    },
    periodicCheckMs: Math.max(0, Number(cfg('periodicCheckMs', 60000))),
    trace: !!cfg('trace', false)
  };
}

module.exports = { readConfig };
