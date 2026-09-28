import { validateRetrievalAdapterRegistry } from './retrieval-adapter-registry.js';
import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import { RetrievalPlannerV2Service } from './retrieval-planner-v2.service.js';
import { RETRIEVAL_DOMAINS } from './retrieval-v2.types.js';
import { CorePrismaRetrievalAdapter } from './adapters/core-prisma-retrieval.adapter.js';
import { InstitutionalKnowledgeRetrievalAdapter } from './adapters/institutional-knowledge-retrieval.adapter.js';
import { StrategyWorkRetrievalAdapter } from './adapters/strategy-work-retrieval.adapter.js';
import { PublicDomainRetrievalAdapter } from './adapters/public-domain-retrieval.adapter.js';
import { ActionRecommendationsRetrievalAdapter } from './adapters/action-recommendations-retrieval.adapter.js';
import { HearingsRetrievalAdapter } from './adapters/hearings-retrieval.adapter.js';
import { DistrictNexusRetrievalAdapter } from './adapters/district-nexus-retrieval.adapter.js';
import { MondayManagedMcpAdapter } from './adapters/monday-managed-mcp.adapter.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../knowledge/graph/temporal-knowledge-graph.service.js', () => ({
  TemporalKnowledgeGraphService: class {},
}));
jest.mock('../memory/memory-recall-suppression.helpers.js', () => ({
  governedRecallSuppressionEnabled: jest.fn(),
  TERMINAL_GOVERNED_STATUSES: [],
}));
jest.mock('../memory/memory-wall.helpers.js', () => ({ clientMemoryAllowed: jest.fn() }));
jest.mock('../directory/directory.service.js', () => ({ DirectoryService: class {} }));
jest.mock('../federal-spending/federal-market.service.js', () => ({
  FederalMarketService: class {},
}));
jest.mock('../program-element/program-element-read.service.js', () => ({
  ProgramElementReadService: class {},
}));
jest.mock('../district-nexus/district-nexus.service.js', () => ({
  DistrictNexusService: class {},
}));
jest.mock('../district-nexus/district-nexus-strategic.service.js', () => ({
  DistrictNexusStrategicService: class {},
}));
jest.mock('../district-nexus/district-nexus-economic.service.js', () => ({
  DistrictNexusEconomicService: class {},
}));
jest.mock('../district-nexus/priority-intelligence/priority-intelligence.service.js', () => ({
  DistrictNexusPriorityIntelligenceService: class {},
}));
jest.mock('../district-nexus/district-nexus-flag.guard.js', () => ({
  DistrictNexusFlagGuard: class {},
}));
jest.mock('../district-nexus/district-nexus-strategic-flag.guard.js', () => ({
  DistrictNexusStrategicFlagGuard: class {},
}));
jest.mock('../district-nexus/district-nexus-economic-flag.guard.js', () => ({
  DistrictNexusEconomicFlagGuard: class {},
}));
jest.mock('../district-nexus/priority-intelligence/priority-intelligence-flag.guard.js', () => ({
  DistrictNexusPriorityIntelligenceFlagGuard: class {},
}));

const catalog = new SemanticDataCatalogService();
function adapters() {
  // Real adapter metadata and prototype handlers, with inert constructor-only dependencies.
  return [
    new CorePrismaRetrievalAdapter(undefined as never),
    new InstitutionalKnowledgeRetrievalAdapter(
      undefined as never,
      undefined as never,
      undefined as never,
    ),
    new StrategyWorkRetrievalAdapter(undefined as never),
    new PublicDomainRetrievalAdapter(undefined as never, undefined as never, undefined as never),
    new ActionRecommendationsRetrievalAdapter(undefined as never),
    new HearingsRetrievalAdapter(undefined as never),
    new DistrictNexusRetrievalAdapter(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    ),
    new MondayManagedMcpAdapter(undefined as never, undefined as never),
  ];
}

describe('Shared retrieval capability registry', () => {
  it('maps every advertised domain exactly once to a callable actual adapter', () => {
    const readers = adapters();
    expect(
      catalog
        .list()
        .map((dataset) => dataset.domain)
        .sort(),
    ).toEqual([...RETRIEVAL_DOMAINS].sort());
    expect(validateRetrievalAdapterRegistry(catalog.list(), readers)).toBe(readers);
    expect(readers.flatMap((reader) => [...reader.domains]).sort()).toEqual(
      [...RETRIEVAL_DOMAINS].sort(),
    );
  });

  it('fails registration when a domain reader is removed or duplicated', () => {
    const readers = adapters();
    expect(() =>
      validateRetrievalAdapterRegistry(
        catalog.list(),
        readers.filter((reader) => reader.key !== 'hearings'),
      ),
    ).toThrow('no unique registered reader: hearings');
    expect(() =>
      validateRetrievalAdapterRegistry(catalog.list(), [...readers, readers[0]!]),
    ).toThrow('Duplicate retrieval adapter key');
    expect(() =>
      validateRetrievalAdapterRegistry(
        catalog.list(),
        readers.map((reader) =>
          reader.key === 'hearings' ? { ...reader, retrieve: undefined as never } : reader,
        ),
      ),
    ).toThrow('no callable reader: hearings');
  });

  it('advertises typed exact filtering only for domains owned by ExactLexicalRetrievalService', () => {
    expect(
      catalog
        .list()
        .filter((dataset) => dataset.queryCapabilities.exactFiltering)
        .map((dataset) => dataset.domain)
        .sort(),
    ).toEqual(
      [
        'clients',
        'institutional_knowledge',
        'program_elements',
        'legiwatch_bills',
        'contracts_opportunities',
        'federal_awards',
      ].sort(),
    );
  });

  it('makes capped and incomplete domains explicit instead of promising exhaustive scans', () => {
    for (const domain of [
      'hearings',
      'grants',
      'contracts_opportunities',
      'district_nexus',
    ] as const) {
      expect(catalog.get(domain).queryCapabilities.exhaustiveScan).toBe(false);
    }
    for (const domain of [
      'program_elements',
      'legiwatch_bills',
      'grants',
      'contracts_opportunities',
      'federal_awards',
      'directory',
      'district_nexus',
    ] as const) {
      expect(catalog.get(domain).queryCapabilities.temporalHistory).toBe(false);
      expect(catalog.get(domain).supportedQueryClasses).not.toContain('temporal_state');
    }
  });

  it('plans client strategies and refuses unsupported Nexus history without widening scope', () => {
    const planner = new RetrievalPlannerV2Service(catalog);
    const caller = { tenantId: 'tenant', userId: 'user' };
    expect(
      planner.plan({ queryClass: 'lookup', requestedDomains: ['strategies_work'], caller })
        .entries[0]!.supported,
    ).toBe(true);
    expect(
      planner.plan({
        queryClass: 'relationship_history',
        requestedDomains: ['district_nexus'],
        caller,
      }).entries[0]!.supported,
    ).toBe(false);
  });
});
