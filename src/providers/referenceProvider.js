'use strict';

const vscode = require('vscode');
const { stepTextFromLine } = require('../glue/matcher');
const { SCHEME, parseGlueUri } = require('../util/uri');
const { DOCUMENT_SELECTOR } = require('../util/gherkin');
const { locationLinkFor } = require('./definitionProvider');

function usageLocation(usage) {
  const uri = vscode.Uri.parse(usage.uri);
  const position = new vscode.Position(usage.line, 0);
  return new vscode.Location(uri, new vscode.Range(position, position.translate(0, 200)));
}

function register(index, virtual) {
  const provider = {
    provideReferences(document, position, context) {
      let target;
      let origin;
      if (document.uri.scheme === SCHEME) {
        target = virtual.definitionAt(document.uri, position.line);
        const parsed = parseGlueUri(document.uri);
        if (parsed) origin = virtual.locationFor(target || { source: 'jar', jarPath: parsed.jarPath, entryName: parsed.entryName }).range;
      } else {
        const step = stepTextFromLine(document.lineAt(position.line).text);
        if (!step || !step.text) return undefined;
        const matches = index.findDefinitions(step.text);
        target = matches.length ? matches[0].definition : undefined;
        origin = new vscode.Range(
          position.line, step.textStart,
          position.line, step.textStart + step.text.length
        );
      }
      if (!target) return [];

      const locations = [];
      if (context && context.includeDeclaration) {
        const link = locationLinkFor(target, virtual, origin);
        locations.push(new vscode.Location(link.targetUri, link.targetRange));
      }
      for (const usage of index.usagesForDefinition(target)) locations.push(usageLocation(usage));
      return locations;
    }
  };
  return vscode.languages.registerReferenceProvider(
    [...DOCUMENT_SELECTOR, { scheme: SCHEME }], provider
  );
}

module.exports = { register };
