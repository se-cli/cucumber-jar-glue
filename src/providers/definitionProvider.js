'use strict';

const vscode = require('vscode');
const { stepTextFromLine } = require('../glue/matcher');
const { SCHEME } = require('../util/uri');
const { DOCUMENT_SELECTOR } = require('../util/gherkin');

async function locationLinkFor(def, virtual, originRange, options = {}) {
  let uri;
  let range;
  if (def.source === 'jar') {
    const config = options.configRef ? options.configRef() : undefined;
    if (config && config.jarDefinitionView === 'decompiled' && options.decompiled) {
      const loc = await options.decompiled.locationFor(def, options.log);
      if (loc) {
        return {
          originSelectionRange: originRange,
          targetUri: loc.uri,
          targetRange: loc.range,
          targetSelectionRange: loc.range
        };
      }
    }
    const loc = virtual.locationFor(def);
    uri = loc.uri;
    range = loc.range;
  } else {
    uri = vscode.Uri.parse(def.uri);
    const line = Math.max(0, (def.line || 1) - 1);
    const character = def.character || 0;
    range = new vscode.Range(line, character, line, character + (def.methodName || 1).length);
  }
  return {
    originSelectionRange: originRange,
    targetUri: uri,
    targetRange: range,
    targetSelectionRange: range
  };
}

function registerDefinitionProvider(index, virtual, options = {}) {
  return vscode.languages.registerDefinitionProvider(
    DOCUMENT_SELECTOR,
    {
      async provideDefinition(document, position) {
        const step = stepTextFromLine(document.lineAt(position.line).text);
        if (!step || !step.text) return undefined;
        const origin = new vscode.Range(
          position.line, step.textStart,
          position.line, step.textStart + step.text.length
        );
        const links = [];
        for (const match of index.findDefinitions(step.text)) {
          links.push(await locationLinkFor(match.definition, virtual, origin, options));
        }
        return links;
      }
    }
  );
}

function registerGlueSelfDefinition(index, virtual) {
  return vscode.languages.registerDefinitionProvider(
    [{ scheme: SCHEME }],
    {
      provideDefinition(document, position) {
        const def = virtual.definitionAt(document.uri, position.line);
        return def ? virtual.locationFor(def) : undefined;
      }
    }
  );
}

module.exports = { registerDefinitionProvider, registerGlueSelfDefinition, locationLinkFor };
