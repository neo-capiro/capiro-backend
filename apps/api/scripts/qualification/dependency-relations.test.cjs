/* Offline declaration and mocked physical-resolution fixtures; no vendor execution. */
const assert = require('node:assert/strict'), test = require('node:test');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const helper = require('./runtime-closure-contract.cjs');
const edge = { from: 'parent@1', to: 'child@1', dependencyName: 'child', kind: 'optionalDependencies' };
const peer = { peerDependencies: { child: '^1' }, peerDependenciesMeta: { child: { optional: true } } };
const node = { key: 'parent@1', ...peer };
const direct = { dependencies: { child: '^1' }, ...peer };
test('optional peer snapshot placement preserves a required direct dependency', () => {
  const value = helper.classifyDependencyRelations(direct, node, [edge]).get('child');
  assert.equal(value.physicalRequired, true); assert.equal(value.snapshotKind, 'optionalDependencies');
  assert.equal(value.basis, 'FROZEN_OPTIONAL_PEER_PLACEMENT_WITH_REQUIRED_DIRECT_DEPENDENCY');
});
test('explicit optional dependency overrides same-name direct dependency', () => {
  const value = helper.classifyDependencyRelations({ ...direct, optionalDependencies: { child: '^1' } }, node, [edge]).get('child');
  assert.equal(value.physicalRequired, false); assert.equal(value.declaredKind, 'optionalDependencies');
});
test('exception requires exact frozen and installed optional peer declarations', () => {
  const cases = [
    [{ dependencies: { child: '^1' } }, node],
    [direct, { key: node.key }],
    [{ ...direct, peerDependencies: { child: '^2' } }, node],
    [{ ...direct, peerDependenciesMeta: { child: { optional: 'true' } } }, node],
    [direct, { ...node, peerDependenciesMeta: { child: { optional: false } } }],
    [{ ...direct, peerDependencies: { child: '' } }, { ...node, peerDependencies: { child: '' } }],
  ];
  for (const [metadata, frozen] of cases) assert.throws(() => helper.classifyDependencyRelations(metadata, frozen, [edge]), /relation differs/);
});
test('reverse kind mismatch and unlocked direct declarations still hold', () => {
  assert.throws(() => helper.classifyDependencyRelations({ optionalDependencies: { child: '^1' } }, node, [{ ...edge, kind: 'dependencies' }]), /relation differs/);
  assert.throws(() => helper.classifyDependencyRelations(direct, node, []), /unlocked/);
});
test('required and optional peer-only placements preserve existing graph obligations', () => {
  assert.equal(helper.classifyDependencyRelations(peer, node, [edge]).size, 0);
  assert.equal(helper.classifyDependencyRelations({ peerDependencies: { child: '^1' } }, node, [{ ...edge, kind: 'dependencies' }]).size, 0);
});
test('all 515 frozen nodes and 1011 edges retain their exact placement; every optional-peer overlap stays physically required', () => {
  const contract = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json')));
  assert.equal(contract.nodes.length, 515); assert.equal(contract.edges.length, 1011);
  const before = JSON.stringify(contract), nodes = new Map(contract.nodes.map(n => [n.key, n]));
  let overlaps = 0;
  for (const relation of contract.edges) {
    const parent = nodes.get(relation.from), name = relation.dependencyName;
    if (parent && relation.kind === 'optionalDependencies' && parent.peerDependenciesMeta?.[name]?.optional === true) {
      overlaps++;
      const metadata = { dependencies: { [name]: 'synthetic-direct-range' }, peerDependencies: parent.peerDependencies, peerDependenciesMeta: parent.peerDependenciesMeta };
      const selected = helper.classifyDependencyRelations(metadata, parent, [relation]).get(name);
      assert.equal(selected.physicalRequired, true);
    }
  }
  assert.equal(overlaps, 11); assert.equal(JSON.stringify(contract), before);
});
const fixtureSource = fs.readFileSync(path.join(__dirname, 'runtime-closure-contract.test.cjs'), 'utf8');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fixture = vm.runInNewContext(fixtureSource.slice(fixtureSource.indexOf('function write('), fixtureSource.indexOf("test('exact five-root")) + '\nfixture;', { fs, path, os, hash, Buffer });
function vendorFixture(t, { missing = false, incompatible = false, optional = false, wrongVersion = false } = {}) {
  const f = fixture(t, { missing, incompatible });
  const parentRoot = path.join(f.imageRoot, 'node_modules/.pnpm/parent@1/node_modules/parent');
  fs.mkdirSync(parentRoot, { recursive: true });
  const name = f.pkg.name, declared = { dependencies: { [name]: '0.28.2' }, peerDependencies: { [name]: '0.28.2' }, peerDependenciesMeta: { [name]: { optional: true } } };
  if (optional) declared.optionalDependencies = { [name]: '0.28.2' };
  fs.writeFileSync(path.join(parentRoot, 'package.json'), JSON.stringify({ name: 'parent', version: '1', ...declared }));
  const apiFile = path.join(f.imageRoot, 'apps/api/package.json');
  fs.writeFileSync(apiFile, JSON.stringify({ name: '@capiro/api', version: '0.0.0', dependencies: { parent: '1' } }));
  f.contract.inputSHA256['apps/api/package.json'] = hash(fs.readFileSync(apiFile));
  f.contract.nodes.push({ key: 'parent@1', name: 'parent', version: '1', resolution: { integrity: 'sha512-fixture' }, os: null, cpu: null, libc: null, peerDependencies: declared.peerDependencies, peerDependenciesMeta: declared.peerDependenciesMeta });
  f.contract.edges = [{ from: 'importer:apps/api', to: 'parent@1', dependencyName: 'parent', kind: 'dependencies' }, { from: 'parent@1', to: f.contract.nodes[0].key, dependencyName: name, kind: 'optionalDependencies' }];
  if (wrongVersion) fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ ...f.pkg, version: '0.28.1' }));
  f.options.resolve = (owner, dependency) => dependency === 'parent' ? helper.readPackage(parentRoot) : !missing && owner.metadata.name === 'parent' && dependency === name ? helper.readPackage(f.root) : null;
  f.seal(); return f;
}
test('full closure accepts corroborated overlap with exact physical owner', t => {
  const f = vendorFixture(t); assert.equal(helper.verifyInstalledClosure(f.options).visitedNodes, 7);
});
test('direct dependency cannot be absent even when optional-peer target is platform incompatible', t => {
  for (const incompatible of [false, true]) {
    const f = vendorFixture(t, { missing: true, incompatible });
    assert.throws(() => helper.verifyInstalledClosure(f.options), /required or unproven missing/);
  }
});
test('genuine optional dependency still needs positive incompatible-platform absence proof', t => {
  const f = vendorFixture(t, { optional: true, missing: true, incompatible: true });
  assert.equal(helper.verifyInstalledClosure(f.options).missingOptional.length, 1);
  const g = vendorFixture(t, { optional: true, missing: true });
  assert.throws(() => helper.verifyInstalledClosure(g.options), /unproven missing/);
});
test('overlap does not waive exact owner version or installed target compatibility', t => {
  for (const options of [{ wrongVersion: true }, { incompatible: true }]) {
    const f = vendorFixture(t, options); assert.throws(() => helper.verifyInstalledClosure(f.options), /exact package mismatch|incompatible with target/);
  }
});
