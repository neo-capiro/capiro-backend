import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  client,
  clientId,
  deferred,
  harness,
  inputOf,
  installHooks,
  now,
  tenantId,
  userId,
} from '../../test/fixtures/intelligence-portfolio.js';

installHooks();

describe('Portfolio summary original count and monetary projections', () => {
  test('keeps seven summary fields, tenant membership, raw finite LDA IDs, quarter dollars and scoped strategy count', async () => {
    const h = harness({
      rows: {
        clients: [
          client({ profileStatus: 'PAUSED' }),
          client({ id: 'c2', profileStatus: 'MONITORING' }),
          client({ id: 'c3' }),
        ],
        mappings: ['12', '12', '0', '-1', '1.5', 'Infinity', 'bad']
          .map((externalId) => ({ clientId, externalId }))
          .concat([{ clientId: 'foreign', externalId: '99' }]),
        meetingCount: 7,
        bills: 19,
        strategies: [{ count: 8n }],
        regulationCount: 257,
        ldaSpend: [{ total: '12.50' }],
      },
    });
    expect(await h.service.getPortfolioSummary(tenantId, userId)).toEqual({
      activeClients: 3,
      needAttention: 2,
      ldaSpendQtd: 12.5,
      billsTracked: 19,
      activeRegulations: 257,
      meetingsThisWeek: 7,
      activeStrategies: 8,
    });
    expect(h.callsOf('strategies')[0]).toMatchObject({ scope: 'tenant', tenantId, transaction: 1 });
    expect(h.callsOf('strategies')[0]!.query!.values).toEqual([tenantId]);
    expect(h.callsOf('strategies')[0]!.query!.sql).toContain('archived_at IS NULL');
    expect(h.callsOf('ldaSpend')[0]).toMatchObject({ scope: 'global' });
    expect(h.callsOf('ldaSpend')[0]!.query!.values).toEqual([
      [12, 12, 0, -1, 1.5],
      new Date(2026, 9, 1),
    ]);
    expect(h.callsOf('ldaSpend')[0]!.query!.sql).toContain('dt_posted >= ?');
    expect(h.callsOf('bills')[0]!.args).toEqual([]);
  });
  test('keeps empty portfolio zero defaults without a global LDA query', async () => {
    const h = harness();
    expect(await h.service.getPortfolioSummary(tenantId, userId)).toEqual({
      activeClients: 0,
      needAttention: 0,
      ldaSpendQtd: 0,
      billsTracked: 0,
      activeRegulations: 0,
      meetingsThisWeek: 0,
      activeStrategies: 0,
    });
    expect(h.callsOf('ldaSpend')).toEqual([]);
  });
  test('catches only the tenant strategy SQL failure and still commits the count scope', async () => {
    const h = harness({
      rows: { bills: 19 },
      errors: { strategies: new Error('Strategy unavailable') },
    });
    expect(await h.service.getPortfolioSummary(tenantId, userId)).toMatchObject({
      activeStrategies: 0,
      billsTracked: 19,
    });
    expect(h.transactions[0]!.outcome).toBe('commit');
  });
});

describe('Portfolio summary meeting association and week boundary', () => {
  test('keeps own calendar plus explicit/contact associations, normalized email dedupe, and an eight-day inclusive window allowance', async () => {
    const h = harness({
      rows: {
        clients: [
          client({
            primaryContactEmail: ' MAIN@EXAMPLE.TEST ',
            people: [{ email: 'main@example.test' }, { email: null }],
          }),
        ],
      },
    });
    await h.service.getPortfolioSummary(tenantId, userId, {
      from: '2026-10-12T04:00:00Z',
      to: '2026-10-20T04:00:00Z',
    });
    expect(inputOf(h, 'clients')).toEqual({
      where: { tenantId, status: { not: 'archived' } },
      select: {
        id: true,
        profileStatus: true,
        primaryContactEmail: true,
        people: { where: { tenantId }, select: { email: true } },
      },
    });
    expect(inputOf(h, 'meetingCount')).toEqual({
      where: {
        tenantId,
        OR: [{ createdByUserId: userId }, { connection: { createdByUserId: userId } }],
        startsAt: { gte: new Date('2026-10-12T04:00:00Z'), lt: new Date('2026-10-20T04:00:00Z') },
        AND: [
          {
            OR: [
              { clientId },
              {
                clientId: null,
                isInternal: false,
                AND: [
                  {
                    OR: [
                      { associationSignals: { path: ['manual'], equals: Prisma.AnyNull } },
                      { associationSignals: { path: ['manual'], equals: false } },
                    ],
                  },
                  {
                    OR: [
                      { organizerEmail: { in: ['main@example.test'] } },
                      { attendees: { some: { email: { in: ['main@example.test'] } } } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        isInternal: false,
        status: { notIn: ['cancelled', 'canceled', 'deleted'] },
      },
    });
    expect(inputOf(h, 'regulationCount')).toEqual({
      where: { type: { in: ['PROPOSED_RULE', 'RULE'] }, commentEndDate: { gt: now } },
    });
  });
  test('uses the server-local Monday week for empty optional bounds and an empty association set', async () => {
    const h = harness();
    await h.service.getPortfolioSummary(tenantId, '', { from: '', to: '' });
    expect(inputOf(h, 'meetingCount')).toMatchObject({
      where: {
        OR: [{ createdByUserId: '' }, { connection: { createdByUserId: '' } }],
        startsAt: { gte: new Date(2026, 9, 12), lt: new Date(2026, 9, 19) },
        AND: [{ OR: [{ clientId: { in: [] } }] }],
      },
    });
  });
});

describe('Portfolio summary week validation before readers', () => {
  test.each([
    { from: 'invalid', to: '2026-10-19T00:00:00Z' },
    { from: '2026-10-12T00:00:00Z', to: 'invalid' },
    { from: '2026-10-12T00:00:00Z', to: '2026-10-12T00:00:00Z' },
    { from: '2026-10-13T00:00:00Z', to: '2026-10-12T00:00:00Z' },
    { from: '2026-10-12T00:00:00Z', to: '2026-10-20T00:00:00.001Z' },
  ])('refuses the invalid window %p', async (window) => {
    const h = harness();
    await expect(h.service.getPortfolioSummary(tenantId, userId, window)).rejects.toThrow(
      new BadRequestException('A valid week window is required'),
    );
    expect(h.calls).toEqual([]);
  });
});

describe('Portfolio summary parallel phases and fatal failures', () => {
  test('starts global regulation count beside client lookup, then four tenant counts, then LDA after both outer stages', async () => {
    const clients = deferred<unknown[]>();
    const regulation = deferred<number>();
    const h = harness({
      rows: {
        clients: clients.promise,
        regulationCount: regulation.promise,
        mappings: [{ clientId, externalId: '12' }],
      },
    });
    const pending = h.service.getPortfolioSummary(tenantId, userId);
    await h.started('regulationCount');
    expect(h.callsOf('mappings')).toEqual([]);
    clients.resolve([client()]);
    await h.started('strategies');
    expect(
      h.calls
        .filter((call) =>
          ['mappings', 'meetingCount', 'bills', 'strategies'].includes(call.operation),
        )
        .map((call) => call.operation),
    ).toEqual(['mappings', 'meetingCount', 'bills', 'strategies']);
    expect(h.callsOf('ldaSpend')).toEqual([]);
    regulation.resolve(0);
    await pending;
    expect(h.callsOf('ldaSpend')).toHaveLength(1);
  });
  test.each(['clients', 'mappings', 'meetingCount', 'bills', 'regulationCount', 'ldaSpend'])(
    'keeps %s failure fatal',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({
        rows: { clients: [client()], mappings: [{ clientId, externalId: '12' }] },
        errors: { [operation]: error },
      });
      await expect(h.service.getPortfolioSummary(tenantId, userId)).rejects.toBe(error);
    },
  );
});
