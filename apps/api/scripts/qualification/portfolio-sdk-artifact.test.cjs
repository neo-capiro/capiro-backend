'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { portfolioSdkNativeEvidence, artifactOwner } = require('./runtime-closure-contract.cjs');
const { binaryFormat } = require('./alpine-runtime-probe.cjs');
const frozen = require('../../../../docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json');
const hash = data => createHash('sha256').update(data).digest('hex');
// Git checkout newline normalization is only for this source fixture. Production
// admission hashes installed vendor manifest bytes without normalization.
const manifestBytes = Buffer.from(fs.readFileSync(path.join(__dirname, 'fixtures/claude-agent-sdk-0.3.318-manifest.json'), 'utf8').replace(/\r\n/g, '\n'));
const manifest = JSON.parse(manifestBytes);
const target = { os: 'linux', cpu: 'arm64', libc: 'musl' };
const sdkNode = frozen.nodes.find(n => n.name === '@anthropic-ai/claude-agent-sdk' && n.version === '0.3.318');
function fixture(libc = 'musl') {
  const platform = libc === 'musl' ? 'linux-arm64-musl' : 'linux-arm64';
  const name = `@anthropic-ai/claude-agent-sdk-${platform}`;
  const node = frozen.nodes.find(n => n.name === name && n.version === '0.3.318');
  const admittedPlatform = { os: ['linux'], cpu: ['arm64'], libc: [libc] };
  const owner = { metadata: { name, version: '0.3.318', ...admittedPlatform },
    manifestSHA256: libc === 'musl' ? '32ecd14d02faddb449e14be5b4d485a637d5353c0363c9019db7bd7d1d257e66' : 'a341210933888b7305d518dd52ca1fe9b060a88f66d493559b5217c539a7e5c2',
    integrity: node.resolution.integrity, snapshot: node.key,
    platformAdmission: { platform: admittedPlatform, state: libc === 'musl' ? 'TARGET_COMPATIBLE' : 'INACTIVE_INCOMPATIBLE_OPTIONAL', executionAllowed: libc === 'musl' } };
  const distribution = { manifestBytes, owner: { metadata: { name: sdkNode.name, version: sdkNode.version },
    manifestSHA256: 'f2799dd9c43f751e052bd4d410af96274fdc36f514a2d6666fe148c266a0e990', integrity: sdkNode.resolution.integrity, snapshot: sdkNode.key } };
  // Declared facts exercise the pure boundary, not a claim of observed Linux bytes.
  const payload = { bytes: manifest.platforms[platform].size, sha256: manifest.platforms[platform].checksum,
    binary: { format: 'ELF', elf: { class: 64, machine: 183, libc } } };
  return { owner, distribution, payload };
}
const admit = f => portfolioSdkNativeEvidence(f.owner, 'claude', target, f.distribution, f.payload);

test('exact retained SDK distribution entries admit declared byte facts without runtime acceptance', () => {
  assert.equal(hash(manifestBytes), '608425e4ad6b6513a43c281c170d0bdd71b2d30bbf0df09df9b1a2e8c448df07');
  for (const libc of ['musl', 'glibc']) {
    const f = fixture(libc), result = admit(f);
    assert.equal(result.relative, 'claude'); assert.equal(result.bytes, f.payload.bytes); assert.equal(result.sha256, f.payload.sha256);
    assert.equal(result.executionAllowed, libc === 'musl'); assert.equal(result.runtimeQualification, 'UNRUN');
    assert.equal(result.sdkVersion, '0.3.318'); assert.equal(result.declaredCliVersion, '2.1.318');
    if(libc === 'glibc') assert.equal(result.fixture, 'CLAUDE_SDK_INACTIVE_OPTIONAL_NEVER_EXECUTED');
    f.payload.binary.elf.libc = null; // A static ELF may have no dynamic libc dependency.
    assert.equal(admit(f).executionAllowed, libc === 'musl');
  }
});

test('native byte/member/ELF and target mismatches are refused', () => {
  for (const libc of ['musl', 'glibc']) {
    for (const mutate of [
      f => f.payload.bytes--, f => f.payload.sha256 = '0'.repeat(64),
      f => f.payload.binary.format = 'PE', f => f.payload.binary.elf.class = 32,
      f => f.payload.binary.elf.machine = 62,
      f => f.payload.binary.elf.libc = libc === 'musl' ? 'glibc' : 'musl',
    ]) { const f = fixture(libc); mutate(f); assert.throws(() => admit(f)); }
    const f = fixture(libc);
    for(const member of ['other', 'nested/claude', 'claude.exe', '../claude'])
      assert.throws(() => portfolioSdkNativeEvidence(f.owner, member, target, f.distribution, f.payload), /member/);
    assert.throws(() => portfolioSdkNativeEvidence(f.owner, 'claude', { ...target, cpu: 'x64' }, f.distribution, f.payload), /target/);
  }
});

test('native and distribution owners, platform state and retained manifests stay exact', () => {
  for(const mutate of [
    f => f.owner.metadata.version = '0.3.319', f => f.owner.metadata.name += '-foreign',
    f => f.owner.integrity = 'sha512-foreign', f => f.owner.manifestSHA256 = '0'.repeat(64),
    f => f.owner.metadata.cpu = ['x64'], f => f.owner.metadata.os = ['darwin'],
    f => f.owner.platformAdmission.executionAllowed = false,
    f => f.owner.platformAdmission.state = 'INACTIVE_INCOMPATIBLE_OPTIONAL',
    f => f.owner.platformAdmission.platform = { ...target },
    f => f.distribution.owner.metadata.name = 'foreign', f => f.distribution.owner.metadata.version = '0.3.319',
    f => f.distribution.owner.manifestSHA256 = '0'.repeat(64), f => f.distribution.owner.integrity = 'sha512-foreign',
    f => f.distribution.manifestBytes = Buffer.concat([manifestBytes, Buffer.from('\n')]),
  ]) { const f = fixture(); mutate(f); assert.throws(() => admit(f)); }
  const inactive = fixture('glibc'); inactive.owner.platformAdmission.executionAllowed = true;
  assert.throws(() => admit(inactive), /execution eligibility/);
});

function physicalFixture(t, libc = 'musl') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-sdk-artifact-'));
  t.diagnostic(`Retained static fixture: ${temp}`); // No cleanup in this allocation.
  const f = fixture(libc); f.owner.root = path.join(temp, 'native'); f.distribution.owner.root = path.join(temp, 'sdk');
  fs.mkdirSync(f.owner.root); fs.mkdirSync(f.distribution.owner.root);
  fs.writeFileSync(path.join(f.distribution.owner.root, 'manifest.json'), manifestBytes);
  const file = path.join(f.owner.root, 'claude'), bytes = Buffer.alloc(128);
  bytes.set(Buffer.from('7f454c46', 'hex')); bytes[4] = 2; bytes[5] = 1;
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(183, 18); bytes.writeBigUInt64LE(64n, 40);
  bytes.writeUInt16LE(64, 58); bytes.writeUInt16LE(1, 60);
  assert.equal(binaryFormat(bytes).format, 'ELF');
  fs.writeFileSync(file, bytes); // Inert synthetic header, never a native invocation.
  const edge = { from: f.distribution.owner.snapshot, to: f.owner.snapshot, dependencyName: f.owner.metadata.name,
    kind: 'optionalDependencies', physicalOwner: f.owner.root };
  return { ...f, file, temp, closure: { target, owners: [f.owner, f.distribution.owner], generated: [], edges: [edge] } };
}

test('artifactOwner reads physical bytes and refuses synthetic ELF despite matching trusted owner facts', t => {
  const f = physicalFixture(t);
  assert.throws(() => artifactOwner(f.file, f.closure), /native byte length/);
  fs.writeFileSync(f.file, 'not ELF');
  assert.throws(() => artifactOwner(f.file, f.closure), /native byte length|native format/);
  fs.writeFileSync(path.join(f.owner.root, 'other'), 'unexpected member');
  assert.throws(() => artifactOwner(path.join(f.owner.root, 'other'), f.closure), /unexpected Portfolio SDK native member/);
  const outside = path.join(f.temp, 'outside'); fs.writeFileSync(outside, 'outside validated owners');
  assert.throws(() => artifactOwner(outside, f.closure), /outside validated/);
});

test('artifactOwner still requires an exact physical optional edge and unique distribution owner', t => {
  const f = physicalFixture(t), edge = f.closure.edges[0];
  for(const changed of [{ ...edge, kind: 'dependencies' }, { ...edge, physicalOwner: f.temp }, { ...edge, to: 'foreign' }])
    assert.throws(() => artifactOwner(f.file, { ...f.closure, edges: [changed] }), /physical optional owner edge/);
  for(const owners of [[f.owner], [f.owner, f.distribution.owner, f.distribution.owner]])
    assert.throws(() => artifactOwner(f.file, { ...f.closure, owners }), /distribution owner missing or ambiguous/);
});

test('retained glibc optional member cannot substitute for the target musl owner/member', t => {
  const f = physicalFixture(t, 'glibc');
  assert.throws(() => artifactOwner(f.file, f.closure), /compatible musl owner required/);
  const musl = fixture().owner; musl.root = path.join(f.temp, 'missing-musl'); fs.mkdirSync(musl.root);
  const closure = { ...f.closure, owners: [...f.closure.owners, musl], edges: [...f.closure.edges,
    { from: f.distribution.owner.snapshot, to: musl.snapshot, dependencyName: musl.metadata.name,
      kind: 'optionalDependencies', physicalOwner: musl.root }] };
  assert.throws(() => artifactOwner(f.file, closure), { code: 'ENOENT' });
});
