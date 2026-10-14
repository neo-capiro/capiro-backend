const assert = require('node:assert/strict');
const test = require('node:test');
const { assertDumbInitVersion } = require('./alpine-runtime-probe.cjs');
const { classifyNativeArtifact, assertActiveBinding, assertOptionalInactive } = require('./alpine-runtime-probe.cjs');
const { boundedChild, collectChecks, parseLoaderMappings, assertRuntimeLibc, parseChildProof } = require('./alpine-runtime-probe.cjs');
const { resolvedNativeBinding, readDeployedPackage } = require('./alpine-runtime-probe.cjs');
const { createReceiptStream, completeReceiptReport, inspectArtifact } = require('./alpine-runtime-probe.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Minimal ELF64 section fixtures contain real SHT_DYNAMIC/DT_NEEDED references.
// They test classification only and are never passed to a native loader.
function elf(needed = [], machine = 183) {
  const strings = Buffer.from(`\0${needed.join('\0')}\0`);
  const dynamicOffset = 256, dynamicSize = (needed.length + 1) * 16, stringOffset = dynamicOffset + dynamicSize;
  const data = Buffer.alloc(stringOffset + strings.length);
  data.write('7f454c46', 0, 'hex'); data[4] = 2; data[5] = 1; data.writeUInt16LE(machine, 18);
  data.writeBigUInt64LE(64n, 40); data.writeUInt16LE(64, 58); data.writeUInt16LE(3, 60);
  data.writeUInt32LE(6, 132); data.writeBigUInt64LE(BigInt(dynamicOffset), 152); data.writeBigUInt64LE(BigInt(dynamicSize), 160); data.writeUInt32LE(2, 168);
  data.writeUInt32LE(3, 196); data.writeBigUInt64LE(BigInt(stringOffset), 216); data.writeBigUInt64LE(BigInt(strings.length), 224);
  let start = 1;
  needed.forEach((name, index) => { data.writeBigUInt64LE(1n, dynamicOffset + index * 16); data.writeBigUInt64LE(BigInt(start), dynamicOffset + index * 16 + 8); start += Buffer.byteLength(name) + 1; });
  strings.copy(data, stringOffset); return data;
}
function artifact(t, metadata, data = elf(['libc.musl-aarch64.so.1']), suffix = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-native-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = path.join(root, `store${suffix}`, 'node_modules', metadata.name || 'fixture'); fs.mkdirSync(owner, { recursive: true });
  fs.writeFileSync(path.join(owner, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', ...metadata }));
  const file = path.join(owner, 'binding.node'); fs.writeFileSync(file, data);
  return { file, options: { root } };
}
test('Sharp glibc owner lacking -gnu is retained inactive using positive package evidence', t => {
  const { file, options } = artifact(t, { name: '@img/sharp-linux-arm64', version: '0.35.5', os: ['linux'], cpu: ['arm64'], libc: ['glibc'] }, elf(['libc.so.6']));
  const receipt = classifyNativeArtifact(file, options);
  assert.equal(receipt.state, 'INCOMPATIBLE'); assert.equal(receipt.owner.name, '@img/sharp-linux-arm64');
  assert.equal(receipt.elf.machine, 183); assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => assertActiveBinding(file, options), /not proven ARM64\/musl/);
});
test('musl Sharp package is compatible and passes the active binding identity gate', t => {
  const { file, options } = artifact(t, { name: '@img/sharp-linuxmusl-arm64', version: '0.35.5', os: ['linux'], cpu: ['arm64'], libc: ['musl'] });
  assert.equal(assertActiveBinding(file, options).state, 'COMPATIBLE');
});
test('absent libc uses actual ELF DT_NEEDED, not a GNU-looking path', t => {
  const { file, options } = artifact(t, {}, elf(['libc.musl-aarch64.so.1']), '-gnu');
  assert.equal(classifyNativeArtifact(file, options).state, 'COMPATIBLE');
  assert.equal(assertActiveBinding(file, options).libc, 'musl');
});
test('absent package libc can establish incompatibility from ELF glibc dependency', t => {
  const { file, options } = artifact(t, {}, elf(['libc.so.6']));
  assert.equal(classifyNativeArtifact(file, options).state, 'INCOMPATIBLE');
});
test('no libc evidence remains UNKNOWN and fails the active gate', t => {
  const { file, options } = artifact(t, {}, elf([]), '-gnu');
  assert.equal(classifyNativeArtifact(file, options).state, 'UNKNOWN');
  assert.throws(() => assertActiveBinding(file, options), /not proven/);
});
test('package/ELF libc disagreement fails closed', t => {
  const { file, options } = artifact(t, { libc: ['musl'] }, elf(['libc.so.6']));
  assert.throws(() => classifyNativeArtifact(file, options), /libc (constraint )?disagreement/);
});
test('wrong ELF machine cannot pass an arm64 package declaration', t => {
  const { file, options } = artifact(t, { cpu: ['arm64'], libc: ['musl'] }, elf(['libc.musl-x86_64.so.1'], 62));
  assert.throws(() => classifyNativeArtifact(file, options), /cpu disagreement/);
});
test('positively identified x64 package remains incompatible and never passes active gate', t => {
  const { file, options } = artifact(t, { cpu: ['x64'], os: ['linux'], libc: ['musl'] }, elf(['libc.musl-x86_64.so.1'], 62));
  assert.equal(classifyNativeArtifact(file, options).state, 'INCOMPATIBLE');
  assert.throws(() => assertActiveBinding(file, options), /not proven/);
});
test('malformed ELF, metadata and escaped root are rejected', t => {
  const { file, options } = artifact(t, { libc: 'musl' });
  assert.throws(() => classifyNativeArtifact(file, options), /invalid package libc/);
  fs.writeFileSync(path.join(path.dirname(file), 'package.json'), '{"name":"fixture","version":"1"}');
  fs.writeFileSync(file, Buffer.from('not ELF'));
  assert.throws(() => classifyNativeArtifact(file, options), /must be ELF/);
  const otherRoot = path.join(options.root, 'unrelated'); fs.mkdirSync(otherRoot);
  assert.throws(() => classifyNativeArtifact(file, { root: otherRoot }), /escapes inventory root/);
});
test('truncated ELF tables and absent package ownership fail closed', t => {
  const { file, options } = artifact(t, {});
  const truncated = elf(['libc.musl-aarch64.so.1']); truncated.writeBigUInt64LE(100000n, 40);
  fs.writeFileSync(file, truncated);
  assert.throws(() => classifyNativeArtifact(file, options), /truncated ELF sections/);
  fs.unlinkSync(path.join(path.dirname(file), 'package.json'));
  assert.throws(() => classifyNativeArtifact(file, options), /identity missing/);
});
test('negated CPU and libc constraints contradicting observed ELF hold', t => {
  for (const metadata of [{ cpu: ['!arm64'] }, { libc: ['!musl'] }]) {
    const { file, options } = artifact(t, metadata);
    assert.throws(() => classifyNativeArtifact(file, options), /constraint disagreement/);
  }
});
function parentManifest(root, name, fields) {
  const file = path.join(root, 'package.json'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name, version: '2.0.0', ...fields })); return file;
}
test('incompatible addon requires actual exact optional owner resolution before exemption', t => {
  const { file, options } = artifact(t, { name: '@img/sharp-linux-arm64', version: '0.35.5', libc: ['glibc'] }, elf(['libc.so.6']));
  const receipt = classifyNativeArtifact(file, options);
  const manifest = parentManifest(path.join(options.root, 'store'), 'sharp', { optionalDependencies: { '@img/sharp-linux-arm64': '0.35.5' } });
  const evidence = assertOptionalInactive(receipt, [manifest], { ...options, imageRoot: options.root });
  assert.equal(evidence.length, 1); assert.equal(evidence[0].relation, 'optionalDependencies');
  assert.equal(evidence[0].resolvedOwnerRoot, receipt.owner.root);
  assert.equal(evidence[0].resolvedManifest, path.join(receipt.owner.root, 'package.json'));
});
test('required incompatible addon holds even when another owner declares it optional', t => {
  const { file, options } = artifact(t, { libc: ['glibc'] }, elf(['libc.so.6']));
  const receipt = classifyNativeArtifact(file, options), opt = { ...options, imageRoot: options.root };
  assert.throws(() => assertOptionalInactive(receipt, [], opt), /lacks verified optional/);
  const optional = parentManifest(path.join(options.root, 'store'), 'optional-parent', { optionalDependencies: { fixture: '1.0.0' } });
  const required = parentManifest(path.join(options.root, 'store', 'node_modules', 'required-parent'), 'required-parent', { dependencies: { fixture: '1.0.0' } });
  assert.throws(() => assertOptionalInactive(receipt, [optional, required], opt), /required deployed dependency/);
});
test('same name in another physical owner and non-exact optional version cannot authorize skip', t => {
  const { file, options } = artifact(t, { libc: ['glibc'] }, elf(['libc.so.6']));
  const receipt = classifyNativeArtifact(file, options), opt = { ...options, imageRoot: options.root };
  const parent = parentManifest(path.join(options.root, 'elsewhere'), 'different-parent', { optionalDependencies: { fixture: '1.0.0' } });
  parentManifest(path.join(options.root, 'elsewhere', 'node_modules', 'fixture'), 'fixture', {});
  assert.throws(() => assertOptionalInactive(receipt, [parent], opt), /lacks verified optional/);
  const wrongPin = parentManifest(path.join(options.root, 'store'), 'parent', { optionalDependencies: { fixture: '^1.0.0' } });
  assert.throws(() => assertOptionalInactive(receipt, [wrongPin], opt), /exact installed version pin/);
});
function runtimeProof() {
  const receipt = { file: '/app/node_modules/.pnpm/fixture/index.node', sha256: 'a'.repeat(64), state: 'UNKNOWN', elf: { machine: 183, needed: ['libc.so'], libc: null } };
  const musl = { file: '/lib/ld-musl-aarch64.so.1', sha256: 'b'.repeat(64), elf: { machine: 183, libc: null, soname: 'libc.so' } };
  return { receipt, evidence: { addon: { file: receipt.file, sha256: receipt.sha256 }, dlopen: [{ file: receipt.file, sha256: receipt.sha256 }],
    runtime: { platform: 'linux', arch: 'arm64', glibc: null }, expectedLoader: { ...musl }, musl,
    banner: 'musl libc (aarch64)\nVersion 1.2.5\nDynamic Program Loader', mapped: [{ ...musl }, { file: receipt.file, sha256: receipt.sha256, elf: receipt.elf }],
    resolved: [{ dependency: 'libc.so', file: musl.file, sha256: musl.sha256 }], loader: { status: 0, nodeSymbols: [], unexplained: [] } } };
}
test('generic libc.so needs exact loaded addon and resolved/mapped positive musl proof', () => {
  const { receipt, evidence } = runtimeProof(), accepted = assertRuntimeLibc(receipt, evidence);
  assert.equal(accepted.state, 'COMPATIBLE'); assert.equal(accepted.staticState, 'UNKNOWN'); assert.equal(accepted.runtimeEvidence, evidence);
});
test('generic libc rejects glibc, unknown, escaped, unobserved and contradictory mappings', () => {
  const mutations = [
    p => { p.evidence.runtime.glibc = '2.36'; },
    p => { p.evidence.mapped.push({ file: '/lib/libc.so.6', sha256: 'c'.repeat(64), elf: { libc: 'glibc' } }); },
    p => { p.evidence.banner = 'unknown runtime'; },
    p => { p.evidence.mapped = []; },
    p => { p.evidence.resolved = []; },
    p => { p.evidence.resolved[0].file = '/vendor/libc.so'; },
    p => { p.evidence.resolved[0].sha256 = 'c'.repeat(64); },
    p => { p.evidence.musl.file = p.evidence.expectedLoader.file = '/app/vendor/loader'; },
    p => { p.evidence.dlopen[0].sha256 = 'c'.repeat(64); },
    p => { p.receipt.state = 'INCOMPATIBLE'; },
    p => { p.evidence.loader.unexplained = ['Error loading shared library absent.so']; },
    p => { p.evidence.loader.status = 127; },
  ];
  for (const mutate of mutations) { const proof = runtimeProof(); mutate(proof); assert.throws(() => assertRuntimeLibc(proof.receipt, proof.evidence)); }
});
test('unknown non-libc dependency cannot become musl just because the process maps musl', () => {
  const { receipt, evidence } = runtimeProof(); receipt.elf.needed = ['unknown.so'];
  assert.throws(() => assertRuntimeLibc(receipt, evidence), /no resolvable libc evidence/);
});
test('loader mapping parser retains dependency and actual absolute target, ignores unrelated lines', () => {
  assert.deepEqual(parseLoaderMappings('libc.so => /lib/ld-musl-aarch64.so.1 (0x123abc)\nmissing.so => not found\n/lib/ld-musl-aarch64.so.1 (0xaaa)'), [{ dependency: 'libc.so', file: '/lib/ld-musl-aarch64.so.1' }]);
});
test('stripped section table holds rather than treating absent evidence as compatibility', t => {
  const { file, options } = artifact(t, {}), data = elf(['libc.so']); data.writeUInt16LE(0, 60); fs.writeFileSync(file, data);
  assert.throws(() => classifyNativeArtifact(file, options), /bounded ELF sections/);
});
test('bounded native child outcomes retain failure, timeout and capped output evidence', () => {
  const failed = boundedChild(process.execPath, ['-e', 'process.stderr.write("native load failed");process.exit(7)']);
  assert.equal(failed.status, 7); assert.match(failed.stderr, /native load failed/);
  const timed = boundedChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }); assert.equal(timed.error.code, 'ETIMEDOUT');
  const overflow = boundedChild(process.execPath, ['-e', 'process.stdout.write("x".repeat(65536))'], { maxBuffer: 1024 });
  assert.equal(overflow.error.code, 'ENOBUFS'); assert(overflow.stdout.length <= 1024);
});
test('collector runs Sharp and remaining independent cases after prior failures; aggregate stays HOLD', async () => {
  const ran = [], emitted = [];
  const result = await collectChecks([
    { name: 'native-failed', run: () => { ran.push('native'); throw new Error('load failed'); } },
    { name: 'sharp', run: async () => { ran.push('sharp'); return 'pixel case executed'; } },
    { name: 'timed-child', run: () => { ran.push('timeout'); const child = boundedChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }); const error = new Error('timeout'); error.child = child; throw error; } },
    { name: 'remaining-fixture', run: () => ran.push('remaining') },
  ], row => emitted.push(row));
  assert.deepEqual(ran, ['native', 'sharp', 'timeout', 'remaining']); assert.equal(result.status, 'HOLD');
  assert.equal(emitted.length, 4); assert.equal(emitted[2].child.error.code, 'ETIMEDOUT'); assert.equal(emitted[3].status, 'PASS');
});
test('child proof rejects missing, duplicate, malformed and failed receipts', () => {
  const base = { status: 0, signal: null, error: null, stdout: '', stderr: '' };
  for (const stdout of ['', 'CORE_NATIVE_CHILD {}\nCORE_NATIVE_CHILD {}', 'CORE_NATIVE_CHILD {']) assert.throws(() => parseChildProof({ ...base, stdout }));
  assert.throws(() => parseChildProof({ ...base, status: 1, stdout: 'CORE_NATIVE_CHILD {}' }));
  assert.deepEqual(parseChildProof({ ...base, stdout: 'CORE_NATIVE_CHILD {"value":7}' }), { value: 7 });
});
test('dispatcher resolves exact physical native owner without inventing absent libc metadata', t => {
  const { file, options } = artifact(t, { version: '2.0.0' }, elf(['libc.so']));
  const parent = parentManifest(path.join(options.root, 'store'), 'dispatcher', { optionalDependencies: { fixture: '2.0.0' } });
  const selected = resolvedNativeBinding(parent, 'fixture', options);
  assert.equal(selected.receipt.file, fs.realpathSync(file));
  assert.equal(selected.receipt.state, 'UNKNOWN'); assert.equal(selected.receipt.owner.libc, null);
});
test('dispatcher rejects wrong optional pin, wrong installed version and ambiguous native owner', t => {
  const { file, options } = artifact(t, { version: '1.0.0' });
  const parent = parentManifest(path.join(options.root, 'store'), 'dispatcher', { optionalDependencies: { fixture: '2.0.0' } });
  assert.throws(() => resolvedNativeBinding(parent, 'fixture', options));
  fs.writeFileSync(path.join(path.dirname(file), 'package.json'), JSON.stringify({ name: 'fixture', version: '2.0.0' }));
  fs.writeFileSync(path.join(path.dirname(file), 'other.node'), elf(['libc.musl-aarch64.so.1']));
  assert.throws(() => resolvedNativeBinding(parent, 'fixture', options), /one exact resolved/);
  parentManifest(path.join(options.root, 'store'), 'dispatcher', { optionalDependencies: { fixture: '^2.0.0' } });
  assert.throws(() => resolvedNativeBinding(parent, 'fixture', options), /optional pin mismatch/);
});
test('deployed package inventory records real identity/hash/platform without libc inference', t => {
  const { file, options } = artifact(t, { os: ['linux'], cpu: ['arm64'] });
  const manifest = path.join(path.dirname(file), 'package.json');
  const observed = readDeployedPackage(manifest, { imageRoot: options.root });
  assert.equal(observed.row.manifest, fs.realpathSync(manifest)); assert.equal(observed.row.name, 'fixture');
  assert.equal(observed.row.version, '1.0.0'); assert.equal(observed.row.libc, null);
  assert.equal(observed.row.format, 'NAMED_PACKAGE_MANIFEST'); assert.match(observed.row.sha256, /^[a-f0-9]{64}$/);
  fs.writeFileSync(manifest, '{"type":"module"}');
  const scope = readDeployedPackage(manifest, { imageRoot: options.root }).row;
  assert.equal(scope.format, 'PACKAGE_SCOPE_METADATA'); assert.equal(scope.name, null); assert.equal(scope.version, null);
});
test('package inventory rejects escaped, malformed and invalid platform metadata', t => {
  const { file, options } = artifact(t, {}), manifest = path.join(path.dirname(file), 'package.json');
  const other = path.join(options.root, 'other-root'); fs.mkdirSync(other);
  assert.throws(() => readDeployedPackage(manifest, { imageRoot: other }), /bounded contained/);
  fs.writeFileSync(manifest, '{'); assert.throws(() => readDeployedPackage(manifest, { imageRoot: options.root }));
  fs.writeFileSync(manifest, '{"name":"fixture","version":"1","libc":"musl"}');
  assert.throws(() => readDeployedPackage(manifest, { imageRoot: options.root }), /invalid package libc/);
});
test('actual report finalizer counts the summary receipt in emitted output', () => {
  const output = [], stream = createReceiptStream(line => output.push(line));
  stream.emit('native-inventory', { file: '/app/fixture.node' });
  completeReceiptReport({ status: 'FAIL', mode: 'OFFLINE_RUNTIME' }, stream, 'summary', { status: 'FAIL' });
  const emitted = output.join('\n'), lines = emitted.split('\n');
  const receipts = lines.filter(line => line.startsWith('CORE_NATIVE_RECEIPT ')).map(line => JSON.parse(line.slice('CORE_NATIVE_RECEIPT '.length)));
  const report = JSON.parse(lines.filter(line => !line.startsWith('CORE_NATIVE_RECEIPT ')).join('\n'));
  assert.equal(receipts.length, 2); assert.equal(report.receiptCount, receipts.length);
  assert.deepEqual(receipts.map(row => row.sequence), [1, 2]); assert.equal(receipts.at(-1).kind, 'summary');
});
test('per-file inspection failures retain rows and do not stop the next native observation', t => {
  const { file, options } = artifact(t, {});
  const missing = inspectArtifact(path.join(options.root, 'missing.node'), options);
  assert.equal(missing.format, 'UNREADABLE_OR_INVALID_ARTIFACT'); assert.equal(missing.inspectionError.code, 'ENOENT');
  const good = inspectArtifact(file, options);
  assert.equal(good.format, 'ELF'); assert.equal(good.classification.state, 'COMPATIBLE');
  fs.writeFileSync(path.join(path.dirname(file), 'package.json'), '{');
  const invalid = inspectArtifact(file, options); assert.equal(invalid.format, 'ELF'); assert(invalid.inspectionError);
  assert.match(invalid.sha256, /^[a-f0-9]{64}$/);
});

function probe(script, options) {
  return assertDumbInitVersion(process.execPath, ['-e', script], options);
}

test('accepts the pinned version from stderr, as observed in the failed Alpine build', () => {
  probe('process.stderr.write("dumb-init v1.2.5\\n")');
});
test('accepts the same pinned version from stdout', () => {
  probe('process.stdout.write("dumb-init v1.2.5\\n")');
});
test('rejects a different version on either stream', () => {
  for (const stream of ['stdout', 'stderr']) {
    assert.throws(() => probe(`process.${stream}.write("dumb-init v1.2.4\\n")`), /did not match/);
  }
});
test('rejects nonzero exit even when the expected version is printed', () => {
  assert.throws(() => probe('process.stderr.write("dumb-init v1.2.5\\n");process.exit(7)'), /must exit successfully/);
});
test('rejects empty output', () => {
  assert.throws(() => probe(''), /did not match/);
});
test('kills and rejects a command exceeding the deadline', () => {
  assert.throws(() => probe('setInterval(()=>{},1000)', { timeout: 100 }), error => error.code === 'ETIMEDOUT');
});
test('rejects output exceeding the bounded buffer', () => {
  assert.throws(() => probe('process.stdout.write("x".repeat(2*1024*1024))'), error => error.code === 'ENOBUFS');
});
test('rejects an unavailable executable', () => {
  assert.throws(() => assertDumbInitVersion(require('node:path').join(__dirname, 'nonexistent-qualification-executable')), error => error.code === 'ENOENT');
});
