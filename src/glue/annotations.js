'use strict';

// Cucumber-JVM glue annotation compatibility.
// v1:  cucumber.api.java.<locale>.<Keyword> / cucumber.api.java.<Hook>
// v2+: io.cucumber.java.<locale>.<Keyword>  / io.cucumber.java.<Hook>
// Locale is treated generically (en, fr, zh_cn, zh_CN, ...), so no dialect
// table needs to be kept in sync with Cucumber releases.

const BASES = [
  { prefix: 'cucumber/api/java/', version: '1.x' },
  { prefix: 'io/cucumber/java/', version: '2.x+' }
];

const HOOKS = new Set([
  'Before', 'After', 'BeforeStep', 'AfterStep',
  'BeforeAll', 'AfterAll', 'BeforeClass', 'AfterClass'
]);

const META = new Set([
  'ParameterType', 'DataTableType', 'DocStringType',
  'DefaultParameterTransformer', 'DefaultDataTableCellTransformer',
  'DefaultDataTableEntryTransformer', 'ScenarioContext', 'ObjectFactory'
]);

// typeDescriptor is the JVM descriptor from the annotation attribute,
// e.g. "Lio/cucumber/java/en/Given;".
function classify(typeDescriptor, extraPrefixes = []) {
  if (typeof typeDescriptor !== 'string' || !typeDescriptor.startsWith('L') || !typeDescriptor.endsWith(';')) {
    return undefined;
  }
  const internal = typeDescriptor.slice(1, -1);

  for (const base of BASES) {
    if (!internal.startsWith(base.prefix)) continue;
    const rest = internal.slice(base.prefix.length);
    const parts = rest.split('/').filter(Boolean);
    if (parts.length === 0) return undefined;
    if (parts.length >= 2) {
      return {
        kind: 'step',
        version: base.version,
        language: parts[0],
        keyword: parts[parts.length - 1],
        type: typeDescriptor
      };
    }
    const name = parts[0];
    if (HOOKS.has(name)) {
      return { kind: 'hook', version: base.version, hook: name, keyword: name, type: typeDescriptor };
    }
    if (META.has(name)) {
      return { kind: name, version: base.version, keyword: name, type: typeDescriptor };
    }
    return undefined;
  }

  for (const prefix of extraPrefixes || []) {
    const p = String(prefix).replace(/^\//, '').replace(/\/$/, '') + '/';
    if (!internal.startsWith(p)) continue;
    const parts = internal.slice(p.length).split('/').filter(Boolean);
    if (parts.length === 0) return undefined;
    return {
      kind: 'step',
      version: 'custom',
      language: 'custom',
      keyword: parts[parts.length - 1],
      type: typeDescriptor
    };
  }
  return undefined;
}

function isStepAnnotation(typeDescriptor, extraPrefixes) {
  const c = classify(typeDescriptor, extraPrefixes);
  return !!c && c.kind === 'step';
}

function descriptorFromQualifiedName(name) {
  // io.cucumber.java.en.Given -> Lio/cucumber/java/en/Given;
  return `L${String(name).replace(/\./g, '/')};`;
}

module.exports = { classify, isStepAnnotation, descriptorFromQualifiedName, HOOKS, META };
