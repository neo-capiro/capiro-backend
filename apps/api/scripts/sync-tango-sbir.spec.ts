import { TangoSbirHttpError } from '../src/external/tango/tango-sbir.client.js';
import {
  SBIR_ENDPOINTS,
  parseArgs,
  runSbirSync,
  type SbirEndpoint,
  type SbirEndpointSummary,
  type SbirSyncDeps,
  type SbirSyncSummary,
} from './sync-tango-sbir.js';

/**
 * P42 part 3 — the SBIR/STTR sync walk.
 *
 * Everything here runs against fakes: no Postgres, no Tango call. That is not
 * a shortcut, it is the only honest option — **nothing has ever called
 * `/api/sbir/`**, so a test that pretended to exercise the provider would be
 * asserting a fiction. What these DO pin is the walk's own behaviour: the
 * request it issues, what it drops and why, what it counts, and how it reports
 * a partial run.
 */

describe('CLI parsing', () => {
  test('dry run is the default, both endpoints, no limit, 7-day overlap', () => {
    const args = parseArgs([]);
    expect(args.commit).toBe(false);
    expect(args.full).toBe(false);
    expect(args.since).toBeNull();
    expect(args.limit).toBeUndefined();
    expect(args.overlapDays).toBe(7);
    expect(args.endpoints).toEqual(['solicitation', 'topic']);
  });

  test('--commit, --full, --limit, --overlap-days', () => {
    const args = parseArgs(['--commit', '--full', '--limit=250', '--overlap-days=3']);
    expect(args.commit).toBe(true);
    expect(args.full).toBe(true);
    expect(args.limit).toBe(250);
    expect(args.overlapDays).toBe(3);
  });

  test('--since accepts only an unambiguous calendar day', () => {
    expect(parseArgs(['--since=2026-08-01']).since).toBe('2026-08-01');
    // A half-parsed date would silently NARROW the window, which is the one
    // failure this script cannot detect afterwards.
    expect(parseArgs(['--since=Aug 1 2026']).since).toBeNull();
    expect(parseArgs(['--since=2026-8-1']).since).toBeNull();
    expect(parseArgs(['--since']).since).toBeNull();
  });

  test('--endpoint selects a subset, and an unrecognised name does NOT fall back to both', () => {
    expect(parseArgs(['--endpoint=topic']).endpoints).toEqual(['topic']);
    // `topics` is the endpoint PATH but not the name here — a real typo, and it
    // must not quietly become a full catalog sync.
    expect(parseArgs(['--endpoint=topics']).endpoints).toEqual([]);
    expect(parseArgs(['--endpoint=nonsense']).endpoints).toEqual([]);
  });

  test('cycles are walked before topics however the flag is written', () => {
    // Not a correctness requirement — there is no FK — but an interrupted run
    // leaves a more useful database with parents present.
    expect(parseArgs(['--endpoint=topic,solicitation']).endpoints).toEqual([
      'solicitation',
      'topic',
    ]);
    expect(SBIR_ENDPOINTS).toEqual(['solicitation', 'topic']);
  });
});

// ── Fakes ────────────────────────────────────────────────────────────────────

function solicitation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    solicitation_id: id,
    solicitation_number: `DoD-SBIR-${id}`,
    title: `Cycle ${id}`,
    program: 'SBIR',
    cycle_name: '26.A',
    year: 2026,
    start_date: '2026-01-06',
    end_date: '2026-02-04',
    out_of_cycle: false,
    activity: 'Open',
    solicitation_status: 'Open',
    sol_download_url: 'https://example.invalid/sol',
    ...overrides,
  };
}

function topic(id: string, overrides: Record<string, unknown> = {}) {
  return {
    topic_id: id,
    topic_number: `A26-${id}`,
    title: `Topic ${id}`,
    agency: 'Department of Defense',
    year: 2026,
    solicitation_number: 'DoD-SBIR-SOL1',
    release_date: '2025-12-04',
    open_date: '2026-01-06',
    close_date: '2026-02-04',
    activity: 'Open',
    solicitation_status: 'Open',
    topic_url: 'https://example.invalid/topic',
    official_solicitation_url: 'https://example.invalid/dsip',
    ...overrides,
  };
}

type Pages = Array<Array<Record<string, unknown>>>;

interface GatewayCall {
  endpoint: SbirEndpoint;
  options: Record<string, unknown>;
}

function fakeGateway(
  pagesByEndpoint: Partial<Record<SbirEndpoint, Pages>>,
  rateByEndpoint: Partial<Record<SbirEndpoint, unknown>> = {},
) {
  const calls: GatewayCall[] = [];
  const pageFor = (endpoint: SbirEndpoint, options: any) => {
    calls.push({ endpoint, options: { ...options } });
    const pages = pagesByEndpoint[endpoint] ?? [];
    const index = (options?.page ?? 1) - 1;
    const items = pages[index] ?? [];
    const hasMore = index + 1 < pages.length;
    return Promise.resolve({
      items,
      totalCount: null,
      nextPage: hasMore ? index + 2 : null,
      rate: (rateByEndpoint[endpoint] as any) ?? null,
    });
  };
  return {
    calls,
    gateway: {
      configured: true,
      listSolicitations: jest.fn((options: any = {}) => pageFor('solicitation', options)),
      listTopics: jest.fn((options: any = {}) => pageFor('topic', options)),
    } as any,
  };
}

/** Upsert stores keyed the way the real unique indexes are: the provider's own id. */
function fakeDeps(
  pagesByEndpoint: Partial<Record<SbirEndpoint, Pages>>,
  highWater: Partial<Record<SbirEndpoint, Date | null>> = {},
  rateByEndpoint: Partial<Record<SbirEndpoint, unknown>> = {},
) {
  const { gateway, calls } = fakeGateway(pagesByEndpoint, rateByEndpoint);
  const solicitations = new Map<string, unknown>();
  const topics = new Map<string, unknown>();
  const sleeps: number[] = [];
  const deps: SbirSyncDeps = {
    gateway,
    upsertSolicitation: jest.fn(async (row: any) => {
      solicitations.set(row.tangoSbirId, row);
    }) as any,
    upsertTopic: jest.fn(async (row: any) => {
      topics.set(row.tangoSbirId, row);
    }) as any,
    highWaterMark: jest.fn(async (endpoint: SbirEndpoint) => highWater[endpoint] ?? null) as any,
    now: () => new Date('2026-08-08T00:00:00.000Z'),
    // Never a real delay: the rate-limit paths wait ~31s in production, and a
    // suite that actually slept would be deleted by the first person it slowed.
    sleep: jest.fn(async (ms: number) => {
      sleeps.push(ms);
    }) as any,
  };
  return { deps, calls, solicitations, topics, sleeps };
}

const byEndpoint = (summary: SbirSyncSummary, e: SbirEndpoint): SbirEndpointSummary =>
  summary.endpoints.find((s) => s.endpoint === e)!;

// ── Posture ──────────────────────────────────────────────────────────────────

describe('write posture', () => {
  test('a dry run writes nothing but still reports what it would have written', async () => {
    const { deps, solicitations, topics } = fakeDeps({
      solicitation: [[solicitation('SOL1')]],
      topic: [[topic('T1'), topic('T2')]],
    });
    const summary = await runSbirSync(deps, { commit: false });

    expect(solicitations.size).toBe(0);
    expect(topics.size).toBe(0);
    expect(byEndpoint(summary, 'solicitation').written).toBe(1);
    expect(byEndpoint(summary, 'topic').written).toBe(2);
    expect(summary.commit).toBe(false);
  });

  test('--commit writes, and the two row types go to their own stores', async () => {
    const { deps, solicitations, topics } = fakeDeps({
      solicitation: [[solicitation('SOL1')]],
      topic: [[topic('T1')]],
    });
    await runSbirSync(deps, { commit: true });

    expect([...solicitations.keys()]).toEqual(['SOL1']);
    expect([...topics.keys()]).toEqual(['T1']);
  });
});

describe('idempotency and replay', () => {
  test('re-running the same page does not duplicate — the provider id is the key', async () => {
    const pages = { solicitation: [[solicitation('SOL1')]], topic: [[topic('T1')]] };
    const { deps, solicitations, topics } = fakeDeps(pages);
    await runSbirSync(deps, { commit: true });
    await runSbirSync(deps, { commit: true });

    expect(solicitations.size).toBe(1);
    expect(topics.size).toBe(1);
  });

  test('the same id arriving twice within one walk collapses to one row', async () => {
    const { deps, topics } = fakeDeps({ topic: [[topic('T1'), topic('T1', { title: 'Revised' })]] });
    const summary = await runSbirSync(deps, { commit: true, endpoints: ['topic'] });

    expect(topics.size).toBe(1);
    expect((topics.get('T1') as any).title).toBe('Revised');
    // Both were processed; the collapse happens at the store, not by skipping.
    expect(byEndpoint(summary, 'topic').processed).toBe(2);
  });
});

describe('identity: neither endpoint may reach for the other key, or for uuid', () => {
  /**
   * The trap this rail is most exposed to. Topics key on `topic_id`,
   * solicitations on `solicitation_id`, and NEITHER is the `uuid` DIBBS uses.
   * A walk that reached for `uuid` would drop every record and still report
   * "complete" — a clean, wrong, green run.
   */
  test('a record carrying only `uuid` is dropped, not stored', async () => {
    const { deps, topics } = fakeDeps({
      topic: [[{ uuid: 'T1', topic_number: 'A26-1' }]],
    });
    const summary = await runSbirSync(deps, { commit: true, endpoints: ['topic'] });

    expect(topics.size).toBe(0);
    expect(byEndpoint(summary, 'topic').droppedNoId).toBe(1);
  });

  test('a cycle carrying the TOPIC id field is dropped', async () => {
    const { deps, solicitations } = fakeDeps({
      solicitation: [[{ topic_id: 'SOL1', solicitation_number: 'N-1' }]],
    });
    const summary = await runSbirSync(deps, { commit: true, endpoints: ['solicitation'] });

    expect(solicitations.size).toBe(0);
    expect(byEndpoint(summary, 'solicitation').droppedNoId).toBe(1);
  });

  test('drop reasons distinguish "no id" from "id but no required field"', async () => {
    const { deps } = fakeDeps({
      solicitation: [
        [
          solicitation('SOL1', { solicitation_id: undefined }), // no id
          solicitation('SOL2', { solicitation_number: undefined }), // id, no join key
          solicitation('SOL3'), // fine
        ],
      ],
    });
    const summary = await runSbirSync(deps, { commit: true, endpoints: ['solicitation'] });
    const s = byEndpoint(summary, 'solicitation');

    expect(s.droppedNoId).toBe(1);
    expect(s.droppedNoRequiredField).toBe(1);
    expect(s.written).toBe(1);
    expect(s.processed).toBe(3);
  });
});

describe('topicsWithNoStatedCycle is a contract signal, not noise', () => {
  test('a topic with no parent is COUNTED and still stored', async () => {
    const { deps, topics } = fakeDeps({
      topic: [[topic('T1', { solicitation_number: undefined }), topic('T2')]],
    });
    const summary = await runSbirSync(deps, { commit: true, endpoints: ['topic'] });

    // Stored, because the column is nullable precisely so this is representable
    // — dropping it would lose a real topic over a secondary field.
    expect(topics.size).toBe(2);
    expect(summary.topicsWithNoStatedCycle).toBe(1);
  });

  test('a cycle can never contribute to the count', async () => {
    const { deps } = fakeDeps({ solicitation: [[solicitation('SOL1')]] });
    const summary = await runSbirSync(deps, { commit: true, endpoints: ['solicitation'] });
    expect(summary.topicsWithNoStatedCycle).toBe(0);
  });

  test('an ORPHAN topic — a parent that was never synced — is stored without complaint', async () => {
    // There is no FK, deliberately: a topic can name a cycle this system never
    // fetched, and a missing parent must not drop a real topic.
    const { deps, topics } = fakeDeps({
      topic: [[topic('T1', { solicitation_number: 'DoD-SBIR-99.Z-NEVER-SYNCED' })]],
    });
    const summary = await runSbirSync(deps, { commit: true, endpoints: ['topic'] });

    expect(topics.size).toBe(1);
    expect(summary.topicsWithNoStatedCycle).toBe(0);
  });
});

describe('the incremental window', () => {
  test('each endpoint sends its OWN documented date-filter spelling', async () => {
    const { deps, calls } = fakeDeps(
      { solicitation: [[solicitation('SOL1')]], topic: [[topic('T1')]] },
      {
        solicitation: new Date('2026-06-01T00:00:00.000Z'),
        topic: new Date('2026-06-01T00:00:00.000Z'),
      },
    );
    await runSbirSync(deps, { commit: false, overlapDays: 0 });

    const cycleCall = calls.find((c) => c.endpoint === 'solicitation')!;
    const topicCall = calls.find((c) => c.endpoint === 'topic')!;
    // A cycle filters on start_date; a topic on release_date. Sending one
    // endpoint's spelling to the other is a 400 at best and a silent full walk
    // at worst.
    expect(cycleCall.options.startDateAfter).toBe('2026-06-01');
    expect(cycleCall.options.releaseDateAfter).toBeUndefined();
    expect(topicCall.options.releaseDateAfter).toBe('2026-06-01');
    expect(topicCall.options.startDateAfter).toBeUndefined();
  });

  test('the window is the high-water mark minus the overlap', async () => {
    const { deps, calls } = fakeDeps({ topic: [[topic('T1')]] }, { topic: new Date('2026-06-10T00:00:00.000Z') });
    await runSbirSync(deps, { commit: false, endpoints: ['topic'], overlapDays: 7 });

    expect(calls[0]!.options.releaseDateAfter).toBe('2026-06-03');
  });

  test('a first run — no stored rows — has no window at all', async () => {
    const { deps, calls } = fakeDeps({ topic: [[topic('T1')]] });
    const summary = await runSbirSync(deps, { commit: false, endpoints: ['topic'] });

    expect(calls[0]!.options.releaseDateAfter).toBeUndefined();
    expect(byEndpoint(summary, 'topic').windowFrom).toBeNull();
  });

  test('--full drops the window even when a high-water mark exists', async () => {
    const { deps, calls } = fakeDeps({ topic: [[topic('T1')]] }, { topic: new Date('2026-06-10T00:00:00.000Z') });
    const summary = await runSbirSync(deps, { commit: false, endpoints: ['topic'], full: true });

    expect(calls[0]!.options.releaseDateAfter).toBeUndefined();
    expect(summary.windowKind).toBe('full');
  });

  test('--since overrides the derived mark', async () => {
    const { deps, calls } = fakeDeps({ topic: [[topic('T1')]] }, { topic: new Date('2026-06-10T00:00:00.000Z') });
    const summary = await runSbirSync(deps, {
      commit: false,
      endpoints: ['topic'],
      since: '2026-01-01',
    });

    expect(calls[0]!.options.releaseDateAfter).toBe('2026-01-01');
    expect(summary.windowKind).toBe('explicit-since');
  });
});

describe('page-complete walking', () => {
  test('walks every page until the provider stops offering one', async () => {
    const { deps } = fakeDeps({
      topic: [[topic('T1')], [topic('T2')], [topic('T3')]],
    });
    const summary = await runSbirSync(deps, { commit: false, endpoints: ['topic'] });
    const t = byEndpoint(summary, 'topic');

    expect(t.pagesRead).toBe(3);
    expect(t.processed).toBe(3);
    expect(t.complete).toBe(true);
    expect(summary.completeness).toBe('complete');
  });

  test('--limit stops early and the run is reported in_progress, not complete', async () => {
    const { deps } = fakeDeps({ topic: [[topic('T1'), topic('T2')], [topic('T3')]] });
    const summary = await runSbirSync(deps, { commit: false, endpoints: ['topic'], limit: 2 });

    expect(byEndpoint(summary, 'topic').complete).toBe(false);
    expect(summary.completeness).toBe('in_progress');
  });

  test('an endpoint the caller did not ask for is never called', async () => {
    const { deps, calls } = fakeDeps({
      solicitation: [[solicitation('SOL1')]],
      topic: [[topic('T1')]],
    });
    await runSbirSync(deps, { commit: false, endpoints: ['topic'] });

    expect(calls.every((c) => c.endpoint === 'topic')).toBe(true);
  });

  test('one endpoint stopping early does not make the other look incomplete', async () => {
    const { deps } = fakeDeps({
      solicitation: [[solicitation('SOL1')]],
      topic: [[topic('T1'), topic('T2')], [topic('T3')]],
    });
    const summary = await runSbirSync(deps, { commit: false, limit: 2 });

    // The cycle walk finished its single page within the cap.
    expect(byEndpoint(summary, 'solicitation').complete).toBe(true);
    expect(byEndpoint(summary, 'topic').complete).toBe(false);
    expect(summary.completeness).toBe('in_progress');
  });
});

describe('rate limiting', () => {
  /**
   * The REAL error class, not a lookalike.
   *
   * `fetchWithRateLimitRetry` tests `error instanceof TangoSbirHttpError`, so a
   * hand-rolled fake with the same `name` and an `isRateLimited` getter would
   * NOT be retried — and the test would pass for the wrong reason, proving the
   * retry path works while never entering it.
   */
  const rateLimitError = (rate: Record<string, unknown> | null) =>
    new TangoSbirHttpError(429, 'Tango SBIR request failed (429)', rate as any);

  test('a 429 is retried, honouring Retry-After, and the walk continues', async () => {
    const { deps, sleeps } = fakeDeps({ topic: [[topic('T1')]] });
    const real = (deps.gateway as any).listTopics;
    let calls = 0;
    (deps.gateway as any).listTopics = jest.fn(async (options: any) => {
      calls += 1;
      if (calls === 1) throw rateLimitError({ retryAfter: 31, resetIn: 60, remaining: 0 });
      return real(options);
    });

    const summary = await runSbirSync(deps, { commit: false, endpoints: ['topic'] });
    const t = byEndpoint(summary, 'topic');

    // Retry-After wins over resetIn: guessing is worse in both directions.
    expect(sleeps).toContain(31_000);
    expect(t.rateLimitRetries).toBe(1);
    expect(t.complete).toBe(true);
    expect(t.processed).toBe(1);
  });

  test('falls back to resetIn when Retry-After is absent', async () => {
    const { deps, sleeps } = fakeDeps({ topic: [[topic('T1')]] });
    const real = (deps.gateway as any).listTopics;
    let calls = 0;
    (deps.gateway as any).listTopics = jest.fn(async (options: any) => {
      calls += 1;
      if (calls === 1) throw rateLimitError({ retryAfter: null, resetIn: 45, remaining: 0 });
      return real(options);
    });

    await runSbirSync(deps, { commit: false, endpoints: ['topic'] });
    expect(sleeps).toContain(45_000);
  });

  test('a rate limit that outlasts every retry stops ONE endpoint, never the run', async () => {
    const { deps } = fakeDeps({
      solicitation: [[solicitation('SOL1')]],
      topic: [[topic('T1')]],
    });
    (deps.gateway as any).listTopics = jest.fn(async () => {
      throw rateLimitError({ retryAfter: 1, resetIn: 1, remaining: 0 });
    });

    const summary = await runSbirSync(deps, { commit: false, maxRateLimitRetries: 2 });

    // The cycle walk still completed. Killing it too would turn one throttled
    // walk into two unsynced datasets.
    expect(byEndpoint(summary, 'solicitation').complete).toBe(true);
    expect(byEndpoint(summary, 'topic').rateLimited).toBe(true);
    expect(byEndpoint(summary, 'topic').complete).toBe(false);
    // Surfaced at run level too: `completeness` alone cannot tell "capped by
    // --limit, as instructed" apart from "the provider throttled us".
    expect(summary.rateLimited).toBe(true);
    expect(summary.completeness).toBe('in_progress');
  });

  test('a page reporting remaining: 0 pauses BEFORE the next request', async () => {
    // Waiting for the 429 works, but spends a request to learn what the previous
    // response already said.
    const { deps, sleeps } = fakeDeps(
      { topic: [[topic('T1')], [topic('T2')]] },
      {},
      { topic: { remaining: 0, limit: 25, resetIn: 31, retryAfter: null, limitType: null } },
    );
    const summary = await runSbirSync(deps, { commit: false, endpoints: ['topic'] });

    expect(sleeps).toContain(31_000);
    expect(byEndpoint(summary, 'topic').throttleWaits).toBeGreaterThan(0);
  });

  test('a non-rate-limit failure is NOT swallowed as a throttle', async () => {
    const { deps } = fakeDeps({ topic: [[topic('T1')]] });
    (deps.gateway as any).listTopics = jest.fn(async () => {
      throw new Error('boom');
    });

    await expect(runSbirSync(deps, { commit: false, endpoints: ['topic'] })).rejects.toThrow('boom');
  });
});

describe('what the summary reports', () => {
  test('windowKind, completeness and rateLimited are all stated, never inferred by a reader', async () => {
    const { deps } = fakeDeps({ solicitation: [[solicitation('SOL1')]], topic: [[topic('T1')]] });
    const summary = await runSbirSync(deps, { commit: true });

    expect(summary.windowKind).toBe('derived-high-water');
    expect(summary.completeness).toBe('complete');
    expect(summary.rateLimited).toBe(false);
    // Per endpoint, never pooled: a pooled drop count cannot say WHICH
    // endpoint's contract drifted, which is the only thing the number is for.
    expect(summary.endpoints.map((e) => e.endpoint)).toEqual(['solicitation', 'topic']);
  });

  test('an errored upsert is not counted as written', async () => {
    const { deps } = fakeDeps({ topic: [[topic('T1')]] });
    (deps as any).upsertTopic = jest.fn(async () => {
      throw new Error('constraint violation');
    });
    const summary = await runSbirSync(deps, { commit: true, endpoints: ['topic'] });
    const t = byEndpoint(summary, 'topic');

    expect(t.errored).toBe(1);
    expect(t.written).toBe(0);
  });
});
