import { describe, expect, it } from 'vitest';
import {
  buildGovernanceActionRequest,
  governanceAuthorityLabel,
  governanceBucketForTab,
  governanceStatusLabel,
  shouldRenderMemoryGovernanceCenter,
} from './MemoryGovernanceCenter.js';

const overview = {
  enabled: true,
  counts: {
    active: 1,
    pendingReview: 2,
    conflicts: 3,
    reviewDue: 4,
    history: 5,
    activeGrants: 6,
    projectionAttention: 7,
  },
};

describe('Memory Governance Center browser boundary', () => {
  it('shows only to an administrator when the server explicitly enables it', () => {
    expect(shouldRenderMemoryGovernanceCenter(true, overview)).toBe(true);
    expect(shouldRenderMemoryGovernanceCenter(false, overview)).toBe(false);
    expect(shouldRenderMemoryGovernanceCenter(true, { ...overview, enabled: false })).toBe(false);
    expect(shouldRenderMemoryGovernanceCenter(true, undefined)).toBe(false);
  });

  it('maps only item-backed tabs to controlled server buckets', () => {
    expect(governanceBucketForTab('active')).toBe('active');
    expect(governanceBucketForTab('review_due')).toBe('review_due');
    expect(governanceBucketForTab('conflicts')).toBe('conflicts');
    expect(governanceBucketForTab('history')).toBe('history');
    expect(governanceBucketForTab('pending')).toBeNull();
    expect(governanceBucketForTab('grants')).toBeNull();
  });

  it('builds action requests from ids and bounded user input without authority claims', () => {
    const stale = buildGovernanceActionRequest('mark_stale', 'item-1', {
      reason: '  Needs review.  ',
    });
    expect(stale).toEqual({
      method: 'post',
      path: '/api/memory/governance/items/item-1/mark-stale',
      body: { reason: 'Needs review.' },
    });

    const correction = buildGovernanceActionRequest('correction', 'item-1', {
      content: '  Corrected truth. ',
    });
    expect(correction.body).toEqual({ content: 'Corrected truth.' });

    const conflict = buildGovernanceActionRequest('resolve_conflict', 'item-1', {
      controllingItemId: 'item-2',
      reason: 'Primary source controls.',
    });
    expect(conflict).toEqual({
      method: 'post',
      path: '/api/memory/items/item-1/conflicts/resolve',
      body: { controllingItemId: 'item-2', reason: 'Primary source controls.' },
    });

    for (const request of [stale, correction, conflict]) {
      expect(request.body).not.toHaveProperty('tenantId');
      expect(request.body).not.toHaveProperty('role');
      expect(request.body).not.toHaveProperty('clientId');
      expect(request.body).not.toHaveProperty('allowed');
      expect(request.body).not.toHaveProperty('capabilities');
    }
  });

  it('never echoes unknown authority or lifecycle slugs to the administrator', () => {
    expect(governanceAuthorityLabel('firm_approved')).toBe('Firm approved');
    expect(governanceAuthorityLabel('future_internal_authority')).toBe('Unknown');
    expect(governanceStatusLabel('active')).toBe('Active');
    expect(governanceStatusLabel('future_internal_status')).toBe('Unknown');
  });
});
