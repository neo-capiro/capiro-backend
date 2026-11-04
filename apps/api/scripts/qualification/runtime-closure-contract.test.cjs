const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyInstalledClosure, readPackage, readContract, walkRuntime, artifactOwner, lockedWasmEvidence, resolveDependency, classifyDependencyRelations } = require('./runtime-closure-contract.cjs');
const { inspectArtifact } = require('./alpine-runtime-probe.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
test('repository production contract is admitted by the default frozen pin', t => {
  const root = path.resolve(__dirname, '../../../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-runtime-contract-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const imageRoot = path.join(temp, 'app'), qualificationRoot = path.join(temp, 'qualification');
  // The release archive contains LF Git text, even from a Windows checkout.
  const archiveText = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
  const contractText = archiveText('docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json');
  const contractFile = path.join(qualificationRoot, 'RUNTIME-CLOSURE-CONTRACT.json');
  write(contractFile, contractText);
  for (const file of Object.keys(JSON.parse(contractText).inputSHA256)) {
    const destination = file === 'package.json' ? path.join(qualificationRoot, 'root-package.json') :
      file === 'pnpm-lock.yaml' ? path.join(qualificationRoot, file) : path.join(imageRoot, file);
    write(destination, archiveText(file));
  }
  const options = { contractFile, imageRoot, qualificationRoot };
  // Unlike synthetic fixtures, exercise the real default without supplying expectedSHA256.
  assert.equal(readContract(options).contractSHA256, hash(contractText));
  assert.throws(() => readContract({ ...options,
    expectedSHA256: 'a38f5d6c7f0f567eb0fd300257895d3e57eb50c0faee50bdd9247b3daae68e00',
  }), /frozen contract hash/, 'the previously shipped stale pin must still be refused');
});
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n');
}
function fixture(t, { optional = false, missing = false, incompatible = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-closure-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const imageRoot = path.join(temp, 'app'), qualificationRoot = path.join(temp, 'qualification');
  const roots = ['apps/api', 'packages/shared', 'packages/meriv2-core', 'packages/defense-contracts', 'packages/defense-domain'];
  const contract = { schemaVersion: 1, inputSHA256: {}, roots: [], nodes: [], edges: [], unresolvedEdges: [] };
  for (const dir of roots) {
    const name = '@capiro/' + path.basename(dir), manifest = { name, version: '0.0.0' };
    if (dir === 'apps/api') manifest[optional ? 'optionalDependencies' : 'dependencies'] = { '@esbuild/linux-arm64': '0.28.2' };
    const file = path.join(imageRoot, dir, 'package.json'); write(file, manifest);
    contract.inputSHA256[dir + '/package.json'] = hash(fs.readFileSync(file));
    contract.roots.push({ key: 'importer:' + dir, path: dir, name, version: '0.0.0' });
  }
  const pkg = { name: '@esbuild/linux-arm64', version: '0.28.2', os: ['linux'], cpu: [incompatible ? 'x64' : 'arm64'] };
  const root = path.join(imageRoot, 'node_modules/.pnpm/@esbuild+linux-arm64@0.28.2/node_modules/@esbuild/linux-arm64');
  fs.mkdirSync(path.join(imageRoot, 'node_modules/.pnpm'), { recursive: true });
  if (!missing) {
    write(path.join(root, 'package.json'), pkg);
  }
  contract.nodes.push({ key: '@esbuild/linux-arm64@0.28.2', ...pkg, libc: null, resolution: { integrity: 'sha512-fixture-not-vendor-admission' } });
  contract.edges.push({ from: 'importer:apps/api', to: contract.nodes[0].key, dependencyName: pkg.name, kind: optional ? 'optionalDependencies' : 'dependencies' });
  write(path.join(qualificationRoot, 'root-package.json'), { private: true });
  write(path.join(qualificationRoot, 'pnpm-lock.yaml'), 'synthetic-lock-only\n');
  for (const [source, target] of [['package.json', 'root-package.json'], ['pnpm-lock.yaml', 'pnpm-lock.yaml']]) contract.inputSHA256[source] = hash(fs.readFileSync(path.join(qualificationRoot, target)));
  const contractFile = path.join(qualificationRoot, 'contract.json');
  // Resolver boundary is mocked: this sandbox denies real junction creation (EPERM).
  const options = { imageRoot, qualificationRoot, contractFile, resolve: (parent, name) => {
    if (!missing && name === pkg.name && ['@capiro/api', '@capiro/shared'].includes(parent.metadata.name)) return readPackage(fs.realpathSync(root));
    return null;
  } };
  const seal = () => { write(contractFile, contract); options.expectedSHA256 = hash(fs.readFileSync(contractFile)); };
  seal(); return { temp, imageRoot, root, pkg, contract, options, seal };
}
test('exact five-root graph resolves required owner with snapshot, integrity and manifest evidence', t => {
  const f = fixture(t), result = verifyInstalledClosure(f.options);
  assert.equal(result.status, 'PASS_EXACT_INSTALLED_PRODUCTION_CLOSURE'); assert.equal(result.visitedNodes, 6);
  assert.equal(result.owners[0].snapshot, '@esbuild/linux-arm64@0.28.2'); assert.equal(result.edges.length, 1);
  assert.equal(result.traversal.files.filter(p => p.endsWith('package.json')).length, 6);
});
test('missing required or compatible optional dependency holds; declared incompatible optional absence is explicit', t => {
  for (const optional of [false, true]) {
    const f = fixture(t, { optional, missing: true }); assert.throws(() => verifyInstalledClosure(f.options), /unproven missing/);
  }
  const f = fixture(t, { optional: true, missing: true, incompatible: true }), result = verifyInstalledClosure(f.options);
  assert.equal(result.missingOptional[0].reason, 'LOCK_DECLARED_PLATFORM_INCOMPATIBLE'); assert.equal(result.owners.length, 0);
});
test('extra dev-only store owner is rejected even when no binary exists', t => {
  const f = fixture(t); write(path.join(f.imageRoot, 'node_modules/.pnpm/dev-only@1/node_modules/dev-only/package.json'), { name: 'dev-only', version: '1' });
  assert.throws(() => verifyInstalledClosure(f.options), /unexpected\/unreachable/);
});
test('unindexed physical, nested or generated package outside graph holds', t => {
  for (const relative of ['node_modules/stray/package.json', 'node_modules/.pnpm/node_modules/stray/package.json', 'node_modules/.pnpm/@esbuild+linux-arm64@0.28.2/node_modules/.prisma/stray/package.json']) {
    const f = fixture(t); write(path.join(f.imageRoot, relative), { name: 'stray', version: '1' });
    assert.throws(() => verifyInstalledClosure(f.options), /unexplained installed\/nested/);
  }
});
test('wrong exact version or platform metadata cannot impersonate expected owner', t => {
  for (const change of [{ version: '0.28.3' }, { cpu: ['x64'] }]) {
    const f = fixture(t); write(path.join(f.root, 'package.json'), { ...f.pkg, ...change });
    assert.throws(() => verifyInstalledClosure(f.options), /exact package mismatch|metadata differs/);
  }
  const optional = fixture(t, { optional: true, incompatible: true });
  assert.throws(() => verifyInstalledClosure(optional.options), /physically installed package is incompatible/);
});
test('peer context collision, duplicate edge, unknown target and modified source input hold', t => {
  const peer = fixture(t), original = peer.contract.nodes[0];
  peer.contract.nodes.push({ ...original, key: original.key + '(peer@1)' });
  peer.contract.edges.push({ from: 'importer:packages/shared', dependencyName: original.name, kind: 'dependencies', to: original.key + '(peer@1)' });
  peer.seal();
  assert.throws(() => verifyInstalledClosure(peer.options), /peer-context/);
  const duplicate = fixture(t); duplicate.contract.edges.push(duplicate.contract.edges[0]); duplicate.seal(); assert.throws(() => readContract(duplicate.options), /duplicate graph edge/);
  const unknown = fixture(t); unknown.contract.edges[0].to = 'unknown'; unknown.seal(); assert.throws(() => readContract(unknown.options), /unknown graph edge/);
  const modified = fixture(t); fs.appendFileSync(path.join(modified.imageRoot, 'apps/api/package.json'), '\n'); assert.throws(() => verifyInstalledClosure(modified.options), /frozen input mismatch/);
});
test('contract hash and new undeclared installed dependency are not accepted', t => {
  const f = fixture(t); fs.appendFileSync(f.options.contractFile, '\n'); assert.throws(() => readContract(f.options), /frozen contract hash/);
  const next = fixture(t); write(path.join(next.root, 'package.json'), { ...next.pkg, dependencies: { missing: '1' } });
  assert.throws(() => verifyInstalledClosure(next.options), /unlocked installed dependency/);
});

function removalFixture(t, { optionalPeer = false } = {}) {
  const f = fixture(t), name = optionalPeer ? 'unpdf' : 'pptxgenjs', version = optionalPeer ? '1.8.1' : '3.12.0';
  const dependencyName = optionalPeer ? '@napi-rs/canvas' : 'image-size', key = `${name}@${version}`, selector = `${key}>${dependencyName}`;
  const owner = path.join(f.imageRoot, 'node_modules/.pnpm', key, 'node_modules', name);
  const metadata = { name, version, ...(optionalPeer ? {
    peerDependencies: { [dependencyName]: '^0.1.69 || ^1.0.0' }, peerDependenciesMeta: { [dependencyName]: { optional: true } },
  } : { dependencies: { [dependencyName]: '^1.0.0' } }) };
  const frozen = { key, name, version, os: null, cpu: null, libc: null, resolution: { integrity: 'sha512-fixture' }, ...(optionalPeer ? {
    peerDependencies: { [dependencyName]: '*' }, peerDependenciesMeta: { [dependencyName]: { optional: true } },
  } : {}) };
  write(path.join(owner, 'package.json'), metadata);
  write(path.join(f.root, 'package.json'), { ...f.pkg, dependencies: { [name]: version } });
  f.contract.nodes.push(frozen);
  f.contract.edges.push({ from: f.contract.nodes[0].key, to: key, dependencyName: name, kind: 'dependencies' });
  f.contract.removedDependencies = [{ from: key, dependencyName, selector }];
  const rootManifest = path.join(f.options.qualificationRoot, 'root-package.json');
  const setOverrides = overrides => {
    write(rootManifest, { private: true, pnpm: { overrides } });
    f.contract.inputSHA256['package.json'] = hash(fs.readFileSync(rootManifest));
  };
  setOverrides({ [selector]: '-' });
  const originalResolve = f.options.resolve;
  f.options.resolve = (parent, dependency, imageRoot, diagnostic) => dependency === name ? readPackage(owner) :
    dependency === dependencyName ? resolveDependency(parent, dependency, imageRoot, diagnostic) : originalResolve(parent, dependency);
  f.seal(); return { ...f, owner, key, selector, dependencyName, metadata, frozen, setOverrides };
}

test('exact frozen PptxGenJS removal accepts its upstream declaration only when physically absent', t => {
  const f = removalFixture(t), result = verifyInstalledClosure(f.options);
  assert.deepEqual(result.removedDependencies, [{ from: f.key, dependencyName: 'image-size', selector: f.selector, reason: 'EXACT_FROZEN_REMOVAL_AND_PHYSICAL_ABSENCE' }]);
  assert.equal(result.owners.length, 2);
  assert.equal(result.edges.length, 2);
});

test('removed dependency must not resolve locally or through an ancestor lookup', t => {
  for (const location of ['local', 'ancestor']) {
    const f = removalFixture(t);
    const directory = location === 'local' ? path.join(f.owner, 'node_modules/image-size') : path.join(f.imageRoot, 'node_modules/image-size');
    write(path.join(directory, 'package.json'), { name: 'image-size', version: '1.0.0' });
    assert.throws(() => verifyInstalledClosure(f.options), /removed dependency physically resolves/);
  }
});

test('unpdf optional peer resolves to the same exact canvas owner required by pdf-parse', t => {
  const f = fixture(t);
  const unpdf = 'unpdf@1.8.1(@napi-rs/canvas@0.1.80)', pdf = 'pdf-parse@2.4.5', canvas = '@napi-rs/canvas@0.1.80';
  const specs = [
    { key: unpdf, name: 'unpdf', version: '1.8.1', peerDependencies: { '@napi-rs/canvas': '^0.1.69 || ^1.0.0' }, peerDependenciesMeta: { '@napi-rs/canvas': { optional: true } } },
    { key: pdf, name: 'pdf-parse', version: '2.4.5', dependencies: { '@napi-rs/canvas': '0.1.80' } },
    { key: canvas, name: '@napi-rs/canvas', version: '0.1.80' },
  ];
  const owners = new Map();
  for (const { key, ...metadata } of specs) {
    const owner = path.join(f.imageRoot, 'node_modules/.pnpm', key.replaceAll('/', '+'), 'node_modules', metadata.name);
    write(path.join(owner, 'package.json'), metadata);
    owners.set(metadata.name, owner);
    f.contract.nodes.push({ key, name: metadata.name, version: metadata.version, os: null, cpu: null, libc: null,
      resolution: { integrity: 'sha512-synthetic-not-vendor-admission' },
      ...(key === unpdf ? { peerDependencies: { '@napi-rs/canvas': '0.1.80' }, peerDependenciesMeta: metadata.peerDependenciesMeta } : {}) });
  }
  write(path.join(f.root, 'package.json'), { ...f.pkg, dependencies: { unpdf: '1.8.1', 'pdf-parse': '2.4.5' } });
  f.contract.edges.push(
    { from: f.contract.nodes[0].key, to: unpdf, dependencyName: 'unpdf', kind: 'dependencies' },
    { from: f.contract.nodes[0].key, to: pdf, dependencyName: 'pdf-parse', kind: 'dependencies' },
    { from: unpdf, to: canvas, dependencyName: '@napi-rs/canvas', kind: 'optionalDependencies' },
    { from: pdf, to: canvas, dependencyName: '@napi-rs/canvas', kind: 'dependencies' },
  );
  const originalResolve = f.options.resolve;
  f.options.resolve = (parent, name, ...rest) => owners.has(name) ? readPackage(owners.get(name)) : originalResolve(parent, name, ...rest);
  f.seal();
  const admitted = verifyInstalledClosure(f.options);
  assert.equal(admitted.owners.filter(owner => owner.metadata.name === '@napi-rs/canvas').length, 1);
  assert.equal(new Set(admitted.edges.filter(edge => edge.dependencyName === '@napi-rs/canvas').map(edge => edge.physicalOwner)).size, 1);
  assert.deepEqual(admitted.removedDependencies, []);
  const resolveInstalled = f.options.resolve;
  f.options.resolve = (parent, name, ...rest) => name === '@napi-rs/canvas' ? null : resolveInstalled(parent, name, ...rest);
  assert.throws(() => verifyInstalledClosure(f.options), /required or unproven missing dependency/);
  write(path.join(owners.get('@napi-rs/canvas'), 'package.json'), { name: '@napi-rs/canvas', version: '1.0.9' });
  f.options.resolve = resolveInstalled;
  assert.throws(() => verifyInstalledClosure(f.options), /resolved exact package mismatch/);
});

test('missing, wrong, duplicate or graph-conflicting removal proof refuses', t => {
  for (const overrides of [{}, { 'pptxgenjs@3.12.1>image-size': '-' }, { 'pptxgenjs@*>image-size': '-' }, { 'pptxgenjs@3.12.0>image-size': '1.0.0' }]) {
    const f = removalFixture(t); f.setOverrides(overrides); f.seal();
    assert.throws(() => verifyInstalledClosure(f.options), /frozen exact removal/);
  }
  const missing = removalFixture(t); delete missing.contract.removedDependencies; missing.seal();
  assert.throws(() => verifyInstalledClosure(missing.options), /unlocked installed dependency/);
  const duplicate = removalFixture(t); duplicate.contract.removedDependencies.push(duplicate.contract.removedDependencies[0]); duplicate.seal();
  assert.throws(() => verifyInstalledClosure(duplicate.options), /duplicate removed dependency/);
  const edge = removalFixture(t); edge.contract.edges.push({ from: edge.key, dependencyName: 'image-size', kind: 'dependencies', to: edge.contract.nodes[0].key }); edge.seal();
  assert.throws(() => verifyInstalledClosure(edge.options), /also has graph edge/);
  const extra = removalFixture(t); write(path.join(extra.owner, 'package.json'), { name: 'pptxgenjs', version: '3.12.0', dependencies: { 'image-size': '^1.0.0', unapproved: '1.0.0' } });
  assert.throws(() => verifyInstalledClosure(extra.options), /unlocked installed dependency/);
  const stale = removalFixture(t); write(path.join(stale.owner, 'package.json'), { name: 'pptxgenjs', version: '3.12.0' });
  assert.throws(() => verifyInstalledClosure(stale.options), /removed dependency declaration missing/);
});

test('exact frozen optional-peer removal accepts the differing unpdf ranges only with physical absence', t => {
  const f = removalFixture(t, { optionalPeer: true }), result = verifyInstalledClosure(f.options);
  assert.notEqual(f.metadata.peerDependencies[f.dependencyName], f.frozen.peerDependencies[f.dependencyName]);
  assert.deepEqual(result.removedDependencies, [{ from: f.key, dependencyName: f.dependencyName,
    selector: f.selector, reason: 'EXACT_FROZEN_REMOVAL_AND_PHYSICAL_ABSENCE' }]);
  assert.equal(result.owners.length, 2); assert.equal(result.edges.length, 2);
});

test('optional-peer removal rejects missing or nonoptional declarations on either owner', t => {
  for (const side of ['metadata', 'frozen']) {
    for (const change of ['missing-peer', 'empty-peer', 'blank-peer', 'missing-optionality', 'required-peer', 'string-optionality']) {
      const f = removalFixture(t, { optionalPeer: true }), owner = f[side], name = f.dependencyName;
      if (change === 'missing-peer') delete owner.peerDependencies[name];
      if (change === 'empty-peer') owner.peerDependencies[name] = '';
      if (change === 'blank-peer') owner.peerDependencies[name] = ' ';
      if (change === 'missing-optionality') delete owner.peerDependenciesMeta[name];
      if (change === 'required-peer') owner.peerDependenciesMeta[name].optional = false;
      if (change === 'string-optionality') owner.peerDependenciesMeta[name].optional = 'true';
      write(path.join(f.owner, 'package.json'), f.metadata); f.seal();
      assert.throws(() => verifyInstalledClosure(f.options), /removed dependency declaration missing/, `${side}: ${change}`);
    }
  }
});

test('optional-peer removal rejects local and ancestor physical resolution', t => {
  for (const location of ['local', 'ancestor']) {
    const f = removalFixture(t, { optionalPeer: true });
    const directory = path.join(location === 'local' ? f.owner : f.imageRoot, 'node_modules', f.dependencyName);
    write(path.join(directory, 'package.json'), { name: f.dependencyName, version: '0.1.80' });
    assert.throws(() => verifyInstalledClosure(f.options), /removed dependency physically resolves/, location);
  }
});

test('optional-peer removal retains exact owner identity and frozen removal proof', t => {
  const wrongOwner = removalFixture(t, { optionalPeer: true });
  write(path.join(wrongOwner.owner, 'package.json'), { ...wrongOwner.metadata, version: '1.8.2' });
  assert.throws(() => verifyInstalledClosure(wrongOwner.options), /resolved exact package mismatch/);
  const noOverride = removalFixture(t, { optionalPeer: true }); noOverride.setOverrides({}); noOverride.seal();
  assert.throws(() => verifyInstalledClosure(noOverride.options), /frozen exact removal/);
  const withEdge = removalFixture(t, { optionalPeer: true });
  withEdge.contract.edges.push({ from: withEdge.key, to: withEdge.contract.nodes[0].key,
    dependencyName: withEdge.dependencyName, kind: 'optionalDependencies' }); withEdge.seal();
  assert.throws(() => verifyInstalledClosure(withEdge.options), /also has graph edge/);
});

test('optional-peer removal does not change normal peers or required-direct precedence', () => {
  const name = 'child', peer = { peerDependencies: { [name]: '^1' }, peerDependenciesMeta: { [name]: { optional: true } } };
  const frozen = { key: 'parent@1.0.0', ...peer }, edge = { dependencyName: name, kind: 'optionalDependencies' };
  assert.equal(classifyDependencyRelations(peer, frozen, [edge]).size, 0);
  assert.equal(classifyDependencyRelations(peer, frozen, []).size, 0);
  const direct = classifyDependencyRelations({ dependencies: { [name]: '^1' }, ...peer }, frozen, [edge]).get(name);
  assert.equal(direct.physicalRequired, true); assert.equal(direct.declaredKind, 'dependencies');
  assert.equal(direct.basis, 'FROZEN_OPTIONAL_PEER_PLACEMENT_WITH_REQUIRED_DIRECT_DEPENDENCY');
});
test('mocked contained symlinks deduplicate and external symlinks hold without creating junctions', t => {
  const f = fixture(t), alias = path.join(f.imageRoot, 'alias'); fs.mkdirSync(alias);
  const originalReal = fs.realpathSync, originalLstat = fs.lstatSync; let target = f.root;
  t.mock.method(fs, 'realpathSync', input => input === alias ? target : originalReal(input));
  t.mock.method(fs, 'lstatSync', input => input === alias ? { isSymbolicLink: () => true } : originalLstat(input));
  const result = walkRuntime(f.imageRoot); assert.equal(result.symbolicLinks, 1);
  assert.equal(result.files.filter(p => p === path.join(f.root, 'package.json')).length, 1);
  target = path.join(f.temp, 'external'); assert.throws(() => walkRuntime(f.imageRoot), /escapes image/);
});
test('artifact policy joins physical locked owner and rejects injected file names or workspace binaries', t => {
  const f = fixture(t), result = verifyInstalledClosure(f.options), binary = path.join(f.root, 'bin/esbuild'); write(binary, 'fixture-only');
  assert.equal(artifactOwner(binary, result).fixture, 'ESBUILD_REAL_TRANSFORM');
  const extra = path.join(f.root, 'bin/extra'); write(extra, 'fixture-only'); assert.throws(() => artifactOwner(extra, result), /unreviewed native artifact/);
  const app = path.join(f.imageRoot, 'apps/api/foreign.node'); write(app, 'fixture-only'); assert.throws(() => artifactOwner(app, result), /outside validated package/);
});
test('non-executable extensionless ELF and renamed WASM cannot evade magic inventory', t => {
  const f = fixture(t), file = path.join(f.root, 'not-named-native');
  write(file, Buffer.from('7f454c4602010100', 'hex')); fs.chmodSync(file, 0o644);
  const row = inspectArtifact(file, { root: path.join(f.imageRoot, 'node_modules/.pnpm') }); assert(row.inspectionError);
  write(file, Buffer.from('0061736d01000000', 'hex')); const wasm = inspectArtifact(file, { root: path.join(f.imageRoot, 'node_modules/.pnpm') });
  assert.equal(wasm.format, 'WEBASSEMBLY_V1'); assert(wasm.inspectionError); assert.equal(inspectArtifact(path.join(f.root, 'package.json')), null);
  const wrapper = path.join(f.root, 'query_engine_bg.postgresql.wasm.js'); write(wrapper, 'module.exports = {};\n');
  assert.equal(inspectArtifact(wrapper), null, 'JavaScript WASM loader wrapper is not a binary');
});
test('PDFjs WASM provenance binds exact vendor identity, member, size and bytes without executing codecs', () => {
  const owner = { name: 'pdfjs-dist', version: '5.4.296' }, relative = 'wasm/openjpeg.wasm';
  const digest = '67b8e2b162da472e98cb48d3d32e3e38fff481b9b32ff4818e78bb248af88ab2';
  const valid = lockedWasmEvidence(owner, relative, 250009, digest);
  assert.equal(valid.verified, true); assert.equal(valid.instantiated, false); assert.equal(valid.codecOperation, 'UNRUN');
  for (const args of [[{ ...owner, version: '5.4.297' }, relative, 250009, digest], [owner, 'wasm/foreign.wasm', 250009, digest],
    [owner, relative, 250010, digest], [owner, relative, 250009, '0'.repeat(64)]]) assert.equal(lockedWasmEvidence(...args).verified, false);
  const prisma = lockedWasmEvidence({ name: '@prisma/client', version: '5.22.0' }, 'runtime/query_engine_bg.postgresql.wasm', 2130325, 'b8c2cab13e50491cec4ca2d16a20cd549f09449736ab2361ad53c0254a08bf91');
  assert.equal(prisma.verified, true); assert.equal(prisma.nativeLoad, 'NOT_APPLICABLE');
});
test('Prisma CLI schema WASM binds the pinned archive and exact member bytes', () => {
  const owner = { name: 'prisma', version: '5.22.0' }, relative = 'build/prisma_schema_build_bg.wasm';
  const digest = 'adf02f9b486d507024be2bf59b271a88e39f48c3ca2266c6c46d7e9109296c05';
  const proof = lockedWasmEvidence(owner, relative, 2893316, digest);
  assert.equal(proof.verified, true);
  assert.equal(proof.archiveSHA256, '5ff71b20c5fb9d92c55e9412cc7613d282a4dee7e854c774fa5c87a8c3842e84');
  assert.equal(proof.archiveIntegrity, 'sha512-vtpjW3XuYCSnMsNVBjLMNkTj6OZbudcPPTPYHqX0CJfpcdWciI1dM8uHETwmDxxiqEwCIE6WvXucWUetJgfu/A==');
  for (const args of [[{ ...owner, name: '@prisma/client' }, relative, 2893316, digest],
    [{ ...owner, version: '5.22.1' }, relative, 2893316, digest], [owner, 'build/unreviewed.wasm', 2893316, digest],
    [owner, relative, 2893315, digest], [owner, relative, 2893316, '0'.repeat(64)]])
    assert.equal(lockedWasmEvidence(...args).verified, false);
});
