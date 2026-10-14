const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyInstalledClosure, readPackage, readContract, walkRuntime, artifactOwner, lockedWasmEvidence } = require('./runtime-closure-contract.cjs');
const { inspectArtifact } = require('./alpine-runtime-probe.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
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
