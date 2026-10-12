const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript');
const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa';
const source = '8834c1d76659b343fb37c60733fa1dd618a06db9';
const evidence = '9b1d3dc10be2f175b0d1154850895925b264d8c2';
const packet = 'docs/cleanup-strategy-template-conversion-20261012/';
const git = (...args) => execFileSync('git', args);
const blob = (pin, file) => git('show', pin + ':' + file);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const authorIndex = JSON.parse(blob(evidence, packet + 'SHA256.json'));
const authorRows = Object.entries(authorIndex);
for (const [file, sha256] of authorRows) assert.equal(hash(blob(evidence, packet + file)), sha256, file);
const changes = git('diff', '--name-only', base, source).toString().trim().split('\n');
const expected = ['apps/api-strategy/src/context/frontmatter.spec.ts', 'apps/api-strategy/src/context/frontmatter.ts',
  'apps/api-strategy/src/context/template-registry.spec.ts', 'apps/api-strategy/src/context/template-registry.ts',
  'apps/api-strategy/src/reports/report-context.spec.ts', 'apps/api-strategy/src/reports/report-context.ts'];
assert.deepEqual(changes.sort(), expected.sort());
const authorChanges = git('diff', '--name-only', source, evidence).toString().trim().split('\n');
assert(authorChanges.every((p) => p.startsWith(packet)));
function array(file, name, property) {
  const bytes = fs.readFileSync(file); assert(bytes.equals(blob(base, file)));
  const sf = ts.createSourceFile(file, bytes.toString(), ts.ScriptTarget.Latest, true);
  const declaration = sf.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations]).find((d) => d.name.getText(sf) === name);
  assert(declaration);
  let initializer = declaration.initializer;
  while (ts.isAsExpression(initializer)) initializer = initializer.expression;
  assert(ts.isArrayLiteralExpression(initializer));
  return initializer.elements.map((node) => {
    if (property) node = node.properties.find((p) => p.name?.getText(sf) === property).initializer;
    assert(ts.isStringLiteral(node)); return node.text;
  });
}
const importTypes = array('apps/meriv2-orchestrator/src/meri/steward/context-import-prompt.ts', 'CONTEXT_IMPORT_TYPES');
const uiTypes = array('apps/web/src/vnext/pages/strategies/context/context-categories.ts', 'CONTEXT_CATEGORIES', 'key');
assert.equal(importTypes.length, 14); assert.deepEqual(uiTypes, importTypes);
const required = array('apps/api-strategy/src/context/steward.service.ts', 'REQUIRED_TEMPLATE_KEYS');
const priority = array('apps/meriv2-orchestrator/src/meri/strategy/strategy-prompt.ts', 'STEWARD_REQUIRED_TEMPLATE_KEYS');
assert.deepEqual(required, ['strategy_brief', 'client_constraints']);
assert.deepEqual(priority, ['01_strategy_brief', '02_client_constraints', '03_ask_and_options']);
const stableGuards = ['isClientSafeContextFrontmatter', 'includeContextDocument', 'contextMetadata'];
const reportFile = 'apps/api-strategy/src/reports/report-context.ts';
const oldReport = ts.createSourceFile(reportFile, blob(base, reportFile).toString(), ts.ScriptTarget.Latest, true);
const newReport = ts.createSourceFile(reportFile, blob(source, reportFile).toString(), ts.ScriptTarget.Latest, true);
const guardRows = stableGuards.map((name) => {
  const old = oldReport.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  const current = newReport.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(current.getText(newReport), old.getText(oldReport));
  return { name, sha256: hash(old.getText(oldReport)), byteExact: true };
});
const frontFile = 'apps/api-strategy/src/context/frontmatter.ts';
const oldFront = ts.createSourceFile(frontFile, blob(base, frontFile).toString(), ts.ScriptTarget.Latest, true);
const currentFront = ts.createSourceFile(frontFile, blob(source, frontFile).toString(), ts.ScriptTarget.Latest, true);
const metadata = ts.createSourceFile('registry.ts', blob(source, 'apps/api-strategy/src/context/template-registry.ts').toString(), ts.ScriptTarget.Latest, true);
for (const name of ['DOCUMENT_TYPES', 'TEMPLATE_KEY_BY_TYPE']) {
  const original = oldFront.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations]).find((d) => d.name.getText(oldFront) === name);
  const owned = metadata.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations]).find((d) => d.name.getText(metadata) === name);
  assert.equal(owned.initializer.getText(metadata), original.initializer.getText(oldFront));
}
const currentGolden = blob(evidence, packet + 'evidence/original-802-golden.json');
const golden = JSON.parse(currentGolden);
assert.equal(golden.source, base);
for (const [name, file] of [['front', frontFile], ['report', reportFile]]) assert.equal(hash(blob(base, file)), golden.pureFrozenSourceHashes[name]);
console.log(JSON.stringify({ base, reviewedSource: source, reviewedTree: 'a143416a96a04d8626ba67cef9e69803586749e2',
  authorEvidence: evidence, authorEvidenceTree: git('rev-parse', evidence + '^{tree}').toString().trim(),
  authorEvidenceHashRowsVerified: authorRows.length, authorDocumentationOnlyPaths: authorChanges.length,
  exactSixApplicationPaths: changes, originalMetadataInitializerBytesExact: true,
  reportGuardRows: guardRows, intentionalOrchestratorImportSubset: importTypes, intentionalUiSubset: uiTypes,
  strategyStewardRequired: required, orchestratorPriority: priority, profilesNotCollapsed: true,
  goldenOriginalHashVerified: hash(currentGolden), originalGoldenNotRegenerated: true,
  productionModulesExecuted: false, sourceEditsByReviewer: false,
  nativeDatabaseProviderPackageManagerOrRootGuardAdoptionAcceptance: false,
}, null, 2));
