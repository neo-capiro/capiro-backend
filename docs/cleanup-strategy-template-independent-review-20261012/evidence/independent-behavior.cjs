// Independent pure original/candidate comparison. Real operations are source
// reads, hashing and read-only Git. No service, provider or bootstrap runs.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript');
const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa';
const head = '8834c1d76659b343fb37c60733fa1dd618a06db9';
const frontPath = 'apps/api-strategy/src/context/frontmatter.ts';
const reportPath = 'apps/api-strategy/src/reports/report-context.ts';
const registryPath = 'apps/api-strategy/src/context/template-registry.ts';
const git = (...args) => execFileSync('git', args);
const source = (revision, file) => git('show', revision + ':' + file).toString();
const originals = { front: source(base, frontPath), report: source(base, reportPath) };
const candidate = { front: source(head, frontPath), report: source(head, reportPath), registry: source(head, registryPath) };
for (const [key, file] of [['front', frontPath], ['report', reportPath], ['registry', registryPath]]) assert.equal(fs.readFileSync(file, 'utf8'), candidate[key]);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const realm = vm.createContext({ Date });
const intrinsicTypeError = vm.runInContext('TypeError', realm);
const noImport = (name) => { throw Error('Unexpected dependency: ' + name); };
function load(text, resolve = noImport) {
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const factory = vm.runInContext('(function(exports,require,module){' + code + '\n})', realm, { timeout: 1000 });
  const module = { exports: {} }; factory(module.exports, resolve, module); return module.exports;
}
function pair() {
  const oldFront = load(originals.front);
  const registry = load(candidate.registry);
  const newFront = load(candidate.front, (name) => { assert.equal(name, './template-registry.js'); return registry; });
  const hook = '\nexport const __review={categoryFor,includeContextDocument,contextMetadata,sectionTitleForTemplate};';
  const oldReport = load(originals.report + hook, (name) => { assert.equal(name, '../context/frontmatter.js'); return oldFront; });
  const newReport = load(candidate.report + hook, (name) => {
    if (name === '../context/frontmatter.js') return newFront;
    assert.equal(name, '../context/template-registry.js'); return registry;
  });
  return { old: { front: oldFront, report: oldReport }, current: { front: newFront, report: newReport }, registry };
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const ASOF = '2026-10-12';
function doc(templateKey, override = {}) {
  return { id: 'synthetic-document', title: 'Independent synthetic input', templateKey,
    content: '---\nauthority: working_draft\nconfidentiality: client_confidential\nsource_of_truth: false\nas_of: "2026-10-11"\n---\n## Overview\n- An authored claim with context.',
    frontmatter: { authority: 'working_draft', confidentiality: 'client_confidential', source_of_truth: false, as_of: '2026-10-11' },
    validUntil: null, updatedAt: new Date('2026-10-11T00:00:00Z'),
    facts: [{ id: 'synthetic-fact', fact: 'A distinct established context claim.', sourceRef: 'heading:Overview', authority: null, asOf: null, confidence: 0.5 }],
    ...override };
}
function observed(work) {
  try { return { returned: plain(work()) }; }
  catch (error) { return { threw: { name: error.name, message: error.message, intrinsicTypeError: error.constructor === intrinsicTypeError } }; }
}
const cases = [];
function compare(name, run, options = {}) {
  const modules = options.fresh ? pair() : shared;
  const before = observed(() => run(modules.old, modules));
  const after = observed(() => run(modules.current, modules));
  assert.deepEqual(after, before, name);
  cases.push({ name, ...after });
  return after;
}
const shared = pair();
assert.equal(shared.current.front.DOCUMENT_TYPES, shared.registry.DOCUMENT_TYPES);
assert.equal(shared.current.front.TEMPLATE_KEY_BY_TYPE, shared.registry.TEMPLATE_KEY_BY_TYPE);
assert.deepEqual(Object.keys(shared.current.front), Object.keys(shared.old.front));
for (const key of ['DOCUMENT_TYPES', 'TEMPLATE_KEY_BY_TYPE']) {
  const before = Object.getOwnPropertyDescriptor(shared.old.front, key);
  const after = Object.getOwnPropertyDescriptor(shared.current.front, key);
  assert.deepEqual(after, { ...before, value: after.value });
  assert.equal(after.get, undefined); assert.equal(after.writable, true);
}
const known = shared.old.front.DOCUMENT_TYPES.map((key) => shared.old.front.TEMPLATE_KEY_BY_TYPE[key]);
assert.equal(known.length, 17);
for (const key of known) for (const audience of ['client', 'internal']) compare('known/' + audience + '/' + key,
  ({ report }) => report.assembleReportContext([doc(key)], audience, ASOF));
const unknown = ['', '__proto__', 'constructor', 'toString', 'prototype', 'hasOwnProperty', 'valueOf',
  '00_fake', '07_current_plan_suffix', '13_AGENT_PERMISSIONS', ' 01_strategy_brief', '01_',
  '01_future', '02_future', '06_future', '03_future', '14_future', '16_future', '<script>x</script>'];
assert.equal(unknown.length, 19);
for (const key of unknown) compare('unknown/' + key, ({ report }) => report.assembleReportContext([doc(key)], 'internal', ASOF));
for (const [index, value] of [null, undefined, 12, {}, ['01_custom']].entries()) {
  const result = compare('malformed-key/' + index, ({ report }) => report.assembleReportContext([doc(value)], 'internal', ASOF));
  assert.equal(result.threw?.name, 'TypeError'); assert.equal(result.threw?.intrinsicTypeError, true);
}
const headings = ['decision evidence deadline ask goal', 'stakeholder deadline evidence', 'deadline evidence constraint',
  'evidence approval ask', 'approval option goal', 'option goal intelligence', 'success intelligence', 'current position', 'Overview'];
for (const heading of headings) compare('heading-first/' + heading, ({ report }) => report.__review.categoryFor('01_future', heading));
for (const match of ['01_', '02_', '06_', '03_', '04_', '05_', '08_', '09_', '10_', null]) {
  compare('prefix-getter-trace/' + match, ({ report }) => {
    const trace = [];
    const key = { marker: 'receiver', get startsWith() {
      trace.push('get'); return function(prefix) { assert.equal(this.marker, 'receiver'); trace.push(prefix); return prefix === match; };
    } };
    return { category: report.__review.categoryFor(key, 'Overview'), trace };
  });
}
const metadata = [null, undefined, [], 'invalid', 5, {}, { confidentiality: 'firm_internal' },
  { confidentiality: 'client_confidential', authority: 'working_draft', source_of_truth: false },
  { confidentiality: 'client_confidential', authority: 'unvetted', source_of_truth: true },
  Object.create({ confidentiality: 'client_confidential', authority: 'working_draft' })];
for (const [index, value] of metadata.entries()) for (const audience of ['client', 'internal']) compare('metadata/' + audience + '/' + index,
  ({ report }) => report.assembleReportContext([doc('01_strategy_brief', { frontmatter: value })], audience, ASOF));
for (const [index, [input, expected]] of [
  [{ confidentiality: ' client_confidential ' }, true],
  [{ confidentiality: 'firm_internal' }, false], [{}, false],
  [{ confidentiality: 7 }, false], [Object.create({ confidentiality: 'client_confidential' }), true],
  [null, false],
].entries()) {
  const result = compare('public-client-safe-guard/' + index,
    ({ report }) => report.isClientSafeContextFrontmatter(input));
  assert.equal(result.returned, expected);
}
for (const value of [null, '2026-10-11T23:59:59.999Z', '2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z', 'invalid']) {
  for (const audience of ['client', 'internal']) compare('freshness/' + audience + '/' + value,
    ({ report }) => report.assembleReportContext([doc('01_strategy_brief', { validUntil: value === null ? null : new Date(value) })], audience, ASOF));
}
for (const heading of ['Instructions to Meri', 'Meri may', 'Watcher rules', 'Proposed firm reference changes', 'Internal operating notes', 'Client-facing overview']) {
  for (const audience of ['client', 'internal']) compare('heading-confidentiality/' + audience + '/' + heading,
    ({ report }) => report.assembleReportContext([doc('01_strategy_brief', { content: '---\n---\n## ' + heading + '\n- A substantive authored claim.' })], audience, ASOF));
}
for (const text of ['---\r\ndocument_type: "strategy_brief"\r\n---\r\n\r\n##  Two  spaces\r\n- row\r\n',
  '# Unfenced body\n', '---\ndocument_type: strategy_brief\nas_of: 2027-02-30\n---\nbody', '---\n---\nbody', '---\nmalformed line\n---\nbody']) {
  compare('parser/' + sha(text).slice(0, 8), ({ front }) => {
    const parsed = front.parseFrontmatter(text); return { parsed, errors: front.validateFrontmatter(parsed.frontmatter) };
  });
}
for (const [name, mutate] of [
  ['shared-array', (front) => front.DOCUMENT_TYPES.push('synthetic_review_type')],
  ['namespace-array-replacement', (front) => { front.DOCUMENT_TYPES = ['synthetic_review_type']; }],
  ['shared-map-entry', (front) => { front.TEMPLATE_KEY_BY_TYPE.strategy_brief = '01_synthetic'; }],
  ['namespace-map-replacement', (front) => { front.TEMPLATE_KEY_BY_TYPE = { strategy_brief: 'replacement' }; }],
]) compare('mutable-facade/' + name, ({ front }) => {
  mutate(front);
  const valid = { document_type: 'synthetic_review_type', schema_version: '1.0', state: 'active', scope: 'strategy', strategy_id: 'synthetic-id', authority: 'working_draft', confidentiality: 'client_confidential', source_of_truth: false, as_of: '2026-10-11', valid_until: null };
  return { documentTypeErrors: front.validateFrontmatter(valid).filter((e) => e.field === 'document_type'),
    tuple: front.DOCUMENT_TYPES, map: front.TEMPLATE_KEY_BY_TYPE };
}, { fresh: true });
compare('fresh-output-arrays-and-items', ({ report }) => {
  const docs = [doc('01_strategy_brief', { facts: [], content: '---\n---\n' + headings.map((h, i) => '## ' + h + '\n- Unique statement ' + i + '.').join('\n') })];
  const first = report.assembleReportContext(docs, 'internal', ASOF);
  const snapshot = plain(first);
  first.sections.reverse(); first.sections[0].items[0].text = 'caller mutation'; first.documents.pop(); first.facts.push({ synthetic: true });
  return { second: report.assembleReportContext(docs, 'internal', ASOF), snapshot };
});
for (const [name, sources] of [['front', [originals.front, candidate.front]], ['report', [originals.report, candidate.report]]]) {
  const [old, current] = sources.map((s) => ts.createSourceFile(name + '.ts', s, ts.ScriptTarget.Latest, true));
  for (const node of old.statements.filter(ts.isFunctionDeclaration)) {
    if (['assembleReportContext', 'categoryFor'].includes(node.name.text)) continue;
    const actual = current.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === node.name.text);
    assert.equal(actual.getText(current), node.getText(old), name + '/' + node.name.text);
  }
}
for (const file of ['apps/api-strategy/src/context/frontmatter.spec.ts', 'apps/api-strategy/src/reports/report-context.spec.ts']) {
  const original = git('show', base + ':' + file); assert(fs.readFileSync(file).subarray(0, original.length).equals(original));
}
const registryOutput = ts.transpileModule(candidate.registry, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
assert(!registryOutput.includes('require('));
console.log(JSON.stringify({ base, head, tree: 'a143416a96a04d8626ba67cef9e69803586749e2',
  sourceHashes: { originalFront: sha(originals.front), originalReport: sha(originals.report), front: sha(candidate.front), report: sha(candidate.report), registry: sha(candidate.registry) },
  knownTemplateKeys: known.length, unknownKeys: unknown.length, malformedSameRealmTypeErrors: 5,
  independentlyAuthoredPairedCases: cases.length, originalAndCandidateEvaluations: cases.length * 2,
  publicFacadeRuntimeExportNamesDescriptorsSharedReferencesAndNamespaceReplacementMatch: true,
  originalParserAuthorityDateCleaningFunctionsByteExact: true, originalTestsStrictlyAdditive: true,
  statefulPrefixGetterReceiverAndShortCircuitTracesMatch: true, freshReportResultMutationIsolationMatches: true,
  registryRuntimeImports: 0, cases,
  realServiceProviderDatabaseNetworkPackageManagerNativeOperations: false,
  arbitraryGlobalJavaScriptMutationContainment: false, fullNativeOrGuardAdoptionAcceptance: false,
}, null, 2));
