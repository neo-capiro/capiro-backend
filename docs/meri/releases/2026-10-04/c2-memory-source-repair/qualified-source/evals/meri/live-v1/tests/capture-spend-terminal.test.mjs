import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256Stable } from '../lib/stable.mjs';
import { CASE01_TERMINAL_SCOPE as scope, CASE01_TERMINAL_EVIDENCE as evidence,
  inspectOriginalCase01TerminalEvidence } from '../case01-terminal-spend-authority.mjs';
import { initializeCaptureSpendAggregate, openCaptureSpendAggregate,
  closeOriginalCase01TerminalUncertain } from '../capture-spend-aggregate.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/case01-terminal-reconciliation.unit.json', import.meta.url)));
const python = process.env.MERI_WINDOWS_PYTHON ?? 'C:/ProgramData/Hermes/tools/python-3.14.7+20260901-win32-x64/python.exe';
const helper = fileURLToPath(new URL('../lib/windows-capture-spend.py', import.meta.url));
const parent = 'C:/dev/cap-meri-foundation-evidence/spend-terminal-tests';
mkdirSync(parent, { recursive: true });
const wire = (prior, op, event) => ({ root: prior.state.root, state: prior.state, op, event });
function native(input) {
  const r = spawnSync(python, ['-I', helper], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { exit: r.status, value: JSON.parse(r.stdout) };
}
function proof() {
  const value = inspectOriginalCase01TerminalEvidence(structuredClone(fixture));
  value.reconciliationSha256 = sha256Stable({ kind: 'original01-terminal-cost-unknown', proof: value, scope, evidence });
  return value;
}
function prepared() {
  const start = initializeCaptureSpendAggregate({ root: join(parent, randomUUID()), pythonExecutable: python,
    inventory: { sliceId: randomUUID(), priorRuns: [], boundary: { kind: 'original_file01_capture_slice',
      firstCaseId: '01', firstCaptureRunId: scope.captureRunId, inventorySha256: scope.inventorySha256 } } });
  const reserved = native(wire(start, 'reserve', { kind: 'reserve', caseId: '01', captureRunId: scope.captureRunId,
    reservationId: scope.reservationId, ceilingMicros: 3000000 }));
  assert.equal(reserved.exit, 0);
  return reserved.value;
}
const event = () => ({ kind: 'close_terminal_uncertain', caseId: '01', captureRunId: scope.captureRunId,
  reservationId: scope.reservationId, disposition: 'TERMINAL_SETUP_REJECTION_COST_UNKNOWN', actualCostMicros: null, proof: proof() });

test('source terminal classifier joins recorded error and current zero-attempt owner; absent Orc events are not its authority', () => {
  const p = proof();
  assert.equal(sha256Stable(p), 'd8555b206bf7d47630838885f8fe4fce0e8fb5f25fda851e3b8e07e54b17314f');
  const x = structuredClone(fixture);
  x.terminalLog.services = x.terminalLog.services.filter(v => v.service === 'api');
  assert.deepEqual(inspectOriginalCase01TerminalEvidence(x), inspectOriginalCase01TerminalEvidence(fixture));
});

test('active request, provider attempt, wrong source/actor, nonempty turn/messages and stale readback refuse closure', () => {
  const mutations = [
    x => x.terminalLog.services[0].events.splice(2, 1),
    x => x.terminalLog.services[0].events[2].outcome = 'active',
    x => x.terminalLog.services[0].events[2].requestIdSha256 = 'a'.repeat(64),
    x => x.authenticatedReadback.budget.ledger.attempts.push({ status: 'reserved' }),
    x => x.authenticatedReadback.budget.ledger.chargedAttempts = 1,
    x => x.authenticatedReadback.budget.turnId = randomUUID(),
    x => x.authenticatedReadback.messageCount = 1,
    x => x.authenticatedReadback.messageRoles = ['user'],
    x => x.authenticatedReadback.observedAt = '2026-10-02T17:00:00.000Z',
    x => x.authenticatedReadback.reads[0].apiReleaseSha = 'a'.repeat(40),
    x => x.authenticatedReadback.userId = randomUUID(),
    x => x.authenticatedReadback.budget.qualification.maxCostMicros = 1,
    x => x.failedExecution.outcome.synthesisSubmissionCount = 2,
  ];
  for (const mutate of mutations) { const x = structuredClone(fixture); mutate(x); assert.throws(() => inspectOriginalCase01TerminalEvidence(x)); }
});

test('native append-only terminal closure retains full ceiling and UNKNOWN cost while ending only active run', () => {
  const before = prepared(), reserveBytes = readFileSync(join(before.state.root, 'spend-000001.json'));
  const after = native(wire(before, 'close_terminal_uncertain', event()));
  assert.equal(after.exit, 0);
  assert.deepEqual(readFileSync(join(before.state.root, 'spend-000001.json')), reserveBytes);
  assert.equal(after.value.snapshot.eventCount, 2);
  assert.equal(after.value.snapshot.activeRun, null);
  assert.equal(after.value.snapshot.reservedCeilingsMicros, 3000000);
  assert.equal(after.value.snapshot.remainingReservationMicros, 27000000);
  assert.equal(after.value.snapshot.knownSettledCostMicros, 0);
  assert.equal(after.value.snapshot.terminalUnknownConservativeCostMicros, 3000000);
  assert.equal(after.value.snapshot.terminalUnknownCostCount, 1);
  assert.equal(after.value.snapshot.billedTotalStatus, 'UNKNOWN');
  assert.equal(after.value.snapshot.refundsAllowed, false);
  assert.equal(after.value.snapshot.runs[`01:${scope.captureRunId}`].actualCostMicros, null);
  assert.equal(native(wire(after.value, 'read')).exit, 0);
});

test('repeat close, stale checkpoint, late settlement and same-run reserve cannot reclaim the charged ceiling', () => {
  const before = prepared(), e = event(), after = native(wire(before, 'close_terminal_uncertain', e));
  assert.equal(after.exit, 0);
  assert.equal(native(wire(before, 'close_terminal_uncertain', e)).exit, 1);
  assert.equal(native(wire(after.value, 'close_terminal_uncertain', e)).exit, 1);
  assert.equal(native(wire(after.value, 'reserve', { kind: 'reserve', caseId: '01', captureRunId: scope.captureRunId,
    reservationId: randomUUID(), ceilingMicros: 1 })).exit, 1);
  assert.equal(native(wire(after.value, 'settle', { kind: 'settle', caseId: '01', captureRunId: scope.captureRunId,
    reservationId: scope.reservationId, chargedCostMicros: 0, ledgerSha256: 'a'.repeat(64), envelopeSha256: 'b'.repeat(64) })).exit, 1);
});

test('primitive close rejects altered proof, inflight flag, alternate run, refund and cost-zero substitution', () => {
  const before = prepared();
  for (const mutate of [
    e => e.proof.authenticatedReadbackSha256 = 'a'.repeat(64),
    e => e.proof.pendingProviderAttempts = 1,
    e => e.proof.providerAttempts = [{ status: 'reserved' }],
    e => e.captureRunId = randomUUID(),
    e => e.reservationId = randomUUID(),
    e => e.actualCostMicros = 0,
    e => e.refundMicros = 3000000,
  ]) { const x = event(); mutate(x); assert.equal(native(wire(before, 'close_terminal_uncertain', x)).exit, 1); }
  assert.equal(native(wire(before, 'read')).value.snapshot.activeRun, `01:${scope.captureRunId}`);
});

test('terminal event tampering cannot reopen the original ledger', () => {
  const before = prepared(), after = native(wire(before, 'close_terminal_uncertain', event()));
  assert.equal(after.exit, 0);
  writeFileSync(join(before.state.root, 'spend-000002.json'), '{}');
  assert.equal(native(wire(after.value, 'read')).exit, 1);
});

test('JS closure refuses JSON lookalike authority and omitted explicit root invocation before write', () => {
  const before = prepared();
  for (const invocation of [undefined, 'CLOSE_ORIGINAL01_TERMINAL_COST_UNKNOWN_ONCE']) {
    assert.throws(() => closeOriginalCase01TerminalUncertain({ kind: 'meri-original-capture-spend-checkpoint', version: 1, ...before },
      { pythonExecutable: python, authority: { kind: 'original01-terminal-uncertain-closure', proof: proof() }, invocation }));
  }
  assert.equal(openCaptureSpendAggregate({ kind: 'meri-original-capture-spend-checkpoint', version: 1, ...before },
    { pythonExecutable: python }).checkpoint().snapshot.eventCount, 1);
});
