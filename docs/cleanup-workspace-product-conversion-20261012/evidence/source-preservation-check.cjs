const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript');
const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa';
const evidence = __dirname + '/';
const configPath = 'apps/workspace/src/cascade/cascade.config.ts';
const registryPath = 'apps/workspace/src/cascade/workspace-product.registry.ts';
const before = fs.readFileSync(evidence + 'cascade.config.before.ts', 'utf8');
const after = fs.readFileSync(configPath, 'utf8');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
assert.equal(before, execFileSync('git', ['show', base + ':' + configPath]).toString());
const original = ts.createSourceFile('before.ts', before, ts.ScriptTarget.Latest, true);
const candidate = ts.createSourceFile(configPath, after, ts.ScriptTarget.Latest, true);
const declaration = (sf, name) => {
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      const d = s.declarationList.declarations.find((d) => d.name.getText(sf) === name);
      if (d) return d;
    }
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
  }
  throw Error('Missing declaration: ' + name);
};
const preserved = ['WSC', 'sectionSpecFor', 'INDUSTRY_DATA', 'SECTION_LIBRARY'].map((name) => {
  const text = declaration(original, name).getText(original);
  assert.equal(declaration(candidate, name).getText(candidate), text);
  return { name, sha256: sha(text), byteExact: true };
});
for (const s of original.statements.filter(ts.isInterfaceDeclaration)) {
  const actual = candidate.statements.find((n) => ts.isInterfaceDeclaration(n) && n.name.text === s.name.text);
  assert.equal(actual.getText(candidate), s.getText(original));
}
const projectionRoles = {
  PRODUCT_META: 'WORKSPACE_PRODUCT_METADATA', SUGGESTED_SECTIONS: 'WORKSPACE_PRODUCT_SECTIONS',
  SUGGESTED_PAGES: 'WORKSPACE_PRODUCT_PAGES', CANONICAL_PRODUCTS: 'WORKSPACE_PRODUCT_CANONICAL',
  UNIVERSAL_PRODUCTS: 'WORKSPACE_PRODUCT_UNIVERSAL', FUNDING_PRODUCTS: 'WORKSPACE_PRODUCT_FUNDING',
};
const edits = [];
for (const [name, expected] of Object.entries(projectionRoles)) {
  const node = declaration(candidate, name);
  assert.equal(node.initializer.getText(candidate), expected);
  edits.push({ start: node.initializer.getStart(candidate), end: node.initializer.end,
    value: declaration(original, name).initializer.getText(original) });
}
const originalNames = [], actualNames = [];
const collectNames = (sf, target) => {
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'name') target.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(declaration(sf, 'CASCADE').initializer);
};
collectNames(original, originalNames); collectNames(candidate, actualNames);
assert.equal(originalNames.length, 19); assert.equal(actualNames.length, 19);
const keys = JSON.parse(fs.readFileSync(evidence + 'registry-projection-orders.json', 'utf8')).namesToDescriptorKeys;
for (let index = 0; index < originalNames.length; index++) {
  const old = originalNames[index], current = actualNames[index];
  assert.equal(current.getText(candidate), 'WORKSPACE_PRODUCT_REGISTRY.' + keys[old.text] + '.name');
  edits.push({ start: current.getStart(candidate), end: current.end, value: old.getText(original) });
}
const imports = candidate.statements.filter(ts.isImportDeclaration);
assert.equal(imports.length, 1);
assert.equal(imports[0].moduleSpecifier.text, './workspace-product.registry.js');
let importEnd = imports[0].end;
assert.equal(after.slice(importEnd, importEnd + 2), '\n\n'); importEnd += 2;
edits.push({ start: imports[0].getStart(candidate), end: importEnd, value: '' });
let reconstructed = after;
for (const e of edits.sort((a, b) => b.start - a.start)) reconstructed = reconstructed.slice(0, e.start) + e.value + reconstructed.slice(e.end);
assert.equal(reconstructed, before, 'Only six initializers, nineteen references and one import may differ');
const registry = fs.readFileSync(registryPath, 'utf8');
const compiled = ts.transpileModule(registry, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
assert(!compiled.includes('require('), 'Registry back-reference must remain type-only');
const fixturePath = 'apps/workspace/test/fixtures/product-registry-before.json';
const fixtureHash = sha(fs.readFileSync(fixturePath));
assert.equal(fixtureHash, '5b9e9a08b8ede106fa19ed8ff7f1341a1ff65729e8296c45ae2b328c37a01d9c');
for (const [path, copy] of [
  ['apps/workspace/src/cascade/cascade.service.ts', 'cascade.service.before.ts'],
  ['apps/workspace/test/cascade.spec.ts', 'cascade.spec.before.ts'],
]) {
  assert(fs.readFileSync(path).equals(fs.readFileSync(evidence + copy)));
  assert(fs.readFileSync(path).equals(execFileSync('git', ['show', base + ':' + path])));
}
const sourcePaths = [configPath, registryPath, 'apps/workspace/test/product-registry-characterization.spec.ts', fixturePath];
console.log(JSON.stringify({ base, baseTree: '6c11b1094aadcbf6645e759204f72b6f87c8982a', preserved,
  originalConfigRestoredByteExactByOnlyAllowedEdits: true, compatibilityConstAliases: projectionRoles,
  cascadeDescriptorReferences: actualNames.length, registryRuntimeImports: 0, beforeFixtureSha256: fixtureHash,
  existingCascadeServiceAndSpecByteExact: true, publicInterfacesByteExact: true,
  sourceFiles: sourcePaths.map((path) => ({ path, sha256: sha(fs.readFileSync(path)) })),
  fieldApiDtoSchemaRouteDelta: 0, nativeOrFullCleanupAcceptance: false,
}, null, 2));
