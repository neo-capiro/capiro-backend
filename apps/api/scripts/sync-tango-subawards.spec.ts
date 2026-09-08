import type {
  TangoSubawardGateway,
  TangoSubawardListOptions,
} from '../src/external/tango/tango-subaward.types.js';
import { parseArgs, runSubawardSync, type SubawardCheckpoint } from './sync-tango-subawards.js';

function checkpoint(overrides: Partial<SubawardCheckpoint> = {}): SubawardCheckpoint {
  return {
    windowStart: null,
    windowEnd: new Date('2026-08-08T00:00:00.000Z'),
    nextPage: 1,
    completeness: 'complete',
    rowsProcessed: 0n,
    pageSize: 100,
    pageSizeSource: 'run_arg',
    totalReported: null,
    ...overrides,
  };
}

/**
 * Deterministic provider fake with REAL offset-pagination semantics: page N
 * with limit L serves items [(N-1)*L, N*L). This is what makes the no-skip /
 * no-duplicate proofs meaningful — a fake that ignores the request limit
 * cannot detect a walk that changes page size between requests.
 */
function fakeProvider(
  items: Array<Record<string, unknown>>,
  options: { failOnPage?: number; error?: Error } = {},
) {
  const requests: TangoSubawardListOptions[] = [];
  const gateway: TangoSubawardGateway = {
    configured: true,
    listSubawards: async (maybeRequest) => {
      const request = maybeRequest ?? {};
      requests.push({ ...request });
      if (options.failOnPage != null && request.page === options.failOnPage) {
        throw options.error ?? new Error('429');
      }
      const limit = request.limit ?? 100;
      const page = request.page ?? 1;
      const start = (page - 1) * limit;
      const slice = items.slice(start, start + limit);
      const nextPage = start + limit < items.length ? page + 1 : null;
      return {
        items: slice,
        totalCount: items.length,
        nextPage,
        rate: null,
      };
    },
  };
  return { gateway, requests };
}

/** Persists into a Set like the real ON CONFLICT (provider_key) upsert does. */
function recordingDeps(gateway: TangoSubawardGateway, initial: SubawardCheckpoint | null = null) {
  let persisted: SubawardCheckpoint | null = initial;
  const persistedKeys = new Map<string, number>();
  const writes: number[] = [];
  const deps = {
    gateway,
    readCheckpoint: async () => persisted,
    writeCheckpoint: async (
      _key: string,
      next: Omit<SubawardCheckpoint, 'rowsProcessed' | 'totalReported'> & {
        rowsProcessed: number;
        totalReported: number | null;
      },
    ) => {
      writes.push(next.nextPage);
      persisted = {
        ...next,
        rowsProcessed: BigInt(next.rowsProcessed),
        totalReported: next.totalReported == null ? null : BigInt(next.totalReported),
      };
    },
    upsert: async (row: { providerKey: string }) => {
      persistedKeys.set(row.providerKey, (persistedKeys.get(row.providerKey) ?? 0) + 1);
      return 'written' as const;
    },
    now: () => new Date('2026-09-08T00:00:00.000Z'),
  };
  return { deps, writes, persistedKeys, getPersisted: () => persisted };
}

describe('sync-tango-subawards', () => {
  it('is dry-run by default', () => {
    expect(parseArgs([]).commit).toBe(false);
  });

  it('requires an explicit acknowledgement for a first unbounded commit', async () => {
    const gateway: TangoSubawardGateway = {
      configured: true,
      listSubawards: jest.fn(),
    };
    await expect(
      runSubawardSync(
        {
          gateway,
          readCheckpoint: async () => null,
          writeCheckpoint: async () => undefined,
          upsert: async () => 'written',
        },
        parseArgs(['--commit']),
      ),
    ).rejects.toThrow('--allow-full');
    expect(gateway.listSubawards).not.toHaveBeenCalled();
  });

  it('walks every page and writes a complete checkpoint', async () => {
    // Page size 1 makes a 2-item corpus genuinely two pages; the pre-rewrite
    // mock faked nextPage on a 1-item page, which an honest offset provider
    // never reports. The per-page checkpoint cadence is the pinned contract.
    const { gateway } = fakeProvider([{ key: 'a' }, { key: 'b' }]);
    const checkpoints: Array<{ completeness: string; nextPage: number; pageSize: number | null }> =
      [];
    const summary = await runSubawardSync(
      {
        gateway,
        readCheckpoint: async () => checkpoint(),
        writeCheckpoint: async (_key, state) => {
          checkpoints.push({
            completeness: state.completeness,
            nextPage: state.nextPage,
            pageSize: state.pageSize,
          });
        },
        upsert: async () => 'written',
        now: () => new Date('2026-08-09T00:00:00.000Z'),
      },
      parseArgs(['--commit', '--page-size', '1']),
    );
    expect(summary).toMatchObject({
      processed: 2,
      mapped: 2,
      written: 2,
      completeness: 'complete',
    });
    expect(checkpoints).toEqual([
      { completeness: 'in_progress', nextPage: 2, pageSize: 1 },
      { completeness: 'complete', nextPage: 1, pageSize: 1 },
    ]);
  });

  it('does not write rows or checkpoints during a dry run', async () => {
    const writes = jest.fn();
    const upserts = jest.fn();
    const summary = await runSubawardSync(
      {
        gateway: {
          configured: true,
          listSubawards: async () => ({
            items: [{ key: 'a' }],
            totalCount: 1,
            nextPage: null,
            rate: null,
          }),
        },
        readCheckpoint: async () => null,
        writeCheckpoint: writes,
        upsert: upserts,
      },
      parseArgs([]),
    );
    expect(summary).toMatchObject({ mapped: 1, written: 0, commit: false });
    expect(writes).not.toHaveBeenCalled();
    expect(upserts).not.toHaveBeenCalled();
  });
});

describe('stable pagination across bounded runs, changed limits, retries and restarts', () => {
  const items = Array.from({ length: 250 }, (_, i) => ({
    key: `r${String(i + 1).padStart(3, '0')}`,
  }));

  it('a fresh bounded run with limit <= page size requests exactly limit rows and records the walk page size', async () => {
    // Mirrors the live first run: --limit 25 with the default page size 100
    // must issue ONE request of 25 (not 100) and persist pageSize=25 so the
    // resume continues at 25 instead of skipping to item 101.
    const { gateway, requests } = fakeProvider(items);
    const { deps, getPersisted } = recordingDeps(gateway);
    const summary = await runSubawardSync(deps, parseArgs(['--commit', '--limit', '25']));

    expect(requests).toEqual([{ page: 1, limit: 25 }]);
    expect(summary).toMatchObject({
      processed: 25,
      written: 25,
      completeness: 'in_progress',
      nextPage: 2,
      effectivePageSize: 25,
      pageSizeSource: 'run_arg',
    });
    expect(getPersisted()).toMatchObject({
      nextPage: 2,
      completeness: 'in_progress',
      pageSize: 25,
      pageSizeSource: 'run_arg',
      totalReported: 250n,
    });
  });

  it('a larger bounded run resumes the 25-record checkpoint at the persisted page size, not the CLI default', async () => {
    const { gateway, requests } = fakeProvider(items);
    const initial = checkpoint({
      completeness: 'in_progress',
      nextPage: 2,
      rowsProcessed: 25n,
      pageSize: 25,
      pageSizeSource: 'run_arg',
      totalReported: 250n,
      windowEnd: new Date('2026-09-08T03:16:34.000Z'),
    });
    const { deps, getPersisted } = recordingDeps(gateway, initial);
    // The resume asks for a bigger CLI page size; the persisted walk size must win.
    const summary = await runSubawardSync(
      deps,
      parseArgs(['--commit', '--limit', '100', '--page-size', '100']),
    );

    expect(requests[0]).toEqual({ page: 2, limit: 25 });
    expect(summary.effectivePageSize).toBe(25);
    expect(summary.pageSizeSource).toBe('checkpoint');
    expect(summary.requestedPageSizeIgnored).toBe(true);
    expect(getPersisted()?.pageSize).toBe(25);
    // The continuation preserves the establishment provenance, not a new one.
    expect(getPersisted()?.pageSizeSource).toBe('run_arg');
  });

  it('a limit not divisible by the page size processes whole pages without shrinking requests, and the union has no skips or duplicates', async () => {
    const { gateway, requests } = fakeProvider(items);
    const { deps, persistedKeys, getPersisted } = recordingDeps(gateway);
    const first = await runSubawardSync(
      deps,
      parseArgs(['--commit', '--limit', '130', '--page-size', '100']),
    );

    // 130 crosses the page-2 boundary: both requests stay at 100 — the old
    // code shrank page 2 to 30, which silently moved the provider's page
    // boundaries and skipped items on resume.
    expect(requests).toEqual([
      { page: 1, limit: 100 },
      { page: 2, limit: 100 },
    ]);
    expect(first).toMatchObject({
      processed: 200,
      completeness: 'in_progress',
      nextPage: 3,
      effectivePageSize: 100,
    });
    expect(getPersisted()).toMatchObject({ nextPage: 3, pageSize: 100 });

    const { requests: resumeRequests } = { requests };
    const second = await runSubawardSync(deps, parseArgs(['--commit', '--page-size', '100']));
    expect(resumeRequests[2]).toEqual({ page: 3, limit: 100 });
    expect(second).toMatchObject({ processed: 50, completeness: 'complete', nextPage: null });

    // No skipped records and no duplicate persisted identities across both runs.
    expect(persistedKeys.size).toBe(250);
    expect([...persistedKeys.values()].every((n) => n === 1)).toBe(true);
    expect([...persistedKeys.keys()].sort()).toEqual(items.map((item) => String(item.key)).sort());
  });

  it('a legacy in_progress checkpoint without a recorded page size fails closed instead of guessing', async () => {
    // The exact live shape: 25-row first run written by the pre-pagination code,
    // next_page=2, no page size column value. Resuming at the default 100 would
    // skip items 26-100; the sync must refuse rather than assume.
    const legacy = checkpoint({
      completeness: 'in_progress',
      nextPage: 2,
      rowsProcessed: 25n,
      pageSize: null,
      pageSizeSource: null,
      windowEnd: new Date('2026-09-08T03:16:34.000Z'),
    });
    const { gateway, requests } = fakeProvider(items);
    const { deps } = recordingDeps(gateway, legacy);
    await expect(runSubawardSync(deps, parseArgs(['--commit', '--limit', '100']))).rejects.toThrow(
      /--resume-page-size/,
    );
    expect(requests).toEqual([]);
  });

  it('--resume-page-size recovers a legacy checkpoint by persisting the operator-asserted size', async () => {
    const legacy = checkpoint({
      completeness: 'in_progress',
      nextPage: 2,
      rowsProcessed: 25n,
      pageSize: null,
      pageSizeSource: null,
      windowEnd: new Date('2026-09-08T03:16:34.000Z'),
    });
    const { gateway, requests } = fakeProvider(items);
    const { deps, getPersisted } = recordingDeps(gateway, legacy);
    const summary = await runSubawardSync(
      deps,
      parseArgs(['--commit', '--limit', '100', '--resume-page-size', '25']),
    );

    expect(requests[0]).toEqual({ page: 2, limit: 25 });
    expect(summary).toMatchObject({ effectivePageSize: 25, pageSizeSource: 'resume_flag' });
    expect(getPersisted()).toMatchObject({
      pageSize: 25,
      pageSizeSource: 'resume_flag',
      completeness: 'in_progress',
    });
  });

  it('--resume-page-size is rejected when it contradicts a known persisted page size', async () => {
    const known = checkpoint({
      completeness: 'in_progress',
      nextPage: 2,
      pageSize: 25,
      pageSizeSource: 'run_arg',
    });
    const { gateway, requests } = fakeProvider(items);
    const { deps, getPersisted } = recordingDeps(gateway, known);
    await expect(
      runSubawardSync(deps, parseArgs(['--commit', '--resume-page-size', '100'])),
    ).rejects.toThrow(/contradicts/i);
    expect(requests).toEqual([]);
    expect(getPersisted()?.pageSize).toBe(25);
  });

  it('--resume-page-size with no checkpoint, or with a complete checkpoint, is an error', async () => {
    const { gateway } = fakeProvider(items);
    const fresh = recordingDeps(gateway, null);
    await expect(
      runSubawardSync(fresh.deps, parseArgs(['--commit', '--resume-page-size', '25'])),
    ).rejects.toThrow(/requires an in_progress checkpoint.*no checkpoint for this sync key/s);

    const done = recordingDeps(gateway, checkpoint());
    await expect(
      runSubawardSync(done.deps, parseArgs(['--commit', '--resume-page-size', '25'])),
    ).rejects.toThrow(/already complete.*nothing to recover/s);
  });

  it('HTTP 429 after a successful page keeps the checkpoint at the last persisted page and resumes without repeats', async () => {
    const { gateway, requests } = fakeProvider(items, { failOnPage: 2, error: new Error('429') });
    const { deps, persistedKeys, getPersisted } = recordingDeps(gateway);
    await expect(
      runSubawardSync(deps, parseArgs(['--commit', '--allow-full', '--page-size', '100'])),
    ).rejects.toThrow('429');
    // Page 1 succeeded and persisted; the page-2 attempt itself 429'd, which is
    // why the checkpoint must still say page 2.
    expect(requests).toEqual([
      { page: 1, limit: 100 },
      { page: 2, limit: 100 },
    ]);
    expect(getPersisted()).toMatchObject({
      nextPage: 2,
      completeness: 'in_progress',
      pageSize: 100,
    });
    expect(persistedKeys.size).toBe(100);

    // Restart: page 1 is never re-requested; the walk completes from page 2.
    const resumed = fakeProvider(items);
    const {
      deps: resumeDeps,
      persistedKeys: resumeKeys,
      getPersisted: resumedCk,
    } = recordingDeps(resumed.gateway, getPersisted());
    const summary = await runSubawardSync(
      resumeDeps,
      parseArgs(['--commit', '--page-size', '100']),
    );
    expect(resumed.requests[0]).toEqual({ page: 2, limit: 100 });
    expect(summary).toMatchObject({ completeness: 'complete', nextPage: null });
    expect(resumeKeys.size).toBe(150);
    expect(resumedCk()).toMatchObject({ completeness: 'complete', nextPage: 1 });
  });

  it('a mid-page write failure does not advance the checkpoint; the idempotent retry re-processes the page with no duplicate identities', async () => {
    const { gateway } = fakeProvider([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
    let failOnce = true;
    const persistedKeys = new Map<string, number>();
    const checkpoints: number[] = [];
    const deps = {
      gateway,
      readCheckpoint: async () => null as SubawardCheckpoint | null,
      writeCheckpoint: async (_key: string, next: { nextPage: number }) => {
        checkpoints.push(next.nextPage);
      },
      upsert: async (row: { providerKey: string }) => {
        if (failOnce && row.providerKey === 'b') throw new Error('write failed');
        persistedKeys.set(row.providerKey, (persistedKeys.get(row.providerKey) ?? 0) + 1);
        return 'written' as const;
      },
      now: () => new Date('2026-09-08T00:00:00.000Z'),
    };

    await expect(
      runSubawardSync(deps, parseArgs(['--commit', '--allow-full', '--page-size', '100'])),
    ).rejects.toThrow('write failed');
    // The page never reached its checkpoint write — nothing was advanced.
    expect(checkpoints).toEqual([]);

    failOnce = false;
    const summary = await runSubawardSync(
      deps,
      parseArgs(['--commit', '--allow-full', '--page-size', '100']),
    );
    expect(summary).toMatchObject({ written: 3, completeness: 'complete' });
    // 'a' was upserted twice across runs (allowed — idempotent), but every
    // identity persisted exactly once is NOT what the raw insert count shows;
    // what matters is the SET: complete, no key missing, no duplicate identity
    // in the persisted store (the DB's ON CONFLICT would collapse the retry).
    expect([...persistedKeys.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('dry-run previews the resume page at the persisted size and never mutates the checkpoint', async () => {
    const inProgress = checkpoint({
      completeness: 'in_progress',
      nextPage: 2,
      rowsProcessed: 25n,
      pageSize: 25,
      pageSizeSource: 'run_arg',
    });
    const { gateway, requests } = fakeProvider(items);
    const { deps, writes, getPersisted } = recordingDeps(gateway, inProgress);
    const summary = await runSubawardSync(deps, parseArgs(['--limit', '50']));

    expect(requests[0]).toEqual({ page: 2, limit: 25 });
    expect(summary.commit).toBe(false);
    expect(summary.effectivePageSize).toBe(25);
    expect(writes).toEqual([]);
    expect(getPersisted()).toBe(inProgress);
  });

  it('dry-run against a legacy checkpoint also fails closed rather than previewing with a guessed size', async () => {
    const legacy = checkpoint({
      completeness: 'in_progress',
      nextPage: 2,
      pageSize: null,
      pageSizeSource: null,
    });
    const { gateway, requests } = fakeProvider(items);
    const { deps } = recordingDeps(gateway, legacy);
    await expect(runSubawardSync(deps, parseArgs(['--limit', '50']))).rejects.toThrow(
      /--resume-page-size/,
    );
    expect(requests).toEqual([]);
  });

  it('rejects invalid --resume-page-size values', () => {
    expect(() => parseArgs(['--resume-page-size', '0'])).toThrow(/resume-page-size/);
    expect(() => parseArgs(['--resume-page-size', '101'])).toThrow(/resume-page-size/);
    expect(() => parseArgs(['--resume-page-size', 'abc'])).toThrow(/resume-page-size/);
    expect(parseArgs([]).resumePageSize).toBeUndefined();
    expect(parseArgs(['--resume-page-size', '25']).resumePageSize).toBe(25);
  });
});
