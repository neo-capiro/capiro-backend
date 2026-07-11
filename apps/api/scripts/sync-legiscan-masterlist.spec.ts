import { diffMasterlist } from './sync-legiscan-masterlist.js';

/**
 * REGRESSION (2026-07-10 hot-fix, W1.2 item 5): the priority and wide-sweep
 * masterlist schedules previously shared the bare 'sync-legiscan-masterlist'
 * SyncRun source, so a slow run on one schedule could make the other's
 * skipIfRunning guard falsely no-op, and per-schedule health was
 * indistinguishable in diag-ingestion-health. LEGISCAN_MASTERLIST_SOURCE_SUFFIX
 * gives each schedule its own source.
 */
describe('SYNC_RUN_SOURCE (LEGISCAN_MASTERLIST_SOURCE_SUFFIX)', () => {
  afterEach(() => {
    delete process.env.LEGISCAN_MASTERLIST_SOURCE_SUFFIX;
    jest.resetModules();
  });

  it('defaults to the bare source when no suffix env var is set', async () => {
    delete process.env.LEGISCAN_MASTERLIST_SOURCE_SUFFIX;
    process.env.LEGISCAN_API_KEY = 'test-key';
    jest.resetModules();
    const mod = await import('./sync-legiscan-masterlist.js');
    expect(mod.SYNC_RUN_SOURCE).toBe('sync-legiscan-masterlist');
  });

  it('appends the suffix to distinguish the priority schedule', async () => {
    process.env.LEGISCAN_MASTERLIST_SOURCE_SUFFIX = 'priority';
    process.env.LEGISCAN_API_KEY = 'test-key';
    jest.resetModules();
    const mod = await import('./sync-legiscan-masterlist.js');
    expect(mod.SYNC_RUN_SOURCE).toBe('sync-legiscan-masterlist-priority');
  });

  it('appends a different suffix to distinguish the wide schedule (the two are NEVER equal)', async () => {
    process.env.LEGISCAN_MASTERLIST_SOURCE_SUFFIX = 'wide';
    process.env.LEGISCAN_API_KEY = 'test-key';
    jest.resetModules();
    const modWide = await import('./sync-legiscan-masterlist.js');
    expect(modWide.SYNC_RUN_SOURCE).toBe('sync-legiscan-masterlist-wide');
    expect(modWide.SYNC_RUN_SOURCE).not.toBe('sync-legiscan-masterlist-priority');
  });
});

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
