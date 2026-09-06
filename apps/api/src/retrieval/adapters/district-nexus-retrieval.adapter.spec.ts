import { DistrictNexusRetrievalAdapter } from './district-nexus-retrieval.adapter.js';
import { SemanticDataCatalogService } from '../data-catalog/semantic-data-catalog.service.js';
import type { RetrievalRequest } from '../retrieval-v2.types.js';

jest.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../../district-nexus/district-nexus.service.js', () => ({ DistrictNexusService: class {} }));
jest.mock('../../district-nexus/district-nexus-strategic.service.js', () => ({ DistrictNexusStrategicService: class {} }));
jest.mock('../../district-nexus/district-nexus-economic.service.js', () => ({ DistrictNexusEconomicService: class {} }));
jest.mock('../../district-nexus/priority-intelligence/priority-intelligence.service.js', () => ({ DistrictNexusPriorityIntelligenceService: class {} }));
jest.mock('../../district-nexus/district-nexus-flag.guard.js', () => ({ DistrictNexusFlagGuard: class {} }));
jest.mock('../../district-nexus/district-nexus-strategic-flag.guard.js', () => ({ DistrictNexusStrategicFlagGuard: class {} }));
jest.mock('../../district-nexus/district-nexus-economic-flag.guard.js', () => ({ DistrictNexusEconomicFlagGuard: class {} }));
jest.mock('../../district-nexus/priority-intelligence/priority-intelligence-flag.guard.js', () => ({ DistrictNexusPriorityIntelligenceFlagGuard: class {} }));

const CLIENT = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = 'user_one';
const catalog = new SemanticDataCatalogService();
function setup() {
  const input: RetrievalRequest = { queryClass: 'lookup', requestedDomains: ['district_nexus'], caller: {
    tenantId: TENANT, userId: USER, clientIds: [CLIENT], authorizedClientIds: [CLIENT],
  } };
  const tx = { client: { findMany: jest.fn().mockResolvedValue([{ id: CLIENT }]) } };
  const prisma = { withTenantUser: jest.fn().mockImplementation((_tenant, _user, fn) => fn(tx)) };
  const base = { clientId: CLIENT, districts: [{ districtKey: 'VA-10', awarded: { amount: 12 } }],
    freshness: [{ lastSyncedAt: '2026-08-01T00:00:00Z' }, { lastSyncedAt: '2026-09-01T00:00:00Z' }], warnings: ['LODES unavailable'] };
  const nexus = { getClientDistrictNexus: jest.fn().mockResolvedValue(base) };
  const strategic = { getClientStrategicMap: jest.fn().mockResolvedValue({ districts: [{ strategicScore: 42 }], empiricallyValidated: false }) };
  const economic = { getClientFootprint: jest.fn().mockResolvedValue({ evidence: [{ reviewStatus: 'pending_review' }] }),
    getSupplierFootprintStatus: jest.fn().mockResolvedValue({ status: 'unavailable' }),
    getDistrictContext: jest.fn().mockResolvedValue({ metrics: [{ source: 'ACS', value: 100 }] }) };
  const priority = { getClientDistrictPriorityIntelligence: jest.fn().mockResolvedValue({ cpfCds: [{ sourceUrl: 'https://example.gov/cpf' }], gsa: { propertyCount: 4 } }) };
  const gate = () => ({ assertEnabledForTenant: jest.fn().mockResolvedValue(true) });
  const baseGate = gate(), strategicGate = gate(), economicGate = gate(), priorityGate = gate();
  const adapter = new DistrictNexusRetrievalAdapter(prisma as never, nexus as never, strategic as never, economic as never, priority as never,
    baseGate as never, strategicGate as never, economicGate as never, priorityGate as never);
  return { input, tx, adapter, base, nexus, strategic, economic, priority, baseGate, strategicGate, economicGate, priorityGate };
}

describe('District Nexus shared retrieval', () => {
  it('uses existing footprint, strategic, economic and priority services and preserves their source caveats', async () => {
    const s = setup();
    const result = await s.adapter.retrieve(catalog.get('district_nexus'), s.input);
    expect(s.nexus.getClientDistrictNexus).toHaveBeenCalledWith(CLIENT, TENANT);
    expect(s.strategic.getClientStrategicMap).toHaveBeenCalledWith(TENANT, CLIENT);
    expect(s.economic.getDistrictContext).toHaveBeenCalledWith('VA', '10');
    expect(s.priority.getClientDistrictPriorityIntelligence).toHaveBeenCalledWith(TENANT, CLIENT, 'VA', '10');
    expect(result.records.find((r) => r.payload.rail === 'verified_footprint')!.payload.data).toEqual(s.base);
    expect(result.records.find((r) => r.payload.rail === 'strategic_relevance')!.payload.data).toMatchObject({ empiricallyValidated: false });
    expect(result).toMatchObject({ sourceStatus: 'degraded', coverageComplete: false, truncated: true, paginationComplete: true });
    expect(result.lastSyncAt).toEqual(new Date('2026-08-01')); // oldest rail, never generatedAt
  });

  it('denies before reading Nexus if the base feature is disabled', async () => {
    const s = setup(); s.baseGate.assertEnabledForTenant.mockRejectedValue(new Error('disabled'));
    const result = await s.adapter.retrieve(catalog.get('district_nexus'), s.input);
    expect(result.sourceStatus).toBe('unauthorized');
    expect(s.nexus.getClientDistrictNexus).not.toHaveBeenCalled();
  });

  it('honors child feature denial without dropping the allowed source records', async () => {
    const s = setup(); s.priorityGate.assertEnabledForTenant.mockRejectedValue(new Error('explicit child disabled'));
    const result = await s.adapter.retrieve(catalog.get('district_nexus'), s.input);
    expect(s.priority.getClientDistrictPriorityIntelligence).not.toHaveBeenCalled();
    expect(result.records.find((r) => r.payload.rail === 'priority_intelligence:VA-10')!.payload).toMatchObject({ status: 'unauthorized', data: null });
    expect(result.records.find((r) => r.payload.rail === 'verified_footprint')!.payload.status).toBe('available');
    expect(result.coverageComplete).toBe(false);
  });

  it('preserves failed rails as unavailable instead of converting failures to empty evidence', async () => {
    const s = setup(); s.economic.getDistrictContext.mockRejectedValue(new Error('database timeout'));
    const result = await s.adapter.retrieve(catalog.get('district_nexus'), s.input);
    expect(result.records.find((r) => r.payload.rail === 'economic_context:VA-10')!.payload).toMatchObject({ status: 'unavailable', data: null });
    expect(result.stopReason).toContain('some_rails_unavailable');
  });

  it('drops pending results if the ethical wall changes during the multi-service read', async () => {
    const s = setup(); s.tx.client.findMany.mockResolvedValueOnce([{ id: CLIENT }]).mockResolvedValueOnce([]);
    const result = await s.adapter.retrieve(catalog.get('district_nexus'), s.input);
    expect(result).toMatchObject({ sourceStatus: 'unauthorized', returned: 0, records: [], stopReason: 'client_access_changed_during_read' });
  });

  it('continues later rails through a cursor and never claims to enumerate capped evidence', async () => {
    const s = setup(); s.input.pageSize = 2;
    const first = await s.adapter.retrieve(catalog.get('district_nexus'), s.input);
    expect(first).toMatchObject({ returned: 2, hasMore: true, coverageComplete: false });
    const second = await s.adapter.retrieve(catalog.get('district_nexus'), s.input, first.nextCursor);
    expect(second.records.map((r) => r.payload.rail)).toEqual(['economic_footprint', 'supplier_footprint_status']);
    expect(second.coverageComplete).toBe(false);
  });

  it('rejects exhaustive/history/window requests the summary services cannot satisfy', async () => {
    const s = setup();
    const result = await s.adapter.retrieve(catalog.get('district_nexus'), { ...s.input, queryClass: 'exhaustive_search' });
    expect(result.sourceStatus).toBe('unsupported');
    expect(s.nexus.getClientDistrictNexus).not.toHaveBeenCalled();
  });
});
