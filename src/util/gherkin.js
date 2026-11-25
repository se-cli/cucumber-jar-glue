'use strict';

// The official Cucumber extension (cucumberopen.cucumber-official) registers
// `.feature` with language id "cucumber", while other setups use "gherkin".
// Bind to both, plus a file-pattern fallback so no feature file is missed.
const LANGUAGE_IDS = ['gherkin', 'cucumber'];

const DOCUMENT_SELECTOR = [
  { language: 'gherkin', scheme: 'file' },
  { language: 'cucumber', scheme: 'file' },
  { pattern: '**/*.feature', scheme: 'file' }
];

function isGherkinDocument(document) {
  if (!document) return false;
  if (LANGUAGE_IDS.includes(document.languageId)) return true;
  const fsPath = document.uri && document.uri.fsPath;
  return typeof fsPath === 'string' && fsPath.toLowerCase().endsWith('.feature');
}

module.exports = { LANGUAGE_IDS, DOCUMENT_SELECTOR, isGherkinDocument };
