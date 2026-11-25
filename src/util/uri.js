'use strict';

const vscode = require('vscode');

const SCHEME = 'cucumber-glue';

function glueUri(jarPath, entryName) {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${encodeURIComponent(jarPath)}!${encodeURIComponent(entryName)}`
  });
}

function parseGlueUri(uri) {
  if (!uri || uri.scheme !== SCHEME) return undefined;
  const raw = String(uri.path || '').replace(/^\//, '');
  const bang = raw.indexOf('!');
  if (bang < 0) return undefined;
  try {
    return {
      jarPath: decodeURIComponent(raw.slice(0, bang)),
      entryName: decodeURIComponent(raw.slice(bang + 1))
    };
  } catch (_) {
    return undefined;
  }
}

module.exports = { SCHEME, glueUri, parseGlueUri };
