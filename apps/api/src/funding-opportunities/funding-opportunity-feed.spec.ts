import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FundingOpportunityFeedService } from './funding-opportunity-feed.service.js';
import {
  FundingOpportunityInboxService,
  encodeInboxCursor,
} from './funding-opportunity-inbox.service.js';

const AT = new Date('2026-09-06T00:00:00.000Z');
const forecast = {
  tangoForecastId: 'forecast-1',
  title: 'Aircraft maintenance',
  description: 'Agency procurement plan',
  agency: 'VA',
  sourceUrl: null,
  anticipatedAwardDate: new Date('2027-04-01'),
  estimatedPeriod: 'FY27 Q3',
  fiscalYear: 2027,
  status: 'Planned',
  isActive: true,
  sourceSystem: 'VA',
  naicsCode: '336411',
  providerModifiedAt: AT,
  lastSyncedAt: AT,
};

function setup(
  options: {
    flags?: string[];
    walled?: boolean;
    workflow?: Record<string, unknown>;
  } = {},
) {
  const flags = options.flags ?? [
    'funding_opportunities',
    'funding_opportunities_forecasts',
    'funding_opportunities_sbir',
  ];
  const tx = {
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, feature: string) =>
      flags.includes(feature) ? [{ ok: 1 }] : [],
    ),
    client: {
      findMany: jest.fn(async () => [
        { id: 'client-1', name: 'Acme', memoryWall: options.walled ?? false },
      ]),
    },
    clientMemoryAccess: { findMany: jest.fn(async () => []) },
    user: {
      findFirst: jest.fn(async () => ({ id: 'user-1' })),
      findMany: jest.fn(async () => []),
    },
    clientFundingOpportunity: {
      findFirst: jest.fn(async () => options.workflow ?? null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }) => ({ id: 'workflow-1', ...data })),
      update: jest.fn(async ({ data }) => ({ ...options.workflow, ...data })),
    },
    auditLog: { create: jest.fn(async (args) => args) },
  };
  const prisma: any = {
    withSystem: jest.fn(async (run) => run(tx)),
    withTenant: jest.fn(async (_tenant, run) => run(tx)),
    $queryRaw: jest.fn(async () => [
      {
        started_at: AT,
        finished_at: AT,
        status: 'success',
        error_count: 0,
        last_success_at: AT,
      },
    ]),
    tangoProcurementForecast: {
      aggregate: jest.fn(async () => ({ _max: { lastSyncedAt: AT } })),
      findMany: jest.fn(async () => [forecast]),
      findUnique: jest.fn(async () => forecast),
      count: jest.fn(async () => 103),
    },
    tangoDibbsSolicitation: {
      aggregate: jest.fn(async () => ({ _max: { lastSyncedAt: AT } })),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      findUnique: jest.fn(async () => ({
        tangoDibbsId: 'd-1',
        solicitation: 'SPR-1',
        nomenclature: 'Rotor',
        documentType: 'rfq',
        isOpen: false,
        lastSyncedAt: AT,
        updatedAt: AT,
        closesDate: AT,
        documentUrl: 'https://www.dibbs.bsm.dla.mil/example',
        quantity: null,
      })),
    },
    tangoSbirTopic: {
      aggregate: jest.fn(async () => ({ _max: { lastSyncedAt: AT } })),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    tangoSbirSolicitation: { findMany: jest.fn(async () => []) },
  };
  return { prisma, tx, service: new FundingOpportunityFeedService(prisma) };
}

describe('Tango feeds are bounded source reads', () => {
  test('forecast Browse paginates the global catalog without needing a client or suggestions', async () => {
    const { service, prisma, tx } = setup();
    const result = await service.list('tenant', 'actor', 'agency_forecast', {
      page: 3,
      pageSize: 25,
      q: 'aircraft',
      naics: '336411',
    });
    expect(result).toMatchObject({
      total: 103,
      page: 3,
      pageSize: 25,
      hasMore: true,
      clientId: null,
    });
    expect(prisma.tangoProcurementForecast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 50,
        take: 25,
        orderBy: [
          { providerModifiedAt: { sort: 'desc', nulls: 'last' } },
          { tangoForecastId: 'asc' },
        ],
      }),
    );
    expect(tx.clientFundingOpportunity.findMany).not.toHaveBeenCalled();
    expect(result.rows[0]).toMatchObject({
      responseDeadline: null,
      anticipatedAwardDate: '2027-04-01',
      sourceUrl: null,
      workflow: null,
    });
  });

  test('search and lifecycle predicates also constrain counts, including unknown active states', async () => {
    const { service, prisma } = setup();
    await service.list('tenant', 'actor', 'agency_forecast', {
      q: 'repair',
      activeState: 'active',
    });
    const query = prisma.tangoProcurementForecast.findMany.mock.calls[0][0];
    expect(prisma.tangoProcurementForecast.count).toHaveBeenCalledWith({
      where: query.where,
    });
    expect(query.where.AND).toContainEqual({
      OR: [{ isActive: true }, { isActive: null }],
    });
  });

  test('unsupported NAICS cannot silently return an unfiltered DIBBS or SBIR catalog', async () => {
    const { service, prisma } = setup();
    await expect(service.list('tenant', 'actor', 'dibbs', { naics: '336411' })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.tangoDibbsSolicitation.findMany).not.toHaveBeenCalled();
  });

  test('a failed latest source run remains failed even when a successful run exists', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([
      {
        started_at: AT,
        finished_at: AT,
        status: 'error',
        error_count: 1,
        last_success_at: AT,
      },
    ]);
    expect((await service.list('tenant', 'actor', 'agency_forecast', {})).freshness).toMatchObject({
      state: 'failed',
      lastSuccessAt: AT.toISOString(),
    });
  });
});

describe('source flags gate reads, writes, inbox pages and counts', () => {
  test('master off blocks a forecast even when its source flag is on', async () => {
    const { service, prisma } = setup({
      flags: ['funding_opportunities_forecasts'],
    });
    await expect(service.list('tenant', 'actor', 'agency_forecast', {})).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.tangoProcurementForecast.findMany).not.toHaveBeenCalled();
  });
  test('forecast off blocks detail and Save before any source or workflow write', async () => {
    const { service, prisma, tx } = setup({ flags: ['funding_opportunities'] });
    await expect(
      service.detail('tenant', 'actor', 'agency_forecast', 'forecast-1'),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.write('tenant', 'actor', 'client-1', 'agency_forecast', 'forecast-1', {
        status: 'saved',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.tangoProcurementForecast.findUnique).not.toHaveBeenCalled();
    expect(tx.clientFundingOpportunity.create).not.toHaveBeenCalled();
  });
  test('DIBBS remains available with the approved master-only rule', async () => {
    const { service } = setup({ flags: ['funding_opportunities'] });
    await expect(service.list('tenant', 'actor', 'dibbs', {})).resolves.toMatchObject({
      source: 'dibbs',
    });
  });
  test('disabled sources are removed in SQL before pagination and from every count', async () => {
    const { prisma, tx } = setup({ flags: ['funding_opportunities'] });
    await new FundingOpportunityInboxService(prisma).list('tenant', 'actor', {
      filter: 'suggested',
      pageSize: 1,
    });
    expect(tx.clientFundingOpportunity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: expect.objectContaining({
          source: { in: ['grants_gov', 'sam_gov', 'dibbs'] },
        }),
      }),
    );
    for (const [args] of tx.clientFundingOpportunity.count.mock.calls as any[])
      expect(args.where.source).toEqual({
        in: ['grants_gov', 'sam_gov', 'dibbs'],
      });
  });
  test('explicit disabled source returns 404 without querying or leaking counts', async () => {
    const { prisma, tx } = setup({ flags: ['funding_opportunities'] });
    await expect(
      new FundingOpportunityInboxService(prisma).list('tenant', 'actor', {
        source: 'sbir_sttr',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(tx.clientFundingOpportunity.count).not.toHaveBeenCalled();
  });
  test('a pursuing cursor cannot overwrite the pursuing OR predicate', async () => {
    const { prisma, tx } = setup();
    await new FundingOpportunityInboxService(prisma).list('tenant', 'actor', {
      filter: 'pursuing',
      cursor: encodeInboxCursor(AT, 'wf-1'),
    });
    const where = (tx.clientFundingOpportunity.findMany.mock.calls as any[])[0][0].where;
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0].AND[0]).toEqual({
      OR: [{ workflowStatus: 'pursuing' }, { humanDecision: 'pursue' }],
    });
    expect(where.AND[1].OR).toBeDefined();
  });
});

describe('forecast decisions keep their distinct meaning', () => {
  test('Save creates a client record with no decision, task or fabricated deadline', async () => {
    const { service, tx } = setup();
    await service.write('tenant', 'actor', 'client-1', 'agency_forecast', 'forecast-1', {
      status: 'saved',
    });
    expect(tx.clientFundingOpportunity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: 'client-1',
        source: 'agency_forecast',
        sourceRecordKey: 'forecast-1',
        workflowStatus: 'saved',
        responseDeadlineSnapshot: null,
        userCreated: true,
      }),
    });
    expect(
      (tx.clientFundingOpportunity.create.mock.calls as any[])[0][0].data.humanDecision,
    ).toBeUndefined();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
  test('Watch persists monitor without inventing a response deadline', async () => {
    const { service, tx } = setup();
    await service.write('tenant', 'actor', 'client-1', 'agency_forecast', 'forecast-1', {
      decision: 'monitor',
    });
    expect((tx.clientFundingOpportunity.create.mock.calls as any[])[0][0].data).toMatchObject({
      humanDecision: 'monitor',
      responseDeadlineSnapshot: null,
    });
  });
  test.each([
    { decision: 'pursue' as const },
    { status: 'pursuing' as const },
    { status: 'won' as const },
  ])('forecasts refuse a solicitation action %p', async (input) => {
    const { service, tx } = setup();
    await expect(
      service.write('tenant', 'actor', 'client-1', 'agency_forecast', 'forecast-1', input),
    ).rejects.toThrow(BadRequestException);
    expect(tx.clientFundingOpportunity.create).not.toHaveBeenCalled();
  });
  test('closed DIBBS detail stays readable but pursuit is refused', async () => {
    const { service, tx } = setup();
    expect(await service.detail('tenant', 'actor', 'dibbs', 'd-1')).toMatchObject({
      isActive: false,
      sourceUrl: 'https://www.dibbs.bsm.dla.mil/example',
    });
    await expect(
      service.write('tenant', 'actor', 'client-1', 'dibbs', 'd-1', {
        decision: 'pursue',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(tx.clientFundingOpportunity.create).not.toHaveBeenCalled();
  });
  test('a walled client cannot be read or written without an explicit grant', async () => {
    const { service, tx } = setup({ walled: true });
    await expect(
      service.detail('tenant', 'actor', 'agency_forecast', 'forecast-1', 'client-1'),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.write('tenant', 'actor', 'client-1', 'agency_forecast', 'forecast-1', {
        decision: 'monitor',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(tx.clientFundingOpportunity.create).not.toHaveBeenCalled();
  });
});

describe('safe edits of existing client decisions', () => {
  test('Save preserves a pursuit and Watch cannot replace it', async () => {
    const workflow = {
      id: 'wf-1',
      workflowStatus: 'pursuing',
      humanDecision: 'pursue',
      decisionAt: AT,
      decisionByUserId: 'actor',
    };
    const { service, tx } = setup({ workflow });
    await service.write('tenant', 'actor', 'client-1', 'agency_forecast', 'forecast-1', {
      status: 'saved',
    });
    expect((tx.clientFundingOpportunity.update.mock.calls as any[])[0][0].data.workflowStatus).toBe(
      'pursuing',
    );
    await expect(
      service.write('tenant', 'actor', 'client-1', 'agency_forecast', 'forecast-1', {
        decision: 'monitor',
      }),
    ).rejects.toThrow(BadRequestException);
  });
  test('Watch rechecks the committed decision after acquiring the row lock', async () => {
    const workflow = {
      id: 'wf-1',
      workflowStatus: 'saved',
      humanDecision: null as string | null,
    };
    const { service, tx } = setup({ workflow });
    tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray, value: string) => {
      if (sql.join('').includes('FOR UPDATE')) {
        workflow.humanDecision = 'pursue';
        workflow.workflowStatus = 'pursuing';
        return [];
      }
      return ['funding_opportunities', 'funding_opportunities_forecasts'].includes(value)
        ? [{ ok: 1 }]
        : [];
    });
    await expect(
      service.write('tenant', 'actor', 'client-1', 'agency_forecast', 'forecast-1', {
        decision: 'monitor',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(tx.clientFundingOpportunity.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.clientFundingOpportunity.update).not.toHaveBeenCalled();
  });
  test('existing catalog observations without a complete run are unknown, not unsynced', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    expect((await service.list('tenant', 'actor', 'agency_forecast', {})).freshness).toMatchObject({
      state: 'unknown',
      lastObservedAt: AT.toISOString(),
    });
  });
});

describe('Tango team-plan edits', () => {
  test('a date-only edit uses the existing action without making a decision', async () => {
    const { service } = setup({
      workflow: {
        id: 'wf-1',
        workflowStatus: 'saved',
        humanDecision: null,
        nextAction: 'Confirm agency timing',
        nextActionDueAt: null,
      },
    });
    const result = await service.write(
      'tenant',
      'actor',
      'client-1',
      'agency_forecast',
      'forecast-1',
      { nextActionDueAt: '2026-10-01T00:00:00Z' },
    );
    expect(result).toMatchObject({
      status: 'saved',
      nextAction: 'Confirm agency timing',
      nextActionDueAt: '2026-10-01T00:00:00.000Z',
      decision: null,
    });
  });
  test('saved forecast details expose the plan even when there is no human decision', async () => {
    const { service } = setup({
      workflow: {
        id: 'wf-1',
        workflowStatus: 'saved',
        humanDecision: null,
        nextAction: 'Confirm agency timing',
        nextActionDueAt: AT,
      },
    });
    const result = await service.detail(
      'tenant',
      'actor',
      'agency_forecast',
      'forecast-1',
      'client-1',
    );
    expect(result.workflow).toMatchObject({
      nextAction: 'Confirm agency timing',
      nextActionDueAt: AT.toISOString(),
    });
    expect(result.decision).toBeNull();
  });
});
