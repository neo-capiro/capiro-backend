import { describe, expect, it } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import {
  decodeMemoryReviewCursor,
  encodeMemoryReviewCursor,
  memoryReviewBlockedReason,
  memoryReviewCandidateKindFromSource,
  memoryReviewNextAction,
  memoryReviewStatusFromDb,
  parseMemoryReviewInboxView,
  parseMemoryReviewPageSize,
} from './memory-review-inbox.helpers.js';

describe('memory review inbox helpers', () => {
  it('round-trips stable cursor identity', () => {
    const cursor = {
      createdAt: '2026-08-06T12:00:00.000Z',
      id: '11111111-1111-4111-8111-111111111111',
    };
    expect(decodeMemoryReviewCursor(encodeMemoryReviewCursor(cursor))).toEqual(cursor);
  });

  it('rejects malformed and oversized cursor/page input', () => {
    expect(() => decodeMemoryReviewCursor('not-a-cursor')).toThrow(
      BadRequestException,
    );
    expect(() => parseMemoryReviewPageSize(0)).toThrow(BadRequestException);
    expect(() => parseMemoryReviewPageSize(51)).toThrow(BadRequestException);
  });

  it('uses the safe default view and bounded default page size', () => {
    expect(parseMemoryReviewInboxView('unknown')).toBe('needs_my_review');
    expect(parseMemoryReviewPageSize(undefined)).toBe(25);
  });

  it('maps database vocabulary to plain English workflow vocabulary', () => {
    expect(memoryReviewStatusFromDb('changes_needed')).toBe('changes_requested');
    expect(memoryReviewCandidateKindFromSource('memory_restore')).toBe('restore');
  });

  it('derives blocked reasons from client and current reviewer eligibility', () => {
    expect(
      memoryReviewBlockedReason({
        clientId: null,
        clientStatus: null,
        assignedReviewerId: null,
        assignedReviewerActive: false,
        assignedReviewerEligible: false,
      }),
    ).toBe('no_reviewer');
    expect(
      memoryReviewBlockedReason({
        clientId: '22222222-2222-4222-8222-222222222222',
        clientStatus: 'archived',
        assignedReviewerId: '33333333-3333-4333-8333-333333333333',
        assignedReviewerActive: true,
        assignedReviewerEligible: true,
      }),
    ).toBe('archived_client');
    expect(
      memoryReviewBlockedReason({
        clientId: null,
        clientStatus: null,
        assignedReviewerId: '33333333-3333-4333-8333-333333333333',
        assignedReviewerActive: true,
        assignedReviewerEligible: false,
      }),
    ).toBe('reviewer_unavailable');
  });

  it('makes current assignment and proposer state determine the next action', () => {
    expect(
      memoryReviewNextAction({
        status: 'pending',
        viewerIsSubmitter: false,
        viewerIsAssignedReviewer: true,
        viewerIsAdmin: false,
        canApprove: true,
        canReject: true,
        canRevise: false,
        canReassign: false,
      }),
    ).toBe('review');
    expect(
      memoryReviewNextAction({
        status: 'changes_requested',
        viewerIsSubmitter: true,
        viewerIsAssignedReviewer: false,
        viewerIsAdmin: false,
        canApprove: false,
        canReject: false,
        canRevise: true,
        canReassign: false,
      }),
    ).toBe('revise');
  });
});
