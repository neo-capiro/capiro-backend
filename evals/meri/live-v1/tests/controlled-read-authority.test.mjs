import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as memoryFixture } from './case01-authority.test.mjs';
import { createControlledReadDefinition } from '../fixture-provisioning/controlled-read-definitions.mjs';
import {
  inspectControlledReadScope,
  inspectControlledReadAdmission,
  executeControlledReadLiveCapture,
  currentControlledReadCaptureAuthority,
  prepareControlledReadLiveCapture,
} from '../controlled-read-live-capture.mjs';
import { assertControlledReadReceiptJoins } from '../controlled-read-receipt-joins.mjs';
import {
  inspectControlledReadSavedEvidence,
  gradeControlledReadCapturedOutcome,
} from '../grade-controlled-read-capture.mjs';
import { sha256Bytes, sha256Stable } from '../artifact-collector.mjs';

const obs = (value) => ({ status: 'OBSERVED', value, reason: null });
const refresh = (j) => {
  j.doneEnvelope = structuredClone(j.envelope);
  j.authority.envelopeSha256 = sha256Stable(j.envelope);
  j.authority.answerSha256 = sha256Bytes(j.answer);
};
function fixture(caseId) {
  const h = memoryFixture(),
    c = h.config,
    j = h.joins;
  c.caseId = caseId;
  const definition = createControlledReadDefinition({
    caseId,
    tenantId: j.expected.tenantId,
    clientId: j.expected.clientId,
    captureRunId: c.captureRunId,
  });
  const read = definition.reads[0];
  c.scope.sources = structuredClone(definition.sourceMap);
  c.fixture.mappingSha256 = definition.physicalMapSha256;
  const scope = inspectControlledReadScope(c, { MERI_LIVE_BEARER_TOKEN: 'synthetic-test-bearer' });
  const canonical = {
    ...j.authority.fixture,
    physicalMapSha256: c.fixture.mappingSha256,
    sources: [
      {
        logicalId: read.logicalId,
        physicalId: read.physicalId,
        tenantId: j.expected.tenantId,
        clientId: caseId === '20' ? null : j.expected.clientId,
        sourceVersion: 'v1',
        kind: read.kind,
        contentSha256: read.contentSha256,
        sourceStorage: 'immutable_source_owned_controlled_adapter',
        ...(caseId === '72'
          ? { fault: { httpStatus: 200, error: 'document unavailable', repeated: true } }
          : {}),
      },
    ],
  };
  for (const v of [j.expected, j.policy, j.admission, j.authority, j.envelope.receipt]) {
    v.caseId = caseId;
    v.physicalMapSha256 = c.fixture.mappingSha256;
  }
  j.admission.fixture = canonical;
  j.authority.fixture = structuredClone(canonical);
  j.admission.kind = 'meri-controlled-read-authenticated-admission';
  j.authority.kind = 'meri-controlled-read-authenticated-readback';
  j.admission.providerBudget.coverage = `case${caseId}_controlled_read_turn`;
  j.authority.providerBudget.coverage = j.admission.providerBudget.coverage;
  const r = j.envelope.receipt;
  r.providerBudget.boundary = j.admission.providerBudget.coverage;
  r.fixture.physicalMapSha256 = obs(c.fixture.mappingSha256);
  const tool = caseId === '20' ? 'get_program_element' : 'read_client_documents';
  r.controlledReadAttempts = Array.from({ length: caseId === '20' ? 1 : 3 }, (_, i) => ({
    callId: `call-${i + 1}`,
    tool,
    httpStatus: 200,
    logicalError: caseId === '20' ? null : 'document unavailable',
    ...Object.fromEntries(
      ['caseId', 'captureRunId', 'requestId', 'traceId', 'turnId'].map((k) => [k, j.policy[k]]),
    ),
    sourceId: read.physicalId,
    logicalSourceId: read.logicalId,
    sourceVersion: 'v1',
    sourceTenantId: j.expected.tenantId,
    sourceClientId: canonical.sources[0].clientId,
    currentVerifySha256: canonical.currentVerifySha256,
    contentSha256: read.contentSha256,
    responseSha256: sha256Bytes(
      caseId === '20' ? read.content : '{"error":"document unavailable"}',
    ),
    fullRead: caseId === '20',
    passageSha256: caseId === '20' ? read.contentSha256 : null,
  }));
  r.toolCalls = r.controlledReadAttempts.map((a) => ({
    callId: a.callId,
    name: tool,
    attempt: 1,
    readOnly: true,
    status: caseId === '20' ? 'complete' : 'failed',
    sourceIds: caseId === '20' ? [read.physicalId] : [],
  }));
  r.boundedRuntime = {
    acquisitionStopped: caseId === '72',
    stopReason: caseId === '72' ? 'no_progress' : null,
    toolCalls: r.toolCalls.length,
    modelCalls: 4,
    retryCalls: caseId === '72' ? 2 : 0,
  };
  r.sources =
    caseId === '20'
      ? [
          {
            sourceId: read.physicalId,
            toolCallId: 'call-1',
            tenantId: obs(j.expected.tenantId),
            clientId: obs(null),
            currentVersion: obs('v1'),
            fullRead: obs(true),
            locator: obs('page 14'),
            passageSha256: obs(read.contentSha256),
            byteSha256: obs(read.contentSha256),
          },
        ]
      : [];
  r.blockers = caseId === '20' ? [`source_client_authority_unproved:${read.physicalId}`] : [];
  r.status = r.blockers.length ? 'BLOCKED' : 'COMPLETE';
  j.sourceReadback =
    caseId === '20'
      ? {
          kind: 'controlled_read',
          status: 'available',
          recordId: read.physicalId,
          sourceVersion: 'v1',
          tenantId: j.expected.tenantId,
          clientId: j.expected.clientId,
          conversationId: j.expected.conversationId,
          section: 'page 14',
          text: read.content,
          offset: 0,
          nextCursor: null,
          controlled: true,
        }
      : null;
  j.citations =
    caseId === '20'
      ? [
          {
            id: read.physicalId,
            tool,
            snippet: read.content,
            source: {
              kind: 'controlled_read',
              recordId: read.physicalId,
              version: 'v1',
              section: 'page 14',
              clientId: j.expected.clientId,
              conversationId: j.expected.conversationId,
            },
          },
        ]
      : [];
  j.answer =
    caseId === '20'
      ? 'PE 0912345T FY27 President’s Budget request is $42M (R2-27, page 14).'
      : 'I could not read the memo: document unavailable.';
  refresh(j);
  return {
    config: c,
    scope,
    joins: j,
    admissionInput: { ...h.admissionInput, scope, admission: j.admission },
  };
}

for (const caseId of ['20', '72']) {
  test(`case ${caseId} fixed source, admission and signed owner joins pass only pure checks`, () => {
    const h = fixture(caseId);
    assert.equal(inspectControlledReadAdmission(h.admissionInput).caseId, caseId);
    assert.equal(assertControlledReadReceiptJoins(h.joins).status, 'VALIDATED_JOINS_ONLY');
    assert.deepEqual(inspectControlledReadSavedEvidence(h.joins).defects, []);
  });
  for (const [name, mutate] of [
    ['foreign actor', (j) => (j.authority.actorUserId = 'other')],
    ['old run', (j) => (j.envelope.receipt.controlledReadAttempts[0].captureRunId = 'old')],
    [
      'display call identity',
      (j) => (j.envelope.receipt.controlledReadAttempts[0].callId = 'read memo'),
    ],
    ['missing HTTP attempt', (j) => j.envelope.receipt.controlledReadAttempts.pop()],
    ['HTTP 201', (j) => (j.envelope.receipt.controlledReadAttempts[0].httpStatus = 201)],
    ['changed current fixture', (j) => (j.authority.fixture.currentVerifySha256 = 'f'.repeat(64))],
    ['unknown input usage', (j) => (j.envelope.receipt.usage.inputTokens.status = 'UNKNOWN')],
    ['unsettled accounting', (j) => (j.envelope.receipt.providerBudget.status = 'UNCERTAIN')],
    [
      'wrong budget case',
      (j) => (j.envelope.receipt.providerBudget.boundary = 'case01_memory_turn'),
    ],
    [
      'unexpected write',
      (j) =>
        j.envelope.receipt.effects.writes.push({
          logicalWriteId: 'send',
          kind: 'mail_send',
          status: 'observed',
        }),
    ],
    ['missing bound runtime', (j) => delete j.envelope.receipt.boundedRuntime],
    [
      'unknown blocker',
      (j) => j.envelope.receipt.blockers.push('provider_budget_api_ingress_unaccounted'),
    ],
  ])
    test(`case ${caseId} rejects ${name}`, () => {
      const h = fixture(caseId);
      mutate(h.joins);
      refresh(h.joins);
      assert.throws(() => assertControlledReadReceiptJoins(h.joins), /CONTROLLED_READ_/);
    });
}
test('20 rejects title-only, altered full passage, foreign locator, and forged global authorization', () => {
  for (const edit of [
    (j) => (j.envelope.receipt.sources[0].fullRead.value = false),
    (j) => (j.sourceReadback.text = 'title only'),
    (j) => (j.citations[0].source.conversationId = 'foreign'),
    (j) => (j.authority.fixture.sources[0].clientId = j.expected.clientId),
  ]) {
    const h = fixture('20');
    edit(h.joins);
    refresh(h.joins);
    assert.throws(() => assertControlledReadReceiptJoins(h.joins));
  }
});
test('72 refuses error-as-source, false-complete classification and invented successful passages', () => {
  for (const edit of [
    (j) => (j.envelope.receipt.toolCalls[0].status = 'complete'),
    (j) => j.citations.push({ id: 'invented' }),
    (j) => (j.envelope.receipt.controlledReadAttempts[0].fullRead = true),
  ]) {
    const h = fixture('72');
    edit(h.joins);
    refresh(h.joins);
    assert.throws(() => assertControlledReadReceiptJoins(h.joins));
  }
});
test('72 actual early stop without repeated suppression is saved as deterministic failure, never PASS', () => {
  const h = fixture('72');
  h.joins.envelope.receipt.boundedRuntime.stopReason = null;
  h.joins.envelope.receipt.boundedRuntime.acquisitionStopped = false;
  refresh(h.joins);
  assert.ok(
    inspectControlledReadSavedEvidence(h.joins).defects.includes(
      'NO_PROGRESS_SUPPRESSION_NOT_OBSERVED',
    ),
  );
});
test('20 wrong amount/stage and 72 false success fail saved answer checks', () => {
  const a = fixture('20');
  a.joins.answer = 'PE 0912345T FY27 $37M enacted.';
  refresh(a.joins);
  assert.ok(inspectControlledReadSavedEvidence(a.joins).defects.includes('REQUEST_AMOUNT_MISSING'));
  const b = fixture('72');
  b.joins.answer = 'I have read Aster latest memo successfully.';
  refresh(b.joins);
  assert.ok(inspectControlledReadSavedEvidence(b.joins).defects.includes('FAILURE_NOT_DISCLOSED'));
});
test('caller JSON cannot mint live capability, artifact owner or a grade', async () => {
  await assert.rejects(
    executeControlledReadLiveCapture({ kind: 'meri-controlled-read-live-session' }),
    /AUTHENTICATED_CAPABILITY/,
  );
  assert.throws(
    () => currentControlledReadCaptureAuthority({ status: 'CAPTURE_COMPLETE' }),
    /AUTHENTICATED_OUTCOME/,
  );
  assert.throws(
    () => gradeControlledReadCapturedOutcome({ status: 'CAPTURE_COMPLETE', caseId: '20' }),
    /AUTHENTICATED_OUTCOME/,
  );
  await assert.rejects(
    prepareControlledReadLiveCapture({
      config: fixture('20').config,
      runRoot: 'unused',
      artifactStorage: {},
      env: { MERI_LIVE_BEARER_TOKEN: 'synthetic-test-bearer' },
    }),
    /storage|authority|capability/i,
  );
});
test('scope rejects other rows, arbitrary physical maps, customer tenants, higher caps and parallelism', () => {
  for (const edit of [
    (c) => (c.caseId = '74'),
    (c) => (c.scope.sources['R2-27'].physicalId = c.conversationId),
    (c) => (c.scope.tenants.T1.physicalId = c.conversationId),
    (c) => (c.limits.maxSpendUsd = 3.01),
    (c) => (c.limits.concurrency = 2),
  ]) {
    const h = fixture('20');
    edit(h.config);
    assert.throws(() =>
      inspectControlledReadScope(h.config, { MERI_LIVE_BEARER_TOKEN: 'synthetic' }),
    );
  }
});
