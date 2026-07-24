import { describe, expect, it } from '@jest/globals';
import {
  buildSnapshot,
  isCoalescible,
  COALESCE_WINDOW_MS,
  type SnapshotNodeRow,
  type SnapshotStrategyRow,
} from './versioning.js';

const strategy: SnapshotStrategyRow = {
  id: 's1',
  clientId: 'c1',
  title: 'FY27 plus-up',
  type: 'appropriations',
  goal: 'Secure the plus-up',
  meriContext: null,
  meriSummary: null,
  targetDate: new Date('2027-09-30T00:00:00.000Z'),
  ownerUserId: 'user_a',
  createdByUserId: 'user_a',
  createdAt: new Date('2026-07-01T12:00:00.000Z'),
};

const node: SnapshotNodeRow = {
  id: 'n1',
  kind: 'action',
  subject: 'deliverable',
  title: 'Submit request',
  note: null,
  ownerUserId: 'user_a',
  status: 'draft',
  startsOn: new Date('2027-02-06T00:00:00.000Z'),
  endsOn: null,
  openEnded: false,
  dependsOnIds: ['n0'],
  meriAuthored: false,
  createdByUserId: 'user_a',
  createdAt: new Date('2026-07-01T12:30:00.000Z'),
};

describe('buildSnapshot', () => {
  it('serializes @db.Date fields to YYYY-MM-DD and DateTime to ISO', () => {
    const snap = buildSnapshot(strategy, [node]);
    expect(snap.meta.targetDate).toBe('2027-09-30');
    expect(snap.meta.createdAt).toBe('2026-07-01T12:00:00.000Z');
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0]!.startsOn).toBe('2027-02-06');
    expect(snap.nodes[0]!.endsOn).toBeNull();
    expect(snap.nodes[0]!.title).toBe('Submit request');
    // A2: dependency edges are captured in the snapshot (survive restore).
    expect(snap.nodes[0]!.dependsOnIds).toEqual(['n0']);
  });

  it('null targetDate stays null; empty node list allowed', () => {
    const snap = buildSnapshot({ ...strategy, targetDate: null }, []);
    expect(snap.meta.targetDate).toBeNull();
    expect(snap.nodes).toEqual([]);
  });
});

describe('isCoalescible', () => {
  const nowMs = new Date('2026-07-01T12:02:00.000Z').getTime();
  const base = {
    authorKind: 'person',
    authorUserId: 'user_a',
    restoredFromVersionId: null,
    coalescible: true,
    createdAt: new Date('2026-07-01T12:00:00.000Z'),
  };

  it('folds a same-author person edit inside the window', () => {
    expect(isCoalescible(base, { authorUserId: 'user_a', nowMs })).toBe(true);
  });

  it('never coalesces when there is no prior version', () => {
    expect(isCoalescible(null, { authorUserId: 'user_a', nowMs })).toBe(false);
  });

  it('never coalesces onto a non-coalescible (structural) version', () => {
    expect(isCoalescible({ ...base, coalescible: false }, { authorUserId: 'user_a', nowMs })).toBe(
      false,
    );
  });

  it('never coalesces onto a Meri version', () => {
    expect(isCoalescible({ ...base, authorKind: 'meri' }, { authorUserId: 'user_a', nowMs })).toBe(
      false,
    );
  });

  it('never coalesces onto a restore version', () => {
    expect(
      isCoalescible({ ...base, restoredFromVersionId: 'v0' }, { authorUserId: 'user_a', nowMs }),
    ).toBe(false);
  });

  it('never coalesces across authors', () => {
    expect(isCoalescible(base, { authorUserId: 'user_b', nowMs })).toBe(false);
  });

  it('never coalesces when the incoming author is anonymous', () => {
    expect(isCoalescible(base, { authorUserId: null, nowMs })).toBe(false);
  });

  it('does not coalesce past the window', () => {
    const stale = new Date(base.createdAt.getTime() - COALESCE_WINDOW_MS - 1).toISOString();
    // latest.createdAt older than the window relative to now
    expect(
      isCoalescible({ ...base, createdAt: new Date(nowMs - COALESCE_WINDOW_MS - 1) }, {
        authorUserId: 'user_a',
        nowMs,
      }),
    ).toBe(false);
    expect(stale).toBeTruthy();
  });
});
