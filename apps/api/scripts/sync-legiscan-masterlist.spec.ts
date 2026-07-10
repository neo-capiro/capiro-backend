import { diffMasterlist } from './sync-legiscan-masterlist.js';

describe('diffMasterlist (2026-07-10 hot-fix: un-primed-session guard)', () => {
  it('REGRESSION: a never-backfilled cursor (empty billHashes) with a non-trivial masterlist is flagged unprimed and queues NOTHING', () => {
    const masterlist = [
      { bill_id: 1, change_hash: 'h1' },
      { bill_id: 2, change_hash: 'h2' },
      { bill_id: 3, change_hash: 'h3' },
    ];
    const r = diffMasterlist(masterlist, {}, new Set());
    expect(r.unprimed).toBe(true);
    expect(r.toQueue).toEqual([]);
  });

  it('an empty masterlist against an empty billHashes map is NOT flagged unprimed (nothing to cold-drain)', () => {
    const r = diffMasterlist([], {}, new Set());
    expect(r.unprimed).toBe(false);
    expect(r.toQueue).toEqual([]);
  });

  it('a primed cursor (non-empty billHashes) diffs normally, queuing only changed bills', () => {
    const masterlist = [
      { bill_id: 1, change_hash: 'h1-new' }, // changed
      { bill_id: 2, change_hash: 'h2' }, // unchanged
      { bill_id: 3, change_hash: 'h3-new' }, // changed
    ];
    const billHashes = { '1': 'h1-old', '2': 'h2', '3': 'h3-old' };
    const r = diffMasterlist(masterlist, billHashes, new Set());
    expect(r.unprimed).toBe(false);
    expect(r.toQueue.sort()).toEqual([1, 3]);
  });

  it('a bill already in the pending queue is not re-queued', () => {
    const masterlist = [{ bill_id: 1, change_hash: 'h1-new' }];
    const billHashes = { '1': 'h1-old' };
    const r = diffMasterlist(masterlist, billHashes, new Set([1]));
    expect(r.toQueue).toEqual([]);
  });

  it('a brand-new bill (no prior hash entry) on an ALREADY-PRIMED cursor still queues (primed just means non-empty, not exhaustive)', () => {
    const masterlist = [
      { bill_id: 1, change_hash: 'h1' }, // known, unchanged
      { bill_id: 99, change_hash: 'h99' }, // new bill this session gained
    ];
    const billHashes = { '1': 'h1' };
    const r = diffMasterlist(masterlist, billHashes, new Set());
    expect(r.unprimed).toBe(false);
    expect(r.toQueue).toEqual([99]);
  });
});
