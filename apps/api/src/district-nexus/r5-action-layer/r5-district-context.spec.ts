import { describe, expect, jest, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { DistrictNexusService } from '../district-nexus.service.js';
import type { DistrictNexusPriorityIntelligenceService } from '../priority-intelligence/priority-intelligence.service.js';
import type { DistrictNexusStrategicService } from '../district-nexus-strategic.service.js';
import type { DistrictNexusEconomicService } from '../district-nexus-economic.service.js';
import type { DistrictNexusStrategicFlagGuard } from '../district-nexus-strategic-flag.guard.js';
import type { DistrictNexusEconomicFlagGuard } from '../district-nexus-economic-flag.guard.js';
import { DistrictNexusPriorityIntelligenceFlagGuard } from '../priority-intelligence/priority-intelligence-flag.guard.js';
import { ConfigService } from '@nestjs/config';
import type { FederalMarketGeographyService } from '../../federal-spending/federal-market-geography.service.js';
import type { ClientPriorityIntelligenceResponse } from '../priority-intelligence/priority-intelligence.types.js';
import type { DistrictNexusDistrictDetailResponse, DistrictNexusMapResponse } from '../district-nexus.types.js';
import type { DistrictEconomicContextResponse } from '../district-nexus-economic.types.js';
import { R5DistrictContextService } from './r5-district-context.service.js';

const tenant = 'tenant-1';
const clientId = 'client-1';
const request: ClientPriorityIntelligenceResponse['priorityIntelligence']['cpfCds']['districtRequests'][number] = {
  requestId: 'r1', chamber: 'house', requestType: 'cpf', fiscalYear: 2027,
  requesterName: 'Representative', recipientName: 'Recipient', projectTitle: 'Project',
  districtKey: 'WY-00', geography: { basis: 'house_district', state: 'WY', district: '00' },
  requestedAmountUsd: 700, finalAmountUsd: null, amountStageRaw: 'requested',
  appropriationsAccountRaw: null, sourceOccurrenceCount: 1, occurrences: [], clientAttribution: null,
};

function fixture() {
  const detail = {
    awarded: { contractObligations: 300, grantObligations: null, grantOutlays: null },
    facilities: [], evidence: [], representatives: { house: null, senate: [] }, warnings: [],
  } satisfies Pick<DistrictNexusDistrictDetailResponse, 'awarded' | 'facilities' | 'evidence' | 'representatives' | 'warnings'>;
  const pi = {
    priorityIntelligence: { cpfCds: { availability: { status: 'loaded', reason: null, lastIngestRunAt: null, loadedFiscalYears: [2027] }, districtRequests: [request], clientRequests: [] }, recentChanges: [] },
    freshness: [],
  } satisfies { priorityIntelligence: { cpfCds: Pick<ClientPriorityIntelligenceResponse['priorityIntelligence']['cpfCds'], 'availability' | 'districtRequests' | 'clientRequests'>; recentChanges: ClientPriorityIntelligenceResponse['priorityIntelligence']['recentChanges'] }; freshness: ClientPriorityIntelligenceResponse['freshness'] };
  const economic = {
    metrics: [{ source: 'acs', dataset: 'acs/acs5', metricKey: 'total_population', value: 576851, unit: 'people',
      marginOfError: -555555555, sourceRecordId: 'acs-1', sourceUrl: null, observedAt: null,
      lastSyncedAt: '2026-01-01', sourceYear: 2024, boundaryCongress: 119, metadata: {}, naicsCode: null }],
    sources: [], warnings: [],
  } satisfies Pick<DistrictEconomicContextResponse, 'metrics' | 'sources' | 'warnings'>;
  const client = { id: clientId, name: 'Client', status: 'active' };
  const prisma = { withTenant: jest.fn(async (id: string, callback: (tx: { client: { findFirst: () => Promise<typeof client> } }) => Promise<typeof client>) =>
    callback({ client: { findFirst: async () => id === tenant ? client : null as never } })) };
  const districtNexus = {
    getDistrictDetail: jest.fn(async () => detail),
    getFirmDistrictNexusMap: jest.fn(async () => ({ freshness: [] } satisfies Pick<DistrictNexusMapResponse, 'freshness'>)),
  };
  const priority = { getClientDistrictPriorityIntelligence: jest.fn(async () => pi) };
  const strategicFlag = { assertEnabledForTenant: jest.fn(async () => { throw new NotFoundException(); }) };
  const economicFlag = { assertEnabledForTenant: jest.fn(async (_: string, feature: string) => {
    if (feature === 'district_nexus_supplier_footprint') throw new NotFoundException();
    return true;
  }) };
  const econ = { getDistrictContext: jest.fn(async () => economic) };
  const market = { geography: jest.fn(async () => ({ districts: [], futureSignals: [], futureSignalsAvailability: 'available' })) };
  const priorityFlag = new DistrictNexusPriorityIntelligenceFlagGuard(prisma as unknown as PrismaService, new ConfigService());
  priorityFlag.assertEnabledForTenant = async () => true;
  const service = new R5DistrictContextService(
    prisma as unknown as PrismaService, districtNexus as unknown as DistrictNexusService,
    priority as unknown as DistrictNexusPriorityIntelligenceService,
    {} as DistrictNexusStrategicService, econ as unknown as DistrictNexusEconomicService,
    strategicFlag as unknown as DistrictNexusStrategicFlagGuard,
    economicFlag as unknown as DistrictNexusEconomicFlagGuard,
    market as unknown as FederalMarketGeographyService,
    priorityFlag,
  );
  return { service, districtNexus, priority, econ, market, prisma, detail, pi, economic };
}

describe('R5 context parity with existing drawer endpoints', () => {
  test('uses the same CPF request rows, contract total and economic point estimate for client+district', async () => {
    const f = fixture();
    const context = await f.service.getContext(tenant, clientId, 'WY', '00');
    const drawer = await f.districtNexus.getDistrictDetail();
    const priorityEndpoint = await f.priority.getClientDistrictPriorityIntelligence();
    const economicEndpoint = await f.econ.getDistrictContext();
    expect(context.facts.filter((fact) => fact.section === 'cpf_cds' && fact.amountStage === 'requested')).toHaveLength(priorityEndpoint.priorityIntelligence.cpfCds.districtRequests.length);
    expect(context.facts.find((fact) => fact.id === 'footprint:contract_obligations:WY-00')?.value).toBe(drawer.awarded.contractObligations);
    expect(context.facts.find((fact) => fact.id === 'economic:acs:acs-1')?.value).toBe(economicEndpoint.metrics[0]?.value);
    expect(context.facts.find((fact) => fact.id === 'economic:acs:acs-1')?.caveats).toContain('MOE unavailable');
    expect(context.facts.some((fact) => fact.amountStage === 'enacted')).toBe(false);
    expect(context.facts.every((fact) => fact.coverage !== 'complete')).toBe(true);
  });
  test('foreign client fails before reading any district rail', async () => {
    const f = fixture();
    await expect(f.service.getContext('other-tenant', clientId, 'WY', '00')).rejects.toThrow(NotFoundException);
    expect(f.districtNexus.getDistrictDetail).not.toHaveBeenCalled();
  });
  test('priority failure becomes a gap; no fabricated zero', async () => {
    const f = fixture();
    f.priority.getClientDistrictPriorityIntelligence.mockRejectedValueOnce(new Error('offline'));
    const context = await f.service.getContext(tenant, clientId, 'WY', '00');
    expect(context.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ section: 'cpf_cds' })]));
    expect(context.facts.some((fact) => fact.section === 'cpf_cds')).toBe(false);
  });
});
