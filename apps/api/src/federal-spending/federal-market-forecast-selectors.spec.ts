import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { FederalMarketService } from './federal-market.service.js';
import { FederalMarketMeriToolsService } from './federal-market-meri-tools.service.js';
import { FederalMarketController } from './federal-market.controller.js';

const ctx = { tenantId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002' } as TenantContext;
const unsupported = { state: 'AL', district: '99', recipient: 'Synthetic recipient', dateFrom: '2026-01-01', dateTo: '2026-12-31' };
const row = { id: 'synthetic-forecast', forecastId: 'SYN-001', title: 'Synthetic aircraft', description: null,
  agency: 'Synthetic agency', department: null, office: null, anticipatedAwardDate: null, estimatedPeriod: null,
  fiscalYear: 2026, naicsCode: null, pscCode: null, setAside: null, contractVehicle: null,
  placeOfPerformance: 'Baltimore, MD', contactName: null, contactEmail: null, status: 'active', active: true,
  sourceSystem: 'synthetic', sourceUrl: null, sourceUpdatedAt: new Date('2026-10-01T00:00:00.000Z') };

function harness() {
  const query = jest.fn(async (statement: Prisma.Sql) => statement.text.includes('COUNT(*)')
    ? [{ count: 1n, asOf: row.sourceUpdatedAt }] : [row]);
  const market = new FederalMarketService({ $queryRaw: query } as never);
  return { query, market, tools: new FederalMarketMeriToolsService(market, {} as never), controller: new FederalMarketController(market, {} as never) };
}

describe('forecast supported selectors', () => {
  test.each(Object.entries(unsupported))('direct owner rejects unsupported %s before database access', async (key, value) => {
    const { market, query } = harness();
    await expect(market.listForecasts({ [key]: value })).rejects.toThrow(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  test.each(Object.entries(unsupported))('Meri refuses unsupported %s before database access', async (key, value) => {
    const { tools, query } = harness();
    await expect(tools.execute(ctx, 'search_procurement_forecasts', { [key]: value })).rejects.toThrow(/do not support/);
    expect(query).not.toHaveBeenCalled();
  });

  test.each(Object.entries(unsupported))('REST route refuses unsupported %s before database access', async (key, value) => {
    const { controller, query } = harness();
    await expect(controller.forecasts({ [key]: value })).rejects.toThrow(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  test.each([42, {}, [], false])('Meri does not erase invalid meaningful geography input', async state => {
    const { tools, query } = harness();
    await expect(tools.execute(ctx, 'search_procurement_forecasts', { state })).rejects.toThrow(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  test.each([undefined, null, '', '   '])('direct legacy absent/null/blank fields remain inert', async value => {
    const { market } = harness();
    const input = Object.fromEntries(Object.keys(unsupported).map(key => [key, value]));
    const page = await market.listForecasts(input);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ forecastId: 'SYN-001', placeOfPerformance: 'Baltimore, MD' });
  });

  test('supported query, agency, fiscal year and paging retain identical count and data filters', async () => {
    const { tools, query } = harness();
    const page = await tools.execute(ctx, 'search_procurement_forecasts', {
      query: 'aircraft', agency: 'Synthetic agency', fiscalYear: 2026, page: 1, limit: 2,
      clientId: '00000000-0000-4000-8000-000000000003',
    });
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 2, hasMore: false, nextPage: null, paginationLimitReached: false,
      items: [expect.objectContaining({ forecastId: 'SYN-001', sourceUpdatedAt: '2026-10-01T00:00:00.000Z' })] });
    expect(query).toHaveBeenCalledTimes(2);
    const [count, data] = query.mock.calls.map(([sql]) => sql);
    expect(count!.values).toEqual(['%aircraft%', '%aircraft%', '%aircraft%', '%Synthetic agency%', 2026]);
    expect(data!.values).toEqual([...count!.values, 2, 0]);
    expect(data!.text).not.toContain('client_id');
  });

  test('native forecast schema advertises only supported geography-free selectors', () => {
    const { tools } = harness();
    const schema = tools.anthropicSchemas().find(tool => tool.name === 'search_procurement_forecasts')!.input_schema;
    expect(Object.keys(schema.properties).sort()).toEqual(['agency', 'clientId', 'fiscalYear', 'limit', 'page', 'query']);
  });
});
