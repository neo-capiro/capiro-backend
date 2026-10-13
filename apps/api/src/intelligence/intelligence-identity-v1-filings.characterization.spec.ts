import {
  clientId,
  clientRow,
  filingRow,
  harness,
  installHooks,
  now,
  tenantId,
} from '../../test/fixtures/intelligence-identity.js';

installHooks();

function mapped(rows: unknown[] = []) {
  return harness({ rows: { client: clientRow({ ldaClientIds: [7, 2] }), detailedFilings: rows } });
}

it('identity detailed filings returns an unmatched envelope for unresolved clients without catalog I/O', async () => {
  const h = harness({ rows: { client: null } });
  expect(await h.service.getClientLdaFilings(clientId, tenantId)).toEqual({
    matched: false,
    ldaClientIds: [],
    totalFilings: 0,
    totalIncome: 0,
    totalExpenses: 0,
    firstFilingYear: null,
    latestFilingYear: null,
    registrants: [],
    byYear: [],
    filings: [],
  });
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
});

it('identity detailed filings retains a mapped empty result with explicit nontruncation', async () => {
  const h = mapped();
  expect(await h.service.getClientLdaFilings(clientId, tenantId)).toEqual({
    matched: true,
    ldaClientIds: [7, 2],
    totalFilings: 0,
    truncated: false,
    totalIncome: 0,
    totalExpenses: 0,
    firstFilingYear: null,
    latestFilingYear: null,
    registrants: [],
    byYear: [],
    filings: [],
  });
});

it('identity detailed filings uses real late-bound tenant resolution then the exact global detail projection', async () => {
  const h = mapped([filingRow()]);
  const resolve = jest.spyOn(h.subject, 'resolveLdaClientIds');
  const result = await h.service.getClientLdaFilings(clientId, tenantId);
  expect(resolve).toHaveBeenCalledWith(clientId, tenantId);
  expect(resolve.mock.contexts[0]).toBe(h.service);
  expect(result.ldaClientIds).toBe(await (resolve.mock.results[0]!.value as Promise<number[]>));
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'client',
    'detailedFilings',
  ]);
  expect(h.callsOf('detailedFilings')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: { clientId: { in: [7, 2] } },
        orderBy: [{ filingYear: 'desc' }, { dtPosted: 'desc' }],
        take: 501,
        select: {
          filingUuid: true,
          registrantId: true,
          clientId: true,
          filingType: true,
          filingYear: true,
          filingPeriod: true,
          income: true,
          expenses: true,
          dtPosted: true,
          registrantName: true,
          clientName: true,
          issueCodes: true,
          governmentEntities: true,
          lobbyists: true,
          lobbyingActivities: true,
          filingDocumentUrl: true,
        },
      },
    ],
  });
  expect(h.callsOf('detailedFilings')[0]!.tenantId).toBeUndefined();
});

it('identity detailed filings parses government and lobbyist vintages without inventing activity details', async () => {
  const codes: unknown[] = ['SCI', null, 42];
  const row = filingRow({
    registrantName: '  Research Lobbyists  ',
    income: '10.5',
    expenses: '3',
    issueCodes: codes,
    governmentEntities: [
      ' Senate ',
      { name: 'Senate' },
      { name: { name: ' House ' } },
      { name: ' ' },
      null,
      3,
    ],
    lobbyists: [
      { lobbyist: { first_name: 'Jane', last_name: 'Doe' } },
      { first_name: 'Jane', last_name: 'Doe' },
      { first_name: 'Jane ', last_name: ' Doe' },
      { lobbyist: null, first_name: 'Solo' },
      'Ignored String',
      { first_name: 42 },
    ],
    lobbyingActivities: [{ specific_issues: 'Selected but not surfaced' }],
    filingDocumentUrl: 'https://example.invalid/filing',
  });
  const result = await mapped([row]).service.getClientLdaFilings(clientId, tenantId);
  expect(result.filings).toEqual([
    {
      filingUuid: 'filing-one',
      registrantId: 41,
      ldaClientId: 7,
      filingType: 'LD-2',
      filingYear: 2026,
      filingPeriod: 'third_quarter',
      income: 10.5,
      expenses: 3,
      amount: 10.5,
      postedAt: now.toISOString(),
      registrantName: 'Research Lobbyists',
      clientName: 'Acme Research',
      issueCodes: codes,
      governmentEntities: ['Senate', 'House'],
      lobbyists: ['Jane Doe', 'Jane   Doe', 'Solo'],
      documentUrl: 'https://example.invalid/filing',
    },
  ]);
  const projection = result.filings[0] as Record<string, unknown>;
  expect(projection.issueCodes).toBe(codes);
  expect(projection).not.toHaveProperty('lobbyingActivities');
});

it.each([
  {
    label: 'income wins',
    income: -2,
    expenses: 9,
    expectedIncome: -2,
    expectedExpenses: 9,
    amount: -2,
  },
  {
    label: 'zero income fallback',
    income: 0,
    expenses: '7.5',
    expectedIncome: 0,
    expectedExpenses: 7.5,
    amount: 7.5,
  },
  {
    label: 'nonfinite defaults',
    income: Infinity,
    expenses: 'bad',
    expectedIncome: 0,
    expectedExpenses: 0,
    amount: 0,
  },
  {
    label: 'nullish defaults',
    income: null,
    expenses: undefined,
    expectedIncome: 0,
    expectedExpenses: 0,
    amount: 0,
  },
  {
    label: 'decimal valueOf',
    income: { valueOf: () => '12' },
    expenses: null,
    expectedIncome: 12,
    expectedExpenses: 0,
    amount: 12,
  },
])(
  'identity detailed filing money retains $label coercion and headline choice',
  async (example) => {
    const result = await mapped([
      filingRow({
        income: example.income,
        expenses: example.expenses,
        dtPosted: null,
        registrantName: null,
        issueCodes: 'SCI',
        governmentEntities: {},
        lobbyists: {},
      }),
    ]).service.getClientLdaFilings(clientId, tenantId);
    expect(result.filings[0]).toMatchObject({
      income: example.expectedIncome,
      expenses: example.expectedExpenses,
      amount: example.amount,
      postedAt: null,
      registrantName: 'Unknown registrant',
      issueCodes: [],
      governmentEntities: [],
      lobbyists: [],
      documentUrl: null,
    });
    expect(result.totalIncome).toBe(example.expectedIncome);
    expect(result.totalExpenses).toBe(example.expectedExpenses);
  },
);

it('identity detailed filings groups years descending and trimmed registrants with stable income ties', async () => {
  const rows = [
    filingRow({ filingYear: 2024, registrantName: '  Firm B ', income: 5, expenses: 2 }),
    filingRow({ filingYear: 2026, registrantName: 'Firm A', income: 10, expenses: -1 }),
    filingRow({ filingYear: 2024, registrantName: 'Firm B', income: 5, expenses: 3 }),
    filingRow({ filingYear: 2025, registrantName: ' ', income: -2, expenses: 1 }),
  ];
  const original = structuredClone(rows);
  const result = await mapped(rows).service.getClientLdaFilings(clientId, tenantId);
  expect(result.byYear).toEqual([
    { year: 2026, income: 10, expenses: -1, filings: 1 },
    { year: 2025, income: -2, expenses: 1, filings: 1 },
    { year: 2024, income: 10, expenses: 5, filings: 2 },
  ]);
  expect(result.registrants).toEqual([
    { name: 'Firm B', income: 10, filings: 2 },
    { name: 'Firm A', income: 10, filings: 1 },
    { name: 'Unknown registrant', income: -2, filings: 1 },
  ]);
  expect(result).toMatchObject({
    totalIncome: 18,
    totalExpenses: 5,
    firstFilingYear: 2024,
    latestFilingYear: 2026,
    totalFilings: 4,
  });
  expect(result.filings.map((filing) => (filing as Record<string, unknown>).filingYear)).toEqual([
    2024, 2026, 2024, 2025,
  ]);
  expect(rows).toEqual(original);
});

it('identity detailed filings limits the ranked registrant view to ten without limiting totals', async () => {
  const rows = Array.from({ length: 12 }, (_, index) =>
    filingRow({ registrantName: `Firm ${index}`, income: index + 1 }),
  );
  const result = await mapped(rows).service.getClientLdaFilings(clientId, tenantId);
  expect(result.registrants.map((registrant) => registrant.name)).toEqual([
    'Firm 11',
    'Firm 10',
    'Firm 9',
    'Firm 8',
    'Firm 7',
    'Firm 6',
    'Firm 5',
    'Firm 4',
    'Firm 3',
    'Firm 2',
  ]);
  expect(result.totalIncome).toBe(78);
  expect(result.totalFilings).toBe(12);
});

it.each([500, 501])(
  'identity detailed filings preserves the %s-row visibility and truncation boundary',
  async (count) => {
    const rows = Array.from({ length: count }, (_, index) =>
      filingRow({
        filingUuid: `filing-${index}`,
        income: index === 500 ? 9999 : 1,
        expenses: index === 500 ? 9999 : 2,
        filingYear: index === 500 ? 1999 : 2026,
        registrantName: index === 500 ? 'Hidden firm' : 'Visible firm',
      }),
    );
    const result = await mapped(rows).service.getClientLdaFilings(clientId, tenantId);
    expect(result).toMatchObject({
      totalFilings: 500,
      truncated: count === 501,
      totalIncome: 500,
      totalExpenses: 1000,
      firstFilingYear: 2026,
      latestFilingYear: 2026,
      registrants: [{ name: 'Visible firm', income: 500, filings: 500 }],
      byYear: [{ year: 2026, income: 500, expenses: 1000, filings: 500 }],
    });
    expect(result.filings).toHaveLength(500);
    expect(result.filings[499]).toMatchObject({ filingUuid: 'filing-499' });
  },
);

it.each(['invalid date', 'symbol money', 'throwing decimal', 'nonstring registrant'])(
  'identity detailed filing preserves %s projection failure rather than dropping the row',
  async (kind) => {
    const failure = new Error('Decimal primitive failed');
    const row =
      kind === 'invalid date'
        ? filingRow({ dtPosted: new Date('invalid') })
        : kind === 'symbol money'
          ? filingRow({ income: Symbol('income') })
          : kind === 'throwing decimal'
            ? filingRow({
                income: {
                  valueOf: () => {
                    throw failure;
                  },
                },
              })
            : filingRow({ registrantName: 42 });
    const h = mapped([row]);
    const work = h.service.getClientLdaFilings(clientId, tenantId);
    if (kind === 'throwing decimal') await expect(work).rejects.toBe(failure);
    else await expect(work).rejects.toThrow(kind === 'invalid date' ? RangeError : TypeError);
    expect(h.callsOf('detailedFilings')).toHaveLength(1);
  },
);

it('identity detailed filings propagates the global query failure after tenant resolution', async () => {
  const failure = new Error('Catalog unavailable');
  const h = harness({
    rows: { client: clientRow({ ldaClientIds: [7] }) },
    errors: { detailedFilings: failure },
  });
  await expect(h.service.getClientLdaFilings(clientId, tenantId)).rejects.toBe(failure);
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'client',
    'detailedFilings',
  ]);
});
