import {
  invertOpenstatesCommittees,
  fetchAllPages,
  resolveSyncStates,
  parseRetryAfterMs,
  aggregateStateOutcomes,
  type OpenstatesCommittee,
  type OpenstatesStateOutcome,
} from './sync-openstates';

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

/** Deterministic sleep recorder — no real timers, no wall-clock dependence. */
function fakeSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
  };
  return { calls, sleep };
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
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'va' },
      5,
      { sleep },
    );
    expect(result).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], complete: true });
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
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'va' },
      5,
      { sleep },
    );
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: false });
  });

  it('reports complete:true on a genuinely empty first page (no error, just nothing there)', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockOsResponse(200, { results: [] })) as unknown as typeof fetch;

    const { sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'va' },
      5,
      { sleep },
    );
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
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'md' },
      3,
      { sleep },
    );
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
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'va' },
      5,
      { sleep },
    );
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
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'md' },
      5,
      { sleep, now: () => 0 },
    );
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: true });
    // inter-page DELAY_MS, then max(backoff 4000, Retry-After 120000).
    expect(calls).toEqual([2000, 120000]);
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
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'md' },
      5,
      { sleep: clockedSleep, now: () => clock },
    );
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: true });
    // 2000 inter-page, then one full 120000 wait before the successful retry.
    expect(calls).toEqual([2000, 120000]);
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
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'md' },
      5,
      { sleep, now: () => now },
    );
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: true });
    // 120s HTTP-date hint honored in full (was previously capped to 30000).
    expect(calls).toEqual([2000, 120000]);
  });

  it('falls back to bounded exponential backoff when Retry-After is absent or invalid', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockOsResponse(429, {})) // no header
      .mockResolvedValueOnce(mockOsResponse(429, {}, { 'retry-after': 'bogus' }))
      .mockResolvedValueOnce(
        mockOsResponse(200, { results: [{ id: 'a' }], pagination: { max_page: 1 } }),
      ) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'md' },
      5,
      { sleep },
    );
    expect(result.complete).toBe(true);
    // attempt 0 -> 4000, attempt 1 -> 8000 (invalid header ignored)
    expect(calls).toEqual([2000, 4000, 8000]);
  });

  it('does NOT sleep after the final exhausted 429 attempt and reports complete:false', async () => {
    // Old defect: on the 4th 429 the loop slept 30s then fell through without
    // the announced retry (logs showed "attempt 4/3"). Now the exhausted
    // attempt returns immediately — no trailing sleep, no phantom retry.
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockOsResponse(429, {})) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'md' },
      5,
      { sleep },
    );
    expect(result).toEqual({ rows: [], complete: false });
    // 1 page-walk sleep + 3 retry waits (4000/8000/16000); NO 30s trailing sleep.
    expect(calls).toEqual([2000, 4000, 8000, 16000]);
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
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'md' },
      5,
      { sleep },
    );
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: false });
    // inter-page sleeps + bounded local backoff 4000/8000/16000 (no hint), no
    // trailing sleep after the final 429.
    expect(calls).toEqual([2000, 2000, 4000, 8000, 16000]);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(5); // page1 + 4 attempts on page2
  });

  it('defers without retrying on an unschedulable Retry-After instead of overflowing a timer', async () => {
    // setTimeout clamps delays above 2^31-1 ms to 1ms — pretending to wait
    // ~24.8 days would actually retry instantly. The honest behavior is to
    // return partial/defer immediately without sleeping.
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockOsResponse(429, {}, { 'retry-after': '2147483648' })) as unknown as typeof fetch;

    const { calls, sleep } = fakeSleep();
    const result = await fetchAllPages<{ id: string }>(
      '/committees',
      { jurisdiction: 'md' },
      5,
      { sleep, now: () => 0 },
    );
    expect(result).toEqual({ rows: [], complete: false });
    expect(calls).toEqual([2000]); // only the inter-page delay; no retry attempted
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
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
      aggregateStateOutcomes([{ peopleFetched: 0, peopleComplete: true, committeesComplete: true }]),
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
