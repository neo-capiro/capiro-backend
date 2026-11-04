'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const helper = require('./runtime-closure-contract.cjs');
const frozen = require('../../../../docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const target = { os: 'linux', cpu: 'arm64', libc: 'musl' };
const optional = { dependencyKind: 'optionalDependencies', physicalRequired: false };
const observed = [
  ['linux-arm64', 'glibc', 'a341210933888b7305d518dd52ca1fe9b060a88f66d493559b5217c539a7e5c2'],
  ['linux-arm64-musl', 'musl', '32ecd14d02faddb449e14be5b4d485a637d5353c0363c9019db7bd7d1d257e66'],
].map(([suffix, libc, manifestSHA256]) => {
  // Reconstructed manifest bytes must hash-match the retained build110 observation.
  // No archive download, install, native binary or SDK invocation is performed.
  const metadata = { name: `@anthropic-ai/claude-agent-sdk-${suffix}`, version: '0.3.318',
    description: `Native CLI binary for @anthropic-ai/claude-agent-sdk on ${suffix}`,
    os: ['linux'], cpu: ['arm64'], libc: [libc], files: ['claude', 'README.md', 'LICENSE.md'],
    license: 'SEE LICENSE IN LICENSE.md' };
  const bytes = JSON.stringify(metadata) + '\n';
  assert.equal(hash(bytes), manifestSHA256);
  const node = frozen.nodes.find(row => row.key === `${metadata.name}@${metadata.version}`);
  assert(node);
  return { node, bytes, owner: { metadata, manifestSHA256 } };
});

test('retained SDK manifest pins reconcile only omitted libc and retain execution distinction', () => {
  for (const { node, owner } of observed) {
    assert.equal(node.libc, null);
    const result = helper.ownerPlatformAdmission(node, owner, target, optional);
    assert.deepEqual(result.platform.libc, owner.metadata.libc);
    assert.equal(result.evidence.basis, 'EXACT_LOCK_AND_RETAINED_BUILD_MANIFEST');
    assert.equal(result.evidence.integrity, node.resolution.integrity);
    assert.equal(result.evidence.buildLogSHA256, '73aac8a22d47fffd794edbbf4dce4168405dd111b14daab9cde6b554c2f4c5eb');
    assert.equal(result.executionAllowed, owner.metadata.libc[0] === 'musl');
    assert.equal(result.state, owner.metadata.libc[0] === 'musl' ? 'TARGET_COMPATIBLE' : 'INACTIVE_INCOMPATIBLE_OPTIONAL');
  }
});

test('SDK reconciliation rejects changed archive, manifest, version and platform constraints', () => {
  for (const { node, owner } of observed) {
    for (const changed of [
      { ...node, resolution: { integrity: 'sha512-foreign' } }, { ...node, version: '0.3.319' },
      { ...node, os: ['darwin'] }, { ...node, cpu: ['x64'] }, { ...node, libc: ['musl'] },
    ]) assert.throws(() => helper.reconciledPlatform(changed, owner));
    assert.throws(() => helper.reconciledPlatform(node, { ...owner, manifestSHA256: '0'.repeat(64) }), /manifest bytes/);
    assert.throws(() => helper.reconciledPlatform(node, { ...owner, metadata: { ...owner.metadata, libc: ['foreign'] } }), /libc metadata/);
  }
  const { node, owner } = observed[0];
  for (const relation of [undefined, { dependencyKind: 'dependencies', physicalRequired: true },
    { dependencyKind: 'optionalDependencies', physicalRequired: true }])
    assert.throws(() => helper.ownerPlatformAdmission(node, owner, target, relation), /incompatible with target/);
});

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n');
}
function fixture(t, { missing = [], requiredGlibc = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-sdk-platform-'));
  // Retain this owned static fixture; the correction allocation forbids cleanup.
  t.diagnostic(`Retained static fixture: ${temp}`);
  const imageRoot = path.join(temp, 'app'), qualificationRoot = path.join(temp, 'qualification');
  const contract = { schemaVersion: 1, inputSHA256: {}, roots: [], nodes: observed.map(row => row.node), edges: [], unresolvedEdges: [] };
  for (const dir of ['apps/api', 'packages/shared', 'packages/meriv2-core', 'packages/defense-contracts', 'packages/defense-domain']) {
    const name = '@capiro/' + path.basename(dir), manifest = { name, version: '0.0.0' };
    if (dir === 'apps/api') for (const { node } of observed) {
      const kind = requiredGlibc && node.name === observed[0].node.name ? 'dependencies' : 'optionalDependencies';
      (manifest[kind] ||= {})[node.name] = node.version;
      contract.edges.push({ from: 'importer:apps/api', to: node.key, dependencyName: node.name, kind });
    }
    const file = path.join(imageRoot, dir, 'package.json'); write(file, manifest);
    contract.inputSHA256[dir + '/package.json'] = hash(fs.readFileSync(file));
    contract.roots.push({ key: 'importer:' + dir, path: dir, name, version: '0.0.0' });
  }
  fs.mkdirSync(path.join(imageRoot, 'node_modules/.pnpm'), { recursive: true });
  const locations = new Map();
  for (const row of observed) if (!missing.includes(row.owner.metadata.libc[0])) {
    const root = path.join(imageRoot, 'node_modules/.pnpm', row.node.key.replace('/', '+'), 'node_modules', row.node.name);
    write(path.join(root, 'package.json'), row.bytes); locations.set(row.node.name, root);
  }
  write(path.join(qualificationRoot, 'root-package.json'), { private: true });
  write(path.join(qualificationRoot, 'pnpm-lock.yaml'), 'synthetic-static-fixture-only\n');
  for (const [source, destination] of [['package.json', 'root-package.json'], ['pnpm-lock.yaml', 'pnpm-lock.yaml']])
    contract.inputSHA256[source] = hash(fs.readFileSync(path.join(qualificationRoot, destination)));
  const contractFile = path.join(qualificationRoot, 'contract.json'); write(contractFile, contract);
  return { imageRoot, locations, options: { imageRoot, qualificationRoot, contractFile, target,
    expectedSHA256: hash(fs.readFileSync(contractFile)),
    resolve: (parent, name) => parent.metadata.name === '@capiro/api' && locations.has(name)
      ? helper.readPackage(locations.get(name)) : null } };
}

test('installed SDK siblings retain exact owners while native artifact admission remains closed', t => {
  const f = fixture(t), result = helper.verifyInstalledClosure(f.options);
  assert.equal(result.status, 'PASS_EXACT_INSTALLED_PRODUCTION_CLOSURE');
  assert.equal(result.owners.length, 2);
  for (const owner of result.owners) {
    assert.equal(owner.platformAdmission.executionAllowed, owner.metadata.libc[0] === 'musl');
    const binary = path.join(owner.root, 'claude'); write(binary, 'static fixture, never executable');
    assert.throws(() => helper.artifactOwner(binary, result), /unreviewed native artifact owner\/path/);
  }
});

test('missing compatible musl and required glibc siblings still hold; incompatible optional absence is explicit', t => {
  for (const options of [{ missing: ['musl'] }, { requiredGlibc: true }, { requiredGlibc: true, missing: ['glibc'] }]) {
    const f = fixture(t, options);
    assert.throws(() => helper.verifyInstalledClosure(f.options), /unproven missing|incompatible with target/);
  }
  const f = fixture(t, { missing: ['glibc'] }), result = helper.verifyInstalledClosure(f.options);
  assert.equal(result.owners.length, 1);
  assert.equal(result.missingOptional[0].reason, 'RETAINED_BUILD_BOUND_PLATFORM_INCOMPATIBLE');
  assert.deepEqual(result.missingOptional[0].platform.libc, ['glibc']);
});

test('changed physical SDK owner bytes and unrecognized store owners are still refused', t => {
  const f = fixture(t), location = f.locations.get(observed[1].node.name);
  write(path.join(location, 'package.json'), { ...observed[1].owner.metadata, description: 'tampered' });
  assert.throws(() => helper.verifyInstalledClosure(f.options), /manifest bytes/);
  const g = fixture(t);
  write(path.join(g.imageRoot, 'node_modules/.pnpm/foreign@1/node_modules/foreign/package.json'), { name: 'foreign', version: '1' });
  assert.throws(() => helper.verifyInstalledClosure(g.options), /unexpected\/unreachable physical package owner/);
});
