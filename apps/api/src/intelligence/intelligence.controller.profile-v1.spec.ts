import { IntelligenceController } from './intelligence.controller.js';
import type { TenantContext } from '@capiro/shared';

describe('IntelligenceController profile-v1 integration', () => {
  const tenantContext: TenantContext = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    tenantSlug: 'capiro',
    userId: '00000000-0000-0000-0000-000000000002',
    clerkUserId: 'user_test',
    role: 'standard_user',
  };

  const clientId = '00000000-0000-0000-0000-000000000010';

  const makeController = () => {
    const service = {
      getClientProfileV1: jest.fn(),
    } as any;

    const config = { get: () => 'off' } as any; // KG_INTEL_GRAPH etc; unused by profile-v1
    const controller = new IntelligenceController(service, {} as any, {} as any, {} as any, config);
    return { controller, service };
  };

  test('mapped client: forwards tenant-scoped request and returns profile-v1 payload', async () => {
    const { controller, service } = makeController();
    service.getClientProfileV1.mockResolvedValue({
      client: { id: clientId, name: 'Acme Defense' },
      generatedAt: '2026-05-27T00:00:00.000Z',
      links: {
        changesInbox: '/intelligence/changes?clientId=' + clientId,
        mappingsAdmin: '/settings/intelligence-mappings',
        competitorIssuePage: '/intelligence/issues/DEF',
        billDetailBase: '/explorer',
        entityResolutionQueue: '/settings/intelligence-mappings',
      },
      sections: {
        snapshot: {
          trajectory: { label: 'stable', growthRate: null, totalSpending: 0, yearlySpend: [] },
          health: { score: 0, trend: 'stable' },
          topAlerts: [],
          activity14d: [],
          changes7dCount: 0,
        },
        financialFootprint: {
          hero: { lobbyingTtm: 0, obligationsTtm: 0, returnRatio: null, gap: 0 },
          series: { lobbying: [], obligations: [], quarterSeries: [] },
          fecMoneyFlow: { mappedEmployer: null, summary: {} },
          districtNexus: { topDistricts: [], capabilities: [] },
        },
        legislativeRegulatory: {
          kanban: { total: 0, issueCodes: [], columns: [] },
          regulatoryLifecycle: { rails: [] },
          hearingsAndMarkups: [],
        },
        relationships: {
          scopedGraph: {
            resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 },
            meta: { lobbyistCount: 0, memberCount: 0, committeeCount: 0 },
          },
          officeRecommender: [],
          exStafferCount: 0,
        },
      },
    });

    const result = await controller.getClientProfileV1(tenantContext, clientId);

    expect(service.getClientProfileV1).toHaveBeenCalledWith(clientId, tenantContext.tenantId, tenantContext.userId);
    expect(result.client.id).toBe(clientId);
    expect(result.sections.snapshot).toBeDefined();
    expect(result.sections.financialFootprint).toBeDefined();
    expect(result.sections.legislativeRegulatory).toBeDefined();
    expect(result.sections.relationships).toBeDefined();
  });

  test('partially mapped client: returns payload with safe section defaults (no throw)', async () => {
    const { controller, service } = makeController();
    service.getClientProfileV1.mockResolvedValue({
      client: { id: clientId, name: 'Partially Mapped Co' },
      generatedAt: '2026-05-27T00:00:00.000Z',
      links: {
        changesInbox: '/intelligence/changes?clientId=' + clientId,
        mappingsAdmin: '/settings/intelligence-mappings',
        competitorIssuePage: '',
        billDetailBase: '/explorer',
        entityResolutionQueue: '/settings/intelligence-mappings',
      },
      sections: {
        snapshot: {
          trajectory: { label: null, growthRate: null, totalSpending: 0, yearlySpend: [] },
          health: { score: 0, trend: 'stable' },
          topAlerts: [],
          activity14d: [],
          changes7dCount: 0,
        },
        financialFootprint: {
          hero: { lobbyingTtm: 0, obligationsTtm: 0, returnRatio: null, gap: 0 },
          series: { lobbying: [], obligations: [], quarterSeries: [] },
          fecMoneyFlow: { mappedEmployer: null, summary: {} },
          districtNexus: { topDistricts: [], capabilities: [] },
        },
        legislativeRegulatory: {
          kanban: { total: 0, issueCodes: [], columns: [] },
          regulatoryLifecycle: { rails: [] },
          hearingsAndMarkups: [],
        },
        relationships: {
          scopedGraph: {
            resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 },
            meta: { lobbyistCount: 0, memberCount: 0, committeeCount: 0 },
          },
          officeRecommender: [],
          exStafferCount: 0,
        },
      },
    });

    const result = await controller.getClientProfileV1(tenantContext, clientId);

    expect(result.client.name).toContain('Partially');
    expect(result.sections.snapshot.changes7dCount).toBe(0);
    expect(result.sections.legislativeRegulatory.kanban.columns).toEqual([]);
    expect(result.sections.relationships.officeRecommender).toEqual([]);
  });
});
