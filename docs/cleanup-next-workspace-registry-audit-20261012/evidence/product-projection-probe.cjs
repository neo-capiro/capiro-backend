// Read-only audit. Execute only frozen pure catalog/section helpers and the thin
// CascadeService with an identity Injectable decorator. No shell, bootstrap,
// database, HTTP, model, provider, or proposed production module is executed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require('/workspace/capirov2/node_modules/typescript');
const root = path.resolve(__dirname, '../../..');
const configPath = 'apps/workspace/src/cascade/cascade.config.ts';
const source = fs.readFileSync(path.join(root, configPath), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'apps/workspace/src/cascade/cascade.service.ts'), 'utf8');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
function loadConfig(text) {
  const module = { exports: {} };
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require(id) { throw Error('Unexpected catalog dependency: ' + id); } }, { timeout: 1000 });
  return module.exports;
}
function serviceFor(catalog) {
  const module = { exports: {} };
  const code = ts.transpileModule(serviceSource, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
  } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require(id) {
    if (id === '@nestjs/common') return { Injectable: () => (target) => target };
    assert.equal(id, './cascade.config.js'); return catalog;
  } }, { timeout: 1000 });
  return new module.exports.CascadeService();
}
const before = loadConfig(source);
const maps = ['PRODUCT_META', 'SUGGESTED_SECTIONS', 'SUGGESTED_PAGES'];
const lists = ['CANONICAL_PRODUCTS', 'UNIVERSAL_PRODUCTS', 'FUNDING_PRODUCTS'];
const names = Object.keys(before.PRODUCT_META);
assert.equal(names.length, 11);
for (const map of maps) assert.equal(Object.keys(before[map]).length, 11);
const ranks = (values, name) => values.includes(name) ? values.indexOf(name) : null;
const rows = names.map((name) => ({ name,
  meta: before.PRODUCT_META[name], sections: before.SUGGESTED_SECTIONS[name], pages: before.SUGGESTED_PAGES[name],
  orders: Object.fromEntries([...maps, ...lists].map((key) => [key, ranks(maps.includes(key) ? Object.keys(before[key]) : before[key], name)])),
}));
const prefix = `
const __auditRegistry = ${JSON.stringify(rows)};
const __auditOrdered = (key) => __auditRegistry.filter(row => row.orders[key] !== null).sort((a, b) => a.orders[key] - b.orders[key]);
const __auditList = (key) => __auditOrdered(key).map(row => row.name);
const __auditMap = (key, value) => __auditOrdered(key).reduce((result, row) => { result[row.name] = row[value]; return result; }, {});
`;
const projected = {
  PRODUCT_META: "__auditMap('PRODUCT_META', 'meta')",
  SUGGESTED_SECTIONS: "__auditMap('SUGGESTED_SECTIONS', 'sections')",
  SUGGESTED_PAGES: "__auditMap('SUGGESTED_PAGES', 'pages')",
  CANONICAL_PRODUCTS: "__auditList('CANONICAL_PRODUCTS')",
  UNIVERSAL_PRODUCTS: "__auditList('UNIVERSAL_PRODUCTS')",
  FUNDING_PRODUCTS: "__auditList('FUNDING_PRODUCTS')",
};
const ast = ts.createSourceFile(configPath, source, ts.ScriptTarget.Latest, true);
const replacements = [];
for (const statement of ast.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    const replacement = projected[declaration.name.getText(ast)];
    if (replacement) replacements.push({ start: declaration.initializer.getStart(ast), end: declaration.initializer.end, replacement });
  }
}
assert.equal(replacements.length, 6);
let projectionText = source;
for (const edit of replacements.sort((a, b) => b.start - a.start)) {
  projectionText = projectionText.slice(0, edit.start) + edit.replacement + projectionText.slice(edit.end);
}
projectionText = prefix + projectionText;
// This string exists only in this inert documentation probe, not production.
const after = loadConfig(projectionText);
function capture(work) {
  try {
    const value = work();
    return { ok: true, type: typeof value, json: JSON.stringify(value) ?? null,
      ...(typeof value === 'function' ? { functionName: value.name } : {}) };
  } catch (error) {
    return { ok: false, errorName: error.name, error: error.message };
  }
}
const oddProducts = ['', 'Unknown work product', 'white paper', ' White paper ', 'toString',
  '__proto__', 'constructor', 'hasOwnProperty', 'prototype', 'valueOf'];
const sectionInputs = [...new Set([
  ...Object.values(before.SUGGESTED_SECTIONS).flat(), ...before.SECTION_LIBRARY,
  '', 'unmatched custom heading', 'Summary background', 'Q&A budget',
  'Objectives & the ask', 'Requested amount title', 'Summary report language',
  'opening recommendations', '  Opening', 'THE ASK', 'Funding history background',
  'Authorization of appropriations', 'Effective date funding history',
])];
function profile(catalog) {
  const w = catalog.WSC;
  const service = serviceFor(catalog);
  return {
    serializedExports: Object.fromEntries(['CASCADE', ...lists, ...maps, 'INDUSTRY_DATA', 'SECTION_LIBRARY']
      .map((key) => [key, JSON.stringify(catalog[key])])),
    projectionKeys: Object.fromEntries(maps.map((key) => [key, Object.keys(catalog[key])])),
    allLibraryProducts: w.allLibraryProducts(),
    products: [...names, ...oddProducts].map((product) => ({ product,
      meta: capture(() => w.meta(product)), sections: capture(() => w.suggestedSections(product)),
      pages: capture(() => w.suggestedPages(product)), funding: capture(() => w.isFunding(product)),
      defaults: capture(() => service.defaultsFor(product)),
    })),
    industries: [...w.industries(), 'Unknown industry', '', '__proto__'].map((industry) => ({ industry,
      products: capture(() => w.productsFor(industry)), data: capture(() => w.dataFor(industry)),
      pathways: [...names, 'Unknown work product', '__proto__'].map((product) => ({ product, result: capture(() => w.pathwaysFor(industry, product)) })),
      committees: [[], ['NDAA Authorization'], ['Defense Appropriations', 'NDAA Authorization', 'Defense Appropriations'], ['unknown'], ['__proto__']]
        .map((input) => ({ input, result: capture(() => w.committeesFor(industry, input)) })),
    })),
    sections: sectionInputs.map((name) => ({ name, value: w.specFor(name) })),
    referenceSemantics: {
      knownMetaShared: w.meta(names[0]) === catalog.PRODUCT_META[names[0]],
      unknownMetaFresh: w.meta('unknown') !== w.meta('unknown'),
      sectionsFresh: w.suggestedSections(names[0]) !== w.suggestedSections(names[0]),
      knownDataShared: w.dataFor('Defense & Aerospace') === catalog.INDUSTRY_DATA['Defense & Aerospace'],
      knownPathwaysShared: w.pathwaysFor('Defense & Aerospace', 'NDAA Authorization Request') === catalog.CASCADE[0].products[0].pathways,
      unknownPathwaysFresh: w.pathwaysFor('Defense & Aerospace', 'unknown') !== w.pathwaysFor('Defense & Aerospace', 'unknown'),
      libraryFresh: w.allLibraryProducts() !== w.allLibraryProducts(),
      sameWhiteAndNdaaSectionValues: JSON.stringify(catalog.SUGGESTED_SECTIONS['White paper']) === JSON.stringify(catalog.SUGGESTED_SECTIONS['NDAA Authorization Request']),
      distinctWhiteAndNdaaSectionArrays: catalog.SUGGESTED_SECTIONS['White paper'] !== catalog.SUGGESTED_SECTIONS['NDAA Authorization Request'],
      sectionSpecFresh: w.specFor('Background') !== w.specFor('Background'),
      sectionWordTupleFresh: w.specFor('Background').targetWords !== w.specFor('Background').targetWords,
      unboundReceiver: capture(() => { const detached = w.productsFor; return detached('Defense & Aerospace'); }),
    },
  };
}
function mutationProfile(text) {
  const c = loadConfig(text), w = c.WSC, product = 'NDAA Authorization Request';
  const meta = w.meta(product); meta.cover = !meta.cover;
  const metaMutationVisible = w.meta(product).cover === meta.cover;
  const sections = w.suggestedSections(product); sections.push('caller copy mutation');
  const returnedSectionMutationIsolated = !w.suggestedSections(product).includes('caller copy mutation');
  c.SUGGESTED_SECTIONS[product].push('exported section mutation');
  const exportedSectionMutationVisible = w.suggestedSections(product).includes('exported section mutation');
  c.FUNDING_PRODUCTS.push('exported funding mutation');
  const exportedFundingMutationVisible = w.isFunding('exported funding mutation');
  c.SUGGESTED_PAGES[product] = 0;
  const zeroPagesOrFallbackPreserved = w.suggestedPages(product);
  c.PRODUCT_META = { 'replacement': { icon: 'probe', personalize: false, office: true, cover: false, desc: 'probe' } };
  return { metaMutationVisible, returnedSectionMutationIsolated, exportedSectionMutationVisible,
    exportedFundingMutationVisible, zeroPagesOrFallbackPreserved,
    cjsExportReplacementBehavior: capture(() => w.meta('replacement')),
    cjsConstAliasDescriptor: { enumerable: Object.getOwnPropertyDescriptor(c, 'PRODUCT_META').enumerable,
      writable: Object.getOwnPropertyDescriptor(c, 'PRODUCT_META').writable, getter: !!Object.getOwnPropertyDescriptor(c, 'PRODUCT_META').get } };
}
const baselineProfile = profile(before), projectedProfile = profile(after);
assert.equal(JSON.stringify(baselineProfile), JSON.stringify(projectedProfile));
assert.equal(JSON.stringify(mutationProfile(source)), JSON.stringify(mutationProfile(projectionText)));
assert.equal(before.WSC.allLibraryProducts().length, 11);
assert.equal(before.CANONICAL_PRODUCTS.length, 10);
const frontendPath = 'apps/web/src/pages/workspace/SetupPage.tsx';
const frontend = fs.readFileSync(path.join(root, frontendPath), 'utf8');
const frontendAst = ts.createSourceFile(frontendPath, frontend, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const mirrored = [];
for (const key of ['CASCADE', 'UNIVERSAL_PRODUCTS', ...maps]) {
  const declaration = frontendAst.statements.filter(ts.isVariableStatement)
    .flatMap((s) => [...s.declarationList.declarations]).find((d) => d.name.getText(frontendAst) === key);
  assert(declaration);
  const value = loadConfig(`export const datum = ${declaration.initializer.getText(frontendAst)};`).datum;
  mirrored.push({ declaration: key, entries: Array.isArray(value) ? value.length : Object.keys(value).length,
    exactSerializedValue: JSON.stringify(value) === JSON.stringify(before[key]) });
}
console.log(JSON.stringify({
  source: '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70', tree: 'f14d6fa3f191645839414972063e1057fce557bf',
  originalConfigSha256: hash(source), originalServiceSha256: hash(serviceSource),
  productRows: rows, originalMapKeys: baselineProfile.projectionKeys,
  canonicalCount: before.CANONICAL_PRODUCTS.length, universalCount: before.UNIVERSAL_PRODUCTS.length,
  fundingCount: before.FUNDING_PRODUCTS.length, libraryCount: before.WSC.allLibraryProducts().length,
  cascadePresetOccurrences: before.CASCADE.reduce((n, i) => n + i.products.length, 0),
  industryCount: before.CASCADE.length, sectionInputs: sectionInputs.length,
  productProfiles: baselineProfile.products.length, industryProfiles: baselineProfile.industries.length,
  frozenOldSourceAndDocsOnlyProjectionEquivalent: true,
  serializedDataAndLookupAndFallbackAndFailureValuesExact: true,
  identityAndMutationSemanticsExact: true, prototypeFailuresPreserved: true,
  mutationSemantics: mutationProfile(source), baselineProfile,
  legacyFrontendMirror: { path: frontendPath, sha256: hash(frontend), declarations: mirrored, sourceEdited: false },
  productionSourceEdits: false, proposedRegistryImplemented: false,
  shellOrProviderOrDatabaseOrBootstrapCalled: false, nativeAcceptance: false, fullCleanupAcceptance: false,
}, null, 2));
