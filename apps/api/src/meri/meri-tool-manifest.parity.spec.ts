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
jest.mock('../retrieval/retrieval-v2.service.js', () => ({ RetrievalV2Service: jest.fn() }));
jest.mock('../funding-opportunities/meri-opportunity-tools.adapter.js', () => ({
  MeriOpportunityToolsAdapter: jest.fn(),
}));
// These contracts stub the domain ports; loading the unrelated mail/generation graph is unnecessary.
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: jest.fn() }));

import { MERI_TOOL_MANIFEST } from '@capiro/shared';
import { createGovernedMeriToolsService } from './governed-meri-tools.proxy.js';
import { FederalMarketMeriToolsService } from '../federal-spending/federal-market-meri-tools.service.js';
import { FEDERAL_MARKET_MERI_TOOL_DEFINITIONS } from '../federal-spending/federal-market-meri-tools.service.js';
import { MeriToolsService, TOOL_DEFINITIONS } from './meri-tools.service.js';

describe('complete native API capability manifest', () => {
  it('the governed service advertises the same complete capability surface in its manifest and schemas', () => {
    const raw = Object.create(MeriToolsService.prototype) as MeriToolsService;
    const federal = new FederalMarketMeriToolsService(undefined as never, undefined as never);
    const governed = createGovernedMeriToolsService(raw, undefined, federal);
    const manifestNames = governed
      .manifest()
      .tools.map((tool) => tool.name)
      .sort();
    const schemaNames = governed
      .anthropicToolSchemas()
      .map((tool) => tool.name)
      .sort();
    expect(manifestNames).toEqual(Object.keys(MERI_TOOL_MANIFEST).sort());
    expect(schemaNames).toEqual(manifestNames);
  });

  it('includes both API handler owners exactly once with canonical descriptions', () => {
    const definitions = [...TOOL_DEFINITIONS, ...FEDERAL_MARKET_MERI_TOOL_DEFINITIONS];
    const actual = Object.fromEntries(
      definitions.map(({ name, description }) => [name, description]),
    );
    expect(actual).toEqual(MERI_TOOL_MANIFEST);
    expect(Object.keys(actual)).toHaveLength(definitions.length);
    expect(TOOL_DEFINITIONS).toHaveLength(83);
    expect(FEDERAL_MARKET_MERI_TOOL_DEFINITIONS).toHaveLength(5);
  });
});
