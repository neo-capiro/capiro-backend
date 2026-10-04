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
import { sha256Bytes, sha256Stable } from '../artifact-collector.mjs';
import { nativeMeriCaptureHeaders } from '../lib/native-http.mjs';
const obs = (value) => ({ status: 'OBSERVED', value, reason: null });
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
    candidateId = '6f4545a1-dcd5-5eba-8606-db2043b238ac';
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
  f.sources[0].contentSha256 = 'e398859f2cda473be80da00d8e849a958646f9b105292823f005c848938af8cc';
  j.admission.fixture = f;
  j.admission.providerBudget.coverage = 'case14_memory_turn';
  j.authority.providerBudget.coverage = 'case14_memory_turn';
  j.envelope.receipt.fixture.physicalMapSha256.value = h.config.fixture.mappingSha256;
  j.envelope.receipt.providerBudget.boundary = 'case14_memory_turn';
  const currentVersion = 'content:663dadd36e2a7a58c434215a3f19fdec12b07f7d1152a90a0f4a5b53fd8ca50b';
  j.envelope.receipt.sources[0].currentVersion = obs(currentVersion);
  j.envelope.receipt.sources[0].passageSha256 = obs(sha256Bytes(f.approvedText));
  j.envelope.receipt.sources[0].fullRead = obs(true);
  j.sourceReadback.sourceVersion = source.version;
  j.sourceReadback.text = f.approvedText;
  j.sourceReadback.totalCharacters = f.approvedText.length;
  j.sourceReadback.currentVersion = currentVersion;
  j.sourceReadback.contentStatus = 'available';
  j.sourceReadback.versionStatus = 'matches_cited_version';
  j.sourceReadback.provenance = {
    recordId: source.physicalId,
    sourceId: candidateId,
    sourceVersion: source.version,
    contentHash: f.sources[0].contentSha256,
  };
  j.citations[0].snippet = f.approvedText;
  j.citations[0].source.version = currentVersion;
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
  ['wrong content status', h => { h.joins.sourceReadback.contentStatus = 'partial'; }],
  ['missing canonical DB hash', h => { delete h.joins.sourceReadback.provenance.contentHash; }],
  ['wrong candidate provenance', h => { h.joins.sourceReadback.provenance.sourceId = 'foreign'; }],
  ['wrong provenance version', h => { h.joins.sourceReadback.provenance.sourceVersion = 'changed'; }],
  ['source changed after citation', h => { h.joins.sourceReadback.versionStatus = 'changed_since_citation'; }],
  ['paged source', h => { h.joins.sourceReadback.nextCursor = 'more'; }],
  ['nonzero source offset', h => { h.joins.sourceReadback.offset = 1; }],
  ['object substituted for string version', h => { h.joins.sourceReadback.currentVersion = obs(h.joins.sourceReadback.currentVersion); }],

  [
    'noncanonical source owner',
    (h) => {
      const fixture = structuredClone(h.joins.authority.fixture);
      fixture.sources[0].physicalId = '99999999-9999-4999-8999-999999999999';
      h.joins.authority.fixture = fixture;
      h.joins.admission.fixture = structuredClone(fixture);
    },
  ],
  [
    'wrong approved text',
    (h) => {
      h.joins.sourceReadback.text += ' altered';
      h.joins.sourceReadback.totalCharacters = h.joins.sourceReadback.text.length;
    },
  ],
  [
    'wrong DB provenance hash',
    (h) => {
      const fixture = structuredClone(h.joins.authority.fixture);
      fixture.sources[0].contentSha256 = '0'.repeat(64);
      h.joins.authority.fixture = fixture;
      h.joins.admission.fixture = structuredClone(fixture);
    },
  ],
  [
    'wrong current source version',
    (h) => {
      h.joins.sourceReadback.currentVersion = 'content:' + '0'.repeat(64);
    },
  ],
  [
    'partial source pagination',
    (h) => {
      h.joins.sourceReadback.totalCharacters -= 1;
    },
  ],
  [
    'citation/readback currentVersion contradiction',
    (h) => {
      h.joins.citations[0].source.version = 'content:' + '0'.repeat(64);
    },
  ],
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
