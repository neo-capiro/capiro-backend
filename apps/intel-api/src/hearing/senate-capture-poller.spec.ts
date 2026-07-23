import {
  candidateProbeUrls,
  decideProbeAction,
  DEFAULT_PROBE_WINDOW,
  normalizeCommitteeName,
  titleIndicatesCanceled,
  type CaptureRowLike,
} from './senate-capture-poller.js';

describe('normalizeCommitteeName', () => {
  it('lowercases, expands &, and collapses punctuation', () => {
    expect(normalizeCommitteeName('Homeland Security & Governmental Affairs')).toBe(
      'homeland security and governmental affairs',
    );
    expect(normalizeCommitteeName(null)).toBe('');
  });
});

describe('titleIndicatesCanceled', () => {
  it('detects the sync-hearings status prefix, both spellings', () => {
    expect(titleIndicatesCanceled('[Postponed] Nomination of ...')).toBe(true);
    expect(titleIndicatesCanceled('[Cancelled] Markup')).toBe(true);
    expect(titleIndicatesCanceled('[Canceled] Markup')).toBe(true);
    expect(titleIndicatesCanceled('[Rescheduled] Hearing')).toBe(true);
    expect(titleIndicatesCanceled('An ordinary hearing title')).toBe(false);
    expect(titleIndicatesCanceled(null)).toBe(false);
  });
});

describe('candidateProbeUrls', () => {
  it('leads with the primary streamId master.m3u8, then fallbacks, de-duped', () => {
    const urls = candidateProbeUrls('govtaff', 'govtaff072926');
    expect(urls[0]).toBe(
      'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036792/govtaff/govtaff072926/master.m3u8',
    );
    // msl3archive fallback uses the committee's msl3 LABEL (govtaff → hsgac).
    expect(urls.some((u) => u.includes('msl3archive') && u.includes('/hsgac/'))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length); // de-duped
  });

  it('still yields fallback probes for a committee with no known streamId', () => {
    const urls = candidateProbeUrls('notacommittee', 'nope073126');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('https://'))).toBe(true);
  });
});

describe('decideProbeAction', () => {
  const now = new Date('2026-07-29T15:00:00Z');
  const row = (over: Partial<CaptureRowLike>): CaptureRowLike => ({
    status: 'discovered',
    scheduledAt: null,
    pollCount: 0,
    ...over,
  });

  it('is terminal for non-active statuses', () => {
    for (const status of ['live', 'capturing', 'ended', 'failed', 'skipped']) {
      expect(decideProbeAction(row({ status }), now, DEFAULT_PROBE_WINDOW)).toBe('terminal');
    }
  });

  it('probes a null-scheduledAt active row', () => {
    expect(decideProbeAction(row({ scheduledAt: null }), now, DEFAULT_PROBE_WINDOW)).toBe('probe');
  });

  it('waits before the lead window opens', () => {
    const start = new Date(now.getTime() + 60 * 60_000); // starts in 1h
    expect(decideProbeAction(row({ scheduledAt: start }), now, DEFAULT_PROBE_WINDOW)).toBe('wait');
  });

  it('probes inside the window', () => {
    const start = new Date(now.getTime() - 5 * 60_000); // started 5 min ago
    expect(decideProbeAction(row({ scheduledAt: start }), now, DEFAULT_PROBE_WINDOW)).toBe('probe');
  });

  it('skips a no-show past the pending window or the poll cap', () => {
    const old = new Date(now.getTime() - 5 * 60 * 60_000); // 5h ago > 3h window
    expect(decideProbeAction(row({ scheduledAt: old }), now, DEFAULT_PROBE_WINDOW)).toBe(
      'skip-stale',
    );
    expect(
      decideProbeAction(
        row({ scheduledAt: null, pollCount: DEFAULT_PROBE_WINDOW.maxPollCount }),
        now,
        DEFAULT_PROBE_WINDOW,
      ),
    ).toBe('skip-stale');
  });
});
