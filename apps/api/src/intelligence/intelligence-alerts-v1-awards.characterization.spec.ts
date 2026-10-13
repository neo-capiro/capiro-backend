import {
  clientId,
  clientRow,
  contractorId,
  deferred,
  harness,
  installHooks,
  now,
  since,
  tenantId,
} from '../../test/fixtures/intelligence-alerts.js';

installHooks();

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    externalId: contractorId,
    externalName: 'Catalog Contractor',
    matchBasis: 'reviewed_name',
    matchTier: 1,
    ...overrides,
  };
}
function award(overrides: Record<string, unknown> = {}) {
  return {
    id: 'award-one',
    awardedAt: now,
    amount: '1250.6',
    awardingAgency: null,
    description: null,
    ...overrides,
  };
}

it('award UEI resolver keeps empty guard and last-row map authority in a global catalog query', async () => {
  const h = harness({
    rows: {
      contractors: [
        { id: contractorId, uei: 'FIRST' },
        { id: contractorId, uei: null },
        { id: 'second', uei: 'SECOND' },
      ],
    },
  });
  expect(await h.subject.resolveContractorUeisForAlerts([])).toEqual(new Map());
  expect(h.calls).toEqual([]);
  const ids = [contractorId, 'second'];
  expect(await h.subject.resolveContractorUeisForAlerts(ids)).toEqual(
    new Map([
      [contractorId, null],
      ['second', 'SECOND'],
    ]),
  );
  expect(h.callsOf('contractors')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: { id: { in: ids } },
        select: { id: true, uei: true },
      },
    ],
  });
});

it('award alerts eagerly read mapping and client in one transaction before the missing-mapping refusal', async () => {
  const held = deferred<unknown>();
  const h = harness({
    results: { contractMapping: held.promise },
    rows: { client: clientRow({ uei: 'AAAA1111BBBB' }) },
  });
  const pending = h.service.getContractAwardAlerts(clientId, tenantId, since);
  await h.started('client');
  expect(h.callsOf('contractMapping')).toHaveLength(1);
  expect(h.callsOf('client')[0]!.transaction).toBe(h.callsOf('contractMapping')[0]!.transaction);
  held.resolve(null);
  expect(await pending).toEqual([]);
  expect(h.callsOf('contractors')).toEqual([]);
  expect(h.callsOf('awards')).toEqual([]);
});

it('award alerts resolve UUID catalogs globally and use canonical UEI authority without reviewed-name union', async () => {
  const h = harness({
    rows: {
      contractMapping: mapping(),
      client: clientRow({ uei: ' aaaa1111bbbb ' }),
      contractors: [{ id: contractorId, uei: 'CCCC2222DDDD' }],
      awards: [award()],
    },
  });
  const resolve = jest.spyOn(h.subject, 'resolveContractorUeisForAlerts');
  expect((await h.service.getContractAwardAlerts(clientId, tenantId, since))[0]!.title).toBe(
    'New federal award: $1,251',
  );
  expect(h.callsOf('contractMapping')[0]).toMatchObject({
    tenantId,
    transaction: 1,
    scope: 'tenant',
    args: [
      {
        where: {
          clientId,
          source: 'contracting',
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: true,
        },
        select: { externalId: true, externalName: true, matchBasis: true, matchTier: true },
      },
    ],
  });
  expect(h.callsOf('client')[0]!.args).toEqual([
    { where: { id: clientId }, select: { uei: true } },
  ]);
  expect(resolve).toHaveBeenCalledWith([contractorId]);
  expect(resolve.mock.contexts[0]).toBe(h.service);
  expect(h.callsOf('awards')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: {
          recipientUei: { in: ['AAAA1111BBBB', 'CCCC2222DDDD'] },
          awardedAt: { gte: since },
        },
        orderBy: { awardedAt: 'desc' },
        take: 10,
      },
    ],
  });
  expect(h.events.indexOf('tenant:1:commit')).toBeLessThan(h.events.indexOf('start:contractors'));
});

it('award alerts keep reviewed exact-name fallback for non-UUID identities and missing clients', async () => {
  const h = harness({
    rows: {
      client: null,
      contractMapping: mapping({
        externalId: 'award-name:Name',
        externalName: ' ACME ',
        matchTier: 2,
      }),
    },
  });
  await h.service.getContractAwardAlerts(clientId, tenantId, since);
  expect(h.callsOf('contractors')).toEqual([]);
  expect(h.callsOf('awards')[0]!.args).toEqual([
    {
      where: {
        contractorName: { in: ['acme'], mode: 'insensitive' },
        awardedAt: { gte: since },
      },
      orderBy: { awardedAt: 'desc' },
      take: 10,
    },
  ]);
});

it.each<{ label: string; basis: string | null; tier: number | null }>([
  { label: 'unrecorded basis', basis: null, tier: null },
  { label: 'fuzzy basis', basis: 'fuzzy_name', tier: 1 },
  { label: 'fuzzy tier', basis: 'reviewed_name', tier: 4 },
])(
  'award alerts refuse $label without an authoritative UEI or global award scan',
  async (example) => {
    const h = harness({
      rows: {
        contractMapping: mapping({
          externalId: 'synthetic',
          matchBasis: example.basis,
          matchTier: example.tier,
        }),
      },
    });
    expect(await h.service.getContractAwardAlerts(clientId, tenantId, since)).toEqual([]);
    expect(h.callsOf('awards')).toEqual([]);
    expect(h.warnings).toEqual([]);
  },
);

it('award alerts retain amount coercion, skipped dates, subtitle caps and the five-visible early break', async () => {
  const h = harness({
    rows: {
      contractMapping: mapping({ externalId: 'synthetic' }),
      awards: [
        award({ id: 'undated', awardedAt: null, amount: Symbol('ignored') }),
        award({ id: 'positive', description: 'D'.repeat(70) }),
        award({ id: 'negative', amount: -20, awardingAgency: '' }),
        award({ id: 'null', amount: null }),
        award({ id: 'invalid', amount: 'bad' }),
        award({ id: 'decimal', amount: { valueOf: () => '1.2' } }),
        award({
          id: 'not-inspected',
          amount: {
            valueOf: () => {
              throw new Error('later');
            },
          },
        }),
      ],
    },
  });
  const result = await h.service.getContractAwardAlerts('client/one', tenantId, since);
  expect(result.map((alert) => alert.title)).toEqual([
    'New federal award: $1,251',
    'New federal award',
    'New federal award',
    'New federal award',
    'New federal award: $1',
  ]);
  expect(result[0]).toMatchObject({
    severity: 'notable',
    subtitle: `Federal agency · ${'D'.repeat(60)}`,
    when: now.toISOString(),
    countdownDays: null,
    countdownLabel: null,
    href: '/intelligence/changes?clientId=client%2Fone&source=contract_award',
    _urgencyScore: 25,
    _typeRank: 1,
  });
  expect(result[1]!.subtitle).toBe('');
  expect(h.warnings).toEqual([]);
});

it.each(['contractMapping', 'client', 'contractors', 'awards'])(
  'award alerts warn and return empty after %s failures',
  async (operation) => {
    const h = harness({
      rows: { contractMapping: mapping() },
      errors: { [operation]: new Error(`failed:${operation}`) },
    });
    expect(await h.service.getContractAwardAlerts(clientId, tenantId, since)).toEqual([]);
    expect(h.warnings).toEqual([
      `getContractAwardAlerts failed for ${clientId}: failed:${operation}`,
    ]);
  },
);

it('award alerts discard prior projections on a malformed later awarded date', async () => {
  const h = harness({
    rows: {
      contractMapping: mapping({ externalId: 'synthetic' }),
      awards: [award(), award({ awardedAt: new Date('invalid') })],
    },
  });
  expect(await h.service.getContractAwardAlerts(clientId, tenantId, since)).toEqual([]);
  expect(h.warnings[0]).toContain(`getContractAwardAlerts failed for ${clientId}:`);
});
