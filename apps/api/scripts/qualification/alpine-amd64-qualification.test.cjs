const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { selectedPlatform } = require('./qualification-platform.cjs');
const { reconciledPlatform, ownerPlatformAdmission, IMAGE_LOCAL_PRISMA_SCHEMA_SHA256 } = require('./runtime-closure-contract.cjs');
const { verify } = require('./verify-alpine-amd64-scan.cjs');
const priorArch = process.env.CAPIRO_QUALIFICATION_ARCH;
process.env.CAPIRO_QUALIFICATION_ARCH = 'x64';
const { classifyNativeArtifact, assertActiveBinding } = require('./alpine-runtime-probe.cjs');
if (priorArch === undefined) delete process.env.CAPIRO_QUALIFICATION_ARCH;
else process.env.CAPIRO_QUALIFICATION_ARCH = priorArch;

const root = path.join(__dirname, '../../../../');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json'), 'utf8'));

test('AMD64 selector binds the native loader, Prisma target, and optional packages', () => {
  const platform = selectedPlatform({ CAPIRO_QUALIFICATION_ARCH: 'x64' });
  assert.equal(platform.machine, 62);
  assert.equal(platform.loader, '/lib/ld-musl-x86_64.so.1');
  assert.equal(platform.prisma, 'linux-musl-openssl-3.0.x');
  assert.equal(platform.canvas, '@napi-rs/canvas-linux-x64-musl');
  assert.throws(() => selectedPlatform({ CAPIRO_QUALIFICATION_ARCH: 'unknown' }), /unsupported/);
});

test('candidate Dockerfile copies the shared platform gate into build and runtime', () => {
  const source = fs.readFileSync(path.join(root, 'apps/api/Dockerfile.alpine-amd64-qualification'), 'utf8');
  const pin = 'node:22.23.3-alpine3.24@sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8';
  assert.equal(source.split(pin).length - 1, 2, 'same exact AMD64 base for build and runtime');
  assert.equal(source.split('COPY apps/api/scripts/qualification/qualification-platform.cjs /qualification/qualification-platform.cjs').length - 1, 2);
  assert.match(source, /PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3\.0\.x/);
  assert.equal(source.split('"zlib>=1.3.2-r1"').length - 1, 2, 'build/prod-deps and runtime both require patched zlib');
  assert.doesNotMatch(source, /linux-musl-arm64|sha256:85cdd100/);
});

test('current PR45 canonical schema binds both image-local Prisma targets', () => {
  const schema = fs.readFileSync(path.join(root, 'apps/api/prisma/schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const from = '"linux-arm64-openssl-3.0.x"';
  assert.equal(schema.split(from).length - 1, 1, 'one source generator target');
  for (const [arch, expected] of Object.entries(IMAGE_LOCAL_PRISMA_SCHEMA_SHA256)) {
    const transformed = schema.replace(from, `"${selectedPlatform({ CAPIRO_QUALIFICATION_ARCH: arch }).prisma}"`);
    assert.equal(createHash('sha256').update(transformed).digest('hex'), expected, `${arch} schema source pin`);
  }
});

test('exact locked x64 Canvas archive evidence rejects GNU and admits musl', () => {
  const target = { os: 'linux', cpu: 'x64', libc: 'musl' };
  const cases = [
    ['@napi-rs/canvas-linux-x64-gnu@0.1.80', '4784efb91449657a0cd0d7753a98c50888687dd4ef4ac1ee78a12183da7a3a31', 'glibc'],
    ['@napi-rs/canvas-linux-x64-gnu@1.0.9', 'ff5183ad72e20d10dceb4f18d59a4326edf023b5ae2d022a2f2b8ed8a693ffc2', 'glibc'],
    ['@napi-rs/canvas-linux-x64-musl@0.1.80', '479e39e8af197977ffa141231f01a4a5a693b1785eb6593ece45a4d9ddd4cfe3', 'musl'],
    ['@napi-rs/canvas-linux-x64-musl@1.0.9', '49ce74c87cb8a8800da596426a309ecc072178616261d4e3c4aefb2e16bba387', 'musl'],
  ];
  for (const [key, manifestSHA256, libc] of cases) {
    const node = contract.nodes.find(row => row.key === key);
    assert(node, `frozen lock graph lacks ${key}`);
    const owner = { manifestSHA256, metadata: { os: ['linux'], cpu: ['x64'], libc: [libc] } };
    assert.deepEqual(reconciledPlatform(node, owner).platform.libc, [libc]);
    const optional = { dependencyKind: 'optionalDependencies', physicalRequired: false };
    assert.equal(ownerPlatformAdmission(node, owner, target, optional).executionAllowed, libc === 'musl');
    assert.throws(() => reconciledPlatform(node, { ...owner, manifestSHA256: '0'.repeat(64) }), /manifest bytes/);
    if (libc === 'glibc') assert.throws(() => ownerPlatformAdmission(node, owner, target, { dependencyKind: 'dependencies', physicalRequired: true }), /incompatible/);
  }
});

test('AMD64 ELF classification admits musl and rejects glibc native owners', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpine-amd64-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function owner(name, libc, needed) {
    const folder = path.join(root, name.replaceAll('/', '_'));
    fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version: '1.0.0', os: ['linux'], cpu: ['x64'], libc: [libc] }));
    const strings = Buffer.from(`\0${needed}\0`), data = Buffer.alloc(288 + strings.length);
    data.write('7f454c46', 0, 'hex'); data[4] = 2; data[5] = 1; data.writeUInt16LE(62, 18);
    data.writeBigUInt64LE(64n, 40); data.writeUInt16LE(64, 58); data.writeUInt16LE(3, 60);
    data.writeUInt32LE(6, 132); data.writeBigUInt64LE(256n, 152); data.writeBigUInt64LE(32n, 160); data.writeUInt32LE(2, 168);
    data.writeUInt32LE(3, 196); data.writeBigUInt64LE(288n, 216); data.writeBigUInt64LE(BigInt(strings.length), 224);
    data.writeBigUInt64LE(1n, 256); data.writeBigUInt64LE(1n, 264); strings.copy(data, 288);
    const file = path.join(folder, 'binding.node'); fs.writeFileSync(file, data);
    return file;
  }
  const musl = owner('fixture-musl', 'musl', 'libc.musl-x86_64.so.1');
  const glibc = owner('fixture-gnu', 'glibc', 'libc.so.6');
  assert.equal(assertActiveBinding(musl, { root }).state, 'COMPATIBLE');
  assert.equal(classifyNativeArtifact(glibc, { root }).state, 'INCOMPATIBLE');
  assert.throws(() => assertActiveBinding(glibc, { root }), /not proven x64\/musl/);
});

test('scan admission binds immutable digest, complete fresh findings, and zero high severity', () => {
  const digest = 'sha256:' + 'a'.repeat(64), repository = 'capiro-preview-core';
  const images = { imageDetails: [{ repositoryName: repository, imageDigest: digest, imagePushedAt: '2026-10-16T20:00:00Z' }] };
  const scan = { repositoryName: repository, imageId: { imageDigest: digest }, imageScanStatus: { status: 'COMPLETE' },
    imageScanFindings: { imageScanCompletedAt: '2026-10-16T20:05:00Z', findingSeverityCounts: {}, findings: [] } };
  assert.equal(verify(digest, repository, images, scan).status, 'PASS_EXACT_DIGEST_SCAN');
  assert.throws(() => verify(digest, repository, images, { ...scan, imageScanStatus: { status: 'IN_PROGRESS' } }), /incomplete/);
  assert.throws(() => verify(digest, repository, images, { ...scan, imageId: { imageDigest: 'sha256:' + 'b'.repeat(64) } }), /Expected values/);
  assert.throws(() => verify(digest, repository, images, { ...scan, imageScanFindings: { ...scan.imageScanFindings, findingSeverityCounts: { HIGH: 1 } } }), /HIGH/);
  assert.throws(() => verify(digest, repository, images, { ...scan, imageScanFindings: { ...scan.imageScanFindings, imageScanCompletedAt: '2026-10-16T19:00:00Z' } }), /predates/);
  assert.throws(() => verify(digest, repository, images, { ...scan, imageScanFindings: { ...scan.imageScanFindings, findings: undefined } }), /complete findings/);
});
