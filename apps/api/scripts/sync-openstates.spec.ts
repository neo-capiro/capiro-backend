import {
  invertOpenstatesCommittees,
  fetchAllPages,
  resolveSyncStates,
  type OpenstatesCommittee,
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

function mockOsResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
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

    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'va' });
    expect(result).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], complete: true });
  }, 15000);

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

    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'va' });
    expect(result).toEqual({ rows: [{ id: 'a' }], complete: false });
  }, 15000);

  it('reports complete:true on a genuinely empty first page (no error, just nothing there)', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockOsResponse(200, { results: [] })) as unknown as typeof fetch;

    const result = await fetchAllPages<{ id: string }>('/committees', { jurisdiction: 'va' });
    expect(result).toEqual({ rows: [], complete: true });
  }, 15000);
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
