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
const source = fs.readFileSync(path.join(__dirname, 'cascade.config.before.ts'), 'utf8');
const serviceSource = fs.readFileSync(path.join(__dirname, 'cascade.service.before.ts'), 'utf8');
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

const fixture = path.join(root, 'apps/workspace/test/fixtures/product-registry-before.json');
assert(!fs.existsSync(fixture), 'Do not regenerate a captured before fixture');
assert.equal(hash(source), JSON.parse(fs.readFileSync(path.join(__dirname, 'before-source-bindings.json'), 'utf8')).files[0].sha256);
const beforeFixture = { source: '802bbd0b2c510a44e46a9952d8127e7edc55aaaa', tree: '6c11b1094aadcbf6645e759204f72b6f87c8982a', originalConfigSha256: hash(source), originalServiceSha256: hash(serviceSource), names, sectionInputs, baselineProfile: profile(before), mutationSemantics: mutationProfile(source) };
fs.mkdirSync(path.dirname(fixture), {recursive: true});
fs.writeFileSync(fixture, JSON.stringify(beforeFixture, null, 2) + '\n');
console.log(JSON.stringify({beforeFixtureSha256: hash(fs.readFileSync(fixture)), products: beforeFixture.baselineProfile.products.length, industries: beforeFixture.baselineProfile.industries.length, sections: beforeFixture.baselineProfile.sections.length, libraryProducts: beforeFixture.baselineProfile.allLibraryProducts.length, originalConfigSha256: hash(source), snapshotBeforeAppEdits: true}, null, 2));
