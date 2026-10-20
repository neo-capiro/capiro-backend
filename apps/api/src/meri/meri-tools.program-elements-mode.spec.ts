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
import { MeriToolsService } from './meri-tools.service.js';
import { withMeriReadObservation } from './meri-funding-read-observation.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ctx = { tenantId, userId: '22222222-2222-4222-8222-222222222222', role: 'standard_user' } as TenantContext;
const operations = ['search_program_elements', 'get_program_element', 'get_pe_budget_timeline'] as const;
const code = '0604201A';
function fixture(duringRead: () => void = () => {}) {
  const finder = { peCode: code, title: 'Synthetic line', appropriationType: 'RDT&E', budgetActivity: '6.3', lineType: null,
    spark: [10, 11], latestCurrent: 11, latestCurrentFy: 2026, latestCurrentStage: 'request', latestRequest: 12,
    latestRequestFy: 2027, latestEnacted: 10, latestEnactedFy: 2026, deltaPct: 20 };
  const detail = { peCode: code, title: 'Synthetic line', appropriationType: 'RDT&E', budgetActivity: '6.3', years: [], currentCycleFy: null };
  const programElement = {
    listProgramElements: jest.fn(async () => { duringRead(); return { data: [finder], total: 1, page: 1, limit: 20 }; }),
    getProgramElement: jest.fn(async () => { duringRead(); return detail; }),
    getTimeline: jest.fn(async () => { duringRead(); return detail; }),
  };
  const lineage = jest.fn(async () => [{ relType: 'same_program', status: 'accepted', fromPeCode: code, toPeCode: '0604202A',
    transitionFyFrom: 2025, transitionFyTo: 2026, evidenceJson: { source: 'synthetic stored evidence' } }]);
  const service = Object.assign(Object.create(MeriToolsService.prototype), { programElement, prisma: { budgetLineRelationship: { findMany: lineage } }, logger: { warn: jest.fn() } }) as MeriToolsService;
  return { service, programElement, lineage };
}
function policy(mode: 'off'|'shadow'|'enforce') {
  Object.assign(process.env, { MERI_EVIDENCE_ACCURACY_MODE: mode, MERI_EVIDENCE_ACCURACY_TENANTS: tenantId, MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' });
}

describe('observed program-element mode preserves native claims and lineage', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; jest.useFakeTimers().setSystemTime(new Date('2026-10-17T12:00:00.000Z')); });
  afterEach(() => { process.env = originalEnv; jest.useRealTimers(); });
  for (const operationId of operations) {
    it.each(['off', 'shadow', 'enforce'] as const)(`${operationId} consumes captured %s across awaits without changing its native projection`, async mode => {
      policy(mode);
      const baseline = fixture();
      const expected = await baseline.service.execute(ctx, operationId, { peCode: code });
      const observed = fixture(() => policy(mode === 'enforce' ? 'off' : 'enforce'));
      const actual = await withMeriReadObservation({ operationId, evidenceAccuracyMode: mode }, () => observed.service.execute(ctx, operationId, { peCode: code }));
      expect(actual).toEqual(expected);
      expect(actual).toMatchObject({ tool: operationId, generatedAt: '2026-10-17T12:00:00.000Z' });
      if (operationId === 'search_program_elements') {
        expect(observed.lineage).not.toHaveBeenCalled();
        expect((actual as any).data[0]).not.toHaveProperty('spark');
        expect((actual as any).data[0]).not.toHaveProperty('latestCurrent');
        expect((actual as any).data[0]).toHaveProperty('funding');
      } else {
        expect(observed.lineage).toHaveBeenCalledTimes(mode === 'off' ? 0 : 1);
        expect(Object.hasOwn(actual as object, 'lineage')).toBe(mode === 'enforce');
        if (mode === 'enforce') expect((actual as any).lineage.accepted[0]).toMatchObject({ fromCode: code, toCode: '0604202A', status: 'accepted' });
      }
      expect((observed.service as any).logger.warn).toHaveBeenCalledTimes(mode === 'shadow' ? 1 : 0);
    });
    it(`${operationId} rejects off/shadow mismatch before any domain or lineage query`, async () => {
      policy('shadow'); const f = fixture();
      await expect(withMeriReadObservation({ operationId, evidenceAccuracyMode: 'off' }, () => f.service.execute(ctx, operationId, { peCode: code }))).rejects.toThrow('Current read mode changed');
      expect(f.programElement.listProgramElements).not.toHaveBeenCalled(); expect(f.programElement.getProgramElement).not.toHaveBeenCalled();
      expect(f.programElement.getTimeline).not.toHaveBeenCalled(); expect(f.lineage).not.toHaveBeenCalled();
    });
    it(`${operationId} leaves legacy pre-query mode sampling unchanged`, async () => {
      policy('shadow'); const stable = fixture(); const expected = await stable.service.execute(ctx, operationId, { peCode: code });
      policy('shadow'); const changing = fixture(() => policy('off'));
      expect(await changing.service.execute(ctx, operationId, { peCode: code })).toEqual(expected);
      expect(changing.lineage).toHaveBeenCalledTimes(operationId === 'search_program_elements' ? 0 : 1);
    });
  }
});
