import { describe, expect, it } from '@jest/globals';
import {
  memoryReviewEmailDeliveryEnabled,
  memoryReviewNotificationMatchesWorkflow,
  memoryReviewNotificationOperation,
  normalizeNotificationTitle,
  renderMemoryReviewNotificationEmail,
} from './memory-review-notification.helpers.js';

describe('memory review notification helpers', () => {
  it('requires the exact enforce token for email delivery', () => {
    expect(memoryReviewEmailDeliveryEnabled('enforce')).toBe(true);
    expect(memoryReviewEmailDeliveryEnabled(' ENFORCE ')).toBe(true);
    expect(memoryReviewEmailDeliveryEnabled('true')).toBe(false);
    expect(memoryReviewEmailDeliveryEnabled('1')).toBe(false);
    expect(memoryReviewEmailDeliveryEnabled(undefined)).toBe(false);
  });

  it('routes assignment events through current approve authorization', () => {
    expect(memoryReviewNotificationOperation('review_assigned')).toBe('approve');
    expect(memoryReviewNotificationOperation('review_revision_assigned')).toBe('approve');
    expect(memoryReviewNotificationOperation('review_reassigned')).toBe('approve');
    expect(memoryReviewNotificationOperation('review_changes_requested')).toBe('read');
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
      memoryReviewNotificationMatchesWorkflow('review_changes_requested', proposer, {
        status: 'changes_needed',
        assignedTo: reviewer,
        requestedBy: proposer,
      }),
    ).toBe(true);
    expect(
      memoryReviewNotificationMatchesWorkflow('review_changes_requested', proposer, {
        status: 'superseded',
        assignedTo: reviewer,
        requestedBy: proposer,
      }),
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

  it('normalizes titles and renders body-free escaped email content', () => {
    expect(normalizeNotificationTitle('  Firm\nSoul\u0000 ')).toBe('Firm Soul');
    const rendered = renderMemoryReviewNotificationEmail({
      eventType: 'review_changes_requested',
      title: '<Firm & Soul>',
      reviewRequestId: 'review/id',
      appOrigin: 'https://app.capiro.ai/',
    });
    expect(rendered.subject).toContain('Changes requested on memory proposal');
    expect(rendered.html).toContain('&lt;Firm &amp; Soul&gt;');
    expect(rendered.html).toContain('review%2Fid');
    expect(rendered.text).not.toContain('feedbackReason');
    expect(rendered.text).not.toContain('sourceExcerpt');
    expect(rendered.text).not.toContain('reason:');
  });

  it('does not include an unsafe external origin', () => {
    const rendered = renderMemoryReviewNotificationEmail({
      eventType: 'review_assigned',
      title: 'Firm Soul',
      reviewRequestId: 'review-id',
      appOrigin: 'http://attacker.example',
    });
    expect(rendered.html).not.toContain('attacker.example');
    expect(rendered.text).not.toContain('attacker.example');
  });
});
