const assert = require('node:assert/strict');
const test = require('node:test');
const { assertDumbInitVersion } = require('./alpine-runtime-probe.cjs');
const { classifyNativeArtifact, assertActiveBinding, assertOptionalInactive } = require('./alpine-runtime-probe.cjs');
const { boundedChild, collectChecks, parseLoaderMappings, assertRuntimeLibc, parseChildProof } = require('./alpine-runtime-probe.cjs');
const { resolvedNativeBinding, readDeployedPackage } = require('./alpine-runtime-probe.cjs');
const { createReceiptStream, completeReceiptReport, inspectArtifact } = require('./alpine-runtime-probe.cjs');
const { binaryFormat, wasmVendorEvidence, installedVersionAdmission, packageDependencyEvidence } = require('./alpine-runtime-probe.cjs');
const { elfSymbolFacts, mappedSymbolFacts, collectSymbolProviders, vendorSelectorSources, staticImportCandidates, apiReachabilityEvidence, sourceIdentity } = require('./alpine-runtime-probe.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real ELF64 table relationships; synthetic bytes only, never passed to a loader.
function symbolElf() {
  const data = Buffer.alloc(4096), strings = Buffer.from('\0_Unwind_Resume\0__register_frame\0GCC_3.0\0GCC_REQ\0libgcc_s.so.1\0');
  const name = value => strings.indexOf(Buffer.from(value + '\0'));
  data.write('7f454c46', 0, 'hex'); data[4] = 2; data[5] = 1; data.writeUInt16LE(183, 18);
  data.writeBigUInt64LE(64n, 32); data.writeUInt16LE(56, 54); data.writeUInt16LE(1, 56);
  data.writeBigUInt64LE(512n, 40); data.writeUInt16LE(64, 58); data.writeUInt16LE(7, 60);
  data.writeUInt32LE(1, 64); data.writeUInt32LE(5, 68); data.writeBigUInt64LE(0x1000n, 80);
  data.writeBigUInt64LE(4096n, 96); data.writeBigUInt64LE(4096n, 104); data.writeBigUInt64LE(4096n, 112);
  const section = (index, type, offset, size, link = 0, entry = 0) => {
    const at = 512 + index * 64; data.writeUInt32LE(type, at + 4); data.writeBigUInt64LE(BigInt(offset), at + 24);
    data.writeBigUInt64LE(BigInt(size), at + 32); data.writeUInt32LE(link, at + 40); data.writeBigUInt64LE(BigInt(entry), at + 56);
  };
  strings.copy(data, 160); section(1, 3, 160, strings.length);
  section(2, 11, 256, 72, 1, 24); section(3, 0x6fffffff, 336, 6, 2);
  section(4, 0x6ffffffd, 352, 28, 1); section(5, 0x6ffffffe, 384, 32, 1); section(6, 6, 432, 16, 1);
  data.writeUInt32LE(name('_Unwind_Resume'), 280); data[284] = 0x12; data.writeUInt16LE(1, 286); data.writeBigUInt64LE(0x1100n, 288); data.writeBigUInt64LE(16n, 296);
  data.writeUInt32LE(name('__register_frame'), 304); data[308] = 0x12;
  data.writeUInt16LE(2, 338); data.writeUInt16LE(0x8003, 340);
  data.writeUInt16LE(1, 352); data.writeUInt16LE(2, 356); data.writeUInt16LE(1, 358); data.writeUInt32LE(20, 364); data.writeUInt32LE(name('GCC_3.0'), 372);
  data.writeUInt16LE(1, 384); data.writeUInt16LE(1, 386); data.writeUInt32LE(name('libgcc_s.so.1'), 388); data.writeUInt32LE(16, 392);
  data.writeUInt16LE(3, 406); data.writeUInt32LE(name('GCC_REQ'), 408);
  return data;
}
test('provider dynsym retains exact definition, binding, visibility and version versus requirement', () => {
  const facts = elfSymbolFacts(symbolElf(), ['_Unwind_Resume', '__register_frame', '_Unwind_GetIP']);
  assert.equal(facts.actualProcessLookup, 'UNOBSERVED'); assert.equal(facts.symbols.length, 2);
  const [defined, missing] = facts.symbols;
  assert.equal(defined.defined, true); assert.equal(defined.binding, 1); assert.equal(defined.visibility, 0); assert.equal(defined.value, '0x1100');
  assert.equal(defined.version.descriptor.name, 'GCC_3.0'); assert.equal(defined.version.descriptor.kind, 'DEFINITION');
  assert.equal(missing.defined, false); assert.equal(missing.version.hidden, true); assert.equal(missing.version.descriptor.kind, 'REQUIREMENT');
  assert.deepEqual(facts.missingNames, ['_Unwind_GetIP']); assert.equal(facts.loads[0].virtualAddress, '0x1000');
});
test('provider parser rejects wrong machine, missing symbols, truncated/version/offset corruption', () => {
  const wrong = symbolElf(); wrong.writeUInt16LE(62, 18); assert.throws(() => elfSymbolFacts(wrong), /arm64/);
  const absent = symbolElf(); absent.writeUInt32LE(1, 512 + 2 * 64 + 4); assert.throws(() => elfSymbolFacts(absent), /dynamic symbol table/);
  assert.throws(() => elfSymbolFacts(symbolElf().subarray(0, 700)), /truncated ELF/);
  const bad = symbolElf(); bad.writeUInt32LE(20000, 364); assert.throws(() => elfSymbolFacts(bad), /auxiliary outside/);
  const badString = symbolElf(); badString.writeUInt32LE(9999, 280); assert.throws(() => elfSymbolFacts(badString), /string table/);
  const versym = symbolElf(); versym.writeBigUInt64LE(4n, 512 + 3 * 64 + 32); assert.throws(() => elfSymbolFacts(versym), /truncated symbol versions/);
});
test('mapped addresses are calculated candidates, never observed process lookup', () => {
  const facts = mappedSymbolFacts(symbolElf(), '9000-a000 r-xp 00000000 00:01 1 /usr/lib/provider.so\n', '/usr/lib/provider.so');
  assert.deepEqual(facts.loadBiasCandidates, ['0x8000']); assert.equal(facts.calculatedSymbolAddresses[0].addresses[0].address, '0x9100');
  assert.equal(facts.calculatedSymbolAddresses[0].addresses[0].inMappedRange, true); assert.equal(facts.actualProcessLookup, 'UNOBSERVED');
  const unknown = mappedSymbolFacts(symbolElf(), '', '/usr/lib/provider.so'); assert.equal(unknown.status, 'MAPPING_BIAS_UNPROVEN');
});
test('provider collection retains per-file failures and later valid observations without lookup exemption', () => {
  const bytes = symbolElf(), sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const addon = { file: '/app/node_modules/.pnpm/addon.node', sha256, bytes: bytes.length };
  const good = { file: '/usr/lib/good.so', sha256, bytes: bytes.length }, bad = { file: '/usr/lib/bad.so', sha256: '0'.repeat(64), bytes: bytes.length };
  const result = collectSymbolProviders([bad, good], '', addon, ['_Unwind_Resume'], { read: () => bytes });
  assert.equal(result.providers.length, 3); assert.equal(result.providers[1].status, 'PROVIDER_FACTS_UNVERIFIED');
  assert(result.providers[2].facts.symbols.length); assert.equal(result.actualProcessLookup, 'UNOBSERVED');
});
test('changed provider bytes and escaped provider roots are explicit unverified rows', () => {
  const bytes = symbolElf(), sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex'); let reads = 0;
  const result = collectSymbolProviders([], '', { file: '/usr/lib/provider.so', sha256, bytes: bytes.length }, ['_Unwind_Resume'], { read: () => ++reads === 1 ? bytes : Buffer.alloc(4096) });
  assert.match(result.providers[0].error.message, /changed after/);
  const escaped = collectSymbolProviders([], '', { file: '/outside/provider.so', sha256, bytes: bytes.length }, ['_Unwind_Resume'], { read: () => bytes });
  assert.match(escaped.providers[0].error.message, /escapes/);
});
test('static vendor sources bind exact owner and entry bytes without executing side effects', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-selector-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = path.join(root, 'vendor'); fs.mkdirSync(owner);
  fs.writeFileSync(path.join(owner, 'package.json'), JSON.stringify({ name: 'onnxruntime-node', version: '1.30.0', main: 'index.js' }));
  const code = 'throw new Error("MUST_NOT_EXECUTE"); module.exports=require("./selector.js");';
  fs.writeFileSync(path.join(owner, 'index.js'), code); fs.writeFileSync(path.join(owner, 'selector.js'), 'module.exports=process.arch;');
  const result = vendorSelectorSources(path.join(owner, 'package.json'), { imageRoot: root });
  assert.equal(result.status, 'UNPROVEN'); assert.equal(result.selectedPayload, 'UNOBSERVED'); assert.equal(result.sources.length, 2);
  assert.equal(Buffer.from(result.sources[0].contentBase64, 'base64').toString(), code); assert.equal(result.errors.length, 0);
});
test('vendor large source capture retains hash and explicit incomplete prefix', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-selector-large-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@openai/codex-security', version: '0.1.31', main: 'index.js' }));
  fs.writeFileSync(path.join(root, 'index.js'), 'x'.repeat(70000));
  const result = vendorSelectorSources(path.join(root, 'package.json'), { imageRoot: root });
  assert.equal(result.sources[0].bytes, 70000); assert.equal(result.sources[0].capturedBytes, 65536); assert.equal(result.sources[0].sourceComplete, false);
  assert(result.errors.some(error => /prefix only/.test(error.message))); assert.equal(result.selectedPayload, 'UNOBSERVED');
});
test('API graph is explicitly incomplete lexical evidence and does not execute application or prove unused vendor', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-graph-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'entry.js'); fs.writeFileSync(entry, 'throw new Error("MUST_NOT_EXECUTE"); require("./child.js"); require(dynamicName);');
  fs.writeFileSync(path.join(root, 'child.js'), '// require("not-real")\nmodule.exports=1;');
  const result = apiReachabilityEvidence(entry, { imageRoot: root });
  assert.equal(result.nodes.length, 2); assert.equal(result.applicationExecuted, false); assert.equal(result.status, 'UNPROVEN');
  assert.equal(result.vendorReachability['onnxruntime-node'], 'UNPROVEN'); assert(result.edges.some(edge => edge.specifier === 'not-real' && edge.status === 'UNRESOLVED'));
  const bounded = apiReachabilityEvidence(entry, { imageRoot: root, maximumNodes: 1 }); assert(bounded.errors.some(error => /budget/.test(error.message)));
});
test('source containment/type constraints and missing vendor entry never justify selection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-source-bound-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'data.env'), 'not-source'); assert.throws(() => sourceIdentity(path.join(root, 'data.env'), { imageRoot: root }), /source type/);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'onnxruntime-node', version: '1.30.0', main: 'missing.js' }));
  const result = vendorSelectorSources(path.join(root, 'package.json'), { imageRoot: root }); assert(result.errors.length > 0); assert.equal(result.status, 'UNPROVEN');
  assert.deepEqual(staticImportCandidates('require(dynamic); import(other);'), []);
});

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
  assert.throws(() => assertActiveBinding(file, options), /not proven arm64\/musl/);
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
  assert.equal(classifyNativeArtifact(file, options).format, 'UNKNOWN');
  assert(inspectArtifact(file, options).inspectionError);
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
test('same name in another physical owner and an unverified range engine cannot authorize skip', t => {
  const { file, options } = artifact(t, { libc: ['glibc'] }, elf(['libc.so.6']));
  const receipt = classifyNativeArtifact(file, options), opt = { ...options, imageRoot: options.root };
  const parent = parentManifest(path.join(options.root, 'elsewhere'), 'different-parent', { optionalDependencies: { fixture: '1.0.0' } });
  parentManifest(path.join(options.root, 'elsewhere', 'node_modules', 'fixture'), 'fixture', {});
  assert.throws(() => assertOptionalInactive(receipt, [parent], opt), /lacks verified optional/);
  const wrongPin = parentManifest(path.join(options.root, 'store'), 'parent', { optionalDependencies: { fixture: '^1.0.0' } });
  assert.throws(() => assertOptionalInactive(receipt, [wrongPin], opt), /range engine unavailable/);
});

function semverFixture(root) {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/node_modules/semver'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/node_modules/semver')];
  try { candidates.unshift(path.dirname(require.resolve('semver/package.json'))); } catch {}
  const source = candidates.find(dir => fs.existsSync(path.join(dir, 'package.json')));
  assert(source, 'Tests require the existing Node/npm node-semver library, never a download');
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  const target = path.join(root, `semver@${metadata.version}`, 'node_modules/semver');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(source, target, { recursive: true });
}

test('canonical deployed semver admits ^0.1.18 to0.1.31 and rejects nonmatching/prerelease versions', t => {
  const { options } = artifact(t, {}); semverFixture(options.root);
  const accepted = installedVersionAdmission('^0.1.18', '0.1.31', options.root);
  assert(accepted.admitted); assert.equal(accepted.basis, 'DEPLOYED_NODE_SEMVER');
  assert(!installedVersionAdmission('^0.1.18', '0.2.0', options.root).admitted);
  assert(!installedVersionAdmission('^0.1.18', '0.1.31-beta.1', options.root).admitted);
  assert.throws(() => installedVersionAdmission('not a range', '0.1.31', options.root), /invalid installed/);
});

test('bundled payload owner relation is distinct from required/optional package and remains unverified', t => {
  const { file, options } = artifact(t, { name: '@openai/codex-security', version: '0.1.31' }, elf(['libc.so.6']));
  const bundled = path.join(path.dirname(file), '_bundled_plugin/mcp/native/linux-arm64-gnu/unix.node');
  fs.mkdirSync(path.dirname(bundled), { recursive: true }); fs.writeFileSync(bundled, fs.readFileSync(file)); semverFixture(options.root);
  const parent = parentManifest(path.join(options.root, 'store'), 'parent', { optionalDependencies: { '@openai/codex-security': '^0.1.18' } });
  const receipt = classifyNativeArtifact(bundled, options), settings = { ...options, imageRoot: options.root };
  const relations = packageDependencyEvidence(receipt, [parent], settings);
  assert.equal(relations[0].relation, 'optionalDependencies'); assert(relations[0].versionAdmission.admitted);
  assert.throws(() => assertOptionalInactive(receipt, [parent], settings), error => {
    assert.equal(error.code, 'BUNDLED_PAYLOAD_SELECTION_UNVERIFIED');
    assert.equal(error.evidence.payloadRelation, 'BUNDLED_PAYLOAD_OF_PACKAGE'); return true;
  });
  fs.writeFileSync(parent, JSON.stringify({ name: 'parent', version: '1.0.0', dependencies: { '@openai/codex-security': '^0.1.18' } }));
  assert.equal(packageDependencyEvidence(receipt, [parent], settings)[0].relation, 'dependencies');
});

test('failure policy retains all16 exact unexplained loader lines, mappings and successful operation evidence', async () => {
  const { receipt, evidence } = runtimeProof();
  evidence.operationCompleted = true;
  evidence.loader.unexplained = Array.from({ length: 16 }, (_, i) => `synthetic-unexplained-loader-line-${i}`);
  evidence.loader.stderr = evidence.loader.unexplained.join('\n');
  const result = await collectChecks([{ name: 'swc-policy', run: () => assertRuntimeLibc(receipt, evidence) }]);
  assert.equal(result.status, 'HOLD'); const retained = result.rows[0].evidence.runtimeEvidence;
  assert.deepEqual(retained, evidence); assert.equal(retained.loader.unexplained.length, 16);
  assert.equal(retained.loader.stderr, evidence.loader.stderr); assert(retained.operationCompleted);
  const failed = { status: 1, signal: null, error: null, stdout: 'CORE_NATIVE_EVIDENCE ' + JSON.stringify(evidence), stderr: 'policy HOLD' };
  assert.throws(() => parseChildProof(failed), error => { assert.deepEqual(error.evidence.observations, [evidence]); assert.equal(error.child, failed); return true; });
});

test('positive WASM header has separate vendor scope and cannot pass the active native binding gate', t => {
  const wasm = Buffer.from('0061736d01000000', 'hex'), format = binaryFormat(wasm);
  assert.equal(format.format, 'WEBASSEMBLY_V1'); assert.equal(format.native, false);
  const { file, options } = artifact(t, { name: 'quickjs-wasi', version: '2.2.0' }, wasm);
  assert.equal(classifyNativeArtifact(file, options).state, 'UNKNOWN');
  assert.throws(() => assertActiveBinding(file, options), /not proven/);
  const identity = wasmVendorEvidence({ name: 'quickjs-wasi', version: '2.2.0' }, 'extensions/base64/base64.so', 12518, 'f51012d6c63195a53ca9f2daa6c3de6b0995873888c8106979813015b3388adc');
  assert(identity.verified); assert.equal(identity.providerOperation, 'UNRUN'); assert.equal(identity.nativeLoad, 'NOT_APPLICABLE');
  assert(!wasmVendorEvidence({ name: 'quickjs-wasi', version: '2.2.0' }, 'extensions/base64/base64.so', 12518, '0'.repeat(64)).verified);
  assert.equal(binaryFormat(Buffer.from('0061736d02000000', 'hex')).format, 'UNKNOWN');
});

test('Prisma CLI schema WASM inventory uses only exact archive-backed evidence', () => {
  const owner = { name: 'prisma', version: '5.22.0' }, relative = 'build/prisma_schema_build_bg.wasm';
  const digest = 'adf02f9b486d507024be2bf59b271a88e39f48c3ca2266c6c46d7e9109296c05';
  const proof = wasmVendorEvidence(owner, relative, 2893316, digest);
  assert.equal(proof.verified, true); assert.equal(proof.nativeLoad, 'NOT_APPLICABLE');
  for (const args of [[{ ...owner, name: '@prisma/client' }, relative, 2893316, digest],
    [{ ...owner, version: '5.22.1' }, relative, 2893316, digest], [owner, 'build/other.wasm', 2893316, digest],
    [owner, relative, 2893315, digest], [owner, relative, 2893316, '0'.repeat(64)]])
    assert.equal(wasmVendorEvidence(...args).verified, false);
});

test('all six actual QuickJS vendor identities match the preserved integrity-verified provenance', () => {
  const source = path.resolve(__dirname, '../../../../docs/runtime-source-qualification-20261014/container/QUICKJS-FORMAT-PROVENANCE.json');
  const provenance = JSON.parse(fs.readFileSync(source, 'utf8'));
  assert.equal(provenance.artifacts.length, 6); assert(provenance.frozenLockIntegrityVerified);
  for (const row of provenance.artifacts) {
    const relative = 'extensions/' + row.file.split('/extensions/')[1];
    assert.equal(row.magicHex, '0061736d01000000'); assert(row.vendorArtifactHashMatchesTarget);
    const identity = wasmVendorEvidence({ name: 'quickjs-wasi', version: '2.2.0' }, relative, row.bytes, row.sha256);
    assert(identity.verified); assert.equal(identity.tarballSHA256, provenance.tarballSHA256);
  }
});

test('PE and Mach-O require positive bounded headers; names never decide their format', t => {
  const pe = Buffer.alloc(240); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('50450000', 64, 'hex');
  pe.writeUInt16LE(0xaa64, 68); pe.writeUInt16LE(1, 70); pe.writeUInt16LE(112, 84); pe.writeUInt16LE(0x20b, 88);
  assert.equal(binaryFormat(pe).format, 'PE'); assert.equal(binaryFormat(pe).cpu, 'arm64');
  const contradiction = artifact(t, { os: ['linux'], cpu: ['arm64'] }, pe);
  assert.throws(() => classifyNativeArtifact(contradiction.file, contradiction.options), /OS constraint disagreement/);
  const macho = Buffer.alloc(40); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(0x1000007, 4); macho.writeUInt32LE(8, 12);
  macho.writeUInt32LE(1, 16); macho.writeUInt32LE(8, 20); macho.writeUInt32LE(8, 36);
  assert.equal(binaryFormat(macho).format, 'MACH_O_64_LE'); assert.equal(binaryFormat(macho).cpu, 'x64');
  assert.equal(binaryFormat(Buffer.from('foreign darwin-arm64.so')).format, 'UNKNOWN');
  pe.writeUInt32LE(100000, 60); assert.throws(() => binaryFormat(pe), /PE signature/);
  macho.writeUInt32LE(100000, 36); assert.throws(() => binaryFormat(macho), /Mach-O command/);
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
