import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseMemoryReviewApproveResponse,
  parseMemoryReviewDetail,
  parseMemoryReviewInboxPage,
  parseMemoryReviewRejectRequest,
  parseMemoryReviewRejectResponse,
} from './memory-review.js';

const candidateId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const memoryId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const createdAt = '2026-10-17T00:00:00.000Z';
const reviewer = { userId: actorId, name: 'Reviewer' };

function item() {
  return {
    candidateId,
    reviewRequestId: requestId,
    candidateKind: 'standard',
    scope: 'client',
    client: { id: memoryId, name: 'Client', status: 'active' },
    title: 'Memory proposal',
    status: 'pending',
    revisionNumber: 1,
    rootCandidateId: candidateId,
    predecessorCandidateId: null,
    submittedBy: { userId: memoryId, name: 'Submitter' },
    assignedReviewer: reviewer,
    decidedBy: null,
    createdAt,
    decidedAt: null,
    blockedReason: null,
    nextAction: 'review',
    capabilities: {
      open: true,
      approve: true,
      reject: true,
      requestChanges: true,
      revise: false,
      reassign: false,
      withdraw: false,
    },
  };
}

test('parses the native paged inbox and disabled empty page', () => {
  const page = { enabled: true, view: 'needs_my_review', items: [item()], nextCursor: 'opaque' };
  assert.deepEqual(parseMemoryReviewInboxPage(page), page);
  const disabled = { enabled: false, view: 'history', items: [], nextCursor: null };
  assert.deepEqual(parseMemoryReviewInboxPage(disabled), disabled);
});

test('rejects missing capabilities, unsupported views and nonnative inbox kinds', () => {
  const row = item();
  assert.throws(
    () => parseMemoryReviewInboxPage({ enabled: true, view: 'all', items: [row], nextCursor: null }),
    /page.view/,
  );
  assert.throws(
    () => parseMemoryReviewInboxPage({ enabled: true, view: 'history', items: [{ ...row, capabilities: { approve: true } }], nextCursor: null }),
    /capabilities.open/,
  );
  assert.throws(
    () => parseMemoryReviewInboxPage({ enabled: true, view: 'history', items: [{ ...row, candidateKind: 'learning_signal_conflict' }], nextCursor: null }),
    /candidateKind/,
  );
});

test('parses the protected native detail with proposal and server capabilities', () => {
  const detail = {
    ...item(),
    proposal: {
      key: null,
      value: null,
      canonicalItem: {
        type: 'note', slug: 'memory-proposal', title: 'Memory proposal',
        sections: [{ key: 'summary', heading: 'Summary', owner: 'human', body: 'Proposed text' }],
      },
    },
    feedbackReason: null,
    eligibleReviewers: [{ ...reviewer, role: 'user_admin' }],
    timeline: [{
      candidateId, reviewRequestId: requestId, revisionNumber: 1,
      predecessorCandidateId: null, supersededById: null, title: 'Memory proposal',
      status: 'pending', submittedBy: item().submittedBy, assignedReviewer: reviewer,
      decidedBy: null, createdAt, decidedAt: null,
    }],
    controllingMemory: { itemId: memoryId, version: 2 },
    activeMemoryUnchanged: true,
  };
  assert.deepEqual(parseMemoryReviewDetail(detail, candidateId), detail);
  assert.throws(() => parseMemoryReviewDetail(detail, requestId), /detail.candidateId/);
  assert.throws(
    () => parseMemoryReviewDetail({ ...detail, eligibleReviewers: [{ ...reviewer, role: 'owner' }] }),
    /eligibleReviewers\[0\].role/,
  );
  assert.throws(
    () => parseMemoryReviewDetail({ ...detail, proposal: { ...detail.proposal, canonicalItem: { ...detail.proposal.canonicalItem, sections: [{ ...detail.proposal.canonicalItem.sections[0], owner: 'bot' }] } } }),
    /sections\[0\].owner/,
  );
});

test('parses native approve variants and correlates the requested candidate', () => {
  const standard = { ok: true, candidateId, candidateKind: 'standard', outcome: 'activated', memoryId };
  assert.deepEqual(parseMemoryReviewApproveResponse(standard, candidateId), standard);
  const version = {
    ok: true, candidateId, candidateKind: 'contradiction', outcome: 'conflict',
    memoryItemId: memoryId, controllingItemId: memoryId, conflictGroupId: requestId,
  };
  assert.deepEqual(parseMemoryReviewApproveResponse(version, candidateId), version);
  const duplicate = {
    ok: true, candidateId, candidateKind: 'correction', outcome: 'duplicate',
    memoryItemId: memoryId, controllingItemId: memoryId,
  };
  assert.deepEqual(parseMemoryReviewApproveResponse(duplicate, candidateId), duplicate);
  assert.throws(() => parseMemoryReviewApproveResponse(standard, requestId), /approve.candidateId/);
  assert.throws(() => parseMemoryReviewApproveResponse({ ...standard, memoryId: undefined }), /approve.memoryId/);
  assert.throws(() => parseMemoryReviewApproveResponse({ ...standard, outcome: 'rejected' }), /approve.outcome/);
  assert.throws(() => parseMemoryReviewApproveResponse({ ...duplicate, memoryItemId: undefined }), /approve.memoryItemId/);
  assert.throws(() => parseMemoryReviewApproveResponse({ ...duplicate, controllingItemId: undefined }), /approve.controllingItemId/);
  assert.throws(() => parseMemoryReviewApproveResponse({ ...version, conflictGroupId: undefined }), /approve.conflictGroupId/);
  assert.throws(() => parseMemoryReviewApproveResponse({ ...standard, candidateKind: 'correction' }), /approve.memoryId/);
});

test('requires a nonblank rejection reason and parses the native reject receipt', () => {
  assert.deepEqual(parseMemoryReviewRejectRequest({ reason: 'Incorrect fact' }), { reason: 'Incorrect fact' });
  assert.throws(() => parseMemoryReviewRejectRequest({ reason: ' \n ' }), /rejectRequest.reason/);
  const rejected = { ok: true, candidateId, candidateKind: 'restore', outcome: 'rejected' };
  assert.deepEqual(parseMemoryReviewRejectResponse(rejected, candidateId), rejected);
  assert.throws(() => parseMemoryReviewRejectResponse(rejected, requestId), /reject.candidateId/);
  assert.throws(() => parseMemoryReviewRejectResponse({ ...rejected, outcome: 'activated' }), /reject.outcome/);
});
