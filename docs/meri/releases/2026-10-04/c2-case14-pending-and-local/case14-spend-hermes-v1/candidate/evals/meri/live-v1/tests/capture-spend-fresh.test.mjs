import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pythonExecutable = 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
const evidenceRoot = fileURLToPath(new URL('../../../../../../evidence/', import.meta.url));
const parent = 'C:/dev/main/outputs/meri-c2-20261003/fresh-journal-adapter-v1/local-tests';
const moduleUrl = new URL('../capture-spend-aggregate.mjs', import.meta.url);
const source = readFileSync(moduleUrl, 'utf8');
const original = Object.fromEntries(
  ['run-authorization.json', 'fresh-spend.jsonl'].map((name) => [name, readFileSync(join(evidenceRoot, name))]),
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(original['fresh-spend.jsonl']), '8f20134f71dde90e32fc0c3c2aba2da2d5b93dd13fffea31b83105d1621bc3e5');
assert.equal(hash(original['run-authorization.json']), 'e07822e83a7c7b531606519ecd4fdf1027f2fa7cbaefd4bad92a2084590262fe');
mkdirSync(parent, { recursive: true });

async function fixture() {
  const root = mkdtempSync(join(parent, 'case14-'));
  for (const [name, bytes] of Object.entries(original)) writeFileSync(join(root, name), bytes);
  const wrapper = join(root, 'unit-helper.py');
  const helperSource = fileURLToPath(new URL('../lib/windows-capture-spend.py', import.meta.url));
  const helper = join(root, 'windows-capture-spend.py');
  copyFileSync(helperSource, helper);
  copyFileSync(fileURLToPath(new URL('../lib/windows-artifact-protocol.py', import.meta.url)), join(root, 'windows-artifact-protocol.py'));
  writeFileSync(wrapper,
    `import json,runpy,sys\nm=runpy.run_path(${JSON.stringify(helper)})\n` +
    `m['execute'].__globals__['FRESH_ROOT']=${JSON.stringify(resolve(root))}\n` +
    `try:\n r=m['execute'](json.load(sys.stdin));print(json.dumps({'ok':True,**r}))\n` +
    `except Exception:\n print(json.dumps({'ok':False}));sys.exit(1)\n`);
  const copy = source
    .replace(/from '(\.\/[^']+)'/gu, (_all, ref) => `from '${new URL(ref, moduleUrl).href}'`)
    .replace("const freshRoot = 'C:/dev/main/outputs/meri-fresh-20261003';", `const freshRoot = ${JSON.stringify(root)};`)
    .replace("const helper = fileURLToPath(new URL('./lib/windows-capture-spend.py', import.meta.url));", `const helper = ${JSON.stringify(wrapper)};`);
  assert.notEqual(copy, source);
  const modulePath = join(root, 'unit-owner.mjs');
  writeFileSync(modulePath, copy);
  return { root, module: await import(pathToFileURL(modulePath).href) };
}
const reserve = (caseId = '01') => ({ caseId, captureRunId: randomUUID(), ceilingMicros: 15_000_000 });
const expected = (r) => ({
  caseId: r.caseId, captureRunId: r.captureRunId, maxSpendMicros: r.ceilingMicros,
  conversationId: randomUUID(), actorUserId: randomUUID(), clientId: randomUUID(), promptSha256: 'c'.repeat(64),
});


test('adopts only exact fully settled 24-event checkpoint, without appending', async () => {
  const f = await fixture();
  const prior = f.module.adoptExistingFreshCaptureSpend({ pythonExecutable });
  const owner = f.module.openCaptureSpendAggregate(prior, { pythonExecutable });
  assert.equal(owner.checkpoint().snapshot.eventCount, 24);
  assert.equal(owner.checkpoint().snapshot.activeRun, null);
  assert.deepEqual(readFileSync(join(f.root, 'fresh-spend.jsonl')), original['fresh-spend.jsonl']);
});

test('same owner preserves journal history, failed claims, caps and single-active-run exclusion', async () => {
  const f = await fixture();
  const prior = f.module.adoptExistingFreshCaptureSpend({ pythonExecutable });
  const first = f.module.openCaptureSpendAggregate(prior, { pythonExecutable });
  const stale = f.module.openCaptureSpendAggregate(prior, { pythonExecutable });
  const one = first.reserve(reserve('01'));
  assert.equal(first.checkpoint().snapshot.activeRun, `01:${one.captureRunId}`);
  assert.throws(() => stale.reserve(reserve('20')));
  assert.throws(() => stale.reserve(reserve('20')));
  assert.throws(() => f.module.openCaptureSpendAggregate(first.checkpoint(), { pythonExecutable }));
  assert.equal(readFileSync(join(f.root, 'fresh-spend.jsonl'), 'utf8').trim().split('\n').length, 25);
});

test('fresh owner supports Case14 only after event24 and rejects unsupported cases', async () => {
  const f = await fixture();
  const owner = f.module.openCaptureSpendAggregate(f.module.adoptExistingFreshCaptureSpend({ pythonExecutable }), { pythonExecutable });
  for (const caseId of ['02', '46', '72', '26', '27']) assert.throws(() => owner.reserve(reserve(caseId)));
  const reservation = owner.reserve(reserve('14'));
  assert.equal(owner.checkpoint().snapshot.activeRun, `14:${reservation.captureRunId}`);
  assert.equal(readFileSync(join(f.root, 'fresh-spend.jsonl'), 'utf8').trim().split('\n').length, 25);
});

test('forged or mismatched Case14 outcomes cannot settle or release its ceiling', async () => {
  const f = await fixture();
  const owner = f.module.openCaptureSpendAggregate(f.module.adoptExistingFreshCaptureSpend({ pythonExecutable }), { pythonExecutable });
  const reservation = owner.reserve(reserve('14'));
  f.module.claimCaptureSpendReservation(reservation, expected(reservation));
  for (const outcome of [
    { caseId: '14', captureRunId: reservation.captureRunId, chargedCostMicros: 0 },
    { caseId: '01', captureRunId: reservation.captureRunId, status: 'SETTLED' },
    { kind: 'meri-case14-recall-outcome', signed: true },
  ]) assert.throws(() => f.module.settleCaptureSpendReservation(reservation, outcome));
  assert.equal(owner.checkpoint().snapshot.activeRun, `14:${reservation.captureRunId}`);
  assert.equal(readFileSync(join(f.root, 'fresh-spend.jsonl'), 'utf8').trim().split('\n').length, 25);
});

test('native owner rejects mismatched/duplicate claim and caller-shaped settlement proof', async () => {
  const f = await fixture();
  const owner = f.module.openCaptureSpendAggregate(f.module.adoptExistingFreshCaptureSpend({ pythonExecutable }), { pythonExecutable });
  const reservation = owner.reserve(reserve('01'));
  const binding = expected(reservation);
  assert.throws(() => f.module.claimCaptureSpendReservation({ ...reservation }, binding));
  f.module.claimCaptureSpendReservation(reservation, binding);
  assert.throws(() => f.module.claimCaptureSpendReservation(reservation, binding));
  assert.throws(() => f.module.assertCaptureSpendReservation(reservation, { ...binding, clientId: randomUUID() }));
  assert.throws(() => owner.settleCaptured(reservation, { chargedCostMicros: 0, status: 'CAPTURE_COMPLETE' }));
});

 test('tampered prefix and retroactive Case14 rows fail reduction/adoption', async () => {
  const f = await fixture();
  const sourceHelper = fileURLToPath(new URL('../lib/windows-capture-spend.py', import.meta.url));
  const helper = join(f.root, 'reduce.py');
  copyFileSync(sourceHelper, helper);
  copyFileSync(fileURLToPath(new URL('../../../../../../evidence/evals/meri/live-v1/lib/windows-artifact-protocol.py', import.meta.url)), join(f.root, 'windows-artifact-protocol.py'));
  const wrapper = `import runpy,sys\nm=runpy.run_path(${JSON.stringify(helper)})\ntry:m['reduce_fresh'](open(sys.argv[1],'rb').read());sys.exit(0)\nexcept Exception:sys.exit(1)\n`;
  const runner = join(f.root, 'reduce-wrapper.py'); writeFileSync(runner, wrapper);
  const { spawnSync } = await import('node:child_process');
  const altered = Buffer.from(original['fresh-spend.jsonl']); altered[100] ^= 1;
  const edited = join(f.root, 'edited.jsonl'); writeFileSync(edited, altered);
  const before24 = join(f.root, 'before24.jsonl'); writeFileSync(before24, Buffer.concat(original['fresh-spend.jsonl'].toString().split('\n').slice(0, 20).map((line) => Buffer.from(`${line}\n`))));
  assert.notEqual(spawnSync(pythonExecutable, ['-I', runner, edited]).status, 0);
  assert.notEqual(spawnSync(pythonExecutable, ['-I', runner, before24]).status, 0);
  writeFileSync(join(f.root, 'fresh-spend.jsonl'), before24 ? readFileSync(before24) : Buffer.alloc(0));
  assert.throws(() => f.module.adoptExistingFreshCaptureSpend({ pythonExecutable }));
});

 test('Case14 native reservation over-cap request is rejected before append', async () => {
  const f = await fixture();
  const helper = fileURLToPath(new URL('../lib/windows-capture-spend.py', import.meta.url));
  const native = await f.module.adoptExistingFreshCaptureSpend({ pythonExecutable });
  const owner = f.module.openCaptureSpendAggregate(native, { pythonExecutable });
  assert.throws(() => owner.reserve({ ...reserve('14'), ceilingMicros: 15_000_001 }));
  assert.deepEqual(readFileSync(join(f.root, 'fresh-spend.jsonl')), original['fresh-spend.jsonl']);
  assert.ok(helper);
});
