/* Qualification-only: turn two byte-identical postinstall copies into links to
 * their direct, frozen production dependencies in the final runtime tree.
 * No owner is admitted by this script; the mandatory runtime probe still decides.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const PINS = Object.freeze({
  prismaWasm: Object.freeze({ bytes: 2893316, sha256: 'adf02f9b486d507024be2bf59b271a88e39f48c3ca2266c6c46d7e9109296c05' }),
  esbuildBinary: Object.freeze({ bytes: 11427952, sha256: 'e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100' }),
  // Raw artifact from Prisma's pinned engine commit
  // 605197351a3c8bdd595af2d2a9bc3025bca48ea2 on binaries.prisma.sh.
  prismaEngine: Object.freeze({ bytes: 16128320, sha256: 'b8497554202349836f1f0a418b94fdbddfb5a36911d0cef8cf20b5ce88f0d74f' }),
});
const ENGINE = 'libquery_engine-linux-musl-openssl-3.0.x.so.node';
const WASM = 'build/prisma_schema_build_bg.wasm';
const MAX_BINARY = 64 * 1024 * 1024;

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function boundedFile(file, ownerRoot, maximumBytes) {
  const actual = fs.realpathSync(file), owner = fs.realpathSync(ownerRoot);
  assert(inside(owner, actual), 'artifact escapes exact package owner');
  const stat = fs.statSync(actual);
  assert(stat.isFile() && stat.size > 0 && stat.size <= maximumBytes, 'bounded regular artifact required');
  const data = fs.readFileSync(actual);
  assert.equal(data.length, stat.size, 'artifact changed during read');
  return { path: actual, bytes: data.length, sha256: hash(data), header: data.subarray(0, 8).toString('hex') };
}
function readManifest(root) {
  const file = path.join(root, 'package.json');
  const data = boundedFile(file, root, 1024 * 1024);
  const raw = fs.readFileSync(file);
  assert.equal(raw.length, data.bytes, 'package manifest changed during read');
  assert.equal(hash(raw), data.sha256, 'package manifest changed during read');
  return { ...data, value: JSON.parse(raw.toString('utf8')) };
}
function physicalOwner(store, name, version) {
  const parts = name.split('/'), matches = [];
  for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const candidate = path.join(store, entry.name, 'node_modules', ...parts);
    if (!fs.existsSync(path.join(candidate, 'package.json'))) continue;
    if (!fs.lstatSync(candidate).isDirectory()) continue; // A direct dependency link is not a physical owner.
    const root = fs.realpathSync(candidate);
    assert(inside(store, root), 'physical owner escapes pnpm store');
    const manifest = readManifest(root);
    if (manifest.value.name === name && manifest.value.version === version) matches.push({ root, manifest });
  }
  assert.equal(matches.length, 1, `exactly one physical ${name}@${version} owner required`);
  return matches[0];
}
function directDependency(owner, store, name, version, kind) {
  assert.equal(owner.manifest.value[kind]?.[name], version, 'exact direct dependency declaration required');
  const candidate = path.join(path.dirname(owner.root), ...name.split('/'));
  assert(fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink(), 'direct pnpm dependency link required');
  const actual = fs.realpathSync(candidate);
  assert(inside(store, actual), 'direct dependency escapes pnpm store');
  const dependency = physicalOwner(store, name, version);
  assert.equal(actual, dependency.root, 'direct dependency resolves to wrong physical owner');
  return dependency;
}
function exactPin(observed, expected, label) {
  assert.equal(observed.bytes, expected.bytes, `${label} byte count differs from official payload`);
  assert.equal(observed.sha256, expected.sha256, `${label} SHA-256 differs from official payload`);
}
function sameBytes(derived, source, label) {
  assert.equal(derived.bytes, source.bytes, `${label} derived/source size mismatch`);
  assert.equal(derived.sha256, source.sha256, `${label} derived/source hash mismatch`);
}
function runtimeName(root, file) {
  return '/app/' + path.relative(root, file).split(path.sep).join('/');
}
function planRepair(workspace = '/app', pins = PINS) {
  workspace = fs.realpathSync(workspace);
  const store = fs.realpathSync(path.join(workspace, 'node_modules', '.pnpm'));
  assert(inside(workspace, store), 'pnpm store escapes workspace');

  const prisma = physicalOwner(store, 'prisma', '5.22.0');
  const engines = directDependency(prisma, store, '@prisma/engines', '5.22.0', 'dependencies');
  const esbuild = physicalOwner(store, 'esbuild', '0.28.2');
  const platform = directDependency(esbuild, store, '@esbuild/linux-x64', '0.28.2', 'optionalDependencies');
  assert.deepEqual(platform.manifest.value.os, ['linux']);
  assert.deepEqual(platform.manifest.value.cpu, ['x64']);

  const wasm = boundedFile(path.join(prisma.root, WASM), prisma.root, 4 * 1024 * 1024);
  exactPin(wasm, pins.prismaWasm, 'Prisma CLI WASM');
  assert.equal(wasm.header, '0061736d01000000', 'Prisma CLI WASM v1 header required');

  const prismaDerivedPath = path.join(prisma.root, ENGINE);
  const prismaSourcePath = path.join(engines.root, ENGINE);
  const esbuildDerivedPath = path.join(esbuild.root, 'bin', 'esbuild');
  const esbuildSourcePath = path.join(platform.root, 'bin', 'esbuild');
  for (const file of [prismaDerivedPath, esbuildDerivedPath])
    assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'derived artifact must be an unlinked regular file');
  const prismaDerived = boundedFile(prismaDerivedPath, prisma.root, MAX_BINARY);
  const prismaSource = boundedFile(prismaSourcePath, engines.root, MAX_BINARY);
  sameBytes(prismaDerived, prismaSource, 'Prisma CLI musl engine');
  exactPin(prismaSource, pins.prismaEngine, 'Prisma musl engine');
  assert(prismaDerived.header.startsWith('7f454c46'), 'Prisma musl engine must be ELF');
  const esbuildDerived = boundedFile(esbuildDerivedPath, esbuild.root, MAX_BINARY);
  const esbuildSource = boundedFile(esbuildSourcePath, platform.root, MAX_BINARY);
  sameBytes(esbuildDerived, esbuildSource, 'esbuild wrapper binary');
  exactPin(esbuildSource, pins.esbuildBinary, 'esbuild linux-x64 binary');
  assert(esbuildDerived.header.startsWith('7f454c46'), 'esbuild binary must be ELF');
  // Windows test fixtures cannot preserve POSIX executable mode; the Docker
  // qualification runs on Linux and always enforces it there.
  if (process.platform !== 'win32') assert((fs.statSync(esbuildSourcePath).mode & 0o111) !== 0, 'esbuild platform binary must be executable');

  const records = [
    { gate: 'artifact-production-owner:' + runtimeName(workspace, path.join(prisma.root, WASM)), bytes: wasm.bytes, sha256: wasm.sha256,
      ownerManifestSha256: prisma.manifest.sha256, resolution: 'PINNED_PRISMA_CLI_WASM' },
    { gate: 'wasm-format:' + runtimeName(workspace, path.join(prisma.root, WASM)), bytes: wasm.bytes, sha256: wasm.sha256,
      ownerManifestSha256: prisma.manifest.sha256, resolution: 'PINNED_PRISMA_CLI_WASM' },
    { gate: 'artifact-production-owner:' + runtimeName(workspace, prismaDerivedPath), bytes: prismaDerived.bytes, sha256: prismaDerived.sha256,
      ownerManifestSha256: prisma.manifest.sha256, source: runtimeName(workspace, prismaSourcePath), sourceSha256: prismaSource.sha256,
      sourceOwnerManifestSha256: engines.manifest.sha256, resolution: 'LINK_TO_VERIFIED_DIRECT_ENGINE_OWNER' },
    { gate: 'artifact-production-owner:' + runtimeName(workspace, esbuildDerivedPath), bytes: esbuildDerived.bytes, sha256: esbuildDerived.sha256,
      ownerManifestSha256: esbuild.manifest.sha256, source: runtimeName(workspace, esbuildSourcePath), sourceSha256: esbuildSource.sha256,
      sourceOwnerManifestSha256: platform.manifest.sha256, resolution: 'LINK_TO_PINNED_DIRECT_PLATFORM_OWNER' },
  ];
  return { workspace, store, records, links: [
    { derived: prismaDerivedPath, source: prismaSourcePath, bytes: prismaDerived.bytes, sha256: prismaDerived.sha256 },
    { derived: esbuildDerivedPath, source: esbuildSourcePath, bytes: esbuildDerived.bytes, sha256: esbuildDerived.sha256 },
  ] };
}
function applyRepair(plan) {
  for (const link of plan.links) {
    assert(inside(plan.store, link.derived) && inside(plan.store, link.source), 'repair paths escape pnpm store');
    assert(fs.lstatSync(link.derived).isFile() && !fs.lstatSync(link.derived).isSymbolicLink(), 'derived file changed before linking');
    const current = boundedFile(link.derived, path.dirname(link.derived), MAX_BINARY);
    const source = boundedFile(link.source, path.dirname(link.source), MAX_BINARY);
    sameBytes(current, source, 'derived artifact before linking');
    assert.equal(current.sha256, link.sha256, 'derived artifact changed after plan');
    const relative = path.relative(path.dirname(link.derived), link.source);
    assert(!path.isAbsolute(relative) && inside(plan.store, path.resolve(path.dirname(link.derived), relative)), 'relative target escapes store');
    fs.unlinkSync(link.derived);
    fs.symlinkSync(relative, link.derived, 'file');
    assert.equal(fs.realpathSync(link.derived), fs.realpathSync(link.source), 'derived link does not resolve to validated owner');
  }
}
function boundedError(error) {
  return { code: String(error.code || error.name || 'ERROR').slice(0, 64), message: String(error.message).slice(0, 160) };
}
// Capture the four former HOLD gates even if a pin or ownership assertion
// fails. This is diagnostic only: it cannot authorize a link or native load.
function diagnosticSnapshot(workspace = '/app') {
  const root = path.resolve(workspace), store = path.join(root, 'node_modules', '.pnpm');
  function captureOwner(name, version) {
    try { return physicalOwner(store, name, version); } catch (error) { return { error: boundedError(error) }; }
  }
  function captureArtifact(owner, relative) {
    if (!owner.root) return { error: owner.error };
    try {
      const file = boundedFile(path.join(owner.root, ...relative.split('/')), owner.root, MAX_BINARY);
      return { bytes: file.bytes, sha256: file.sha256, header: file.header };
    } catch (error) { return { error: boundedError(error) }; }
  }
  function captureSource(parent, name, relative) {
    if (!parent.root) return { error: parent.error };
    try {
      const ownerRoot = fs.realpathSync(path.join(path.dirname(parent.root), ...name.split('/')));
      assert(inside(store, ownerRoot), 'source owner escapes pnpm store');
      const manifest = readManifest(ownerRoot), artifact = captureArtifact({ root: ownerRoot }, relative);
      return { name: String(manifest.value.name).slice(0, 64), version: String(manifest.value.version).slice(0, 64),
        ownerManifestSha256: manifest.sha256, ...artifact };
    } catch (error) { return { error: boundedError(error) }; }
  }
  function runtimeArtifact(owner, name, version, relative) {
    return owner.root ? runtimeName(root, path.join(owner.root, ...relative.split('/'))) :
      `/app/node_modules/.pnpm/${name.replace('/', '+')}@${version}/node_modules/${name}/${relative}`;
  }
  const prisma = captureOwner('prisma', '5.22.0'), esbuild = captureOwner('esbuild', '0.28.2');
  const wasm = captureArtifact(prisma, WASM), engine = captureArtifact(prisma, ENGINE), esbuildBinary = captureArtifact(esbuild, 'bin/esbuild');
  const prismaOwner = prisma.manifest ? { name: prisma.manifest.value.name, version: prisma.manifest.value.version,
    ownerManifestSha256: prisma.manifest.sha256 } : { error: prisma.error };
  const esbuildOwner = esbuild.manifest ? { name: esbuild.manifest.value.name, version: esbuild.manifest.value.version,
    ownerManifestSha256: esbuild.manifest.sha256 } : { error: esbuild.error };
  const wasmGate = runtimeArtifact(prisma, 'prisma', '5.22.0', WASM);
  return [
    { gate: 'artifact-production-owner:' + wasmGate, observed: wasm, owner: prismaOwner },
    { gate: 'wasm-format:' + wasmGate, observed: wasm, owner: prismaOwner },
    { gate: 'artifact-production-owner:' + runtimeArtifact(prisma, 'prisma', '5.22.0', ENGINE),
      observed: engine, owner: prismaOwner, source: captureSource(prisma, '@prisma/engines', ENGINE) },
    { gate: 'artifact-production-owner:' + runtimeArtifact(esbuild, 'esbuild', '0.28.2', 'bin/esbuild'),
      observed: esbuildBinary, owner: esbuildOwner, source: captureSource(esbuild, '@esbuild/linux-x64', 'bin/esbuild') },
  ];
}
function main(workspace = '/app', pins = PINS, write = line => console.log(line)) {
  let emitted = false;
  try {
    const plan = planRepair(workspace, pins);
    write('CORE_DERIVED_OWNER_REPAIR_SUMMARY ' + JSON.stringify({ schemaVersion: 1, status: 'VALIDATED_BEFORE_LINKING', records: plan.records }));
    emitted = true;
    applyRepair(plan);
  } catch (error) {
    if (!emitted) write('CORE_DERIVED_OWNER_REPAIR_SUMMARY ' + JSON.stringify({ schemaVersion: 1, status: 'HOLD_BEFORE_LINKING',
      records: diagnosticSnapshot(workspace), validationError: boundedError(error) }));
    throw error;
  }
}
if (require.main === module) main();
module.exports = { PINS, ENGINE, WASM, planRepair, applyRepair, diagnosticSnapshot, main };
