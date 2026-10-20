const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'alpine-runtime-probe.cjs'), 'utf8');
async function runCollector(verifyInstalledClosure) {
  const output = [], counts = { child: 0, packageExecution: 0 };
  const module = { exports: {} };
  const missing = () => { throw Object.assign(new Error('synthetic unreadable artifact'), { code: 'ENOENT' }); };
  const fakeRequire = name => {
    if (name === './qualification-platform.cjs') return require('./qualification-platform.cjs');
    if (name === './runtime-closure-contract.cjs') return { verifyInstalledClosure, artifactOwner: () => { throw new Error('unexplained artifact'); } };
    if (name === 'node:fs') return { existsSync: file => file === '/lib/ld-musl-aarch64.so.1', realpathSync: file => file, statSync: missing };
    if (name === 'node:module') return { createRequire: () => () => { counts.packageExecution++; throw new Error('package execution forbidden'); } };
    if (name === 'node:child_process') return Object.fromEntries(['execFileSync', 'spawnSync', 'spawn'].map(key => [key, () => { counts.child++; throw new Error('child execution forbidden'); }]));
    assert(name.startsWith('node:')); return require(name);
  };
  fakeRequire.main = module;
  const fakeProcess = { platform: 'linux', arch: 'arm64', version: 'v22.23.3', getuid: () => 1001, getgid: () => 1001,
    report: { getReport: () => ({ header: {} }) }, argv: ['node', 'probe', '--static'], env: {}, exitCode: 0 };
  await vm.runInNewContext(source, { require: fakeRequire, module, Buffer, process: fakeProcess, console: { log: value => output.push(value), error: value => output.push(value) } }, { timeout: 2000 });
  assert(output[0].startsWith('CORE_NATIVE_GATE_SUMMARY '), 'bounded gate summary must precede verbose receipts');
  const summary = JSON.parse(output[0].slice('CORE_NATIVE_GATE_SUMMARY '.length));
  const firstReceiptBytes = Buffer.byteLength(output.find(line => line.startsWith('CORE_NATIVE_RECEIPT ')) || '');
  const report = JSON.parse(output.filter(line => !line.startsWith('CORE_NATIVE_RECEIPT ')).at(-1));
  return { report, summary, firstReceiptBytes, counts, exitCode: fakeProcess.exitCode };
}
test('actual collector stops before every package/child/native fixture when installed closure rejects', async () => {
  const value = await runCollector(() => { throw new Error('injected owner or missing contract'); });
  assert.equal(value.exitCode, 1); assert.equal(value.report.status, 'FAIL');
  assert.equal(value.summary.outcome, 'HOLD_BEFORE_NATIVE_EXECUTION');
  assert.deepEqual(value.summary.failures.map(row => row.name), ['production-dependency-closure']);
  assert.equal(value.report.gates[0].name, 'production-dependency-closure'); assert.equal(value.report.gates.length, 1);
  assert.deepEqual(value.counts, { child: 0, packageExecution: 0 });
});
test('actual collector retains artifact HOLD and stops before fixtures after graph success', async () => {
  const value = await runCollector(() => ({ status: 'PASS_EXACT_INSTALLED_PRODUCTION_CLOSURE', contractSHA256: 'fixture', target: {},
    owners: [], generated: [], edges: [{ padding: 'x'.repeat(250000) }], missingOptional: [], visitedNodes: 5,
    traversal: { files: ['/app/unknown.node'], directories: 1, symbolicLinks: 0 } }));
  assert.equal(value.exitCode, 1); assert.equal(value.report.artifacts.length, 1);
  assert(value.firstReceiptBytes > 200 * 1024, 'large closure receipt must follow the bounded summary');
  assert(value.summary.failures.some(row => row.name.startsWith('artifact-production-owner:') && row.message));
  assert(value.report.gates.some(row => row.name.startsWith('artifact-production-owner:') && row.status === 'HOLD'));
  assert(!value.report.gates.some(row => row.name === 'vendor-runtime'));
  assert.deepEqual(value.counts, { child: 0, packageExecution: 0 });
});
