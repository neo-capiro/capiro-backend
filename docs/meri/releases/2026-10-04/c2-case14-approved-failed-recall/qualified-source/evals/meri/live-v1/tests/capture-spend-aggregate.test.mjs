import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createWindowsArtifactStorage } from '../windows-artifact-storage.mjs';
import { fixture as memoryFixture } from './case01-authority.test.mjs';
import { fixture as controlledFixture } from './controlled-read-authority.test.mjs';
import { prepareCase01LiveCapture } from '../case01-live-capture.mjs';
import { prepareControlledReadLiveCapture } from '../controlled-read-live-capture.mjs';
import {
  initializeCaptureSpendAggregate,
  openCaptureSpendAggregate,
  claimCaptureSpendReservation,
  assertCaptureSpendReservation,
} from '../capture-spend-aggregate.mjs';

const parent = 'C:/dev/cap-meri-foundation-evidence/spend-owner-tests';
const python = process.env.MERI_WINDOWS_PYTHON ?? 'C:/ProgramData/Hermes/tools/python-3.14.7+20260901-win32-x64/python.exe';
const helper = fileURLToPath(new URL('../lib/windows-capture-spend.py', import.meta.url));
mkdirSync(parent, { recursive: true });
function sample(priorRuns = []) {
  const firstCaptureRunId = priorRuns[0]?.captureRunId ?? randomUUID();
  const root = join(parent, randomUUID());
  const inventory = {
    sliceId: randomUUID(),
    priorRuns,
    boundary: {
      kind: 'original_file01_capture_slice',
      firstCaseId: '01',
      firstCaptureRunId,
      inventorySha256: 'a'.repeat(64),
    },
  };
  const checkpoint = initializeCaptureSpendAggregate({ root, inventory, pythonExecutable: python });
  return { root, inventory, checkpoint, firstCaptureRunId };
}
function wire(checkpoint, op, event) {
  return { op, root: checkpoint.state.root, state: checkpoint.state, event };
}
function native(request) {
  const result = spawnSync(python, ['-I', helper], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  return { exit: result.status, value: JSON.parse(result.stdout) };
}
const reserve = (run, caseId = '01', amount = 3000000) => ({
  kind: 'reserve',
  caseId,
  captureRunId: run,
  ceilingMicros: amount,
  reservationId: randomUUID(),
});
const settle = (event, amount = 1) => ({
  kind: 'settle',
  caseId: event.caseId,
  captureRunId: event.captureRunId,
  reservationId: event.reservationId,
  chargedCostMicros: amount,
  ledgerSha256: 'b'.repeat(64),
  envelopeSha256: 'c'.repeat(64),
});

test('native Windows owner reserves before work, keeps unresolved cost and denies forged outcome settlement', () => {
  const s = sample();
  const owner = openCaptureSpendAggregate(s.checkpoint, { pythonExecutable: python });
  const claim = owner.reserve({
    caseId: '01',
    captureRunId: s.firstCaptureRunId,
    ceilingMicros: 3000000,
  });
  const current = owner.checkpoint();
  assert.equal(current.snapshot.reservedCeilingsMicros, 3000000);
  assert.equal(current.snapshot.remainingReservationMicros, 27000000);
  assert.throws(() => owner.settleCaptured(claim, { caseId: '01', status: 'CAPTURE_COMPLETE' }));
  assert.deepEqual(owner.checkpoint(), current);
  assert.throws(
    () => openCaptureSpendAggregate(s.checkpoint, { pythonExecutable: python }),
    'stale checkpoint detects the durable reservation',
  );
  const reopened = openCaptureSpendAggregate(current, { pythonExecutable: python });
  assert.throws(() =>
    reopened.reserve({ caseId: '20', captureRunId: randomUUID(), ceilingMicros: 3000000 }),
  );
});

test('primitive journal keeps full ceilings after settlement and blocks the eleventh3USD attempt', () => {
  const s = sample();
  let current = s.checkpoint;
  for (let index = 0; index < 10; index++) {
    const event = reserve(
      index === 0 ? s.firstCaptureRunId : randomUUID(),
      index === 0 ? '01' : '20',
    );
    const reserved = native(wire(current, 'reserve', event));
    assert.equal(reserved.exit, 0);
    const settled = native(wire(reserved.value, 'settle', settle(event, 100000)));
    assert.equal(settled.exit, 0);
    current = settled.value;
  }
  assert.equal(current.snapshot.knownSettledCostMicros, 1000000);
  assert.equal(current.snapshot.reservedCeilingsMicros, 30000000);
  assert.equal(current.snapshot.remainingReservationMicros, 0);
  assert.equal(current.snapshot.refundsAllowed, false);
  assert.equal(native(wire(current, 'reserve', reserve(randomUUID(), '26'))).exit, 1);
});

test('boundary, per-case ceiling, replay and mismatched settlement are fail closed', () => {
  const s = sample();
  assert.equal(native(wire(s.checkpoint, 'reserve', reserve(randomUUID()))).exit, 1);
  assert.equal(
    native(wire(s.checkpoint, 'reserve', reserve(s.firstCaptureRunId, '01', 3000001))).exit,
    1,
  );
  const event = reserve(s.firstCaptureRunId);
  const first = native(wire(s.checkpoint, 'reserve', event));
  assert.equal(first.exit, 0);
  assert.equal(
    native(wire(first.value, 'settle', { ...settle(event), captureRunId: randomUUID() })).exit,
    1,
  );
  assert.equal(native(wire(first.value, 'settle', settle(event, 3000001))).exit, 1);
  const done = native(wire(first.value, 'settle', settle(event)));
  assert.equal(done.exit, 0);
  assert.equal(native(wire(done.value, 'reserve', event)).exit, 1);
  assert.equal(native(wire(done.value, 'settle', settle(event))).exit, 1);
});

test('two actual processes with the same checkpoint cannot reserve concurrently', async () => {
  const s = sample();
  const request = JSON.stringify(wire(s.checkpoint, 'reserve', reserve(s.firstCaptureRunId)));
  const child = () =>
    new Promise((resolve, reject) => {
      const proc = spawn(python, ['-I', helper], { windowsHide: true });
      let output = '';
      proc.stdout.on('data', (chunk) => (output += chunk));
      proc.on('error', reject);
      proc.on('close', (exit) => resolve({ exit, value: JSON.parse(output) }));
      proc.stdin.end(request);
    });
  const results = await Promise.all([child(), child()]);
  assert.deepEqual(results.map((r) => r.exit).sort(), [0, 1]);
  const winner = results.find((r) => r.exit === 0).value;
  assert.equal(winner.snapshot.reservedCeilingsMicros, 3000000);
  assert.equal(winner.snapshot.eventCount, 1);
});

test('tampered journal bytes, missing entry and unrecognized crash entry cannot restore lower spend', () => {
  for (const mutate of [
    (root) => writeFileSync(join(root, 'spend-000001.json'), '{}'),
    (root) => writeFileSync(join(root, 'spend-000002.json'), '{}'),
  ]) {
    const s = sample();
    const event = reserve(s.firstCaptureRunId);
    const reserved = native(wire(s.checkpoint, 'reserve', event));
    assert.equal(reserved.exit, 0);
    mutate(s.root);
    assert.equal(native(wire(reserved.value, 'read')).exit, 1);
  }
});

test('explicit prior reservations count against the bound instead of inventing historical zero', () => {
  const prior = [
    {
      caseId: '01',
      captureRunId: randomUUID(),
      ceilingMicros: 3000000,
      status: 'conservative_prior_reservation',
      terminalReceiptSha256: 'd'.repeat(64),
    },
  ];
  const s = sample(prior);
  assert.equal(s.checkpoint.snapshot.reservedCeilingsMicros, 3000000);
  assert.equal(
    s.checkpoint.snapshot.knownSettledCostMicros,
    0,
    'unknown actual charge is not a billed-zero claim',
  );
  assert.equal(s.checkpoint.snapshot.remainingReservationMicros, 27000000);
  assert.equal(s.checkpoint.snapshot.priorActualCostUnknownCount, 1);
  assert.equal(s.checkpoint.snapshot.billedTotalStatus, 'UNKNOWN');
});

test('opaque admission is one-use and bound to the whole authenticated turn scope before submission', () => {
  const s = sample();
  const owner = openCaptureSpendAggregate(s.checkpoint, { pythonExecutable: python });
  const reservation = owner.reserve({
    caseId: '01',
    captureRunId: s.firstCaptureRunId,
    ceilingMicros: 3000000,
  });
  const expected = {
    caseId: '01',
    captureRunId: s.firstCaptureRunId,
    maxSpendMicros: 3000000,
    tenantId: randomUUID(),
    actorUserId: randomUUID(),
    conversationId: randomUUID(),
    sourceVersion: 'canonical-v2',
  };
  assert.throws(() => claimCaptureSpendReservation(structuredClone(reservation), expected));
  assert.throws(() => assertCaptureSpendReservation(reservation, expected));
  assert.throws(() =>
    claimCaptureSpendReservation(reservation, { ...expected, maxSpendMicros: 1 }),
  );
  claimCaptureSpendReservation(reservation, expected);
  assertCaptureSpendReservation(reservation, expected);
  assert.throws(() => claimCaptureSpendReservation(reservation, expected));
  for (const key of [
    'caseId',
    'captureRunId',
    'tenantId',
    'actorUserId',
    'conversationId',
    'sourceVersion',
  ])
    assert.throws(() =>
      assertCaptureSpendReservation(reservation, { ...expected, [key]: 'different' }),
    );
  assert.throws(() =>
    owner.settleCaptured(reservation, { caseId: '01', status: 'CAPTURE_COMPLETE' }),
  );
  assert.equal(owner.checkpoint().snapshot.activeRun, `01:${s.firstCaptureRunId}`);
});

test('actual native collectors reject absent/serialized aggregate reservation before disk initialization or cloud admission', async () => {
  for (const [prepare, config] of [
    [prepareCase01LiveCapture, memoryFixture().config],
    [prepareControlledReadLiveCapture, controlledFixture('20').config],
  ]) {
    for (const spendReservation of [
      undefined,
      { caseId: config.caseId, captureRunId: config.captureRunId, ceilingMicros: 3000000 },
    ]) {
      const runRoot = join(parent, randomUUID());
      const storage = createWindowsArtifactStorage(runRoot, { pythonExecutable: python });
      await assert.rejects(
        prepare({
          config,
          runRoot,
          artifactStorage: storage,
          spendReservation,
          env: { MERI_LIVE_BEARER_TOKEN: 'unit-only-placeholder' },
        }),
        /CAPTURE_SPEND_AGGREGATE_REJECTED/u,
      );
      assert.equal(existsSync(runRoot), false);
    }
  }
});
