import {
  clientId,
  day,
  deferred,
  harness,
  installHooks,
  now,
  tenantId,
} from '../../test/fixtures/intelligence-supporting.js';

const ninety = new Date(now.getTime() - 90 * day);
function registrant(overrides: Record<string, unknown> = {}) {
  return {
    registrant_id: 1,
    registrant_name: 'Firm',
    filing_count: 2,
    total_income: 3,
    first_filing_date: ninety,
    ...overrides,
  };
}
installHooks();

it('competitor board returns its complete empty envelope without catalog reads when confirmed LDA IDs are empty', async () => {
  const h = harness();
  await expect(h.service.getCompetitorBoard(clientId, tenantId)).resolves.toEqual({
    competitors: [],
    leaderboards: [],
  });
  expect(h.lda).toHaveBeenCalledWith(clientId, tenantId);
  expect(h.calls.filter((c) => c.scope === 'global')).toEqual([]);
});

it('competitor board filters falsey issue codes and returns before competitors or leaderboards when none remain', async () => {
  const ids = [3, 4];
  const h = harness({ ldaIds: ids, results: { issueCodes: [{ code: '' }, { code: null }] } });
  await expect(h.service.getCompetitorBoard(clientId, tenantId)).resolves.toEqual({
    competitors: [],
    leaderboards: [],
  });
  expect(h.callsOf('issueCodes')[0]!.query!.values).toEqual([ids]);
  expect(h.callsOf('issueCodes')[0]!.query!.values[0]).toBe(ids);
  expect(h.callsOf('competitors')).toEqual([]);
  expect(h.callsOf('issueName')).toEqual([]);
});

it('competitor board retains issue-code duplicates/order, starts the first five real leaderboards eagerly, and preserves new-entrant boundaries', async () => {
  const ids = [2, 2, 9];
  const overlap = ['Defense'];
  const gate = deferred<unknown[]>();
  const h = harness({
    ldaIds: ids,
    results: {
      issueCodes: ['A', 'A', '', 'B', 'C', 'D', 'E'].map((code) => ({ code })),
      competitors: gate.promise,
      issueName: (call: { query: { values: unknown[] } }) => [
        { name: `Name ${call.query.values[0]}` },
      ],
    },
  });
  const pending = h.service.getCompetitorBoard(clientId, tenantId);
  await h.started('competitors');
  await h.started('leaderRegistrants');
  expect(h.callsOf('issueName').map((c) => c.query!.values[0])).toEqual(['A', 'A', 'B', 'C', 'D']);
  const query = h.callsOf('competitors')[0]!.query!;
  expect(query.values).toEqual([
    ninety,
    ids,
    ['A', 'A', 'B', 'C', 'D', 'E'],
    ['A', 'A', 'B', 'C', 'D', 'E'],
  ]);
  expect(query.values[2]).toBe(query.values[3]);
  expect(query.sql).toContain('f.client_id != ALL');
  expect(query.sql).toContain('LIMIT 20');
  gate.resolve([
    {
      registrant_name: 'Boundary',
      filing_count: 7,
      all_time_first: ninety,
      shared_issues: overlap,
    },
    {
      registrant_name: 'Old',
      filing_count: 2,
      all_time_first: new Date(ninety.getTime() - 1),
      shared_issues: [],
    },
    { registrant_name: 'Unknown', filing_count: 1, all_time_first: null, shared_issues: null },
  ]);
  const result = await pending;
  expect(result.competitors).toEqual([
    { registrantName: 'Boundary', filingCount: 7, isNewEntrant: true, issueOverlap: overlap },
    { registrantName: 'Old', filingCount: 2, isNewEntrant: false, issueOverlap: [] },
    { registrantName: 'Unknown', filingCount: 1, isNewEntrant: false, issueOverlap: [] },
  ]);
  expect(result.competitors[0]!.issueOverlap).toBe(overlap);
  expect(result.leaderboards.map((l) => l.issueCode)).toEqual(['A', 'A', 'B', 'C', 'D']);
  expect(h.calls.filter((c) => c.query).every((c) => c.scope === 'global')).toBe(true);
});

it.each(['issueCodes', 'competitors', 'issueName'])(
  'competitor board propagates %s failure without a partial success',
  async (operation) => {
    const failure = new Error(`${operation} failed`);
    const h = harness({
      ldaIds: [1],
      results: { issueCodes: [{ code: 'DEF' }] },
      errors: { [operation]: failure },
    });
    await expect(h.service.getCompetitorBoard(clientId, tenantId)).rejects.toBe(failure);
  },
);

it('competitor board propagates confirmed-LDA source failure before global reads', async () => {
  const failure = new Error('LDA failed');
  const h = harness({ ldaIds: failure });
  await expect(h.service.getCompetitorBoard(clientId, tenantId)).rejects.toBe(failure);
  expect(h.calls.filter((c) => c.scope === 'global')).toEqual([]);
});

it('leaderboard resolves an absent name to the raw code and starts count and rows before either finishes', async () => {
  const total = deferred<unknown[]>();
  const rows = deferred<unknown[]>();
  const h = harness({ results: { leaderTotal: total.promise, leaderRegistrants: rows.promise } });
  const pending = h.service.getIssueLeaderboard('RAW');
  await h.started('leaderTotal');
  await h.started('leaderRegistrants');
  expect(
    h.events.filter((e) => ['issueName', 'leaderTotal', 'leaderRegistrants'].includes(e)),
  ).toEqual(['issueName', 'leaderTotal', 'leaderRegistrants']);
  rows.resolve([]);
  total.resolve([{ total: '17tail' }]);
  await expect(pending).resolves.toEqual({
    issueCode: 'RAW',
    issueName: 'RAW',
    totalFilings: 17,
    registrants: [],
  });
  expect(h.callsOf('leaderTotal')[0]!.query!.values).toEqual([
    new Date(now.getTime() - 2 * 365 * day),
    'RAW',
  ]);
  expect(h.callsOf('leaderRegistrants')[0]!.query!.sql).toContain("registrant_name != ''");
  expect(h.callsOf('leaderRegistrants')[0]!.query!.sql).toContain('LIMIT 20');
  expect(h.callsOf('sharedLobbyists')).toEqual([]);
});

it('leaderboard preserves null/default fields and skips shared-lobbyist reads for at most one non-null ID', async () => {
  const h = harness({
    results: {
      issueName: [{ name: '' }],
      leaderTotal: [],
      leaderRegistrants: [
        registrant({ registrant_id: null, first_filing_date: null, total_income: null }),
        registrant({
          registrant_id: 5,
          registrant_name: 'Second',
          first_filing_date: new Date(ninety.getTime() - 1),
        }),
      ],
    },
  });
  await expect(h.service.getIssueLeaderboard('CODE')).resolves.toEqual({
    issueCode: 'CODE',
    issueName: '',
    totalFilings: 0,
    registrants: [
      {
        name: 'Firm',
        filingCount: 2,
        totalIncome: 0,
        isNewEntrant: false,
        firstFilingDate: null,
        sharedLobbyists: [],
      },
      {
        name: 'Second',
        filingCount: 2,
        totalIncome: 3,
        isNewEntrant: false,
        firstFilingDate: new Date(ninety.getTime() - 1).toISOString(),
        sharedLobbyists: [],
      },
    ],
  });
  expect(h.callsOf('sharedLobbyists')).toEqual([]);
});

it('leaderboard retains duplicate IDs and shared-lobbyist occurrences with all repeated SQL bindings', async () => {
  const h = harness({
    results: {
      issueName: [{ name: 'Defense' }],
      leaderTotal: [{ total: '9' }],
      leaderRegistrants: [
        registrant(),
        registrant({ registrant_name: 'Same ID' }),
        registrant({ registrant_id: 2 }),
      ],
      sharedLobbyists: [
        { lobbyist_name: 'Shared', shared_registrant_ids: [1, 1, 2] },
        { lobbyist_name: 'Next', shared_registrant_ids: [1] },
        { lobbyist_name: 'None', shared_registrant_ids: null },
      ],
    },
  });
  const result = await h.service.getIssueLeaderboard('DEF');
  expect(result.registrants[0]).toMatchObject({
    isNewEntrant: true,
    firstFilingDate: ninety.toISOString(),
    sharedLobbyists: ['Shared', 'Shared', 'Next'],
  });
  expect(result.registrants[1]!.sharedLobbyists).toBe(result.registrants[0]!.sharedLobbyists);
  expect(result.registrants[2]!.sharedLobbyists).toEqual(['Shared']);
  const q = h.callsOf('sharedLobbyists')[0]!.query!;
  expect(q.values).toEqual(Array(4).fill([1, 1, 2]));
  expect(q.values.every((v) => v === q.values[0])).toBe(true);
  expect(q.sql).toContain('LIMIT 30');
  expect(q.sql).toContain('> 1');
});

it.each(['issueName', 'leaderTotal', 'leaderRegistrants', 'sharedLobbyists'])(
  'leaderboard propagates %s catalog failure',
  async (operation) => {
    const failure = new Error(`${operation} failed`);
    const h = harness({
      results: { leaderRegistrants: [registrant(), registrant({ registrant_id: 2 })] },
      errors: { [operation]: failure },
    });
    await expect(h.service.getIssueLeaderboard('DEF')).rejects.toBe(failure);
  },
);

it('ex-staffers stop before catalog reads for empty confirmed LDA IDs', async () => {
  const h = harness();
  await expect(h.service.getExStaffers(clientId, tenantId)).resolves.toEqual({ lobbyists: [] });
  expect(h.lda).toHaveBeenCalledWith(clientId, tenantId);
  expect(h.calls.filter((c) => c.scope === 'global')).toEqual([]);
});

it('ex-staffers stop before lobbyist reads when no registrant was found', async () => {
  const ids = [3];
  const h = harness({ ldaIds: ids });
  await expect(h.service.getExStaffers(clientId, tenantId)).resolves.toEqual({ lobbyists: [] });
  expect(h.callsOf('staffRegistrants')[0]!.query!.values).toEqual([ids]);
  expect(h.callsOf('exStaffers')).toEqual([]);
});

it('ex-staffers retain raw ID ordering, name spacing and covered-position array identity', async () => {
  const positions = ['Counsel'];
  const h = harness({
    ldaIds: [3],
    results: {
      staffRegistrants: [{ registrant_id: 8 }, { registrant_id: 8 }, { registrant_id: 9 }],
      exStaffers: [
        { id: 1, first_name: ' Ada ', last_name: ' Example ', covered_positions: positions },
        { id: 2, first_name: '', last_name: ' Solo ', covered_positions: null },
      ],
    },
  });
  const result = await h.service.getExStaffers(clientId, tenantId);
  expect(result).toEqual({
    lobbyists: [
      { name: 'Ada   Example', coveredPositions: positions },
      { name: 'Solo', coveredPositions: [] },
    ],
  });
  expect(result.lobbyists[0]!.coveredPositions).toBe(positions);
  const query = h.callsOf('exStaffers')[0]!.query!;
  expect(query.values).toEqual([[8, 8, 9]]);
  expect(query.sql).toContain("covered_positions::text != '[]'");
  expect(query.sql).toContain('ORDER BY last_name, first_name');
  expect(query.sql).toContain('LIMIT 50');
  expect(h.callsOf('exStaffers')[0]!.scope).toBe('global');
});

it.each(['staffRegistrants', 'exStaffers'])(
  'ex-staffers propagate %s failure',
  async (operation) => {
    const failure = new Error(`${operation} failed`);
    const h = harness({
      ldaIds: [3],
      results: { staffRegistrants: [{ registrant_id: 8 }] },
      errors: { [operation]: failure },
    });
    await expect(h.service.getExStaffers(clientId, tenantId)).rejects.toBe(failure);
  },
);
