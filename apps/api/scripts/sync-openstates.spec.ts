import {
  invertOpenstatesCommittees,
  fetchAllPages,
  resolveSyncStates,
  parseRetryAfterMs,
  classifyOpenstatesRateLimitDetail,
  aggregateStateOutcomes,
  runOpenstatesSync,
  type OpenstatesCommittee,
  type OpenstatesStateOutcome,
} from './sync-openstates';

// Request pacing under test: sync-openstates spaces EVERY request by
// REQUEST_SPACING_MS (6500ms — published default tier is 10/min, so ~9.2
// req/min sustained), and a 429 with no usable Retry-After waits
// NO_HINT_429_WAIT_MS (60000) + jitter (NO_HINT_429_JITTER_MS, <1000) so
// the retry lands in a NEW fixed supplier minute window. random: () => 0
// pins the jitter to zero in every test below.
const SPACING = 6500;
const NO_HINT_WAIT = 60000;
// TRANSIENT_RETRY_EXPONENT_MS: bounded exponential backoff per retry —
// 13000/26000/52000ms for 500/502/503/504 and network transport rejections.
const TRANSIENT_BASE = 13000;

// Fixtures mirror the live OpenStates v3 `/committees?include=memberships`
// shape (verified 2026-07-11 against openapi.json: Committee has no `chamber`
// field; CommitteeMembership.person is an OPTIONAL CompactPerson ref).

function fixtureCommittee(overrides: Partial<OpenstatesCommittee> = {}): OpenstatesCommittee {
  return {
    id: 'ocd-organization/committee-1',
    name: 'Committee on Rules',
    classification: 'committee',
    memberships: [],
    ...overrides,
  };
}

describe('invertOpenstatesCommittees', () => {
  it('links memberships with a resolvable person.id', () => {
    const result = invertOpenstatesCommittees([
      fixtureCommittee({
        name: 'Committee on Rules',
        memberships: [
          { person_name: 'Jane Doe', role: 'Chair', person: { id: 'ocd-person/jane' } },
          { person_name: 'John Smith', role: 'Member', person: { id: 'ocd-person/john' } },
        ],
      }),
    ]);

    expect(result.unlinkedCount).toBe(0);
    expect(result.committeesByPerson.get('ocd-person/jane')).toEqual([
      { name: 'Committee on Rules', role: 'Chair' },
    ]);
    expect(result.committeesByPerson.get('ocd-person/john')).toEqual([
      { name: 'Committee on Rules', role: 'Member' },
    ]);
  });

  it('drops a membership with no resolvable person.id rather than matching by name (PD2)', () => {
    const result = invertOpenstatesCommittees([
      fixtureCommittee({
        memberships: [
          { person_name: 'Vacant Seat / Unresolved', role: 'Member', person: null },
          { person_name: 'No Person Field At All', role: 'Member' },
        ],
      }),
    ]);

    expect(result.unlinkedCount).toBe(2);
    expect(result.committeesByPerson.size).toBe(0);
  });

  it('accumulates multiple committee assignments for the same person', () => {
    const result = invertOpenstatesCommittees([
      fixtureCommittee({
        id: 'ocd-organization/c1',
        name: 'Appropriations',
        memberships: [
          { person_name: 'Jane Doe', role: 'Vice Chair', person: { id: 'ocd-person/jane' } },
        ],
      }),
      fixtureCommittee({
        id: 'ocd-organization/c2',
        name: 'Judiciary',
        classification: 'subcommittee',
        memberships: [
          { person_name: 'Jane Doe', role: 'Member', person: { id: 'ocd-person/jane' } },
        ],
      }),
    ]);

    expect(result.committeesByPerson.get('ocd-person/jane')).toEqual([
      { name: 'Appropriations', role: 'Vice Chair' },
      { name: 'Judiciary', role: 'Member' },
    ]);
  });

  it('treats a missing role as null, matching the state_legislator.committees Json contract', () => {
    const result = invertOpenstatesCommittees([
      fixtureCommittee({
        memberships: [{ person_name: 'Jane Doe', person: { id: 'ocd-person/jane' } }],
      }),
    ]);

    expect(result.committeesByPerson.get('ocd-person/jane')).toEqual([
      { name: 'Committee on Rules', role: null },
    ]);
  });

  it('handles committees with no memberships field and an empty committee list', () => {
    expect(invertOpenstatesCommittees([fixtureCommittee({ memberships: undefined })])).toEqual({
      committeesByPerson: new Map(),
      unlinkedCount: 0,
    });
    expect(invertOpenstatesCommittees([])).toEqual({
      committeesByPerson: new Map(),
      unlinkedCount: 0,
    });
  });

  it('links resolvable and drops unresolvable memberships together, in one committee and across several', () => {
    const result = invertOpenstatesCommittees([
      fixtureCommittee({
        id: 'ocd-organization/c1',
        name: 'Rules',
        memberships: [
          { person_name: 'Jane Doe', role: 'Chair', person: { id: 'ocd-person/jane' } },
          { person_name: 'Vacant Seat', role: 'Member', person: null },
        ],
      }),
      fixtureCommittee({
        id: 'ocd-organization/c2',
        name: 'Finance',
        memberships: [
          { person_name: 'No Person Field', role: 'Member' },
          { person_name: 'John Smith', role: 'Member', person: { id: 'ocd-person/john' } },
        ],
      }),
    ]);

    expect(result.unlinkedCount).toBe(2);
    expect(result.committeesByPerson.get('ocd-person/jane')).toEqual([
      { name: 'Rules', role: 'Chair' },
    ]);
    expect(result.committeesByPerson.get('ocd-person/john')).toEqual([
      { name: 'Finance', role: 'Member' },
    ]);
    expect(result.committeesByPerson.size).toBe(2);
  });
});

function mockOsResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

/** A 429 whose body is unreadable/non-JSON (e.g. an HTML proxy error page). */
function mockOs429WithBrokenBody(headers: Record<string, string> = {}) {
  return {
    status: 429,
    ok: false,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

/** Deterministic sleep recorder — no real timers, no wall-clock dependence. */
function fakeSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
  };
  return { calls, sleep };
}

/** Mocked Prisma client recording stateLegislator upserts (shared by the
 * runtime-level describes — no real DB is ever touched). */
function fakePrisma() {
  const stateLegislatorUpsert = jest.fn().mockResolvedValue({});
  const entityCrosswalkUpsert = jest.fn().mockResolvedValue({});
  return {
    prisma: {
      stateLegislator: { upsert: stateLegislatorUpsert },
      entityCrosswalk: { upsert: entityCrosswalkUpsert },
    },
    stateLegislatorUpsert,
    entityCrosswalkUpsert,
  };
}

describe('fetchAllPages', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('walks every page and reports complete:true on a clean finish', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 2 } }),
      )
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'b' }], pagination: { max_page: 2 } }),
      ) as unknown as typeof fetch;

    const { sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'va' }, 5, {
      sleep,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], complete: true });
  });

  it('paces a multi-page walk under the published default 10/min window', async () => {
    // 4 pages, all 200: every request is preceded by exactly one 6500ms
    // spacing sleep (fetchOS owns pacing now — no separate inter-page
    // delay), so 4 requests cost 26s of spacing < 60s and 4 <= 10: the
    // sustained cadence fits the published default tier window.
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockOsResponse(200, { results: [{ id: 'x' }], pagination: { max_page: 4 } }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
    });
    expect(result.complete).toBe(true);
    expect(result.rows).toHaveLength(4);
    expect(calls).toEqual([SPACING, SPACING, SPACING, SPACING]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(4);
  });

  it('reports complete:false and only the successfully-fetched rows when a later page fails after retries', async () => {
    // PD2: a failed page must never be reported the same way as a legitimate
    // empty/final page — this is exactly the shape that let finding #1
    // (an unconditional state_legislator.committees overwrite on partial data)
    // slip through before this test existed.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 2 } }),
      )
      .mockResolvedValue(mockOsResponse(500, {})) as unknown as typeof fetch;

    const { sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'va' }, 5, {
      sleep,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: false });
  });

  it('reports complete:true on a genuinely empty first page (no error, just nothing there)', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockOsResponse(200, { results: [] })) as unknown as typeof fetch;

    const { sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'va' }, 5, {
      sleep,
    });
    expect(result).toEqual({ rows: [], complete: true });
  });

  it('reports complete:false when the local maxPages ceiling truncates a longer provider tail', async () => {
    // Committee ceiling is 5 pages of 20; a state whose /committees reports
    // max_page 7 must NOT come back complete:true — the two unfetched pages
    // are a truncated tail, not end-of-results.
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockOsResponse(200, { results: [{ id: 'x' }], pagination: { max_page: 7 } }),
      ) as unknown as typeof fetch;

    const { sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 3, {
      sleep,
    });
    expect(result.complete).toBe(false);
    expect(result.rows).toHaveLength(3); // 3 pages fetched, rows preserved
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(3);
  });

  it('reports complete:true when the local ceiling is reached exactly at the provider max_page', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockOsResponse(200, { results: [{ id: 'x' }], pagination: { max_page: 2 } }),
      ) as unknown as typeof fetch;

    const { sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'va' }, 5, {
      sleep,
    });
    expect(result).toEqual({ rows: [{ id: 'x' }, { id: 'x' }], complete: true });
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.parse('Tue, 15 Sep 2026 12:00:00 GMT');

  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('5', now)).toBe(5000);
    expect(parseRetryAfterMs('0', now)).toBe(0);
  });

  it('parses an HTTP-date as a future delta', () => {
    expect(parseRetryAfterMs('Tue, 15 Sep 2026 12:00:10 GMT', now)).toBe(10000);
  });

  it('rejects missing, malformed, negative, and past-date values', () => {
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs('', now)).toBeNull();
    expect(parseRetryAfterMs('soon', now)).toBeNull();
    expect(parseRetryAfterMs('-5', now)).toBeNull();
    expect(parseRetryAfterMs('Tue, 15 Sep 2026 11:59:00 GMT', now)).toBeNull();
  });
});

describe('classifyOpenstatesRateLimitDetail', () => {
  it('recognizes the supplier contract detail for minute/hour/day windows', () => {
    // Exact strings from rate_limiter.py's RateLimitExceeded raises.
    expect(classifyOpenstatesRateLimitDetail({ detail: 'exceeded limit of 10/min: 11' })).toBe(
      'minute',
    );
    expect(classifyOpenstatesRateLimitDetail({ detail: 'exceeded limit of 40/min: 41' })).toBe(
      'minute',
    );
    expect(classifyOpenstatesRateLimitDetail({ detail: 'exceeded limit of 1000/hour: 1001' })).toBe(
      'hour',
    );
    expect(classifyOpenstatesRateLimitDetail({ detail: 'exceeded limit of 250/day: 251' })).toBe(
      'day',
    );
  });

  it('rejects malformed, non-numeric, non-string, and adversarial bodies', () => {
    expect(classifyOpenstatesRateLimitDetail(undefined)).toBeNull();
    expect(classifyOpenstatesRateLimitDetail(null)).toBeNull();
    expect(classifyOpenstatesRateLimitDetail('exceeded limit of 10/min: 11')).toBeNull();
    expect(classifyOpenstatesRateLimitDetail({ detail: 429 })).toBeNull();
    expect(
      classifyOpenstatesRateLimitDetail({ detail: 'exceeded limit of 10/min: many' }),
    ).toBeNull();
    expect(
      classifyOpenstatesRateLimitDetail({ detail: 'exceeded limit of 10/week: 11' }),
    ).toBeNull();
    expect(classifyOpenstatesRateLimitDetail({ detail: 'Rate limit exceeded' })).toBeNull();
    expect(
      classifyOpenstatesRateLimitDetail({ detail: 'exceeded limit of 10/min: 11; DROP TABLE' }),
    ).toBeNull();
    expect(classifyOpenstatesRateLimitDetail({})).toBeNull();
  });
});

describe('fetchAllPages 429 retry semantics', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('honors a Retry-After delta-seconds hint beyond the local backoff ceiling', async () => {
    // Defect #3 probe: a 120s Retry-After used to be clamped to 30s, so the
    // retry landed inside the provider's rate-limit window and was 429'd
    // again, exhausting all retries before the 120s deadline. The valid hint
    // must now be honored in full.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockOsResponse(429, {}, { 'retry-after': '120' }))
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
      now: () => 0,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: true });
    // per-attempt spacing, then the full 120s hint (floored by spacing, which it exceeds).
    expect(calls).toEqual([SPACING, 120000, SPACING]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('succeeds on the next attempt after a 120s Retry-After deadline has actually elapsed', async () => {
    // Full probe shape: the provider keeps answering 429 while the clock is
    // before the deadline and 200 once it passes. With the injected clock the
    // only advance comes from the recorded sleeps, so the sequence proves the
    // retry waits at least as long as the provider required.
    const t0 = Date.parse('Tue, 15 Sep 2026 12:00:00 GMT');
    let clock = t0;
    global.fetch = jest.fn().mockImplementation(async () => {
      if (clock < t0 + 120000) return mockOsResponse(429, {}, { 'retry-after': '120' });
      return mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } });
    }) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const clockedSleep = async (ms: number) => {
      await sleep(ms);
      clock += ms;
    };
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep: clockedSleep,
      now: () => clock,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: true });
    // spacing, one full 120000 wait, spacing — then the successful retry.
    expect(calls).toEqual([SPACING, 120000, SPACING]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
    expect(clock).toBeGreaterThanOrEqual(t0 + 120000);
  });

  it('honors a Retry-After HTTP-date hint and retries to success', async () => {
    const now = Date.parse('Tue, 15 Sep 2026 12:00:00 GMT');
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockOsResponse(429, {}, { 'retry-after': 'Tue, 15 Sep 2026 12:02:00 GMT' }),
      )
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
      now: () => now,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: true });
    // 120s HTTP-date hint honored in full (was previously capped to 30000).
    expect(calls).toEqual([SPACING, 120000, SPACING]);
  });

  it('honors a valid 45s Retry-After as 45s — the 60s no-hint fallback must NOT stretch it', async () => {
    // Review finding: max(60000+jitter, hint) would have turned a valid 45s
    // provider deadline into 60s. The fallback exists only for absent/invalid
    // hints; a valid hint is floored by the normal request spacing alone.
    const t0 = Date.parse('Tue, 15 Sep 2026 12:00:00 GMT');
    let clock = t0;
    global.fetch = jest.fn().mockImplementation(async () => {
      if (clock < t0 + 45000) return mockOsResponse(429, {}, { 'retry-after': '45' });
      return mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } });
    }) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const clockedSleep = async (ms: number) => {
      await sleep(ms);
      clock += ms;
    };
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep: clockedSleep,
      now: () => clock,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: true });
    // spacing, exactly 45000 (not 60000+), spacing — retry lands after the deadline.
    expect(calls).toEqual([SPACING, 45000, SPACING]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
    expect(clock).toBeGreaterThanOrEqual(t0 + 45000);
  });

  it('waits out a full minute window (not 4/8/16s) when a 429 carries no usable hint', async () => {
    // TD6 defect: the old 4/8/16s exponential could burn all retries inside
    // the supplier's FIXED calendar-minute window. The no-hint fallback now
    // waits 60s + jitter so the retry lands in a NEW window.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockOsResponse(429, {})) // no header, no body
      .mockResolvedValueOnce(mockOsResponse(429, {}, { 'retry-after': 'bogus' })) // invalid header
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
      random: () => 0,
    });
    expect(result.complete).toBe(true);
    // spacing, 60s fallback, spacing, 60s fallback (invalid header ignored), spacing.
    expect(calls).toEqual([SPACING, NO_HINT_WAIT, SPACING, NO_HINT_WAIT, SPACING]);
  });

  it('classifies a supplier minute detail and waits out the minute window to success', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockOsResponse(429, { detail: 'exceeded limit of 10/min: 11' }))
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: true });
    expect(calls).toEqual([SPACING, NO_HINT_WAIT, SPACING]);
  });

  it('defers immediately on a supplier hour detail without retrying the known-dead window', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockOsResponse(429, { detail: 'exceeded limit of 1000/hour: 1001' }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [], complete: false });
    // one spacing sleep before the attempt; NO retry wait after the definitive 429.
    expect(calls).toEqual([SPACING]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('defers immediately on a supplier day detail without retrying the known-dead window', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockOsResponse(429, { detail: 'exceeded limit of 250/day: 251' }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [], complete: false });
    expect(calls).toEqual([SPACING]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('treats a malformed/unreadable 429 body as no-hint: no leak, no fabricated success', async () => {
    // An HTML proxy error page or truncated body is NOT a fact about the
    // rate window — the walk falls back to the 60s minute-window wait and
    // the raw text is never logged.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockOs429WithBrokenBody())
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: true });
    expect(calls).toEqual([SPACING, NO_HINT_WAIT, SPACING]);
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).not.toContain('Unexpected token');
      expect(String(call[0])).not.toContain('<');
    }
  });

  it('does NOT sleep after the final exhausted 429 attempt and reports complete:false', async () => {
    // Old defect: on the 4th 429 the loop slept 30s then fell through without
    // the announced retry (logs showed "attempt 4/3"). Now the exhausted
    // attempt returns immediately — no trailing sleep, no phantom retry.
    global.fetch = jest.fn().mockResolvedValue(mockOsResponse(429, {})) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [], complete: false });
    // spacing before each of 4 attempts + 3 minute-window waits; NO trailing sleep.
    expect(calls).toEqual([
      SPACING,
      NO_HINT_WAIT,
      SPACING,
      NO_HINT_WAIT,
      SPACING,
      NO_HINT_WAIT,
      SPACING,
    ]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(4); // 1 initial + 3 retries
  });

  it('keeps rows fetched before a rate-limit wall and reports the walk partial (max-page partial)', async () => {
    // Page 1 succeeds, page 2 hits an unending 429: the walk must stop with
    // complete:false but keep page 1's real rows — a fetch failure is not a
    // fact that the state has only those rows.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 3 } }),
      )
      .mockResolvedValue(mockOsResponse(429, {})) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: false });
    // page-1 spacing, then 4 page-2 attempts each preceded by spacing with
    // 3 minute-window waits between them; no trailing sleep after the final 429.
    expect(calls).toEqual([
      SPACING,
      SPACING,
      NO_HINT_WAIT,
      SPACING,
      NO_HINT_WAIT,
      SPACING,
      NO_HINT_WAIT,
      SPACING,
    ]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(5); // page1 + 4 attempts on page2
  });

  it('defers without retrying on an unschedulable Retry-After instead of overflowing a timer', async () => {
    // setTimeout clamps delays above 2^31-1 ms to 1ms — pretending to wait
    // ~24.8 days would actually retry instantly. The honest behavior is to
    // return partial/defer immediately without sleeping.
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockOsResponse(429, {}, { 'retry-after': '2147483648' }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'md' }, 5, {
      sleep,
      now: () => 0,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [], complete: false });
    expect(calls).toEqual([SPACING]); // only the pre-attempt spacing; no retry attempted
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('logs a controlled HTTP status for non-ok responses (401/403 stay diagnosable, no leak)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockOsResponse(403, { detail: 'Invalid API Key.' }),
      ) as unknown as typeof fetch;

    const { sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/people', { jurisdiction: 'md' }, 5, {
      sleep,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [], complete: false });
    expect(warnSpy).toHaveBeenCalledWith('GET /people: HTTP 403');
    for (const call of warnSpy.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain('Invalid API Key');
      expect(line).not.toContain('apikey');
    }
  });

  it('sanitizes network-error logs: no URL, apikey, or attacker-controlled name/message', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn().mockImplementation(async () => {
      const err = new Error(
        'fetch failed: https://v3.openstates.org/people?apikey=SECRETKEY123&page=1',
      );
      err.name = 'EvilError https://v3.openstates.org/?apikey=SECRETKEY123';
      throw err;
    }) as unknown as typeof fetch;

    const { sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/people', { jurisdiction: 'md' }, 5, {
      sleep,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [], complete: false });
    expect(warnSpy).toHaveBeenCalled();
    for (const call of warnSpy.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain('SECRETKEY123');
      expect(line).not.toContain('apikey');
      expect(line).not.toContain('v3.openstates.org');
      expect(line).not.toContain('EvilError');
      expect(line).not.toContain('fetch failed');
    }
  });
});

describe('fetchAllPages transient server + network retry semantics', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('retries a single 504 on the same page and completes the walk', async () => {
    // OR 2026-09-16 reset run: one HTTP 504 killed the committee walk after
    // page 1 — no retry existed at all. Now one 504 retries the SAME page and
    // the walk finishes complete.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 2 } }),
      )
      .mockResolvedValueOnce(mockOsResponse(504, { detail: 'gateway timeout' }))
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'b' }], pagination: { max_page: 2 } }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'or' }, 25, {
      sleep,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], complete: true });
    // page1 spacing, page2 spacing, 13s backoff, retry spacing.
    expect(calls).toEqual([SPACING, SPACING, TRANSIENT_BASE, SPACING]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(3);
    // Same page retried: pages 1, 2, 2.
    const pages = (global.fetch as jest.Mock).mock.calls.map((c) =>
      new URL(c[0]).searchParams.get('page'),
    );
    expect(pages).toEqual(['1', '2', '2']);
  });

  it.each([502, 503, 504])(
    'retries a single HTTP %s with exponential backoff and completes',
    async (status) => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockOsResponse(status, {}))
        .mockResolvedValueOnce(
          mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } }),
        ) as unknown as typeof fetch;

      const { calls, sleep } = fakeSleep();
      const result = await fetchAllPages<{ id: string }>(
        '/committees',
        { jurisdiction: 'or' },
        25,
        {
          sleep,
          random: () => 0,
        },
      );
      expect(result.complete).toBe(true);
      expect(calls).toEqual([SPACING, TRANSIENT_BASE, SPACING]);
    },
  );

  it('bounds persistent 504 to four attempts, keeps prior rows, and does not sleep after the final failure', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 2 } }),
      )
      .mockResolvedValue(mockOsResponse(504, {})) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'or' }, 25, {
      sleep,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: false });
    // page1 spacing; then 4 page2 attempts each spaced, with 13/26/52s
    // backoffs between; NO sleep after the final 504.
    expect(calls).toEqual([
      SPACING,
      SPACING,
      TRANSIENT_BASE,
      SPACING,
      TRANSIENT_BASE * 2,
      SPACING,
      TRANSIENT_BASE * 4,
      SPACING,
    ]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(5); // page1 + 4 page2 attempts
  });

  it('keeps assignments and prior rows on a bounded persistent-504 walk: existing memberships never overwritten', async () => {
    // The committee walk fails partway (fetchOS exhausted) — runOpenstatesSync
    // must leave existing state_legislator.committees untouched and the run
    // must report truthfully partial.
    const person = { id: 'ocd-person/jane', name: 'Jane Doe' };
    global.fetch = jest
      .fn()
      .mockImplementationOnce(async () =>
        mockOsResponse(200, { results: [person], pagination: { max_page: 1 } }),
      )
      .mockImplementation(async () => mockOsResponse(504, {})) as unknown as typeof fetch;

    const { prisma, stateLegislatorUpsert } = fakePrisma();
    const { sleep } = fakeSleep();
    const counts = await runOpenstatesSync(prisma, ['or'], { sleep, random: () => 0 });

    expect(counts.complete).toBe(false);
    expect(counts.errors).toBe(1);
    expect(stateLegislatorUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = stateLegislatorUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(upsertArg.update).not.toHaveProperty('committees');
  });

  it('retries a network transport failure and recovers; a 200 with malformed JSON is NOT retried as transport', async () => {
    // Network rejection (fetch throws TypeError) recovers on retry with the
    // same bounded backoff. A SUCCESSFUL response whose body fails to parse
    // is not a transport failure — one call, immediate failure, no retry.
    global.fetch = jest
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError('fetch failed: connection reset');
      })
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const recovered = await fetchAllPages<{ id: string }>('/people', { jurisdiction: 'or' }, 25, {
      sleep,
      random: () => 0,
    });
    expect(recovered).toEqual({ rows: [{ id: 'a' }], complete: true });
    expect(calls).toEqual([SPACING, TRANSIENT_BASE, SPACING]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);

    // Malformed JSON on a 200: exactly one call, no retry, complete:false.
    global.fetch = jest.fn().mockImplementation(async () => {
      return {
        status: 200,
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
        headers: { get: () => null },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const malformed = await fetchAllPages<{ id: string }>('/people', { jurisdiction: 'or' }, 25, {
      sleep,
      random: () => 0,
    });
    expect(malformed).toEqual({ rows: [], complete: false });
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('does not retry nontransient 401/403/404/501 — immediate failures', async () => {
    for (const status of [401, 403, 404, 501]) {
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockOsResponse(status, {})) as unknown as typeof fetch;
      const { calls, sleep } = fakeSleep();
      const result = await fetchAllPages<{ id: string }>('/people', { jurisdiction: 'or' }, 25, {
        sleep,
        random: () => 0,
      });
      expect(result).toEqual({ rows: [], complete: false });
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
      expect(calls).toEqual([SPACING]); // only pre-attempt spacing, no backoff
    }
  });

  it('honors a valid 503 Retry-After in full instead of the exponential backoff', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockOsResponse(503, {}, { 'retry-after': '45' }))
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/people', { jurisdiction: 'or' }, 25, {
      sleep,
      now: () => 0,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: true });
    expect(calls).toEqual([SPACING, 45000, SPACING]);
  });

  it('defers an unschedulable 503 Retry-After without a timer-overflow retry', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockOsResponse(503, {}, { 'retry-after': '2147484' }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>('/people', { jurisdiction: 'or' }, 25, {
      sleep,
      now: () => 0,
      random: () => 0,
    });
    expect(result).toEqual({ rows: [], complete: false });
    expect(calls).toEqual([SPACING]); // pre-attempt spacing only; no retry
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });
});

describe('runOpenstatesSync (runtime level, mocked fetch + prisma)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('treats a successful empty people response as a legitimate complete run: no writes, no partial', async () => {
    // Review finding: committeesAttempted=false on the no-people branch used
    // to mark even an authenticated 200 {results:[]} as incomplete, breaking
    // the pre-existing zero-row complete=true/errors=0 contract.
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockOsResponse(200, { results: [], pagination: { max_page: 1 } }),
      ) as unknown as typeof fetch;

    const { prisma, stateLegislatorUpsert, entityCrosswalkUpsert } = fakePrisma();
    const { sleep } = fakeSleep();
    const counts = await runOpenstatesSync(prisma, ['md', 'va'], {
      sleep,
      random: () => 0,
    });

    expect(counts.complete).toBe(true);
    expect(counts.errors).toBe(0);
    expect(counts.inserted).toBe(0);
    expect(stateLegislatorUpsert).not.toHaveBeenCalled();
    expect(entityCrosswalkUpsert).not.toHaveBeenCalled();
    // Both states actually fetched (1 request each) — no poisoning between them.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('halts the whole run on a definitive day-quota 429: zero later requests, authentic rows kept, truthful partial', async () => {
    // state1 people page 1 returns real rows; page 2 gets the definitive
    // "exceeded limit of 250/day" 429. Everything after — the rest of
    // state1's pages, state1 committees, state2 entirely — must make ZERO
    // further provider requests, and the run must report partial.
    const person = {
      id: 'ocd-person/jane',
      name: 'Jane Doe',
      party: 'Democratic',
      current_role: { org_classification: 'lower', district: '1' },
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [person], pagination: { max_page: 2 } }),
      )
      .mockResolvedValue(
        mockOsResponse(429, { detail: 'exceeded limit of 250/day: 251' }),
      ) as unknown as typeof fetch;

    const { prisma, stateLegislatorUpsert } = fakePrisma();
    const { calls, sleep } = fakeSleep();
    const counts = await runOpenstatesSync(prisma, ['md', 'va'], {
      sleep,
      random: () => 0,
    });

    // Exactly 2 provider requests total: state1 people p1 + p2. The
    // committees fetch and ALL of state2 were skipped via the run latch.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
    // No trailing sleep after the definitive 429: p1 spacing + p2 spacing only.
    expect(calls).toEqual([SPACING, SPACING]);

    // The authentic partial person row was still upserted, WITHOUT touching
    // the committees column on update (existing memberships preserved).
    expect(stateLegislatorUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = stateLegislatorUpsert.mock.calls[0][0] as {
      where: { id: string };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    expect(upsertArg.where.id).toBe('ocd-person/jane');
    expect(upsertArg.update).not.toHaveProperty('committees');
    expect(upsertArg.update.name).toBe('Jane Doe');

    // Truthful aggregate: state1 people-partial + committees-unattempted,
    // state2 fully unattempted — both incomplete, inserted counts the 1 real row.
    expect(counts.complete).toBe(false);
    expect(counts.inserted).toBe(1);
    expect(counts.errors).toBe(2);
    expect(counts.incompleteReason).toContain('2 state(s) with incomplete people pages');
    expect(counts.incompleteReason).toContain('2 state(s) with incomplete committee pages');
  });

  it('latches the halt even when the definitive hour detail first arrives on the FINAL attempt', async () => {
    // Review finding: the old branch order checked attempt===MAX_RETRIES
    // before reading the body, so a day/hour detail on the last retry was
    // discarded and the run continued into the known-dead window.
    const person = { id: 'ocd-person/john', name: 'John Smith' };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [person], pagination: { max_page: 2 } }),
      )
      // page 2: minute 429, unknown 429, minute 429, then the FINAL attempt
      // carries the definitive hour detail.
      .mockResolvedValueOnce(mockOsResponse(429, { detail: 'exceeded limit of 10/min: 11' }))
      .mockResolvedValueOnce(mockOsResponse(429, {}))
      .mockResolvedValueOnce(mockOsResponse(429, { detail: 'exceeded limit of 10/min: 12' }))
      .mockResolvedValueOnce(
        mockOsResponse(429, { detail: 'exceeded limit of 1000/hour: 1001' }),
      ) as unknown as typeof fetch;

    const { prisma, stateLegislatorUpsert } = fakePrisma();
    const { calls, sleep } = fakeSleep();
    const counts = await runOpenstatesSync(prisma, ['md', 'va'], {
      sleep,
      random: () => 0,
    });

    // 1 (p1) + 4 (p2 attempts) requests; committees + state2 never fetched.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(5);
    // 3 minute-window waits between the 4 page-2 attempts; NO sleep after
    // the final definitive 429.
    expect(calls).toEqual([
      SPACING, // p1
      SPACING, // p2 attempt 0 (minute 429)
      NO_HINT_WAIT,
      SPACING, // p2 attempt 1 (unknown 429)
      NO_HINT_WAIT,
      SPACING, // p2 attempt 2 (minute 429)
      NO_HINT_WAIT,
      SPACING, // p2 attempt 3 (FINAL: hour detail — latch, return, no sleep)
    ]);

    // Authentic page-1 row preserved; committees column untouched on update.
    expect(stateLegislatorUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = stateLegislatorUpsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(upsertArg.update).not.toHaveProperty('committees');

    expect(counts.complete).toBe(false);
    expect(counts.inserted).toBe(1);
    expect(counts.errors).toBe(2);
  });

  it('does not poison the next independent run: a fresh runOpenstatesSync call starts clean', async () => {
    // The quota latch is run-scoped (never module-level): after a halted
    // run, a new invocation must fetch normally again.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockOsResponse(429, { detail: 'exceeded limit of 250/day: 251' }))
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [], pagination: { max_page: 1 } }),
      ) as unknown as typeof fetch;

    const { prisma } = fakePrisma();
    const { sleep } = fakeSleep();
    const halted = await runOpenstatesSync(prisma, ['md'], { sleep, random: () => 0 });
    expect(halted.complete).toBe(false);

    const fresh = await runOpenstatesSync(prisma, ['md'], { sleep, random: () => 0 });
    expect(fresh.complete).toBe(true);
    expect(fresh.errors).toBe(0);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('fetches six committee pages beyond the old 5-page ceiling and writes every membership', async () => {
    // NY reset run shape: the supplier advertises max_page 6 (120 committees
    // at per_page 20) — the old 5-page ceiling truncated the walk at 100 and
    // still claimed complete. The committee walk must now page to 6 and write
    // all 120 assignments for the member.
    const person = { id: 'ocd-person/jane', name: 'Jane Doe' };
    global.fetch = jest.fn().mockImplementation(async (raw: any) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/people')) {
        return mockOsResponse(200, { results: [person], pagination: { max_page: 1 } });
      }
      const page = Number(url.searchParams.get('page'));
      expect(url.searchParams.get('per_page')).toBe('20');
      return mockOsResponse(200, {
        results: Array.from({ length: 20 }, (_, i) => ({
          id: `committee-${page}-${i}`,
          name: `Committee ${page}/${i}`,
          memberships: [
            { person_name: 'Jane Doe', person: { id: 'ocd-person/jane' }, role: 'member' },
          ],
        })),
        pagination: { max_page: 6 },
      });
    }) as unknown as typeof fetch;

    const { prisma, stateLegislatorUpsert } = fakePrisma();
    const { sleep } = fakeSleep();
    const counts = await runOpenstatesSync(prisma, ['ny'], { sleep, random: () => 0 });

    expect(counts.complete).toBe(true);
    expect(counts.errors).toBe(0);
    const committeeCalls = (global.fetch as jest.Mock).mock.calls.filter((c) =>
      new URL(c[0]).pathname.endsWith('/committees'),
    );
    expect(committeeCalls).toHaveLength(6); // pages 1..6
    const upsertArg = stateLegislatorUpsert.mock.calls[0][0] as {
      update: { committees: { name: string; role: string | null }[] };
    };
    expect(upsertArg.update.committees).toHaveLength(120);
  });

  it('marks the committee walk incomplete when the 25-page ceiling truncates a longer supplier tail', async () => {
    // A supplier advertising max_page 26 must stop at 25 pages with
    // complete:false — never faking complete, never overwriting existing
    // memberships from the partial fetch.
    const person = { id: 'ocd-person/jane', name: 'Jane Doe' };
    global.fetch = jest.fn().mockImplementation(async (raw: any) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/people')) {
        return mockOsResponse(200, { results: [person], pagination: { max_page: 1 } });
      }
      const page = Number(url.searchParams.get('page'));
      return mockOsResponse(200, {
        results: [{ id: `committee-${page}`, name: `Committee ${page}`, memberships: [] }],
        pagination: { max_page: 26 },
      });
    }) as unknown as typeof fetch;

    const { prisma, stateLegislatorUpsert } = fakePrisma();
    const { sleep } = fakeSleep();
    const counts = await runOpenstatesSync(prisma, ['ny'], { sleep, random: () => 0 });

    expect(counts.complete).toBe(false);
    expect(counts.errors).toBe(1);
    expect(counts.incompleteReason).toContain('1 state(s) with incomplete committee pages');
    const committeeCalls = (global.fetch as jest.Mock).mock.calls.filter((c) =>
      new URL(c[0]).pathname.endsWith('/committees'),
    );
    expect(committeeCalls).toHaveLength(25); // ceiling reached, page 26 never attempted
    const upsertArg = stateLegislatorUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(upsertArg.update).not.toHaveProperty('committees'); // old memberships preserved
  });
});

describe('aggregateStateOutcomes', () => {
  const base: OpenstatesStateOutcome = {
    peopleFetched: 100,
    peopleComplete: true,
    committeesComplete: true,
  };

  it('reports a clean complete run when every state finished', () => {
    expect(aggregateStateOutcomes([base, { ...base, peopleFetched: 50 }])).toEqual({
      inserted: 150,
      updated: 0,
      skipped: 0,
      errors: 0,
      complete: true,
    });
  });

  it('reports a legitimate zero-row state as complete (empty success, not a failure)', () => {
    expect(
      aggregateStateOutcomes([
        { peopleFetched: 0, peopleComplete: true, committeesComplete: true },
      ]),
    ).toEqual({ inserted: 0, updated: 0, skipped: 0, errors: 0, complete: true });
  });

  it('aggregates a failed later people page as partial with the rows it did write', () => {
    const counts = aggregateStateOutcomes([
      base,
      { peopleFetched: 40, peopleComplete: false, committeesComplete: true },
    ]);
    expect(counts.complete).toBe(false);
    expect(counts.errors).toBe(1);
    expect(counts.inserted).toBe(140);
    expect(counts.incompleteReason).toContain('1 state(s) with incomplete people pages');
    expect(counts.errorMessage).toBe(counts.incompleteReason);
  });

  it('aggregates a committee failure as partial even when people were clean', () => {
    const counts = aggregateStateOutcomes([
      { peopleFetched: 191, peopleComplete: true, committeesComplete: false },
    ]);
    expect(counts.complete).toBe(false);
    expect(counts.errors).toBe(1);
    expect(counts.incompleteReason).toContain('1 state(s) with incomplete committee pages');
  });

  it('aggregates people-partial + committee-failure across states', () => {
    const counts = aggregateStateOutcomes([
      { peopleFetched: 40, peopleComplete: false, committeesComplete: false },
      { peopleFetched: 0, peopleComplete: true, committeesComplete: false },
      base,
    ]);
    expect(counts.complete).toBe(false);
    expect(counts.errors).toBe(2);
    expect(counts.incompleteReason).toContain('1 state(s) with incomplete people pages');
    expect(counts.incompleteReason).toContain('2 state(s) with incomplete committee pages');
  });
});

describe('resolveSyncStates', () => {
  const ALL = ['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'dc', 'fl', 'ga', 'hi'];

  it('uses the OPENSTATES_STATES override verbatim (lowercased) when set', () => {
    expect(resolveSyncStates('FL,CA, TX ', ALL, 18, 10)).toEqual(['fl', 'ca', 'tx']);
  });

  it('ignores empty entries in the override', () => {
    expect(resolveSyncStates('FL,,CA,', ALL, 1, 10)).toEqual(['fl', 'ca']);
  });

  it('falls back to the day-of-month batch when the override is unset/empty', () => {
    // day 18 -> 18 % ceil(12/10)=2 -> batch 0 -> first 10.
    expect(resolveSyncStates(undefined, ALL, 18, 10)).toEqual(ALL.slice(0, 10));
    // day 1 -> 1 % 2 -> batch 1 -> remainder.
    expect(resolveSyncStates('', ALL, 1, 10)).toEqual(ALL.slice(10, 20));
  });
});
