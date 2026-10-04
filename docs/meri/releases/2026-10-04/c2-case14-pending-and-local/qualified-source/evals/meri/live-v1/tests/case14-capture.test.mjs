import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './case01-authority.test.mjs';
import {
  inspectCase14RecallScope,
  inspectCase14RecallAdmission,
  executeCase14RecallCapture,
  currentCase14RecallAuthority,
} from '../case01-live-capture.mjs';
import { assertCase14ReceiptJoins } from '../case01-receipt-joins.mjs';
import {
  currentCase14ApprovalAuthority,
  currentCase14RecallUiAuthority,
  inspectCase14ApprovalScope,
  inspectCase14ApprovalEvidence,
} from '../case14-approval-capture.mjs';
import { gradeCase14CapturedOutcome } from '../grade-case14-capture.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
import { nativeMeriCaptureHeaders } from '../lib/native-http.mjs';
test('native memory QA transport identifies itself to the edge without caller-selected or newline headers', () => {
  const headers = nativeMeriCaptureHeaders('unit-bearer', 'meri-foundation-20260928-t1');
  assert.equal(headers['User-Agent'], 'Capiro-Meri-Authorized-QA/1.0');
  assert.equal(headers.authorization, 'Bearer unit-bearer');
  assert.equal(headers['x-capiro-tenant'], 'meri-foundation-20260928-t1');
  assert.throws(() =>
    nativeMeriCaptureHeaders('unit\r\nx-forged: yes', 'meri-foundation-20260928-t1'),
  );
  assert.throws(() => nativeMeriCaptureHeaders('unit', 'customer-tenant'));
});

function unitFixture() {
  const h = fixture(),
    candidateId = '11111111-1111-5111-8111-111111111111';
  h.config.caseId = '14';
  h.config.scope.actors.PRIYA = { ...h.config.scope.actors.PAT, role: 'user_admin' };
  delete h.config.scope.actors.PAT;
  const source = {
    ...h.config.scope.sources['MA1-v2'],
    frozenFixtureId: 'MEM-PROPOSAL-14',
    version: `candidate:${candidateId}`,
  };
  h.config.scope.sources = { 'MEM-PROPOSAL-14': source };
  h.config.fixture.mappingSha256 = sha256Stable(h.config.scope.sources);
  h.scope = inspectCase14RecallScope(h.config, { MERI_LIVE_BEARER_TOKEN: 'synthetic-test-bearer' });
  const j = h.joins;
  for (const value of [j.expected, j.admission, j.authority, j.policy, j.envelope.receipt]) {
    value.caseId = '14';
    value.physicalMapSha256 = h.config.fixture.mappingSha256;
  }
  j.admission.kind = 'meri-case14-authenticated-admission';
  j.authority.kind = 'meri-case14-authenticated-readback';
  const f = j.authority.fixture;
  f.physicalMapSha256 = h.config.fixture.mappingSha256;
  f.sources[0].logicalId = 'MEM-PROPOSAL-14';
  f.sources[0].sourceVersion = source.version;
  f.candidateId = candidateId;
  f.decision = {
    decision: 'approved',
    actorUserId: j.expected.actorUserId,
    transitionAuditId: '22222222-2222-4222-8222-222222222222',
  };
  f.approvedText = 'Synthetic Aster candidate for approval';
  j.admission.fixture = f;
  j.admission.providerBudget.coverage = 'case14_memory_turn';
  j.authority.providerBudget.coverage = 'case14_memory_turn';
  j.envelope.receipt.fixture.physicalMapSha256.value = h.config.fixture.mappingSha256;
  j.envelope.receipt.providerBudget.boundary = 'case14_memory_turn';
  j.sourceReadback.sourceVersion = source.version;
  j.doneEnvelope = structuredClone(j.envelope);
  j.authority.envelopeSha256 = sha256Stable(j.envelope);
  h.admissionInput = {
    ...h.admissionInput,
    scope: h.scope,
    admission: j.admission,
    me: { ...h.admissionInput.me, role: 'user_admin' },
  };
  return h;
}
test('case14 exact current approval/version uses shared signed memory receipt joins without relabeling case01', () => {
  const h = unitFixture();
  assert.equal(inspectCase14RecallAdmission(h.admissionInput).caseId, '14');
  assert.equal(assertCase14ReceiptJoins(h.joins).source.logicalId, 'MEM-PROPOSAL-14');
});
for (const [name, change] of [
  [
    'wrong case',
    (h) => {
      h.joins.policy.caseId = '01';
    },
  ],
  [
    'wrong version',
    (h) => {
      h.joins.authority.fixture.sources[0].sourceVersion = 'candidate:wrong';
    },
  ],
  [
    'foreign decision actor',
    (h) => {
      h.joins.authority.fixture.decision.actorUserId = 'foreign';
    },
  ],
  [
    'missing audit',
    (h) => {
      h.joins.authority.fixture.decision.transitionAuditId = null;
    },
  ],
  [
    'unapproved source',
    (h) => {
      h.joins.authority.fixture.decision.decision = 'pending';
    },
  ],
  [
    'unknown cost',
    (h) => {
      h.joins.envelope.receipt.providerBudget.status = 'UNSETTLED';
      h.joins.doneEnvelope = structuredClone(h.joins.envelope);
      h.joins.authority.envelopeSha256 = sha256Stable(h.joins.envelope);
    },
  ],
])
  test(`case14 refuses ${name}`, () => {
    const h = unitFixture();
    change(h);
    assert.throws(() => assertCase14ReceiptJoins(h.joins));
  });
test('copied case14 evidence cannot authorize approval, recall, UI or grading', async () => {
  assert.throws(() => currentCase14ApprovalAuthority({ status: 'APPROVAL_CAPTURE_COMPLETE' }));
  assert.throws(() => currentCase14RecallUiAuthority({ status: 'RECALL_UI_CAPTURE_COMPLETE' }));
  assert.throws(() => currentCase14RecallAuthority({ caseId: '14', status: 'CAPTURE_COMPLETE' }));
  await assert.rejects(executeCase14RecallCapture({ kind: 'meri-case14-live-session' }));
  assert.throws(() =>
    gradeCase14CapturedOutcome({ approvalOutcome: {}, recallOutcome: {}, recallUiOutcome: {} }),
  );
  assert.throws(() =>
    inspectCase14ApprovalScope({ caseId: '14', target: 'https://app.capiro.ai' }),
  );
});

function approvalFixture() {
  const h = unitFixture(),
    f = h.joins.authority.fixture,
    a = h.joins.expected.actorUserId;
  const base = {
    kind: 'meri-case14-current-memory-owner',
    caseId: '14',
    candidateId: f.candidateId,
    recipeSha256: 'a'.repeat(64),
    fixtureInstanceId: '11111111-1111-4111-8111-111111111111',
    tenantId: h.joins.expected.tenantId,
    clientId: h.joins.expected.clientId,
    proposerUserId: '77777777-7777-4777-8777-777777777777',
    reviewerUserId: a,
    reviewerRole: 'user_admin',
    setupReceiptSha256: 'b'.repeat(64),
    payloadSha256: 'c'.repeat(64),
    text: f.approvedText,
  };
  const before = { ...base, state: 'pending', item: null, decision: null };
  before.currentVerifySha256 = sha256Stable(before);
  const after = {
    ...base,
    state: 'approved',
    item: {
      id: h.scope.source.physicalId,
      clioMemoryId: '33333333-3333-4333-8333-333333333333',
      sourceVersion: f.sources[0].sourceVersion,
    },
    decision: f.decision,
  };
  after.currentVerifySha256 = sha256Stable(after);
  return {
    kind: 'meri-case14-owned-approval-evidence',
    caseId: '14',
    applicationApprovalSubmissions: 1,
    synthesisSubmissionCount: 0,
    blockedWrites: 0,
    sessionRevoked: true,
    reviewer: { userId: a },
    apiSha: 'a'.repeat(40),
    before: {
      fixtureEvidence: before,
      candidateId: f.candidateId,
      reviewRequestId: 'review',
      status: 'pending',
    },
    after: {
      fixtureEvidence: after,
      candidateId: f.candidateId,
      reviewRequestId: 'review',
      status: 'approved',
      decidedBy: { userId: a },
    },
    response: {
      status: 201,
      releaseSha: 'a'.repeat(40),
      value: {
        ok: true,
        candidateId: f.candidateId,
        candidateKind: 'standard',
        outcome: 'activated',
        memoryId: after.item.clioMemoryId,
      },
    },
    ui: { pendingVisible: true, confirmedVisible: true, reloadedReceiptVisible: true },
    screenshots: [{}, {}, {}],
  };
}
test('approval grading accepts actual Nest201 semantics and canonical decision joins only', () => {
  assert.equal(
    inspectCase14ApprovalEvidence(approvalFixture()).approvedText,
    'Synthetic Aster candidate for approval',
  );
  for (const mutate of [
    (e) => {
      e.response.status = 403;
    },
    (e) => {
      e.response.value.candidateId = 'foreign';
    },
    (e) => {
      e.after.reviewRequestId = 'foreign';
    },
    (e) => {
      e.after.decidedBy.userId = 'foreign';
    },
    (e) => {
      e.applicationApprovalSubmissions = 2;
    },
    (e) => {
      e.synthesisSubmissionCount = 1;
    },
    (e) => {
      e.ui.reloadedReceiptVisible = false;
    },
    (e) => {
      e.after.fixtureEvidence.item.sourceVersion = 'wrong';
    },
    (e) => {
      e.sessionRevoked = false;
    },
  ]) {
    const e = approvalFixture();
    mutate(e);
    assert.throws(() => inspectCase14ApprovalEvidence(e));
  }
});
