import { describe, expect, jest, test } from '@jest/globals';
import {
  buildSamSearchParams,
  collectSamWindowRecords,
  defaultLookbackDaysForScope,
  descriptionForMatching,
  fetchPage,
  parseCliDate,
  parseSamSyncArgs,
  persistMatches,
  recordInSamScope,
  resolveSamDescription,
  resolveSamWindow,
  splitSamWindow,
  syncSourceForScope,
  type SamFetchPage,
  type SamOpportunityRecord,
} from './sync-sam-opportunities.js';
import { matchOpportunity, trigrams, type AliasForMatch } from './sam-opportunity-matcher.js';

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

// ── Phase F complete-window + network safety ───────────────────────────────

const DOD_PATH = 'DEPT OF DEFENSE.DEPT OF THE ARMY.ACC-APG';

function record(noticeId: string, description?: string): SamOpportunityRecord {
  return {
    noticeId,
    title: `Opportunity ${noticeId}`,
    fullParentPathName: DOD_PATH,
    description,
  };
}

function samWindow(from: string, to: string) {
  return {
    postedFrom: new Date(`${from}T00:00:00.000Z`),
    postedTo: new Date(`${to}T00:00:00.000Z`),
  };
}

describe('SAM date-window completeness', () => {
  test('splitSamWindow produces two smaller non-overlapping UTC windows', () => {
    const [left, right] = splitSamWindow(samWindow('2026-07-01', '2026-07-04'));
    expect(left).toEqual(samWindow('2026-07-01', '2026-07-02'));
    expect(right).toEqual(samWindow('2026-07-03', '2026-07-04'));
  });

  test('historical backfills use a separate SyncRun source and cannot advance the daily watermark', () => {
    expect(syncSourceForScope('dod', false)).toBe('sync-sam-opportunities');
    expect(syncSourceForScope('dod', true)).toBe('sync-sam-opportunities-backfill');
    expect(syncSourceForScope('all_federal', true)).toBe(
      'sync-sam-opportunities-all-federal-backfill',
    );
  });

  test('search failures redact the SAM API key from thrown errors', async () => {
    const fetchImpl = jest.fn<typeof fetch>(async () => {
      throw new Error('runtime-secret network failure');
    });

    await expect(
      fetchPage('runtime-secret', '07/01/2026', '07/01/2026', 0, 100, fetchImpl, 5),
    ).rejects.toThrow('SAM.gov request failed: [REDACTED] network failure');
  });

  test('5,001 rows split into multiple windows and all unique rows are returned', async () => {
    const fetcher: SamFetchPage = jest.fn(
      async (_key: string, from: string, to: string, offset: number, limit: number) => {
        if (from === '07/01/2026' && to === '07/04/2026') {
          return { totalRecords: 5001, opportunitiesData: [] };
        }
        const left = from === '07/01/2026';
        const total = left ? 2500 : 2501;
        const prefix = left ? 'L' : 'R';
        const end = Math.min(total, offset + limit);
        return {
          totalRecords: total,
          opportunitiesData: Array.from({ length: Math.max(0, end - offset) }, (_, index) =>
            record(`${prefix}-${offset + index}`),
          ),
        };
      },
    );

    const result = await collectSamWindowRecords('secret', samWindow('2026-07-01', '2026-07-04'), {
      fetchPage: fetcher,
    });

    expect(result.complete).toBe(true);
    expect(result.records).toHaveLength(5001);
    expect(result.reportedTotal).toBe(5001);
    expect(result.leafWindows).toBe(2);
    expect(result.duplicateNoticeCount).toBe(0);
  });

  test('a window exactly at capacity does not split', async () => {
    const fetcher: SamFetchPage = jest.fn(
      async (_key: string, _from: string, _to: string, offset: number, limit: number) => ({
        totalRecords: 4,
        opportunitiesData: Array.from(
          { length: Math.max(0, Math.min(4, offset + limit) - offset) },
          (_, i) => record(`N-${offset + i}`),
        ),
      }),
    );

    const result = await collectSamWindowRecords('secret', samWindow('2026-07-01', '2026-07-01'), {
      fetchPage: fetcher,
      pageLimit: 2,
      maxPages: 2,
    });

    expect(result.complete).toBe(true);
    expect(result.records).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('a single UTC day above capacity is processed but returned partial', async () => {
    const fetcher: SamFetchPage = jest.fn(
      async (_key: string, _from: string, _to: string, offset: number, limit: number) => ({
        totalRecords: 5,
        opportunitiesData: Array.from(
          { length: Math.max(0, Math.min(4, offset + limit) - offset) },
          (_, i) => record(`N-${offset + i}`),
        ),
      }),
    );

    const result = await collectSamWindowRecords('secret', samWindow('2026-07-01', '2026-07-01'), {
      fetchPage: fetcher,
      pageLimit: 2,
      maxPages: 2,
    });

    expect(result.records).toHaveLength(4);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toContain('07/01/2026');
    expect(result.incompleteReason).toContain('reported 5 records');
    expect(result.incompleteReason).toContain('processed 4');
  });

  test('a notice repeated on split boundaries is written once', async () => {
    const fetcher: SamFetchPage = jest.fn(async (_key, from, to) => {
      if (from === '07/01/2026' && to === '07/02/2026') {
        return { totalRecords: 5, opportunitiesData: [] };
      }
      return from === '07/01/2026'
        ? { totalRecords: 2, opportunitiesData: [record('LEFT'), record('DUP')] }
        : { totalRecords: 2, opportunitiesData: [record('DUP'), record('RIGHT')] };
    });

    const result = await collectSamWindowRecords('secret', samWindow('2026-07-01', '2026-07-02'), {
      fetchPage: fetcher,
      pageLimit: 2,
      maxPages: 2,
    });

    expect(result.records.map((row) => row.noticeId)).toEqual(['LEFT', 'DUP', 'RIGHT']);
    expect(result.duplicateNoticeCount).toBe(1);
  });
});

describe('SAM description resolution', () => {
  test('null and inline text do not make a network call', async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    await expect(resolveSamDescription(null, 'secret', { fetchImpl })).resolves.toEqual({
      text: null,
      sourceUrl: null,
    });
    await expect(
      resolveSamDescription('plain notice text', 'secret', { fetchImpl }),
    ).resolves.toEqual({
      text: 'plain notice text',
      sourceUrl: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('fetches a SAM.gov HTML description, strips markup, and never exposes the API key', async () => {
    const fetchImpl = jest.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('api.sam.gov');
      expect(url.searchParams.get('api_key')).toBe('top-secret');
      return new Response('<h1>Program Element 0603270A</h1><p>Ground robotics.</p>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    const result = await resolveSamDescription(
      'https://api.sam.gov/opportunities/v1/noticedesc?noticeid=abc',
      'top-secret',
      { fetchImpl },
    );

    expect(result.text).toBe('Program Element 0603270A Ground robotics.');
    expect(result.sourceUrl).toBe('https://api.sam.gov/opportunities/v1/noticedesc?noticeid=abc');
    expect(JSON.stringify(result)).not.toContain('top-secret');
  });

  test('strips API keys and URL credentials from persisted source metadata', async () => {
    const fetchImpl = jest.fn<typeof fetch>(async () => new Response('description'));
    const result = await resolveSamDescription(
      'https://user:password@api.sam.gov/description?id=x&API_KEY=embedded-secret',
      'runtime-secret',
      { fetchImpl },
    ).catch((error: unknown) => error);
    expect(String(result)).not.toContain('embedded-secret');
    expect(String(result)).not.toContain('password');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('rejects insecure, private, non-SAM, and unsupported URLs before fetching', async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    await expect(
      resolveSamDescription('http://api.sam.gov/0603270A', 'secret', { fetchImpl }),
    ).rejects.toThrow(/protocol is not allowed/i);
    await expect(
      resolveSamDescription('https://127.0.0.1/0603270A', 'secret', { fetchImpl }),
    ).rejects.toThrow(/private or loopback/i);
    await expect(
      resolveSamDescription('https://example.com/0603270A', 'secret', { fetchImpl }),
    ).rejects.toThrow(/host is not allowed/i);
    await expect(
      resolveSamDescription('file://sam.gov/tmp/0603270A', 'secret', { fetchImpl }),
    ).rejects.toThrow(/protocol is not allowed/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('times out and redacts the API key from the thrown error', async () => {
    const fetchImpl = jest.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('top-secret aborted')));
        }),
    );

    await expect(
      resolveSamDescription('https://api.sam.gov/opportunities/v1/noticedesc?id=x', 'top-secret', {
        fetchImpl,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/\[REDACTED\] aborted/);
  });

  test('rejects an oversized body', async () => {
    const fetchImpl = jest.fn<typeof fetch>(
      async () =>
        new Response('01234567890', {
          status: 200,
          headers: { 'content-type': 'text/plain', 'content-length': '11' },
        }),
    );
    await expect(
      resolveSamDescription('https://sam.gov/description/abc', 'secret', {
        fetchImpl,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/exceeded 10 bytes/);
  });

  test('a URL containing a PE-shaped string is never scanned as notice text', () => {
    const known = new Set(['0603270A']);
    const matches = matchOpportunity(
      {
        title: 'Generic notice',
        description: descriptionForMatching(
          'https://api.sam.gov/opportunities/v1/noticedesc/0603270A',
        ),
        office: null,
        pscCode: null,
        naicsCode: null,
      },
      known,
      [],
    );
    expect(matches).toEqual([]);
  });
});

describe('SAM opportunity match persistence', () => {
  type Stored = {
    id: string;
    opportunityId: string;
    programId: string | null;
    peCode: string | null;
    matchBasis: string;
    confidence: number;
    reviewStatus: string;
  };

  function client(rows: Stored[]) {
    const update = jest.fn(async ({ where, data }: any) => {
      const row = rows.find((item) => item.id === where.id)!;
      Object.assign(row, data);
      return row;
    });
    const create = jest.fn(async ({ data }: any) => {
      const row = { id: `m-${rows.length + 1}`, ...data } as Stored;
      rows.push(row);
      return row;
    });
    const findFirst = jest.fn(
      async ({ where }: any) =>
        rows.find(
          (row) =>
            row.opportunityId === where.opportunityId &&
            row.programId === where.programId &&
            row.peCode === where.peCode,
        ) ?? null,
    );
    return {
      delegate: { samOpportunityMatch: { findFirst, update, create } },
      findFirst,
      update,
      create,
    };
  }

  test('a human-rejected match is never overwritten by a machine rerun', async () => {
    const rows: Stored[] = [
      {
        id: 'm-1',
        opportunityId: 'o-1',
        programId: null,
        peCode: '0603270A',
        matchBasis: 'description_pe_code',
        confidence: 0.2,
        reviewStatus: 'rejected',
      },
    ];
    const mock = client(rows);
    const written = await persistMatches(mock.delegate as never, 'o-1', [
      {
        programId: null,
        peCode: '0603270A',
        matchBasis: 'description_pe_code',
        confidence: 0.95,
        reviewStatus: 'accepted',
      },
    ]);
    expect(written).toBe(0);
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
    expect(rows[0]?.reviewStatus).toBe('rejected');
  });

  test('a human-accepted match is never modified by a machine rerun', async () => {
    const rows: Stored[] = [
      {
        id: 'm-1',
        opportunityId: 'o-1',
        programId: null,
        peCode: '0603270A',
        matchBasis: 'description_pe_code',
        confidence: 0.9,
        reviewStatus: 'accepted',
      },
    ];
    const mock = client(rows);
    const written = await persistMatches(mock.delegate as never, 'o-1', [
      {
        programId: null,
        peCode: '0603270A',
        matchBasis: 'description_pe_code',
        confidence: 0.99,
        reviewStatus: 'accepted',
      },
    ]);
    expect(written).toBe(0);
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
    expect(rows[0]?.confidence).toBe(0.9);
  });

  test('same-basis machine replay refreshes confidence without changing review status', async () => {
    const rows: Stored[] = [
      {
        id: 'm-1',
        opportunityId: 'o-1',
        programId: 'p-1',
        peCode: null,
        matchBasis: 'program_alias',
        confidence: 0.6,
        reviewStatus: 'candidate',
      },
    ];
    const mock = client(rows);
    await persistMatches(mock.delegate as never, 'o-1', [
      {
        programId: 'p-1',
        peCode: null,
        matchBasis: 'program_alias',
        confidence: 0.8,
        reviewStatus: 'candidate',
      },
    ]);
    expect(mock.update).toHaveBeenCalledWith({
      where: { id: 'm-1' },
      data: { confidence: 0.8 },
    });
    expect(rows[0]?.reviewStatus).toBe('candidate');
  });

  test('exact BLIN remains accepted while a fuzzy alias remains candidate', () => {
    const known = new Set(['1242C93000']);
    const alias: AliasForMatch = {
      programId: 'p-1',
      aliasNormalized: 'ADVANCED ELECTRONIC WARFARE SUITE',
      aliasType: 'canonical',
      tg: trigrams('ADVANCED ELECTRONIC WARFARE SUITE'),
      pscHints: new Set(['5865']),
    };
    const exact = matchOpportunity(
      {
        title: 'Solicitation',
        description: 'Funded under BLIN 1242C93000.',
        office: null,
        pscCode: null,
        naicsCode: null,
      },
      known,
      [],
    );
    const fuzzy = matchOpportunity(
      {
        title: 'Advanced Electronic Warfare Suite',
        description: null,
        office: null,
        pscCode: '5865',
        naicsCode: null,
      },
      known,
      [alias],
    );
    expect(exact[0]?.reviewStatus).toBe('accepted');
    expect(fuzzy[0]?.reviewStatus).toBe('candidate');
    expect(fuzzy.some((match) => match.reviewStatus === 'accepted')).toBe(false);
  });
});
