import { describe, expect, it } from 'vitest';
import { memorySaveErrorMessage, settingsMemorySuccessMessage } from './MemoryFileEditor.js';
import {
  memoryReviewSummaryStats,
  type MemoryReviewSummaryResponse,
} from './MemoryReviewStatusSummary.js';
import {
  activeMemoryReviewExplanation,
  activeMemoryVersionPresentation,
  pendingReviewHeadline,
  pendingReviewTone,
  type PendingMemoryReviewState,
} from './PendingMemoryReviewPanel.js';

const missingReviewerMessage =
  'Firm memory requires approval from another active administrator. ' +
  'No eligible reviewer is available.';

describe('MemoryFileEditor Phase 3 result wording', () => {
  it('never labels a shared candidate submission as Saved', () => {
    expect(
      settingsMemorySuccessMessage({
        status: 'pending_review',
        candidateId: 'cand-1',
        activeItemUnchanged: true,
      }),
    ).toBe('Submitted for independent review');
  });

  it('keeps the immediate personal-save wording', () => {
    expect(settingsMemorySuccessMessage({ ok: true, updatedAt: 'now' })).toBe('Saved');
  });

  it('shows the server-owned 409 explanation instead of a generic Axios error', () => {
    expect(
      memorySaveErrorMessage({
        response: {
          data: {
            message: missingReviewerMessage,
          },
        },
      }),
    ).toBe(missingReviewerMessage);
  });
});

describe('Shared memory review status wording', () => {
  const pending: PendingMemoryReviewState = {
    candidateId: 'candidate-1',
    status: 'pending_review',
    submittedAt: '2026-08-05T12:00:00.000Z',
  };

  it('uses plain language and visibly distinguishes blocked review', () => {
    expect(pendingReviewHeadline(pending)).toBe('Waiting for independent review');
    expect(pendingReviewTone(pending)).toBe('info');
    expect(pendingReviewHeadline({ ...pending, blocked: true })).toBe('Review blocked');
    expect(pendingReviewTone({ ...pending, blocked: true })).toBe('error');
  });

  it('does not claim Meri uses a first-time proposal before approval', () => {
    expect(activeMemoryVersionPresentation(false)).toEqual({
      title: 'No active version yet',
      tag: 'Nothing active yet',
      tagColor: 'default',
    });
    expect(activeMemoryReviewExplanation(false)).toContain('will not use this proposal');
  });

  it('keeps all four review queue counts separate', () => {
    const summary: MemoryReviewSummaryResponse = {
      enabled: true,
      counts: {
        awaitingMyReview: 2,
        submittedByMe: 3,
        allPending: 7,
        blocked: 1,
      },
      message: '1 pending submission has no eligible independent reviewer.',
    };
    expect(memoryReviewSummaryStats(summary)).toEqual([
      { key: 'awaiting', title: 'Needs my review', value: 2 },
      { key: 'submitted', title: 'Submitted by me', value: 3 },
      { key: 'all', title: 'All pending I can see', value: 7 },
      { key: 'blocked', title: 'Blocked', value: 1 },
    ]);
  });
});
