'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ENGINE, WASM, planRepair, applyRepair, diagnosticSnapshot, main } = require('./derived-owner-repair.cjs');

const digest = data => createHash('sha256').update(data).digest('hex');
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-derived-owner-'));
  t.after(() => {
    const intended = fs.realpathSync(os.tmpdir());
    assert(path.resolve(root).startsWith(intended + path.sep), 'fixture cleanup escapes temp root');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = path.join(root, 'node_modules', '.pnpm');
  const owner = (entry, name, version, extra = {}) => {
    const packageRoot = path.join(store, entry, 'node_modules', ...name.split('/'));
    write(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version, ...extra }));
    return packageRoot;
  };
  const prisma = owner('prisma@5.22.0', 'prisma', '5.22.0', { dependencies: { '@prisma/engines': '5.22.0' } });
  const engines = owner('@prisma+engines@5.22.0', '@prisma/engines', '5.22.0');
  const esbuild = owner('esbuild@0.28.2', 'esbuild', '0.28.2', { optionalDependencies: { '@esbuild/linux-x64': '0.28.2' } });
  const platform = owner('@esbuild+linux-x64@0.28.2', '@esbuild/linux-x64', '0.28.2', { os: ['linux'], cpu: ['x64'] });
  const directLink = (parent, name, source) => {
    const link = path.join(path.dirname(parent), ...name.split('/'));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(link), source), link, process.platform === 'win32' ? 'junction' : 'dir');
  };
  directLink(prisma, '@prisma/engines', engines);
  directLink(esbuild, '@esbuild/linux-x64', platform);
  const wasm = Buffer.from('0061736d0100000001000000', 'hex');
  const engine = Buffer.from('7f454c4602010100454e47494e45', 'hex');
  const binary = Buffer.from('7f454c460201010045534255494c44', 'hex');
  write(path.join(prisma, WASM), wasm);
  write(path.join(prisma, ENGINE), engine);
  write(path.join(engines, ENGINE), engine);
  write(path.join(esbuild, 'bin', 'esbuild'), binary);
  write(path.join(platform, 'bin', 'esbuild'), binary);
  if (process.platform !== 'win32') fs.chmodSync(path.join(platform, 'bin', 'esbuild'), 0o755);
  const pins = { prismaWasm: { bytes: wasm.length, sha256: digest(wasm) },
    prismaEngine: { bytes: engine.length, sha256: digest(engine) }, esbuildBinary: { bytes: binary.length, sha256: digest(binary) } };
  return { root, prisma, engines, esbuild, platform, pins };
}

test('exact direct owners, three hashes and four former HOLD gates produce a contained repair plan', t => {
  const f = fixture(t), plan = planRepair(f.root, f.pins);
  assert.equal(plan.records.length, 4);
  assert.equal(plan.records[0].sha256, f.pins.prismaWasm.sha256);
  assert.equal(plan.records[1].sha256, f.pins.prismaWasm.sha256);
  assert.equal(plan.records[2].sha256, plan.records[2].sourceSha256);
  assert.equal(plan.records[3].sha256, plan.records[3].sourceSha256);
  assert(plan.records.every(row => row.gate.startsWith('artifact-production-owner:') || row.gate.startsWith('wasm-format:')));
  assert(plan.links.every(row => row.derived.startsWith(plan.store + path.sep) && row.source.startsWith(plan.store + path.sep)));
  if (process.platform === 'win32') return; // Windows ACLs may disallow file symlink creation.
  applyRepair(plan);
  for (const link of plan.links) {
    assert(fs.lstatSync(link.derived).isSymbolicLink());
    assert.equal(fs.realpathSync(link.derived), fs.realpathSync(link.source));
  }
});

test('wrong Prisma engine bytes hold before either binary is linked and retain bounded four-record evidence', t => {
  const f = fixture(t), derived = path.join(f.prisma, ENGINE);
  fs.appendFileSync(derived, 'changed');
  assert.throws(() => planRepair(f.root, f.pins), /derived\/source size mismatch/);
  const records = diagnosticSnapshot(f.root);
  assert.equal(records.length, 4);
  assert.equal(records[2].observed.bytes, f.pins.prismaEngine.bytes + 7);
  assert.equal(records[2].source.sha256, f.pins.prismaEngine.sha256);
  assert.equal(records[3].source.sha256, f.pins.esbuildBinary.sha256);
  assert(!fs.lstatSync(derived).isSymbolicLink());
  assert(!fs.lstatSync(path.join(f.esbuild, 'bin', 'esbuild')).isSymbolicLink());
  assert(Buffer.byteLength(JSON.stringify({ records })) < 8192, 'failure diagnostic must be bounded');
  const lines = [];
  assert.throws(() => main(f.root, f.pins, line => lines.push(line)), /derived\/source size mismatch/);
  assert.equal(lines.length, 1, 'one compact summary before the error');
  const summary = JSON.parse(lines[0].slice('CORE_DERIVED_OWNER_REPAIR_SUMMARY '.length));
  assert.equal(summary.status, 'HOLD_BEFORE_LINKING');
  assert.equal(summary.records.length, 4);
  assert(Buffer.byteLength(lines[0]) < 8192, 'single emitted diagnostic must be bounded');
});

test('unknown Prisma WASM and wrong direct platform identity cannot plan any link', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.prisma, WASM), 'changed');
  assert.throws(() => planRepair(f.root, f.pins), /Prisma CLI WASM byte count/);
  assert(!fs.lstatSync(path.join(f.prisma, ENGINE)).isSymbolicLink());
  fs.writeFileSync(path.join(f.prisma, WASM), Buffer.from('0061736d0100000001000000', 'hex'));
  const manifest = path.join(f.platform, 'package.json');
  const changed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  write(manifest, JSON.stringify({ ...changed, version: '0.28.3' }));
  assert.throws(() => planRepair(f.root, f.pins), /exactly one physical @esbuild\/linux-x64@0\.28\.2 owner/);
  assert(!fs.lstatSync(path.join(f.esbuild, 'bin', 'esbuild')).isSymbolicLink());
});

test('matching copies with unknown engine or esbuild bytes still fail exact official pins', t => {
  const f = fixture(t);
  for (const root of [f.prisma, f.engines]) fs.appendFileSync(path.join(root, ENGINE), 'x');
  assert.throws(() => planRepair(f.root, f.pins), /Prisma musl engine byte count differs/);
  for (const root of [f.prisma, f.engines]) fs.truncateSync(path.join(root, ENGINE), f.pins.prismaEngine.bytes);
  for (const root of [f.esbuild, f.platform]) fs.appendFileSync(path.join(root, 'bin', 'esbuild'), 'x');
  assert.throws(() => planRepair(f.root, f.pins), /esbuild linux-x64 binary byte count differs/);
  assert(!fs.lstatSync(path.join(f.prisma, ENGINE)).isSymbolicLink());
  assert(!fs.lstatSync(path.join(f.esbuild, 'bin', 'esbuild')).isSymbolicLink());
});
