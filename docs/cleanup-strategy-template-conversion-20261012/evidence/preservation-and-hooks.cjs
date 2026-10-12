const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const ts = require('typescript');
const OUT = 'docs/cleanup-strategy-template-conversion-20261012/evidence/';
const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa';
const frontPath = 'apps/api-strategy/src/context/frontmatter.ts';
const reportPath = 'apps/api-strategy/src/reports/report-context.ts';
const registryPath = 'apps/api-strategy/src/context/template-registry.ts';
const oldFront = fs.readFileSync(OUT + 'original-frontmatter.ts', 'utf8');
const oldReport = fs.readFileSync(OUT + 'original-report-context.ts', 'utf8');
const newFront = fs.readFileSync(frontPath, 'utf8'), newReport = fs.readFileSync(reportPath, 'utf8');
const sourceFile = (path, text) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
const oldAsts = { front: sourceFile(frontPath, oldFront), report: sourceFile(reportPath, oldReport) };
const newAsts = { front: sourceFile(frontPath, newFront), report: sourceFile(reportPath, newReport) };
const registry = sourceFile(registryPath, fs.readFileSync(registryPath, 'utf8'));
function named(sf) {
  const rows = new Map();
  for (const node of sf.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) rows.set(node.name.text, node);
    if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) rows.set(d.name.text, node);
  }
  return rows;
}
const unchangedFunctions = {};
for (const [key, before] of Object.entries(oldAsts)) {
  const after = newAsts[key], oldNodes = named(before), newNodes = named(after), kept = [];
  for (const node of before.statements) {
    if (!ts.isFunctionDeclaration(node) || ['assembleReportContext', 'categoryFor'].includes(node.name.text)) continue;
    assert.equal(newNodes.get(node.name.text).getText(after), node.getText(before)); kept.push(node.name.text);
  }
  unchangedFunctions[key] = kept;
}
for (const name of ['CONTEXT_STATES', 'CONTEXT_SCOPES', 'AUTHORITIES', 'CONFIDENTIALITIES', 'DATE_PLACEHOLDER', 'ID_PLACEHOLDERS', 'ID_FIELDS', 'FENCE', 'KEY_VALUE', 'DATE_SHAPE']) {
  assert.equal(named(newAsts.front).get(name).getText(newAsts.front), named(oldAsts.front).get(name).getText(oldAsts.front));
}
for (const name of ['PLACEHOLDER_ONLY', 'PLACEHOLDER_ID', 'IMPORT_SCAFFOLDING']) {
  assert.equal(named(newAsts.report).get(name).getText(newAsts.report), named(oldAsts.report).get(name).getText(oldAsts.report));
}
const oldCategory = named(oldAsts.report).get('categoryFor').getText(oldAsts.report);
const newCategory = named(newAsts.report).get('categoryFor').getText(newAsts.report);
assert.equal(newCategory.split('  return reportFallbackSection(templateKey);')[0], oldCategory.split('  if (templateKey.startsWith("01_"))')[0]);
for (const [file, beforeName] of [['apps/api-strategy/src/context/frontmatter.spec.ts', 'original-frontmatter.spec.ts'], ['apps/api-strategy/src/reports/report-context.spec.ts', 'original-report-context.spec.ts']]) {
  const before = fs.readFileSync(OUT + beforeName), after = fs.readFileSync(file);
  assert(after.subarray(0, before.length).equals(before)); assert(after.length > before.length);
}
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
function statementHash(sf, name) {
  return crypto.createHash('sha256').update(printer.printNode(ts.EmitHint.Unspecified, named(sf).get(name), sf)).digest('hex');
}
const runtimeNames = ['DOCUMENT_TYPES', 'TEMPLATE_KEY_BY_TYPE', 'OPERATIONAL_REPORT_TEMPLATE_KEYS', 'REPORT_SECTION_TITLES', 'REPORT_SECTION_ORDER', 'REPORT_PREFIX_FALLBACKS', 'isOperationalReportTemplate', 'reportFallbackSection'];
const carriers = runtimeNames.map(name => {
  const node = named(registry).get(name);
  assert(node && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  return { file: registryPath, name, kind: ts.isFunctionDeclaration(node) ? 'function' : 'variable', sha256: statementHash(registry, name) };
});
for (const node of registry.statements.filter(ts.isImportDeclaration)) assert(node.importClause.isTypeOnly);
const aliases = ['DOCUMENT_TYPES', 'TEMPLATE_KEY_BY_TYPE'].map(name => ({ file: frontPath, name, sha256: statementHash(newAsts.front, name) }));
function importUses(sf, moduleName) {
  const program = ts.createProgram([sf.fileName], { noLib: true, noResolve: true }, {
    getSourceFile: f => f === sf.fileName ? sf : undefined, getDefaultLibFileName: () => '', writeFile() {},
    getCurrentDirectory: () => '', getDirectories: () => [], fileExists: f => f === sf.fileName,
    readFile: f => f === sf.fileName ? sf.text : undefined, getCanonicalFileName: f => f,
    useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  });
  const checker = program.getTypeChecker(), rows = [];
  for (const n of sf.statements) {
    if (!ts.isImportDeclaration(n) || n.moduleSpecifier.text !== moduleName) continue;
    assert(!n.importClause.isTypeOnly && ts.isNamedImports(n.importClause.namedBindings));
    for (const spec of n.importClause.namedBindings.elements) {
      const symbol = checker.getSymbolAtLocation(spec.name); let uses = 0;
      function visit(node) { if (ts.isTypeNode(node)) return; if (ts.isIdentifier(node) && node !== spec.name && checker.getSymbolAtLocation(node) === symbol) uses++; if (!ts.isImportDeclaration(node)) ts.forEachChild(node, visit); }
      visit(sf); rows.push({ file: sf.fileName, module: moduleName, imported: (spec.propertyName ?? spec.name).text, local: spec.name.text, uses });
    }
  }
  return rows;
}
const ownerEdges = [...importUses(newAsts.front, './template-registry.js'), ...importUses(newAsts.report, '../context/template-registry.js')];
assert.equal(ownerEdges.length, 6);
assert.deepEqual(ownerEdges.map(e => [e.imported, e.uses]).sort(), [['DOCUMENT_TYPES', 1], ['TEMPLATE_KEY_BY_TYPE', 1], ['REPORT_SECTION_ORDER', 1], ['REPORT_SECTION_TITLES', 1], ['isOperationalReportTemplate', 2], ['reportFallbackSection', 1]].sort());
const serviceEdges = [];
for (const name of ['context-import.service.ts', 'context-documents.service.ts', 'steward.service.ts']) {
  const file = 'apps/api-strategy/src/context/' + name;
  const before = cp.execFileSync('git', ['show', base + ':' + file]); assert(fs.readFileSync(file).equals(before));
  serviceEdges.push(...importUses(sourceFile(file, before.toString()), './frontmatter.js').filter(e => ['DOCUMENT_TYPES', 'TEMPLATE_KEY_BY_TYPE'].includes(e.imported)));
}
assert.equal(serviceEdges.length, 4); assert(serviceEdges.every(e => e.uses === 1));
const shared = fs.readFileSync('packages/shared/src/index.ts');
assert(shared.equals(cp.execFileSync('git', ['show', base + ':packages/shared/src/index.ts'])));
assert(fs.readFileSync('scripts/strategy-time-boundaries.json').equals(cp.execFileSync('git', ['show', base + ':scripts/strategy-time-boundaries.json'])));
const result = { base, owner: registryPath, symbols: carriers.map(({ name, kind }) => ({ name, kind })), carriers,
  compatibilityAliases: aliases, canonicalOwnerEdges: ownerEdges, fourOriginalServiceEdgesViaVerifiedFacade: serviceEdges,
  exactUnchangedFunctions: unchangedFunctions, originalHeadingRegexPrefixExact: true,
  authorityDateScalarParserBodyCleaningValidationVocabularyConstantsExact: true,
  bothExistingTestFilesStrictlyAdditive: true, noRuntimeRegistryDependencies: true,
  sharedIndexAndClockDataExactBase: true, publicTypeNameStillDocumentTypeValue: true,
  newGuardDataRootAndCiSourceOwnedByRootNotChangedHere: true,
};
fs.writeFileSync(OUT + 'registry-guard-hooks.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ owner: registryPath, runtimeSymbols: carriers.length, compatibilityAliases: aliases.length, directOwnerBindings: ownerEdges.length, serviceBindings: serviceEdges.length, exactUnchangedFunctions: unchangedFunctions, originalHeadingRegexPrefixExact: true, bothExistingTestsStrictlyAdditive: true }, null, 2));
