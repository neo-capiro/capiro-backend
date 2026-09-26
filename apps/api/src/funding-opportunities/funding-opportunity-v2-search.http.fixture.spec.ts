import request from 'supertest';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FundingOpportunitiesFlagGuard } from './funding-opportunities-flag.guard.js';
import { readEnabledFundingSources } from './funding-opportunity-source-access.js';
import {
  FundingOpportunityV2SearchService,
  type OpportunityCatalogAdapter,
} from './funding-opportunity-v2-search.service.js';
import { FundingOpportunityV2SearchController } from './funding-opportunity-v2-search.controller.js';
import { FundingOpportunityV2DecoratorService } from './funding-opportunity-v2-decorator.service.js';

jest.mock('./funding-opportunity-source-access.js', () => ({
  readEnabledFundingSources: jest.fn(),
}));

/**
 * HTTP-facing coverage contract without a database. The real controller,
 * normalization, role guard and search service run; only tenant source flags,
 * catalog IO, and the outer feature guard are fixture-backed. The separate
 * isolated-PostgreSQL HTTP spec remains responsible for real flag/SQL wiring.
 */
describe('Funding Opportunity v2 HTTP source-coverage fixture', () => {
  const tenantContext: TenantContext = {
    tenantId: 'fixture-tenant',
    tenantSlug: 'fixture-tenant',
    userId: 'fixture-user',
    clerkUserId: 'fixture-clerk-user',
    role: 'standard_user',
  };
  let app: INestApplication;
  let enabledSources: Array<'grants_gov' | 'agency_forecast'>;
  const grantsSearch = jest.fn(async () => ({
    records: [], count: 0, grantsCount: 0, contractsCount: 0,
    activeCount: 0, closedCount: 0,
  }));
  const forecastSearch = jest.fn(async () => ({
    records: [], count: 0, grantsCount: 0, contractsCount: 0,
    activeCount: 0, closedCount: 0,
  }));
  const grantsHealth = jest.fn(async () => ({
    state: 'current' as const, recordCount: 0, activeRecordCount: 0,
    lastSyncedAt: '2026-09-24T00:00:00.000Z',
  }));
  const forecastHealth = jest.fn(async () => ({
    state: 'current' as const, recordCount: 0, activeRecordCount: 0,
    lastSyncedAt: '2026-09-24T00:00:00.000Z',
  }));

  beforeAll(async () => {
    const adapters: OpportunityCatalogAdapter[] = [
      { source: 'grants_gov', search: grantsSearch, health: grantsHealth },
      { source: 'agency_forecast', search: forecastSearch, health: forecastHealth },
    ];
    const searchService = new FundingOpportunityV2SearchService(
      adapters,
      { visibleClientIds: async () => [], read: async () => null },
      {} as PrismaService,
      { decorate: async (records: unknown[]) => records } as unknown as FundingOpportunityV2DecoratorService,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [FundingOpportunityV2SearchController],
      providers: [
        Reflector,
        RolesGuard,
        { provide: PrismaService, useValue: {} },
        { provide: FundingOpportunitiesFlagGuard, useValue: { canActivate: () => true } },
        { provide: FundingOpportunityV2SearchService, useValue: searchService },
      ],
    }).overrideGuard(FundingOpportunitiesFlagGuard).useValue({ canActivate: () => true }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = tenantContext;
      next();
    });
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    enabledSources = ['grants_gov'];
    jest.mocked(readEnabledFundingSources).mockImplementation(async () => enabledSources);
  });

  afterAll(async () => {
    await app?.close();
  });

  test('disabled-only request is unknown, not an exact zero or complete catalog', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/intelligence/opportunities/v2/search')
      .query({ mode: 'all', sources: 'agency_forecast', q: 'fixture-does-not-match' })
      .expect(200);

    expect(forecastSearch).not.toHaveBeenCalled();
    expect(forecastHealth).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      opportunities: [], total: null, catalogComplete: false, emptyReason: null,
      counts: { grants: null, contracts: null, active: null, closed: null },
      freshness: [{ source: 'agency_forecast', state: 'not_enabled', recordCount: null }],
      provenance: [{ source: 'agency_forecast', queried: false, returned: 0, count: null }],
    });
  });

  test('mixed request counts only enabled source and identifies disabled source as unqueried', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/intelligence/opportunities/v2/search')
      .query({ mode: 'all', sources: 'grants_gov,agency_forecast', q: 'fixture-does-not-match' })
      .expect(200);

    expect(grantsSearch).toHaveBeenCalledTimes(1);
    expect(forecastSearch).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      total: 0, catalogComplete: true, emptyReason: 'no_matches',
      freshness: [
        { source: 'grants_gov', state: 'current' },
        { source: 'agency_forecast', state: 'not_enabled' },
      ],
      provenance: [
        { source: 'grants_gov', queried: true, count: 0 },
        { source: 'agency_forecast', queried: false, count: null },
      ],
    });
  });

  test('enabled-only exact zero remains distinguishable from disabled-only unknown', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/intelligence/opportunities/v2/search')
      .query({ mode: 'all', sources: 'grants_gov', q: 'fixture-does-not-match' })
      .expect(200);

    expect(grantsSearch).toHaveBeenCalledTimes(1);
    expect(response.body).toMatchObject({
      total: 0, catalogComplete: true, emptyReason: 'no_matches',
      freshness: [{ source: 'grants_gov', state: 'current' }],
      provenance: [{ source: 'grants_gov', queried: true, count: 0 }],
    });
  });

  test('source-health route shows tenant-disabled source without querying it', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/intelligence/opportunities/v2/sources')
      .expect(200);

    expect(response.body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'agency_forecast', state: 'not_enabled', recordCount: null }),
    ]));
    expect(forecastHealth).not.toHaveBeenCalled();
  });
});
