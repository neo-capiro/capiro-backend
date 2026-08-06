import { describe, expect, it } from 'vitest';
import {
  memoryReviewBlockedReasonLabel,
  memoryReviewNextActionLabel,
  memoryReviewStatusLabel,
  type MemoryReviewInboxItem,
} from './MemoryReviewInbox.js';

const baseItem: MemoryReviewInboxItem = {
  candidateId: '11111111-1111-4111-8111-111111111111',
  reviewRequestId: '22222222-2222-4222-8222-222222222222',
  candidateKind: 'standard',
  scope: 'firm',
  client: null,
  title: 'Firm Soul',
  status: 'pending',
  revisionNumber: 1,
  rootCandidateId: '11111111-1111-4111-8111-111111111111',
  predecessorCandidateId: null,
  submittedBy: {
    userId: '33333333-3333-4333-8333-333333333333',
    name: 'Pat Proposer',
  },
  assignedReviewer: {
    userId: '44444444-4444-4444-8444-444444444444',
    name: 'Riley Reviewer',
  },
  decidedBy: null,
  createdAt: '2026-08-06T12:00:00.000Z',
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

describe('MemoryReviewInbox Phase 3 wording', () => {
  it('uses plain-English public status labels', () => {
    expect(memoryReviewStatusLabel('pending')).toBe('Pending review');
    expect(memoryReviewStatusLabel('changes_requested')).toBe('Changes requested');
    expect(memoryReviewStatusLabel('superseded')).toBe('Revised');
  });

  it('makes current ownership of the next action explicit', () => {
    expect(memoryReviewNextActionLabel(baseItem)).toBe('Your review is needed');
    expect(
      memoryReviewNextActionLabel({
        ...baseItem,
        nextAction: 'await_reviewer',
        capabilities: {
          ...baseItem.capabilities,
          approve: false,
          reject: false,
          requestChanges: false,
        },
      }),
    ).toBe('Waiting for Riley Reviewer');
    expect(
      memoryReviewNextActionLabel({
        ...baseItem,
        nextAction: 'revise',
        status: 'changes_requested',
      }),
    ).toBe('Revise and resubmit');
  });

  it('explains blocked review without exposing internal codes', () => {
    expect(memoryReviewBlockedReasonLabel('no_reviewer')).toBe(
      'No reviewer is assigned.',
    );
    expect(memoryReviewBlockedReasonLabel('reviewer_unavailable')).toBe(
      'The assigned reviewer is no longer eligible.',
    );
    expect(memoryReviewBlockedReasonLabel('archived_client')).toBe(
      'This client is not active, so review is paused.',
    );
  });
});
