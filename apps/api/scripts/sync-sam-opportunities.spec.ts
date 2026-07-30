import { describe, expect, test } from '@jest/globals';
import {
  buildSamSearchParams,
  defaultLookbackDaysForScope,
  parseCliDate,
  parseSamSyncArgs,
  recordInSamScope,
  resolveSamWindow,
  syncSourceForScope,
} from './sync-sam-opportunities.js';

describe('SAM opportunity ingestion scope', () => {
  test('defaults to the existing DoD scope for backward compatibility', () => {
    expect(parseSamSyncArgs(['--commit'])).toEqual({
      scope: 'dod',
      commit: true,
      backfill: false,
      matchOnly: false,
      since: null,
      postedTo: null,
    });
    expect(syncSourceForScope('dod')).toBe('sync-sam-opportunities');
    expect(defaultLookbackDaysForScope('dod')).toBe(30);
  });

  test('all-federal scope uses an independent watermark and short cold-start window', () => {
    expect(
      parseSamSyncArgs([
        '--all-federal',
        '--backfill',
        '--since=2026-07-01',
        '--posted-to',
        '2026-07-07',
      ]),
    ).toEqual({
      scope: 'all_federal',
      commit: false,
      backfill: true,
      matchOnly: false,
      since: '2026-07-01',
      postedTo: '2026-07-07',
    });
    expect(syncSourceForScope('all_federal')).toBe('sync-sam-opportunities-all-federal');
    expect(defaultLookbackDaysForScope('all_federal')).toBe(2);
  });

  test('DoD search sends the department filter, all-federal does not', () => {
    const common = {
      apiKey: 'test-key',
      postedFrom: '07/01/2026',
      postedTo: '07/02/2026',
      offset: 0,
    };
    expect(buildSamSearchParams({ ...common, scope: 'dod' }).get('deptname')).toBe(
      'DEPARTMENT OF DEFENSE',
    );
    expect(buildSamSearchParams({ ...common, scope: 'all_federal' }).has('deptname')).toBe(false);
  });

  test('client-side scope guard retains only DoD records in DoD mode', () => {
    const dod = { fullParentPathName: 'DEPT OF DEFENSE.DEPT OF THE ARMY.ACC' };
    const hhs = { fullParentPathName: 'DEPARTMENT OF HEALTH AND HUMAN SERVICES.CDC' };
    expect(recordInSamScope(dod, 'dod')).toBe(true);
    expect(recordInSamScope(hhs, 'dod')).toBe(false);
    expect(recordInSamScope(dod, 'all_federal')).toBe(true);
    expect(recordInSamScope(hhs, 'all_federal')).toBe(true);
  });
});

// ── §3: ingestion safety ────────────────────────────────────────────────────

describe('a backfill writes to its own ledger source', () => {
  test('daily and backfill sources are distinct, per scope', () => {
    // A successful backfill used to close a SyncRun under the DAILY source, and
    // runWithSyncRun derives the incremental window from the last successful run's
    // `startedAt` — which for a backfill is *now*. So the next daily run's window
    // began when the backfill started, and every notice posted between the previous
    // daily and that instant was skipped permanently. Nothing revisits a passed
    // window.
    expect(syncSourceForScope('dod', false)).toBe('sync-sam-opportunities');
    expect(syncSourceForScope('dod', true)).toBe('sync-sam-opportunities-backfill');
    expect(syncSourceForScope('all_federal', false)).toBe('sync-sam-opportunities-all-federal');
    expect(syncSourceForScope('all_federal', true)).toBe(
      'sync-sam-opportunities-all-federal-backfill',
    );
  });

  test('all four sources are pairwise distinct — DoD and all-federal keep separate watermarks', () => {
    const sources = [
      syncSourceForScope('dod', false),
      syncSourceForScope('dod', true),
      syncSourceForScope('all_federal', false),
      syncSourceForScope('all_federal', true),
    ];
    expect(new Set(sources).size).toBe(4);
  });

  test('the default (no argument) stays the daily source, so existing schedules are unchanged', () => {
    expect(syncSourceForScope('dod')).toBe('sync-sam-opportunities');
    expect(syncSourceForScope('all_federal')).toBe('sync-sam-opportunities-all-federal');
  });
});

describe('parseCliDate validates rather than silently substituting', () => {
  test('a valid date parses to UTC midnight', () => {
    expect(parseCliDate('2026-07-01', '--since')?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  test('absent is null, not today', () => {
    expect(parseCliDate(undefined, '--since')).toBeNull();
    expect(parseCliDate('', '--since')).toBeNull();
  });

  test.each(['2026-13-01', '2026-02-30', '07/01/2026', 'yesterday', '2026-7-1', '2026-07-01T00:00:00Z'])(
    '%p is rejected',
    (raw) => {
      // The old `--posted-to` path was `safeDate(x) ?? new Date()`, so a typo turned
      // a bounded historical window into an unbounded one that also moved the
      // watermark. A typo must stop the run, not change what it does.
      expect(() => parseCliDate(raw, '--posted-to')).toThrow();
    },
  );

  test('the error names the flag, so the operator knows which one to fix', () => {
    expect(() => parseCliDate('nope', '--posted-to')).toThrow(/--posted-to/);
    expect(() => parseCliDate('nope', '--since')).toThrow(/--since/);
  });
});

describe('resolveSamWindow', () => {
  const base = { scope: 'dod' as const, commit: true, matchOnly: false };

  test('a daily run needs no explicit window', () => {
    expect(
      resolveSamWindow({ ...base, backfill: false, since: null, postedTo: null }),
    ).toEqual({ since: null, postedTo: null });
  });

  test('a backfill REQUIRES an explicit --since', () => {
    // `--backfill` alone fell through to the watermark or the default lookback, so a
    // command whose whole purpose is "ingest this specific past year" quietly
    // ingested the last two days and reported success.
    expect(() =>
      resolveSamWindow({ ...base, backfill: true, since: null, postedTo: '2026-07-07' }),
    ).toThrow(/--backfill requires an explicit --since/);
  });

  test('a backfill REQUIRES an explicit --posted-to', () => {
    expect(() =>
      resolveSamWindow({ ...base, backfill: true, since: '2026-07-01', postedTo: null }),
    ).toThrow(/--backfill requires an explicit --posted-to/);
  });

  test('a bounded backfill window is accepted', () => {
    const window = resolveSamWindow({
      ...base,
      backfill: true,
      since: '2024-07-01',
      postedTo: '2025-06-30',
    });
    expect(window.since?.toISOString().slice(0, 10)).toBe('2024-07-01');
    expect(window.postedTo?.toISOString().slice(0, 10)).toBe('2025-06-30');
  });

  test('an inverted window is refused, not silently emptied', () => {
    expect(() =>
      resolveSamWindow({ ...base, backfill: true, since: '2025-06-30', postedTo: '2024-07-01' }),
    ).toThrow(/is after/);
  });

  test('an invalid date in a backfill fails before any network or ledger work', () => {
    expect(() =>
      resolveSamWindow({ ...base, backfill: true, since: '2024-02-30', postedTo: '2025-06-30' }),
    ).toThrow(/not a real calendar date/);
  });
});
