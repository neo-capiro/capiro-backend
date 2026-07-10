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
