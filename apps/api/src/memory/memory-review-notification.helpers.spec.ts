import { describe, expect, it } from '@jest/globals';
import {
  memoryReviewNotificationMatchesWorkflow,
  memoryReviewNotificationOperation,
  normalizeNotificationTitle,
} from './memory-review-notification.helpers.js';

describe('memory review notification helpers', () => {
  it('routes assignment events through current approve authorization', () => {
    expect(memoryReviewNotificationOperation('review_assigned')).toBe('approve');
    expect(memoryReviewNotificationOperation('review_revision_assigned')).toBe(
      'approve',
    );
    expect(memoryReviewNotificationOperation('review_reassigned')).toBe(
      'approve',
    );
    expect(memoryReviewNotificationOperation('review_changes_requested')).toBe(
      'read',
    );
    expect(memoryReviewNotificationOperation('review_approved')).toBe('read');
    expect(memoryReviewNotificationOperation('review_rejected')).toBe('read');
  });

  it('suppresses stale assignments and stale proposer outcomes', () => {
    const reviewer = 'reviewer';
    const proposer = 'proposer';
    expect(
      memoryReviewNotificationMatchesWorkflow('review_assigned', reviewer, {
        status: 'pending',
        assignedTo: reviewer,
        requestedBy: proposer,
      }),
    ).toBe(true);
    expect(
      memoryReviewNotificationMatchesWorkflow('review_assigned', reviewer, {
        status: 'pending',
        assignedTo: 'other-reviewer',
        requestedBy: proposer,
      }),
    ).toBe(false);
    expect(
      memoryReviewNotificationMatchesWorkflow(
        'review_changes_requested',
        proposer,
        {
          status: 'changes_needed',
          assignedTo: reviewer,
          requestedBy: proposer,
        },
      ),
    ).toBe(true);
    expect(
      memoryReviewNotificationMatchesWorkflow(
        'review_changes_requested',
        proposer,
        {
          status: 'superseded',
          assignedTo: reviewer,
          requestedBy: proposer,
        },
      ),
    ).toBe(false);
    expect(
      memoryReviewNotificationMatchesWorkflow('review_approved', proposer, {
        status: 'approved',
        assignedTo: reviewer,
        requestedBy: proposer,
      }),
    ).toBe(true);
    expect(
      memoryReviewNotificationMatchesWorkflow('review_rejected', proposer, {
        status: 'approved',
        assignedTo: reviewer,
        requestedBy: proposer,
      }),
    ).toBe(false);
  });

  it('normalizes notification titles without carrying proposal content', () => {
    expect(normalizeNotificationTitle('  Firm\nSoul\u0000 ')).toBe('Firm Soul');
    expect(normalizeNotificationTitle(undefined)).toBe('Memory proposal');
    expect(normalizeNotificationTitle('x'.repeat(400))).toHaveLength(300);
  });
});
