jest.mock('../clients/client-capabilities.service.js', () => ({
  ClientCapabilitiesService: jest.fn(),
}));
jest.mock('../clients/client-people.service.js', () => ({ ClientPeopleService: jest.fn() }));
jest.mock('../clients/client-facilities.service.js', () => ({
  ClientFacilitiesService: jest.fn(),
}));
jest.mock('../engagement/mail-sender.service.js', () => ({ EngagementMailSender: jest.fn() }));
jest.mock('../regulatory-docket/regulatory-docket.service.js', () => ({
  RegulatoryDocketService: jest.fn(),
}));
jest.mock('../lda-intel/lda-intel.service.js', () => ({ LdaIntelService: jest.fn() }));
jest.mock('../lobby-intel/lobby-intel.service.js', () => ({ LobbyIntelService: jest.fn() }));
jest.mock('../federal-spending/federal-spending.service.js', () => ({
  FederalSpendingService: jest.fn(),
}));
jest.mock('./analytics/analytics-db.service.js', () => ({ AnalyticsDbService: jest.fn() }));
jest.mock('../intelligence/actions/action-recommendation-read.service.js', () => ({
  ActionRecommendationReadService: jest.fn(),
}));
jest.mock('../intelligence/intelligence.service.js', () => ({ IntelligenceService: jest.fn() }));
jest.mock('../clients/clients.service.js', () => ({ ClientsService: jest.fn() }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: jest.fn() }));
jest.mock('../program-element/program-element-read.service.js', () => ({
  ProgramElementReadService: jest.fn(),
}));
jest.mock('../acquisition-personnel/acquisition-personnel-read.service.js', () => ({
  AcquisitionPersonnelReadService: jest.fn(),
}));
jest.mock('../memory/memory-candidate.service.js', () => ({ MemoryCandidateService: jest.fn() }));
jest.mock('../memory/memory-ingest.service.js', () => ({ MemoryIngestService: jest.fn() }));
jest.mock('../memory/memory-store.service.js', () => ({ MemoryStoreService: jest.fn() }));
jest.mock('../clients/representation-resolver.service.js', () => ({
  RepresentationResolverService: jest.fn(),
}));
jest.mock('./meri-docgen.service.js', () => ({ MeriDocgenService: jest.fn() }));
jest.mock('./meri-context-plane.service.js', () => ({ MeriContextPlaneService: jest.fn() }));
jest.mock('../funding-opportunities/meri-opportunity-tools.adapter.js', () => ({
  MeriOpportunityToolsAdapter: jest.fn(),
}));
// These contracts stub the domain ports; loading the unrelated mail/generation graph is unnecessary.
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: jest.fn() }));
jest.mock('./meri-defense-budget-tool.helpers.js', () => ({}));

import type { TenantContext } from '@capiro/shared';
import { FederalMarketService } from '../federal-spending/federal-market.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MeriToolsService } from './meri-tools.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', role: 'standard_user' } as TenantContext;

function harness() {
  const actionDate = new Date('2026-03-04T00:00:00.000Z');
  const row = {
    id: 'award-1',
    contractorName: 'Example Systems',
    awardingAgency: 'Army',
    awardingSubTier: 'ACC',
    amount: 100,
    description: 'Radar testing',
    peCode: '0604201A',
    recipientState: 'MD',
    popCongressionalDistrict: '10',
    actionDate,
    piid: 'PIID-1',
    latestActionDate: actionDate,
    baseAwardSignedDate: null,
    sourceLastModifiedDate: null,
    popStartDate: null,
    popEndDate: null,
    lastSyncedAt: actionDate,
  };
  const federalAward = {
    findMany: jest.fn().mockResolvedValue([row]),
    count: jest.fn().mockResolvedValue(45),
  };
  const prisma = { withSystem: jest.fn(async (read) => read({ federalAward })) };
  const owner = new FederalMarketService(prisma as unknown as PrismaService);
  const ownerRead = jest.spyOn(owner, 'listLegacyGlobalContracts');
  const service = Object.assign(Object.create(MeriToolsService.prototype), {
    prisma,
    federalMarket: owner,
    logger: { warn: jest.fn() },
  }) as MeriToolsService;
  return { service, ownerRead, federalAward, row };
}

describe('legacy award tool delegates to Federal Market without changing its public contract', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, MERI_EVIDENCE_ACCURACY_MODE: 'off' };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it.each(['execute', 'executeFromAuthenticatedUser'] as const)(
    '%s retains legacy fields and global PE search despite a pinned client',
    async (entrypoint) => {
      const { service, ownerRead, federalAward, row } = harness();
      const result = await service[entrypoint](ctx, 'search_federal_awards', {
        clientId: 'pinned-client',
        query: 'radar',
        agency: 'Army',
        peCode: '0604201a',
        page: 2,
      });
      expect(ownerRead).toHaveBeenCalledWith({
        q: 'radar',
        agency: 'Army',
        peCode: '0604201a',
        page: 2,
        pageSize: 20,
      });
      expect(federalAward.findMany.mock.calls[0]?.[0]).toMatchObject({
        where: { peCode: '0604201A' },
        take: 20,
        skip: 20,
      });
      expect(result).toMatchObject({
        tool: 'search_federal_awards',
        total: 45,
        page: 2,
        pageSize: 20,
        hasMore: true,
        nextPage: 3,
        paginationLimitReached: false,
        data: [row],
      });
      expect(result).toEqual(expect.objectContaining({ data: [row] }));
    },
  );

  it('keeps defaults and exposes continuation on the legacy schema', async () => {
    const { service, ownerRead } = harness();
    await service.execute(ctx, 'search_federal_awards', {});
    expect(ownerRead).toHaveBeenCalledWith({
      q: undefined,
      agency: undefined,
      peCode: undefined,
      page: 1,
      pageSize: 20,
    });
    expect(
      service.anthropicToolSchemas().find((tool) => tool.name === 'search_federal_awards')!
        .input_schema,
    ).toMatchObject({ properties: { page: { type: 'integer' } } });
  });

  it.each([0, -1, 1.5, true, '', '2.5', [], {}, 10_001])(
    'rejects invalid legacy page %p',
    async (page) => {
      const { service, ownerRead } = harness();
      await expect(service.execute(ctx, 'search_federal_awards', { page })).rejects.toThrow(
        'page must be an integer',
      );
      expect(ownerRead).not.toHaveBeenCalled();
    },
  );

  it('reports the upper pagination boundary without inventing a next page', async () => {
    const { service, federalAward } = harness();
    federalAward.count.mockResolvedValue(500_001);
    const result = await service.execute(ctx, 'search_federal_awards', { page: 10_000, limit: 50 });
    expect(result).toMatchObject({ hasMore: true, nextPage: null, paginationLimitReached: true });
  });

  it('reports exhausted pages and requires the injected owner', async () => {
    const { service, federalAward } = harness();
    federalAward.count.mockResolvedValue(1);
    expect(await service.execute(ctx, 'search_federal_awards', {})).toMatchObject({
      hasMore: false,
      nextPage: null,
    });
    Object.assign(service, { federalMarket: undefined });
    await expect(service.execute(ctx, 'search_federal_awards', {})).rejects.toThrow(
      'Federal Market reader is not configured',
    );
  });

  it('preserves enforced date semantics without turning latest action into an award date', async () => {
    const enforceCtx = { ...ctx, tenantId: '17b63099-bc0f-4ac5-b596-496161e9481e' };
    process.env = {
      ...process.env,
      MERI_EVIDENCE_ACCURACY_MODE: 'enforce',
      MERI_EVIDENCE_ACCURACY_TENANTS: enforceCtx.tenantId,
      MERI_EVIDENCE_ACCURACY_SURFACES: 'chat',
    };
    const { service, row } = harness();
    expect(await service.execute(enforceCtx, 'search_federal_awards', {})).toMatchObject({
      data: [
        {
          ...row,
          dates: {
            latestActionDate: row.actionDate.toISOString(),
            baseAwardSignedDate: null,
            sourceLastModifiedDate: null,
            capiroSyncedAt: row.lastSyncedAt.toISOString(),
          },
        },
      ],
    });
  });
});
