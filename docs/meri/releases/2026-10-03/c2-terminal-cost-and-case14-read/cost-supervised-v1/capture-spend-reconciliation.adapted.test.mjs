import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Stable } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/lib/stable.mjs';
import { inspectCaptureSpendTerminalReadback, prepareReviewedCaptureSpendReconciliation, currentReviewedCaptureSpendReconciliation } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/capture-spend-reconciliation.mjs';
import { initializeCaptureSpendAggregate, openCaptureSpendAggregate, reconcileCaptureSpendTerminal } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/capture-spend-aggregate.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const python = 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
const parent = 'C:/dev/main/outputs/meri-c2-20261003/cost-supervised-v1/capture-spend-reconciliation';
mkdirSync(parent, { recursive: true });
function fixture() {
  const e = { caseId: '01', captureRunId: randomUUID(), conversationId: randomUUID(),
    tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f', userId: randomUUID(), clientId: randomUUID(),
    apiSourceSha: 'a'.repeat(40), priorExecutionSha256: 'b'.repeat(64), promptSha256: hash('UNIT prompt'),
    reservationId: randomUUID(), ceilingMicros: 3000000 };
  const time = Date.now(), turnId = randomUUID(), admissionId = randomUUID();
  const policy = { version: 1, kind: 'server_readonly_acceptance_capture', fixtureNamespace: 'meri-foundation-20260928',
    caseId: e.caseId, captureRunId: e.captureRunId, tenantId: e.tenantId, actorUserId: e.userId, clientId: e.clientId,
    conversationId: e.conversationId, turnId, issuedAt: time - 2000, expiresAt: time + 60000,
    policyId: randomUUID(), requestId: randomUUID(), traceId: randomUUID(), dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed', toolAuthority: 'shared_static_registry_read_only' };
  const q = { version: 1, caseId: e.caseId, captureRunId: e.captureRunId, maxCostMicros: e.ceilingMicros,
    maxTokens: 100, maxAttempts: 2, priceKind: 'qualified_text_token_upper_bound', rateEvidenceSha256: 'c'.repeat(64),
    rates: [{ kind: 'bedrock_embeddings', provider: 'aws-bedrock', model: 'unit', inputMicrosPerMillion: 20000, outputMicrosPerMillion: 0 }] };
  const budget = { version: 1, turnId, admissionId, policySha256: sha256Stable({ ...policy, turnId: null }),
    qualification: q, qualificationSha256: sha256Stable(q), ledger: { version: 1, activation: 'enforced',
      limits: { maxCostMicros: q.maxCostMicros, maxTokens: q.maxTokens, maxAttempts: q.maxAttempts, deadlineAt: new Date(policy.expiresAt).toISOString() },
      chargedTokens: 11, chargedCostMicros: 1, chargedAttempts: 1,
      attempts: [{ version: 1, attemptId: randomUUID(), runId: admissionId, leaseEpoch: 1, status: 'settled', priceKnown: true,
        kind: 'bedrock_embeddings', provider: 'aws-bedrock', model: 'unit', reservedInputTokens: 100,
        reservedOutputTokens: 0, reservedCostMicros: 2, actualInputTokens: 11, actualOutputTokens: 0, actualCostMicros: 1,
        settledAt: new Date(time - 1000).toISOString() }] } };
  const receipt = { version: 1, kind: 'server_capture_evidence_receipt', status: 'BLOCKED',
    ...Object.fromEntries(['caseId', 'captureRunId', 'conversationId', 'tenantId', 'clientId', 'actorUserId', 'policyId', 'requestId', 'traceId', 'turnId'].map(k => [k, policy[k]])),
    releases: { api: { releaseRevision: { value: e.apiSourceSha } } }, startedAt: time - 900, completedAt: time - 500,
    providerBudget: { version: 1, status: 'SETTLED', admissionId, turnId, ledgerSha256: sha256Stable(budget),
      qualificationSha256: budget.qualificationSha256, chargedCostMicros: 1, chargedTokens: 11, attempts: 1,
      maxCostMicros: e.ceilingMicros, unaccountedBoundaries: [] } };
  const envelope = { version: 1, purpose: 'server_capture_evidence', signature: 'd'.repeat(64), receipt };
  const messages = ['user', 'assistant'].map(role => ({ id: role === 'user' ? turnId : randomUUID(), role,
    body: role === 'user' ? 'UNIT prompt' : 'UNIT failed answer without citation',
    conversationId: e.conversationId, tenantId: e.tenantId, userId: e.userId, clientId: e.clientId,
    metadata: role === 'user' ? {} : { finishReason: 'runtime_error', partial: true, serverReadonlyCapturePolicy: policy, serverCaptureEvidenceReceipt: envelope } }));
  for (const m of messages) m.bodySha256 = hash(m.body);
  const r = { kind: 'meri-capture-terminal-owned-api-readback', status: 'READBACK_CAPTURED',
    ...Object.fromEntries(['captureRunId', 'conversationId', 'tenantId', 'userId', 'clientId', 'apiSourceSha', 'priorExecutionSha256'].map(k => [k, e[k]])),
    applicationWrites: 0, modelSubmissions: 0, sessionRevoked: true, observedAt: new Date(time).toISOString(),
    conversation: { id: e.conversationId, clientId: e.clientId, archivedAt: null }, budget, messages, messageCount: 2,
    reads: ['', '/messages'].map(s => ({ path: `/api/clio/conversations/${e.conversationId}${s}`, status: 200, apiReleaseSha: e.apiSourceSha, bodySha256: 'e'.repeat(64) })) };
  return { e, r };
}
function authority(r, e) {
  const path = join(parent, `${randomUUID()}.json`), bytes = JSON.stringify(r);
  writeFileSync(path, bytes, { flag: 'wx' });
  return prepareReviewedCaptureSpendReconciliation({ readbackPath: path, readbackSha256: hash(bytes), expected: e, invocation: 'PREPARE_ROOT_REVIEWED_TERMINAL_SPEND' });
}
function uncertainFixture() {
  const f = fixture(), r = f.r, p = r.messages[1].metadata.serverReadonlyCapturePolicy;
  p.expiresAt = Date.parse(r.observedAt) - 100;
  const b = r.budget, a = b.ledger.attempts[0];
  b.policySha256 = sha256Stable({ ...p, turnId: null });
  b.ledger.limits.deadlineAt = new Date(p.expiresAt).toISOString();
  Object.assign(a, { status: 'uncertain', actualCostMicros: null, actualInputTokens: null, actualOutputTokens: null });
  b.ledger.chargedCostMicros = a.reservedCostMicros;
  b.ledger.chargedTokens = a.reservedInputTokens;
  Object.assign(r.messages[1].metadata.serverCaptureEvidenceReceipt.receipt.providerBudget,
    { status: 'UNSETTLED', ledgerSha256: sha256Stable(b), chargedCostMicros: b.ledger.chargedCostMicros, chargedTokens: b.ledger.chargedTokens });
  return f;
}
test('budget-only reconciliation accepts terminal FAILED answer without citations or model usage', () => {
  const { r, e } = fixture();
  const p = inspectCaptureSpendTerminalReadback(r, e);
  assert.equal(p.disposition, 'SETTLED'); assert.equal(p.chargedCostMicros, 1);
  assert.equal(p.answerGrade, 'NOT_EVALUATED');
  assert.throws(() => currentReviewedCaptureSpendReconciliation(p));
  assert.equal(currentReviewedCaptureSpendReconciliation(authority(r, e)).ledgerSha256, p.ledgerSha256);
});
test('wrong scope/release/prompt/turn, inflight, bad costs, unaccounted providers and no positive terminal receipt fail closed', () => {
  const changes = [r => r.userId = randomUUID(), r => r.reads[0].apiReleaseSha = 'f'.repeat(40),
    r => r.messages[0].body = 'UNIT altered', r => r.budget.turnId = randomUUID(),
    r => r.budget.ledger.attempts[0].status = 'reserved', r => r.budget.ledger.chargedCostMicros = 0,
    r => r.messages[1].metadata.serverCaptureEvidenceReceipt.receipt.providerBudget.unaccountedBoundaries.push('unaccounted'),
    r => delete r.messages[1].metadata.serverCaptureEvidenceReceipt, r => r.messages[1].metadata.finishReason = 'running',
    r => r.messages[1].metadata.serverCaptureEvidenceReceipt.receipt.completedAt = Date.now() + 100000,
    r => r.budget.ledger.attempts[0].actualInputTokens = 101];
  for (const mutate of changes) { const { r, e } = fixture(); mutate(r); assert.throws(() => inspectCaptureSpendTerminalReadback(r, e)); }
});
test('reviewed bytes are hash-bound; no local cost override or JSON authority accepted', () => {
  const { r, e } = fixture(), path = join(parent, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(r), { flag: 'wx' });
  assert.throws(() => prepareReviewedCaptureSpendReconciliation({ readbackPath: path, readbackSha256: '0'.repeat(64), expected: e, invocation: 'PREPARE_ROOT_REVIEWED_TERMINAL_SPEND' }));
  assert.throws(() => currentReviewedCaptureSpendReconciliation({ chargedCostMicros: 0 }));
});
test('actual native legacy journal settles once, retains entire ceiling and immutable old event, denies reuse/stale checkpoint', () => {
  const { r, e } = fixture();
  const p = initializeCaptureSpendAggregate({ root: join(parent, randomUUID()), pythonExecutable: python,
    inventory: { sliceId: randomUUID(), priorRuns: [], boundary: { kind: 'original_file01_capture_slice', firstCaseId: '01', firstCaptureRunId: e.captureRunId, inventorySha256: 'a'.repeat(64) } } });
  const owner = openCaptureSpendAggregate(p, { pythonExecutable: python });
  const reserved = owner.reserve({ caseId: '01', captureRunId: e.captureRunId, ceilingMicros: e.ceilingMicros });
  e.reservationId = reserved.reservationId;
  const prior = owner.checkpoint(), bytes = readFileSync(join(prior.state.root, 'spend-000001.json'));
  const options = { pythonExecutable: python, invocation: 'RECONCILE_ACTIVE_TERMINAL_SPEND_ONCE', authority: authority(r, e) };
  const next = reconcileCaptureSpendTerminal(prior, options);
  assert.equal(next.snapshot.activeRun, null); assert.equal(next.snapshot.knownSettledCostMicros, 1);
  assert.equal(next.snapshot.reservedCeilingsMicros, 3000000); assert.equal(next.snapshot.remainingReservationMicros, 27000000);
  assert.deepEqual(readFileSync(join(prior.state.root, 'spend-000001.json')), bytes);
  assert.throws(() => reconcileCaptureSpendTerminal(prior, options));
  assert.throws(() => reconcileCaptureSpendTerminal(next, options));
  assert.throws(() => openCaptureSpendAggregate(next, { pythonExecutable: python }).reserve({ caseId: '01', captureRunId: e.captureRunId, ceilingMicros: 1 }));
});
test('uncertain terminal attempts consume full ceiling; reserved/inflight still cannot close after deadline', () => {
  const { r, e } = uncertainFixture();
  assert.equal(inspectCaptureSpendTerminalReadback(r, e).disposition, 'COST_UNKNOWN');
  const p = initializeCaptureSpendAggregate({ root: join(parent, randomUUID()), pythonExecutable: python,
    inventory: { sliceId: randomUUID(), priorRuns: [], boundary: { kind: 'original_file01_capture_slice', firstCaseId: '01', firstCaptureRunId: e.captureRunId, inventorySha256: 'a'.repeat(64) } } });
  const owner = openCaptureSpendAggregate(p, { pythonExecutable: python });
  e.reservationId = owner.reserve({ caseId: '01', captureRunId: e.captureRunId, ceilingMicros: 3000000 }).reservationId;
  const next = reconcileCaptureSpendTerminal(owner.checkpoint(), { pythonExecutable: python,
    invocation: 'RECONCILE_ACTIVE_TERMINAL_SPEND_ONCE', authority: authority(r, e) });
  assert.equal(next.snapshot.activeRun, null); assert.equal(next.snapshot.terminalUnknownCostCount, 1);
  assert.equal(next.snapshot.terminalUnknownConservativeCostMicros, 3000000);
  assert.equal(next.snapshot.remainingReservationMicros, 27000000);
  assert.equal(next.snapshot.runs[`01:${e.captureRunId}`].chargedCostMicros, null);
  r.budget.ledger.attempts[0].status = 'reserved';
  assert.throws(() => inspectCaptureSpendTerminalReadback(r, e));
});
