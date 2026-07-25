import { describe, expect, it } from 'vitest';
import {
  applyApprovalOutcome,
  mergePendingApproval,
  outstandingApprovals,
} from './meri-pending-approvals.js';
import type { PendingApproval } from './useMeriChatController.js';

const card = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  tool: 'update_client_profile',
  label: 'Update client profile',
  fingerprint: 'f1',
  status: 'pending',
  ...over,
});

describe('outstandingApprovals', () => {
  it('counts only what still needs the user', () => {
    const cards = [
      card({ fingerprint: 'a', status: 'pending' }),
      card({ fingerprint: 'b', status: 'ran' }),
      card({ fingerprint: 'c', status: 'failed' }),
      card({ fingerprint: 'd', status: 'running' }),
      card({ fingerprint: 'e', status: 'pending' }),
    ];
    expect(outstandingApprovals(cards).map((c) => c.fingerprint)).toEqual(['a', 'e']);
  });
});

describe('mergePendingApproval', () => {
  it('appends a genuinely new proposal', () => {
    const next = mergePendingApproval([], {
      tool: 'create_client',
      label: 'Create client',
      fingerprint: 'new',
      reason: 'needs approval',
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ fingerprint: 'new', status: 'pending' });
  });

  it('survives across turns: an unrelated new proposal never drops the old one', () => {
    // The whole bug: a second turn used to wipe the first turn's cards.
    const first = mergePendingApproval([], { tool: 'create_client', fingerprint: 'a' });
    const second = mergePendingApproval(first, { tool: 'create_client', fingerprint: 'b' });
    expect(second.map((c) => c.fingerprint)).toEqual(['a', 'b']);
  });

  it('does NOT re-offer a write that already ran', () => {
    // Identical fingerprint = identical action. The model re-proposes because it
    // cannot see the approval; approving again would write the row twice.
    const prev = [card({ fingerprint: 'a', status: 'ran' })];
    const next = mergePendingApproval(prev, { tool: 'update_client_profile', fingerprint: 'a' });
    expect(next).toBe(prev);
    expect(outstandingApprovals(next)).toHaveLength(0);
  });

  it('makes a previously failed action actionable again', () => {
    const prev = [card({ fingerprint: 'a', status: 'failed', detail: 'client not found' })];
    const next = mergePendingApproval(prev, {
      tool: 'update_client_profile',
      fingerprint: 'a',
      reason: 'needs approval',
    });
    expect(next[0]).toMatchObject({ status: 'pending', detail: undefined });
    expect(outstandingApprovals(next)).toHaveLength(1);
  });

  it('is a no-op for something already pending or in flight', () => {
    const pending = [card({ fingerprint: 'a', status: 'pending' })];
    expect(mergePendingApproval(pending, { tool: 't', fingerprint: 'a' })).toBe(pending);
    const running = [card({ fingerprint: 'a', status: 'running' })];
    expect(mergePendingApproval(running, { tool: 't', fingerprint: 'a' })).toBe(running);
  });
});

describe('applyApprovalOutcome', () => {
  it('records success and failure per card, leaving siblings untouched', () => {
    const cards = [card({ fingerprint: 'a' }), card({ fingerprint: 'b' })];
    const ran = applyApprovalOutcome(cards, 'a', 'ran');
    expect(ran[0]).toMatchObject({ status: 'ran' });
    expect(ran[1]).toMatchObject({ status: 'pending' });

    const failed = applyApprovalOutcome(ran, 'b', 'failed', 'Error creating UUID');
    expect(failed[1]).toMatchObject({ status: 'failed', detail: 'Error creating UUID' });
    expect(failed[0]).toMatchObject({ status: 'ran' });
  });
});
