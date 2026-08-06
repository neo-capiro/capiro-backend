import { describe, expect, it } from '@jest/globals';
import {
  isMemoryReviewWorkflowStatus,
  memoryReviewStatusFromDb,
  memoryReviewStatusToDb,
  memoryReviewerDisplayName,
  memoryReviewerRoleRank,
  normalizeMemoryReviewReason,
} from './memory-review-workflow.helpers.js';

describe('memory review workflow helpers', () => {
  it('normalizes and bounds reviewer feedback', () => {
    expect(normalizeMemoryReviewReason('  Needs\nmore   sourcing. ')).toBe(
      'Needs more sourcing.',
    );
    expect(normalizeMemoryReviewReason('   ')).toBeNull();
    expect(normalizeMemoryReviewReason(null)).toBeNull();
    expect(normalizeMemoryReviewReason('x'.repeat(600))).toHaveLength(500);
  });

  it('recognizes the Phase 2 workflow vocabulary', () => {
    expect(isMemoryReviewWorkflowStatus('pending')).toBe(true);
    expect(isMemoryReviewWorkflowStatus('changes_requested')).toBe(true);
    expect(isMemoryReviewWorkflowStatus('unknown')).toBe(false);
    expect(memoryReviewStatusToDb('changes_requested')).toBe('changes_needed');
    expect(memoryReviewStatusFromDb('changes_needed')).toBe('changes_requested');
  });

  it('uses deterministic role ordering and human-readable names', () => {
    expect(memoryReviewerRoleRank('user_admin')).toBeLessThan(
      memoryReviewerRoleRank('standard_user'),
    );
    expect(memoryReviewerRoleRank('standard_user')).toBeLessThan(
      memoryReviewerRoleRank('capiro_admin'),
    );
    expect(
      memoryReviewerDisplayName({
        firstName: 'Riley',
        lastName: 'Reviewer',
        email: 'reviewer@example.com',
      }),
    ).toBe('Riley Reviewer');
    expect(memoryReviewerDisplayName({ email: 'reviewer@example.com' })).toBe(
      'reviewer@example.com',
    );
  });
});
