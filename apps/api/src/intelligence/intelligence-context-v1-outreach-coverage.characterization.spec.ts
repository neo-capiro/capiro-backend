import {
  clientId,
  deferred,
  harness,
  installHooks,
  tenantId,
} from '../../test/fixtures/intelligence-context.js';

installHooks();

it.each([undefined, ''])(
  'skips recipient coverage for office %s even with confirmed LDA IDs',
  async (office) => {
    const h = harness({ results: { confirmedLdaIds: [1] } });
    expect(await h.service.getOutreachContext(clientId, tenantId, office)).toEqual({
      context: 'ENGAGEMENT HEALTH: 0/100 (stable)',
    });
    expect(h.callsOf('coverageRegistrants')).toHaveLength(0);
    expect(h.callsOf('coverageLobbyists')).toHaveLength(0);
  },
);

it('skips recipient coverage when the confirmed LDA ID set is empty', async () => {
  const h = harness();
  await h.service.getOutreachContext(clientId, tenantId, 'Senate');
  expect(h.callsOf('coverageRegistrants')).toHaveLength(0);
  expect(h.callsOf('coverageLobbyists')).toHaveLength(0);
});

it('skips lobbyist lookup after an empty registrant result', async () => {
  const h = harness({ results: { confirmedLdaIds: [1] } });
  expect(await h.service.getOutreachContext(clientId, tenantId, 'Senate')).toEqual({
    context: 'ENGAGEMENT HEALTH: 0/100 (stable)',
  });
  expect(h.callsOf('coverageRegistrants')).toHaveLength(1);
  expect(h.callsOf('coverageLobbyists')).toHaveLength(0);
});

it('runs exact global registrant and lobbyist SQL after the whole context bundle settles without deduplicating bindings', async () => {
  const tracked = deferred<unknown>();
  const ids = [4, 2, 4];
  const h = harness({
    results: {
      confirmedLdaIds: ids,
      trackedBills: tracked.promise,
      coverageRegistrants: [{ registrant_id: 9 }, { registrant_id: 8 }, { registrant_id: 9 }],
    },
  });
  const pending = h.service.getOutreachContext(clientId, tenantId, 'Senate');
  await h.started('outreach');
  expect(h.callsOf('coverageRegistrants')).toHaveLength(0);
  tracked.resolve({ bills: [] });
  await pending;
  const registrants = h.callsOf('coverageRegistrants')[0]!;
  const lobbyists = h.callsOf('coverageLobbyists')[0]!;
  expect(registrants).toMatchObject({
    scope: 'global',
    tenantId: undefined,
    transaction: undefined,
  });
  expect(lobbyists).toMatchObject({ scope: 'global', tenantId: undefined, transaction: undefined });
  expect(registrants.query!.sql.replace(/\s+/g, ' ').trim()).toBe(
    'SELECT DISTINCT registrant_id FROM lda_filing WHERE client_id = ANY(?::int[]) AND registrant_id IS NOT NULL',
  );
  expect(registrants.query!.values).toEqual([[4, 2, 4]]);
  expect(registrants.query!.values[0]).toBe(ids);
  expect(lobbyists.query!.sql.replace(/\s+/g, ' ').trim()).toBe(
    "SELECT first_name, last_name, covered_positions FROM lda_lobbyist WHERE registrant_ids && ?::int[] AND covered_positions::text != '[]' LIMIT 20",
  );
  expect(lobbyists.query!.values).toEqual([[9, 8, 9]]);
  expect(h.calls.slice(-2).map((call) => call.operation)).toEqual([
    'coverageRegistrants',
    'coverageLobbyists',
  ]);
});

it('matches covered position or department case-insensitively and caps names at the first three matching rows', async () => {
  const h = harness({
    results: {
      confirmedLdaIds: [1],
      coverageRegistrants: [{ registrant_id: 2 }],
      coverageLobbyists: [
        {
          first_name: 'Skip',
          last_name: 'One',
          covered_positions: [{ position: 'House', department: 'NASA' }],
        },
        {
          first_name: ' Ada ',
          last_name: 'One ',
          covered_positions: [{ position: 'Former SENATE aide' }],
        },
        {
          first_name: 'Bob',
          last_name: 'Two',
          covered_positions: [{ department: 'Senate committee' }],
        },
        { first_name: 'Cal', last_name: 'Three', covered_positions: [{ position: 'sEnAtE' }] },
        { first_name: 'Dan', last_name: 'Four', covered_positions: [{ department: 'senate' }] },
      ],
    },
  });
  expect(await h.service.getOutreachContext(clientId, tenantId, 'SeNaTe')).toEqual({
    context:
      'LOBBYIST CONNECTIONS TO "SeNaTe":\n- Ada  One\n- Bob Two\n- Cal Three\n\nENGAGEMENT HEALTH: 0/100 (stable)',
  });
});

it('ignores non-array position collections and non-object or non-string position fields', async () => {
  const h = harness({
    results: {
      confirmedLdaIds: [1],
      coverageRegistrants: [{ registrant_id: 2 }],
      coverageLobbyists: [
        {
          first_name: 'Object',
          last_name: 'Collection',
          covered_positions: { position: 'Senate' },
        },
        { first_name: 'String', last_name: 'Collection', covered_positions: '["Senate"]' },
        {
          first_name: 'Bad',
          last_name: 'Entries',
          covered_positions: [null, 'Senate', 7, { position: 1, department: false }],
        },
        {
          first_name: 'Good',
          last_name: 'Entry',
          covered_positions: [null, { department: 'Senate' }],
        },
      ],
    },
  });
  expect((await h.service.getOutreachContext(clientId, tenantId, 'Senate')).context).toBe(
    'LOBBYIST CONNECTIONS TO "Senate":\n- Good Entry\n\nENGAGEMENT HEALTH: 0/100 (stable)',
  );
});

it('preserves recipient whitespace rather than trimming it before matching', async () => {
  const h = harness({
    results: {
      confirmedLdaIds: [1],
      coverageRegistrants: [{ registrant_id: 2 }],
      coverageLobbyists: [
        { first_name: 'Ada', last_name: 'One', covered_positions: [{ position: 'Senate' }] },
      ],
    },
  });
  expect(await h.service.getOutreachContext(clientId, tenantId, ' Senate ')).toEqual({
    context: 'ENGAGEMENT HEALTH: 0/100 (stable)',
  });
});

it('keeps raw name interpolation and does not deduplicate matching lobbyists', async () => {
  const lobbyist = {
    first_name: null,
    last_name: undefined,
    covered_positions: [{ department: 'Senate' }],
  };
  const h = harness({
    results: {
      confirmedLdaIds: [1],
      coverageRegistrants: [{ registrant_id: 2 }],
      coverageLobbyists: [lobbyist, lobbyist],
    },
  });
  expect((await h.service.getOutreachContext(clientId, tenantId, 'Senate')).context).toBe(
    'LOBBYIST CONNECTIONS TO "Senate":\n- null undefined\n- null undefined\n\nENGAGEMENT HEALTH: 0/100 (stable)',
  );
});

it('places lobbyist connections after regulatory context and before real engagement health', async () => {
  const h = harness({
    results: {
      confirmedLdaIds: [1],
      coverageRegistrants: [{ registrant_id: 2 }],
      coverageLobbyists: [
        { first_name: 'Ada', last_name: 'One', covered_positions: [{ position: 'Senate' }] },
      ],
      commentPeriods: [
        {
          title: 'Rule',
          commentEndDate: new Date('2026-10-14T02:00:00.000Z'),
          agencyNames: ['DOE'],
        },
      ],
    },
    queues: { debriefs: [1, 0] },
  });
  expect((await h.service.getOutreachContext(clientId, tenantId, 'Senate')).context).toBe(
    'COMMENT PERIOD DEADLINES:\n- "Rule", 1d left (DOE)\n\nLOBBYIST CONNECTIONS TO "Senate":\n- Ada One\n\nENGAGEMENT HEALTH: 20/100 (improving)',
  );
});

it.each(['coverageRegistrants', 'coverageLobbyists'] as const)(
  'keeps %s lookup failures fatal after all health reads',
  async (operation) => {
    const error = new Error(`${operation} unavailable`);
    const h = harness({
      results: { confirmedLdaIds: [1], coverageRegistrants: [{ registrant_id: 2 }] },
      errors: { [operation]: error },
    });
    await expect(h.service.getOutreachContext(clientId, tenantId, 'Senate')).rejects.toBe(error);
    expect(h.callsOf('meetings')).toHaveLength(2);
    expect(h.callsOf('outreach')).toHaveLength(2);
    expect(h.transactions.every((tx) => tx.outcome === 'commit')).toBe(true);
  },
);
