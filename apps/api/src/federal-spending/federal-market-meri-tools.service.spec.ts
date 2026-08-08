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
