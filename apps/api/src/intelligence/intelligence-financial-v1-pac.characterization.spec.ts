import {
  clientId,
  deferred,
  harness,
  installHooks,
  now,
  pacRow,
  tenantId,
} from '../../test/fixtures/intelligence-financial.js';

installHooks();

function mapped(rows: Record<string, unknown> = {}) {
  return harness({ rows: { committeeMappings: [{ externalId: 'C1' }], ...rows } });
}

it('financial PAC distinguishes no committee mapping from a verified empty import', async () => {
  const h = harness({ rows: { committeeMappings: [{ externalId: ' ' }, { externalId: '' }] } });
  expect(await h.subject.getPacGiving(clientId, tenantId)).toEqual({
    tracked: false,
    committees: [],
    summary: { totalAmount: 0, disbursementCount: 0, recipientCount: 0 },
    coverage: {
      status: 'unmapped',
      cycles: [2022, 2024, 2026],
      lastSyncedAt: null,
      message: 'No FEC committee is mapped to this client.',
    },
  });
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'committeeMappings']);
});

it('financial PAC trims and deduplicates mappings while keeping every empty mapped committee visible', async () => {
  const h = mapped({
    committeeMappings: [
      { externalId: ' C2 ' },
      { externalId: 'C1' },
      { externalId: 'C2' },
      { externalId: '' },
    ],
    committeeCatalog: [{ id: 'C1', name: 'Catalog PAC' }],
  });
  const result = await h.subject.getPacGiving(clientId, tenantId);
  expect(result.committees).toEqual([
    {
      committeeId: 'C2',
      committeeName: null,
      totalAmount: 0,
      disbursementCount: 0,
      recipients: [],
    },
    {
      committeeId: 'C1',
      committeeName: 'Catalog PAC',
      totalAmount: 0,
      disbursementCount: 0,
      recipients: [],
    },
  ]);
  expect(result.coverage).toEqual({
    status: 'pending',
    cycles: [2022, 2024, 2026],
    lastSyncedAt: null,
    message: 'PAC contributions have not finished syncing for this reporting period.',
  });
  expect(result.tracked).toBe(true);
  expect(h.callsOf('committeeMappings')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 1,
    args: [
      {
        where: { clientId, source: 'fec_committee', confirmed: true },
        select: { externalId: true },
      },
    ],
  });
  expect(h.callsOf('committeeCatalog')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: { id: { in: ['C2', 'C1'] } },
        select: { id: true, name: true },
      },
    ],
  });
  expect(h.callsOf('pacSync')[0]!.args).toEqual([
    {
      where: { committeeId: { in: ['C2', 'C1'] }, cycle: { in: [2022, 2024, 2026] } },
      select: { committeeId: true, cycle: true, status: true, completedAt: true },
    },
  ]);
  expect(h.callsOf('pacRows')[0]!.query).toMatchObject({
    sql: 'SELECT committee_id, MAX(committee_name) AS committee_name, recipient_name, MAX(candidate_name) AS candidate_name, COALESCE(SUM(amount), 0)::float AS total_amount, COUNT(*)::int AS disbursement_count FROM fec_pac_contribution WHERE committee_id = ANY($1::text[]) AND cycle = ANY($2::int[]) GROUP BY committee_id, recipient_name ORDER BY total_amount DESC',
    values: [
      ['C2', 'C1'],
      [2022, 2024, 2026],
    ],
  });
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'committeeMappings',
    'committeeCatalog',
    'pacSync',
    'pacRows',
  ]);
  expect(h.callsOf('pacRows')[0]!.tenantId).toBeUndefined();
});

it('financial PAC launches both catalog reads together and waits for both before dollars', async () => {
  const names = deferred<unknown>();
  const states = deferred<unknown>();
  const h = harness({
    rows: { committeeMappings: [{ externalId: 'C1' }] },
    results: { committeeCatalog: names.promise, pacSync: states.promise },
  });
  const pending = h.subject.getPacGiving(clientId, tenantId);
  await h.started('pacSync');
  expect(h.callsOf('committeeCatalog')).toHaveLength(1);
  expect(h.callsOf('pacRows')).toEqual([]);
  names.resolve([{ id: 'C1', name: 'Catalog PAC' }]);
  await names.promise;
  await Promise.resolve();
  expect(h.callsOf('pacRows')).toEqual([]);
  states.resolve([]);
  expect((await pending).committees[0]!.committeeName).toBe('Catalog PAC');
  expect(h.events.indexOf('done:pacSync')).toBeLessThan(h.events.indexOf('start:pacRows'));
});

it('financial PAC captures UTC election cycles before awaiting mappings', async () => {
  jest.setSystemTime(new Date('2027-12-31T23:59:59.000Z'));
  const held = deferred<unknown>();
  const h = harness({ results: { committeeMappings: held.promise } });
  const pending = h.subject.getPacGiving(clientId, tenantId);
  await h.started('committeeMappings');
  jest.setSystemTime(new Date('2029-01-01T00:00:00.000Z'));
  held.resolve([{ externalId: 'C1' }]);
  expect((await pending).coverage.cycles).toEqual([2022, 2024, 2026, 2028]);
  expect(h.callsOf('pacRows')[0]!.query!.values[1]).toEqual([2022, 2024, 2026, 2028]);
});

it('financial PAC converts totals and counts to numbers but preserves raw recipient amounts', async () => {
  const h = mapped({
    committeeCatalog: [{ id: 'C1', name: 'Catalog PAC' }],
    pacRows: [
      pacRow({ total_amount: '12.5', disbursement_count: '3' }),
      pacRow({ recipient_name: '', total_amount: '-2.5', disbursement_count: '1' }),
      pacRow({ recipient_name: null, total_amount: 4, disbursement_count: 2 }),
    ],
  });
  const result = await h.subject.getPacGiving(clientId, tenantId);
  expect(result.committees).toEqual([
    {
      committeeId: 'C1',
      committeeName: 'Catalog PAC',
      totalAmount: 14,
      disbursementCount: 6,
      recipients: [
        {
          recipientName: 'Recipient One',
          candidateName: 'Alice Member',
          totalAmount: '12.5',
        },
      ],
    },
  ]);
  expect(result.summary).toEqual({ totalAmount: 14, disbursementCount: 6, recipientCount: 1 });
  expect(result.coverage.status).toBe('partial');
});

it('financial PAC falls back from null catalog names and retains unexpected stored committees', async () => {
  const h = mapped({
    committeeCatalog: [{ id: 'C1', name: null }],
    pacRows: [
      pacRow({ committee_name: 'First row name', total_amount: 10 }),
      pacRow({ committee_name: 'Later row name', recipient_name: 'Second', total_amount: -2 }),
      pacRow({
        committee_id: 'C9',
        committee_name: null,
        recipient_name: 'Other',
        total_amount: 20,
      }),
    ],
  });
  const result = await h.subject.getPacGiving(clientId, tenantId);
  expect(
    result.committees.map((committee) => [
      committee.committeeId,
      committee.committeeName,
      committee.totalAmount,
    ]),
  ).toEqual([
    ['C9', null, 20],
    ['C1', 'First row name', 8],
  ]);
  expect(result.summary).toEqual({ totalAmount: 28, disbursementCount: 6, recipientCount: 3 });
});

it('financial PAC counts recipients per committee rather than deduplicating their display names', async () => {
  const h = mapped({
    committeeMappings: [{ externalId: 'C2' }, { externalId: 'C1' }],
    pacRows: [
      pacRow({ committee_id: 'C1', candidate_name: null, total_amount: 3 }),
      pacRow({ committee_id: 'C2', total_amount: 3 }),
    ],
  });
  const result = await h.subject.getPacGiving(clientId, tenantId);
  expect(result.committees.map((committee) => committee.committeeId)).toEqual(['C2', 'C1']);
  expect(result.summary).toEqual({ totalAmount: 6, disbursementCount: 4, recipientCount: 2 });
  expect(result.committees[1]!.recipients[0]!.candidateName).toBeNull();
});

it('financial PAC requires every mapped committee and cycle and reports the earliest completed timestamp', async () => {
  const old = new Date('2026-01-01T00:00:00.000Z');
  const h = mapped({
    committeeMappings: [{ externalId: 'C1' }, { externalId: 'C2' }],
    pacSync: ['C1', 'C2'].flatMap((committeeId) =>
      [2022, 2024, 2026].map((cycle) => ({
        committeeId,
        cycle,
        status: 'complete',
        completedAt: committeeId === 'C2' && cycle === 2024 ? old : now,
      })),
    ),
  });
  const result = await h.subject.getPacGiving(clientId, tenantId);
  expect(result.coverage).toEqual({
    status: 'complete',
    cycles: [2022, 2024, 2026],
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    message: 'Contributions to federal candidates and committees, net of corrections.',
  });
  expect(result.summary).toEqual({ totalAmount: 0, disbursementCount: 0, recipientCount: 0 });
});

it.each([
  {
    label: 'stored unnamed row',
    rows: { pacRows: [pacRow({ recipient_name: null })] },
    last: null,
  },
  {
    label: 'one completed cycle',
    rows: { pacSync: [{ committeeId: 'C1', cycle: 2022, status: 'complete', completedAt: now }] },
    last: now.toISOString(),
  },
])(
  'financial PAC exposes partial coverage from $label without claiming complete',
  async (example) => {
    const result = await mapped(example.rows).subject.getPacGiving(clientId, tenantId);
    expect(result.coverage).toEqual({
      status: 'partial',
      cycles: [2022, 2024, 2026],
      lastSyncedAt: example.last,
      message: 'PAC data is incomplete or has not yet been verified for this reporting period.',
    });
  },
);

it('financial PAC error status takes precedence while retaining previously stored totals', async () => {
  const h = mapped({
    pacSync: [{ committeeId: 'C1', cycle: 2024, status: 'error', completedAt: now }],
    pacRows: [pacRow({ total_amount: -25 })],
  });
  const result = await h.subject.getPacGiving(clientId, tenantId);
  expect(result.coverage).toEqual({
    status: 'error',
    cycles: [2022, 2024, 2026],
    lastSyncedAt: now.toISOString(),
    message: 'The latest PAC refresh failed. Previously synced data may still be shown.',
  });
  expect(result.summary.totalAmount).toBe(-25);
});

it.each([
  { latest: 'pending', expected: 'partial' },
  { latest: 'complete', expected: 'complete' },
])('financial PAC uses the last duplicate sync state when it is $latest', async (example) => {
  const h = mapped({
    pacSync: [
      { committeeId: 'C1', cycle: 2022, status: 'complete', completedAt: now },
      { committeeId: 'C1', cycle: 2024, status: 'complete', completedAt: now },
      { committeeId: 'C1', cycle: 2026, status: 'complete', completedAt: now },
      { committeeId: 'C1', cycle: 2026, status: example.latest, completedAt: now },
    ],
  });
  expect((await h.subject.getPacGiving(clientId, tenantId)).coverage.status).toBe(example.expected);
});

it('financial PAC ignores foreign committee and future-cycle failures for coverage', async () => {
  const h = mapped({
    pacSync: [
      { committeeId: 'other', cycle: 2022, status: 'error', completedAt: now },
      { committeeId: 'C1', cycle: 2028, status: 'error', completedAt: now },
      { committeeId: 'C1', cycle: 2022, status: 'complete', completedAt: null },
    ],
  });
  expect((await h.subject.getPacGiving(clientId, tenantId)).coverage).toMatchObject({
    status: 'pending',
    lastSyncedAt: null,
  });
});

it.each(['committeeMappings', 'committeeCatalog', 'pacSync', 'pacRows'])(
  'financial PAC propagates %s failure without inventing a coverage result',
  async (operation) => {
    const failure = new Error(`failure:${operation}`);
    const h = harness({
      rows: { committeeMappings: [{ externalId: 'C1' }] },
      errors: { [operation]: failure },
    });
    await expect(h.subject.getPacGiving(clientId, tenantId)).rejects.toBe(failure);
    expect(h.callsOf(operation)).toHaveLength(1);
    if (operation !== 'pacRows') expect(h.callsOf('pacRows')).toEqual([]);
    if (operation === 'committeeMappings') expect(h.callsOf('committeeCatalog')).toEqual([]);
  },
);

it('financial PAC propagates malformed mapping identifiers before global reads', async () => {
  const h = mapped({ committeeMappings: [{ externalId: null }] });
  await expect(h.subject.getPacGiving(clientId, tenantId)).rejects.toThrow(TypeError);
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'committeeMappings']);
});
