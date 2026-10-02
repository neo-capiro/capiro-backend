import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256Stable } from '../lib/stable.mjs';
import {
  CASE01_TERMINAL_SCOPE as scope,
  CASE01_TERMINAL_EVIDENCE as evidence,
  inspectOriginalCase01TerminalEvidence,
} from '../case01-terminal-spend-authority.mjs';
import {
  initializeCaptureSpendAggregate,
  reviseCaptureSpendProtocol,
  openCaptureSpendAggregate,
} from '../capture-spend-aggregate.mjs';
const python = 'C:/ProgramData/Hermes/tools/python-3.14.7+20260901-win32-x64/python.exe';
const helper = fileURLToPath(new URL('../lib/windows-capture-spend.py', import.meta.url));
const parent = 'C:/dev/cap-meri-foundation-evidence/spend-v2-tests';
mkdirSync(parent, { recursive: true });
function call(p, op, event) {
  const r = spawnSync(python, ['-I', helper], {
    input: JSON.stringify({ root: p.state.root, state: p.state, op, event }),
    encoding: 'utf8',
    windowsHide: true,
  });
  return { exit: r.status, ...JSON.parse(r.stdout) };
}
function closed() {
  let p = initializeCaptureSpendAggregate({
    root: join(parent, randomUUID()),
    pythonExecutable: python,
    inventory: {
      sliceId: randomUUID(),
      priorRuns: [],
      boundary: {
        kind: 'original_file01_capture_slice',
        firstCaseId: '01',
        firstCaptureRunId: scope.captureRunId,
        inventorySha256: scope.inventorySha256,
      },
    },
  });
  p = call(p, 'reserve', {
    kind: 'reserve',
    caseId: '01',
    captureRunId: scope.captureRunId,
    reservationId: scope.reservationId,
    ceilingMicros: 3000000,
  });
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/case01-terminal-reconciliation.unit.json', import.meta.url)),
  );
  const proof = inspectOriginalCase01TerminalEvidence(fixture);
  proof.reconciliationSha256 = sha256Stable({
    kind: 'original01-terminal-cost-unknown',
    proof,
    scope,
    evidence,
  });
  p = call(p, 'close_terminal_uncertain', {
    kind: 'close_terminal_uncertain',
    caseId: '01',
    captureRunId: scope.captureRunId,
    reservationId: scope.reservationId,
    disposition: 'TERMINAL_SETUP_REJECTION_COST_UNKNOWN',
    actualCostMicros: null,
    proof,
  });
  assert.equal(p.exit, 0);
  return { kind: 'meri-original-capture-spend-checkpoint', version: 1, ...p };
}
const opts = () => ({
  pythonExecutable: python,
  invocation: 'ACTIVATE_SHARED_SPEND_V2_SERVER_SETTLEMENT_ONCE',
  reviewSha256: 'a'.repeat(64),
  deadlineAtMs: Date.now() + 600000,
});
const reserve = () => ({
  kind: 'reserve',
  caseId: '02',
  captureRunId: randomUUID(),
  reservationId: randomUUID(),
  ceilingMicros: 3000000,
});
const settle = (e) => ({
  kind: 'settle',
  caseId: e.caseId,
  captureRunId: e.captureRunId,
  reservationId: e.reservationId,
  chargedCostMicros: 100,
  ledgerSha256: 'b'.repeat(64),
  envelopeSha256: 'c'.repeat(64),
});
test('explicit versioned append preserves old UNKNOWN charge and owner/reservation bytes', () => {
  const p = closed(),
    original = readFileSync(join(p.state.root, 'bundle-owner.json')),
    event = readFileSync(join(p.state.root, 'spend-000001.json'));
  assert.throws(() => reviseCaptureSpendProtocol(p, { ...opts(), invocation: 'automatic' }));
  const v = reviseCaptureSpendProtocol(p, opts());
  assert.equal(v.snapshot.protocolVersion, 2);
  assert.equal(v.snapshot.remainingReservationMicros, 27000000);
  assert.deepEqual(readFileSync(join(p.state.root, 'bundle-owner.json')), original);
  assert.deepEqual(readFileSync(join(p.state.root, 'spend-000001.json')), event);
  assert.throws(() => reviseCaptureSpendProtocol(v, opts()));
  assert.equal(v.snapshot.runs['01:' + scope.captureRunId].actualCostMicros, null);
});
test('new settled run releases only its unused ceiling; legacy run cannot refund or replay', () => {
  let p = reviseCaptureSpendProtocol(closed(), opts());
  const e = reserve();
  p = call(p, 'reserve', e);
  assert.equal(p.exit, 0);
  assert.equal(p.snapshot.remainingReservationMicros, 24000000);
  assert.equal(call(p, 'reserve', reserve()).exit, 1);
  p = call(p, 'settle', settle(e));
  assert.equal(p.exit, 0);
  assert.equal(p.snapshot.remainingReservationMicros, 26999900);
  assert.equal(p.snapshot.terminalUnknownConservativeCostMicros, 3000000);
  assert.equal(p.snapshot.releasedUnusedCeilingMicros, 2999900);
  assert.equal(call(p, 'settle', settle(e)).exit, 1);
  assert.equal(call(p, 'reserve', e).exit, 1);
  assert.equal(
    call(p, 'settle', {
      ...settle(e),
      caseId: '01',
      captureRunId: scope.captureRunId,
      reservationId: scope.reservationId,
      chargedCostMicros: 0,
    }).exit,
    1,
  );
});
test('ceiling remains charged for uncertain/active run, client-cost setter absent, forged authority rejected', () => {
  const p = reviseCaptureSpendProtocol(closed(), opts());
  const owner = openCaptureSpendAggregate(p, { pythonExecutable: python });
  const r = owner.reserve(reserve());
  assert.equal(owner.checkpoint().snapshot.remainingReservationMicros, 24000000);
  assert.throws(() => owner.settleCaptured(r, { chargedCostMicros: 0 }));
  assert.equal(owner.checkpoint().snapshot.activeRun, `${r.caseId}:${r.captureRunId}`);
});
test('expiry, excess ceiling, bad proof hash, undeclared cases and stale checkpoint refuse new work', () => {
  const p = closed();
  for (const change of [
    { deadlineAtMs: Date.now() - 1 },
    { deadlineAtMs: Date.now() + 86500000 },
    { reviewSha256: 'bad' },
  ])
    assert.throws(() => reviseCaptureSpendProtocol(p, { ...opts(), ...change }));
  const v = reviseCaptureSpendProtocol(p, opts());
  assert.equal(call(v, 'reserve', { ...reserve(), ceilingMicros: 3000001 }).exit, 1);
  assert.equal(call(v, 'reserve', { ...reserve(), caseId: '75' }).exit, 1);
  const n = call(v, 'reserve', reserve());
  assert.equal(n.exit, 0);
  assert.equal(call(v, 'read').exit, 1);
});
test('protocol revision permits multiple completed failures while retaining every old unknown ceiling', () => {
  let p = closed();
  const e = { ...reserve(), caseId: '01' };
  p = call(p, 'reserve', e);
  assert.equal(p.exit, 0);
  const now = Date.now();
  p = call(p, 'reconcile_terminal', { kind: 'reconcile_terminal', caseId: e.caseId,
    captureRunId: e.captureRunId, reservationId: e.reservationId, disposition: 'COST_UNKNOWN',
    chargedCostMicros: null, proof: { readbackSha256: 'a'.repeat(64), ledgerSha256: 'b'.repeat(64),
      envelopeSha256: 'c'.repeat(64), conversationId: randomUUID(), completedAtMs: now - 1000,
      observedAtMs: now, providerDeadlineAtMs: now - 500, pendingProviderAttempts: 0,
      providerAttempts: 1, answerGrade: 'NOT_EVALUATED' } });
  assert.equal(p.exit, 0);
  const next = reviseCaptureSpendProtocol({ kind: 'meri-original-capture-spend-checkpoint', version: 1, ...p }, opts());
  assert.equal(next.snapshot.remainingReservationMicros, 24000000);
  assert.equal(next.snapshot.terminalUnknownConservativeCostMicros, 6000000);
  assert.equal(next.snapshot.terminalUnknownCostCount, 2);
});
