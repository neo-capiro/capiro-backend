const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const OUT = 'docs/cleanup-strategy-template-conversion-20261012/evidence/';
const frontPath = 'apps/api-strategy/src/context/frontmatter.ts';
const reportPath = 'apps/api-strategy/src/reports/report-context.ts';
const registryPath = 'apps/api-strategy/src/context/template-registry.ts';
const golden = JSON.parse(fs.readFileSync(OUT + 'original-802-golden.json', 'utf8'));
const oldSources = {
  front: fs.readFileSync(OUT + 'original-frontmatter.ts', 'utf8'),
  report: fs.readFileSync(OUT + 'original-report-context.ts', 'utf8'),
};
for (const [name, source] of Object.entries(oldSources)) {
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), golden.pureFrozenSourceHashes[name]);
}
const realm = vm.createContext({ Date });
const realmTypeError = vm.runInContext('TypeError', realm);
function load(source, fileName, resolve) {
  const output = ts.transpileModule(source, {
    fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const factory = vm.runInContext(`(function(exports, require, module){${output}\n})`, realm, { timeout: 1000 });
  const module = { exports: {} };
  factory(module.exports, resolve, module);
  return module.exports;
}
const noImport = (name) => { throw new Error('Unexpected runtime dependency: ' + name); };
const frontProbe = '\nexport const __auditRuntime = { frozenTypes:Object.isFrozen(DOCUMENT_TYPES), frozenMap:Object.isFrozen(TEMPLATE_KEY_BY_TYPE), mapPrototypePlain:Object.getPrototypeOf(TEMPLATE_KEY_BY_TYPE)===Object.prototype };';
const oldFront = load(oldSources.front + frontProbe, frontPath, noImport);
const oldReport = load(oldSources.report + '\nexport const __auditRegistry={categoryFor,sectionTitleForTemplate,skipped:Array.from(SKIPPED_TEMPLATE_KEYS),titles:SECTION_TITLES};', reportPath, name => {
  assert.equal(name, '../context/frontmatter.js'); return oldFront;
});
const registry = load(fs.readFileSync(registryPath, 'utf8'), registryPath, noImport);
const newFront = load(fs.readFileSync(frontPath, 'utf8') + frontProbe, frontPath, name => {
  assert.equal(name, './template-registry.js'); return registry;
});
const newReport = load(fs.readFileSync(reportPath, 'utf8') + '\nexport const __auditRegistry={categoryFor,sectionTitleForTemplate,skipped:Array.from(require("../context/template-registry.js").OPERATIONAL_REPORT_TEMPLATE_KEYS),titles:require("../context/template-registry.js").REPORT_SECTION_TITLES};', reportPath, name => {
  if (name === '../context/frontmatter.js') return newFront;
  assert.equal(name, '../context/template-registry.js'); return registry;
});
const plain = value => JSON.parse(JSON.stringify(value));
const ASOF = '2026-10-12';
function doc(key, overrides = {}) {
  return { id: 'synthetic-' + key, title: key, templateKey: key,
    content: '---\nauthority: working_draft\nconfidentiality: client_confidential\nsource_of_truth: false\nas_of: "2026-10-11"\n---\n- Authored entry for ' + key + '.',
    frontmatter: { authority: 'working_draft', confidentiality: 'client_confidential', source_of_truth: false, as_of: '2026-10-11' },
    validUntil: null, updatedAt: new Date('2026-10-11T00:00:00Z'),
    facts: [{ id: 'fact-' + key, fact: 'Established entry for ' + key + '.', sourceRef: 'heading:Overview', authority: null, asOf: null, confidence: 0.5 }], ...overrides };
}
const counts = { known: 0, unknown: 0, invalidSameRealm: 0, headings: 0, metadata: 0, freshness: 0, templates: 0 };
function assemble(document, audience) {
  const before = plain(oldReport.assembleReportContext([document], audience, ASOF));
  const after = plain(newReport.assembleReportContext([document], audience, ASOF));
  assert.deepEqual(after, before);
  return after;
}
for (const row of golden.known) {
  assert.equal(newReport.__auditRegistry.sectionTitleForTemplate(row.templateKey), row.defaultTitle);
  assert.equal(newReport.__auditRegistry.categoryFor(row.templateKey, 'Overview'), row.defaultCategory);
  assert.deepEqual(assemble(doc(row.templateKey), 'client'), row.client);
  assert.deepEqual(assemble(doc(row.templateKey), 'internal'), row.internal);
  counts.known++;
}
for (const row of golden.unknown) {
  assert.equal(newReport.__auditRegistry.categoryFor(row.key, 'Overview'), row.category);
  assert.equal(newReport.__auditRegistry.sectionTitleForTemplate(row.key), row.title);
  assert.deepEqual(assemble(doc(row.key), 'internal'), row.assembled);
  counts.unknown++;
}
for (const row of golden.invalid) {
  const input = row.input === 'undefined' ? undefined : row.input;
  const caught = [];
  for (const report of [oldReport, newReport]) {
    try { report.assembleReportContext([doc(input)], 'internal', ASOF); assert.fail('Expected original invalid-input refusal'); }
    catch (error) { caught.push(error); }
  }
  assert.equal(caught[0].constructor, realmTypeError);
  assert.equal(caught[1].constructor, caught[0].constructor);
  assert.equal(caught[1].message, caught[0].message);
  assert.equal(caught[1].name, row.throws);
  assert.equal(caught[1].message, row.message);
  counts.invalidSameRealm++;
}
for (const row of golden.headingPrecedence) {
  assert.equal(oldReport.__auditRegistry.categoryFor(row.templateKey, row.heading), row.category);
  assert.equal(newReport.__auditRegistry.categoryFor(row.templateKey, row.heading), row.category);
  counts.headings++;
}
const metadataInputs = { null: null, undefined: undefined, array: [], string: 'invalid', number: 5,
  emptyStoredRecord: {}, storedInternal: { confidentiality: 'firm_internal' },
  storedClientDraft: { confidentiality: 'client_confidential', authority: 'working_draft', source_of_truth: false } };
for (const row of golden.metadataCases) {
  assert.deepEqual(assemble(doc('01_strategy_brief', { frontmatter: metadataInputs[row.name] }), 'client'), row.client);
  counts.metadata++;
}
const dates = { prior: '2026-10-11T23:59:59.999Z', exact: '2026-10-12T00:00:00Z', future: '2026-10-13T00:00:00Z' };
for (const row of golden.freshness) {
  const document = doc('01_strategy_brief', { validUntil: new Date(dates[row.name]) });
  assert.deepEqual(assemble(document, 'client'), row.client);
  assert.deepEqual(assemble(document, 'internal'), row.internal);
  counts.freshness++;
}
for (const row of golden.templates) {
  const raw = fs.readFileSync('apps/api-strategy/src/context/templates/' + row.file, 'utf8');
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), row.sha256);
  const before = oldFront.parseFrontmatter(raw), after = newFront.parseFrontmatter(raw);
  assert.deepEqual(plain(after), plain(before));
  assert.deepEqual(plain(after.frontmatter), row.parsedFrontmatter);
  assert.deepEqual(plain(newFront.validateFrontmatter(after.frontmatter)), row.validationErrors);
  assert.deepEqual(plain(newFront.validateFrontmatter(after.frontmatter)), plain(oldFront.validateFrontmatter(before.frontmatter)));
  counts.templates++;
}
const ordered = doc('01_strategy_brief', { content: '---\n---\n' + ['Overview', 'Success', 'Ask', 'Stakeholder', 'Constraint', 'Deadline', 'Decision', 'Intelligence', 'Evidence', 'Odd neutral'].map((h, i) => '## ' + h + '\n- Unique authored statement ' + i + '.').join('\n'), facts: [] });
const orderDocuments = [ordered, doc('14_target_budget_line', { facts: [] })];
const beforeMixed = plain(oldReport.assembleReportContext(orderDocuments, 'internal', ASOF));
const afterMixed = plain(newReport.assembleReportContext(orderDocuments, 'internal', ASOF));
assert.deepEqual(afterMixed, beforeMixed);
assert.deepEqual(afterMixed.sections.map(s => s.key), golden.sectionOutputOrder);
assert.deepEqual(plain(newFront.parseFrontmatter('---\r\ndocument_type: "strategy_brief"\r\n---\r\n\r\n##  Two  spaces\r\n- row\r\n')), golden.parserBody);
assert.deepEqual(plain(newFront.__auditRuntime), { frozenTypes: false, frozenMap: false, mapPrototypePlain: true });
assert.equal(newFront.DOCUMENT_TYPES, registry.DOCUMENT_TYPES);
assert.equal(newFront.TEMPLATE_KEY_BY_TYPE, registry.TEMPLATE_KEY_BY_TYPE);
assert.deepEqual(Object.keys(newFront), Object.keys(oldFront));
for (const name of ['DOCUMENT_TYPES', 'TEMPLATE_KEY_BY_TYPE']) {
  const before = Object.getOwnPropertyDescriptor(oldFront, name), after = Object.getOwnPropertyDescriptor(newFront, name);
  assert.equal(after.writable, before.writable); assert.equal(after.enumerable, before.enumerable);
  assert.equal(after.configurable, before.configurable); assert.equal(after.get, undefined);
}
const valid = { document_type: 'strategy_brief', schema_version: '1.0', state: 'active', scope: 'strategy', strategy_id: 'synthetic-id', authority: 'working_draft', confidentiality: 'client_confidential', source_of_truth: false, as_of: '2026-10-11', valid_until: null };
registry.DOCUMENT_TYPES.push('synthetic_registry_type');
try { assert(!newFront.validateFrontmatter({ ...valid, document_type: 'synthetic_registry_type' }).some(e => e.field === 'document_type')); }
finally { registry.DOCUMENT_TYPES.pop(); }
const mapValue = registry.TEMPLATE_KEY_BY_TYPE.strategy_brief;
registry.TEMPLATE_KEY_BY_TYPE.strategy_brief = '01_shared_reference';
try { assert.equal(newFront.TEMPLATE_KEY_BY_TYPE.strategy_brief, '01_shared_reference'); }
finally { registry.TEMPLATE_KEY_BY_TYPE.strategy_brief = mapValue; }
assert.deepEqual(plain(registry.DOCUMENT_TYPES), golden.documentTypeOrder);
assert.deepEqual(plain(registry.TEMPLATE_KEY_BY_TYPE), golden.templateMap);
assert.deepEqual(plain(newReport.__auditRegistry.skipped), golden.operationalKeys);
assert.deepEqual(Object.keys(newReport.__auditRegistry.titles), golden.sectionTitleRecordOrder);
const result = { originalSource: golden.source, originalTree: golden.tree, counts,
  sameErrorRealm: true, goldenCapturedBeforeCandidateEdits: true, goldenRegeneratedFromCandidate: false,
  completeKnownUnknownMetadataFreshnessAssemblyOutputsEqual: true,
  publicFrontmatterExportNamesOrderDataDescriptorsAndReferencesEqual: true,
  bodyWhitespaceParserValidationAndTemplateBytesEqual: true,
  runtimeDependencies: ['candidate pure template registry', 'original/candidate pure frontmatter only'],
  db: 0, providers: 0, network: 0, ambientClockSamples: 0, nativeAcceptance: false };
fs.writeFileSync(OUT + 'differential.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
