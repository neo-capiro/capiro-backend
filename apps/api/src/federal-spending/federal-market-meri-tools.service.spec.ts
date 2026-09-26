import type { TenantContext } from '@capiro/shared';
import type { FederalMarketGeographyService } from './federal-market-geography.service.js';
import type { FederalMarketService } from './federal-market.service.js';
import {
  FEDERAL_MARKET_MERI_TOOL_DEFINITIONS,
  FederalMarketMeriToolsService,
} from './federal-market-meri-tools.service.js';

const ctx = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  role: 'standard_user',
} as TenantContext;

function marketMock() {
  return {
    listContracts: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
    listSubawards: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
    listVehicles: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
    listForecasts: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
  };
}

function geographyMock() {
  return {
    geography: jest.fn().mockResolvedValue({
      districts: [],
      stateSubawards: [],
      futureSignals: [],
      awardedMoneyIncludesFutureOpportunities: false,
      warnings: [],
    }),
  };
}

function serviceWith(market = marketMock(), geography = geographyMock()) {
  return {
    market,
    geography,
    service: new FederalMarketMeriToolsService(
      market as unknown as FederalMarketService,
      geography as unknown as FederalMarketGeographyService,
    ),
  };
}

describe('FederalMarketMeriToolsService', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each([
    ['search_federal_contract_awards', 'listContracts'],
    ['search_federal_subawards', 'listSubawards'],
    ['search_contract_vehicles', 'listVehicles'],
    ['search_procurement_forecasts', 'listForecasts'],
    ['get_district_federal_market', 'geography'],
  ] as const)('advertised %s schema dispatches to its existing domain handler', async (name, method) => {
    const { service, market, geography } = serviceWith();
    expect(service.anthropicSchemas().some((schema) => schema.name === name)).toBe(true);
    expect(service.has(name)).toBe(true);
    const result = await service.execute(ctx, name, { state: 'VA', district: '10', query: 'autonomy' });
    const handler = method === 'geography' ? geography.geography : market[method];
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.tool).toBe(name);
  });

  it('registers five bounded read-only local tools', () => {
    const { service } = serviceWith();
    const schemas = service.anthropicSchemas();

    expect(schemas.map((schema) => schema.name)).toEqual(
      FEDERAL_MARKET_MERI_TOOL_DEFINITIONS.map((tool) => tool.name),
    );
    expect(schemas).toHaveLength(5);
    expect(schemas.every((schema) => schema.input_schema.type === 'object')).toBe(true);
  });

  it('routes contract search to the local market service with tenant and client scope', async () => {
    const { service, market } = serviceWith();

    await service.execute(ctx, 'search_federal_contract_awards', {
      clientId: 'client-1',
      query: 'autonomy',
      limit: 7,
    });

    expect(market.listContracts).toHaveBeenCalledWith('tenant-1', {
      clientId: 'client-1',
      q: 'autonomy',
      agency: undefined,
      recipient: undefined,
      state: undefined,
      district: undefined,
      fiscalYear: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      page: 1,
      pageSize: 7,
    });
  });

  it('keeps locally synced contract filters and returned date/source fields distinct from PE search', async () => {
    const item = {
      id: 'award-row-1',
      awardId: 'CONT_AWD_123',
      recipientName: 'Reviewed Recipient LLC',
      recipientUei: 'UEI123456789',
      amount: 123456.78,
      actionDate: '2025-03-01',
      latestActionDate: '2025-04-01',
      baseAwardSignedDate: '2024-10-01',
      sourceLastModifiedDate: '2025-04-02T00:00:00.000Z',
      popStartDate: '2025-03-01',
      popEndDate: '2026-02-28',
      state: 'VA',
      district: '10',
      districtKey: 'VA-10',
      source: 'usaspending' as const,
      sourceUpdatedAt: '2025-04-03T00:00:00.000Z',
    };
    const market = marketMock();
    market.listContracts.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
      pageSize: 10,
      source: 'USAspending / Capiro first-party ingestion',
      asOf: '2025-04-03T00:00:00.000Z',
    });
    const { service } = serviceWith(market);
    const contractSchema = service
      .anthropicSchemas()
      .find((schema) => schema.name === 'search_federal_contract_awards')!;
    expect(contractSchema.input_schema.properties).toHaveProperty('dateFrom');
    expect(contractSchema.input_schema.properties).toHaveProperty('state');
    expect(contractSchema.input_schema.properties).not.toHaveProperty('peCode');

    const result = await service.execute(ctx, 'search_federal_contract_awards', {
      clientId: 'client-1',
      dateFrom: '2025-01-01',
      dateTo: '2025-12-31',
      state: 'VA',
      district: '10',
    });
    expect(market.listContracts).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({
        clientId: 'client-1',
        dateFrom: '2025-01-01',
        dateTo: '2025-12-31',
        state: 'VA',
        district: '10',
      }),
    );
    expect(result).toMatchObject({
      source: 'USAspending / Capiro first-party ingestion',
      asOf: '2025-04-03T00:00:00.000Z',
      items: [
        expect.objectContaining({
          amount: 123456.78,
          actionDate: '2025-03-01',
          latestActionDate: '2025-04-01',
          baseAwardSignedDate: '2024-10-01',
          source: 'usaspending',
          sourceUpdatedAt: '2025-04-03T00:00:00.000Z',
        }),
      ],
    });
  });

  it('never sends clientId into global forecast search as a pretend client match', async () => {
    const { service, market } = serviceWith();

    await service.execute(ctx, 'search_procurement_forecasts', {
      clientId: 'client-1',
      agency: 'Army',
    });

    expect(market.listForecasts).toHaveBeenCalledWith(
      expect.not.objectContaining({ clientId: expect.anything() }),
    );
  });

  it('keeps contract items deep-equal in off mode and adds explicit dates only in enforce mode', async () => {
    const enforceCtx = { ...ctx, tenantId: '17b63099-bc0f-4ac5-b596-496161e9481e' };
    const item = {
      id: 'award-1',
      actionDate: '2026-01-02',
      latestActionDate: '2026-01-01',
      baseAwardSignedDate: '2025-12-01',
      sourceLastModifiedDate: '2026-02-01',
      popStartDate: null,
      popEndDate: null,
      sourceUpdatedAt: '2026-02-02',
    };
    const market = marketMock();
    market.listContracts.mockResolvedValue({ items: [item], total: 1, page: 1, pageSize: 10 });
    const { service } = serviceWith(market);

    process.env = { ...originalEnv };
    const off = await service.execute(ctx, 'search_federal_contract_awards', {});
    if (off.tool !== 'search_federal_contract_awards') throw new Error('wrong tool shape');
    expect(off.items).toEqual([item]);

    process.env = {
      ...originalEnv,
      MERI_EVIDENCE_ACCURACY_MODE: 'enforce',
      MERI_EVIDENCE_ACCURACY_TENANTS: enforceCtx.tenantId,
      MERI_EVIDENCE_ACCURACY_SURFACES: 'chat',
    };
    const enforce = await service.execute(enforceCtx, 'search_federal_contract_awards', {});
    if (enforce.tool !== 'search_federal_contract_awards') throw new Error('wrong tool shape');
    expect(enforce.items[0]).toEqual(
      expect.objectContaining({
        actionDate: '2026-01-02',
        dates: expect.objectContaining({
          baseAwardSignedDate: '2025-12-01T00:00:00.000Z',
          capiroSyncedAt: '2026-02-02T00:00:00.000Z',
        }),
      }),
    );
  });

  it('uses the state-aware geography composer and keeps future signals outside awarded money', async () => {
    const { service, geography } = serviceWith();

    const result = await service.execute(ctx, 'get_district_federal_market', {
      state: 'VA',
      district: '10',
    });

    expect(geography.geography).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ state: 'VA', district: '10' }),
    );
    // `execute` returns the per-tool union; this branch is the geography shape.
    if (result.tool !== 'get_district_federal_market') throw new Error('wrong tool shape');
    expect(result.awardedMoneyIncludesFutureOpportunities).toBe(false);
    expect(result.stateSubawards).toEqual([]);
  });

  it('rejects unbounded result requests', async () => {
    const { service } = serviceWith();
    await expect(service.execute(ctx, 'search_federal_subawards', { limit: 1000 })).rejects.toThrow(
      'limit must be an integer from 1 to 25',
    );
  });

  it('rejects malformed district geography rather than guessing', async () => {
    const { service } = serviceWith();
    await expect(
      service.execute(ctx, 'get_district_federal_market', {
        state: 'Virginia',
        district: 'tenth',
      }),
    ).rejects.toThrow('state must be a two-letter code');
  });
});
