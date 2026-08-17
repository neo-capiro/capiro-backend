import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import type { ExactLexicalRetrievalService } from './exact-lexical-retrieval.service.js';
import { RetrievalPlannerV2Service } from './retrieval-planner-v2.service.js';
import type { RetrievalSourceAdapter } from './retrieval-source.adapter.js';
import { RetrievalV2Service } from './retrieval-v2.service.js';
import type { RetrievalRequest, RetrievalSourceResult } from './retrieval-v2.types.js';

const request = (): RetrievalRequest => ({
  queryClass: 'lookup',
  requestedDomains: ['program_elements'],
  caller: { tenantId: 'tenant-1', userId: 'user-1' },
  exactLexical: { kind: 'pe_code', value: '0605053A' },
});

const exactResult: RetrievalSourceResult = {
  domain: 'program_elements',
  records: [
    {
      domain: 'program_elements',
      recordId: '0605053A',
      payload: { peCode: '0605053A' },
      provenance: { sourceType: 'program_element', sourceId: '0605053A' },
    },
  ],
  total: 1,
  returned: 1,
  hasMore: false,
  truncated: false,
  sourceStatus: 'healthy',
  recordsEvaluated: 1,
  requestedEntityCount: 0,
  searchedEntityCount: 0,
  pagesRead: 1,
  paginationComplete: true,
  coverageComplete: true,
  stopReason: 'authoritative_exact_scan_complete',
};

describe('RetrievalV2Service Phase 11 exact lexical rail', () => {
  it('routes typed exact lookup through the shared exact rail and not the domain adapter', async () => {
    const catalog = new SemanticDataCatalogService();
    const planner = new RetrievalPlannerV2Service(catalog);
    const adapterRetrieve = jest.fn();
    const adapter: RetrievalSourceAdapter = {
      key: 'core-prisma',
      domains: ['clients'],
      retrieve: adapterRetrieve,
    };
    const exactRetrieve = jest.fn().mockResolvedValue([exactResult]);
    const exact = { retrieve: exactRetrieve } as unknown as ExactLexicalRetrievalService;
    const service = new RetrievalV2Service(planner, [adapter], exact);

    const response = await service.retrieve(request());

    expect(exactRetrieve).toHaveBeenCalledWith(request());
    expect(adapterRetrieve).not.toHaveBeenCalled();
    expect(response.records).toEqual(exactResult.records);
    expect(response.coverage).toMatchObject({
      requestedDomains: ['program_elements'],
      searchedDomains: ['program_elements'],
      recordsReturned: 1,
      complete: true,
    });
  });

  it('fails closed as unavailable if exact mode is requested but the exact service is not registered', async () => {
    const catalog = new SemanticDataCatalogService();
    const planner = new RetrievalPlannerV2Service(catalog);
    const service = new RetrievalV2Service(planner, []);

    const response = await service.retrieve(request());

    expect(response.records).toEqual([]);
    expect(response.coverage.complete).toBe(false);
    expect(response.coverage.sources[0]).toMatchObject({
      domain: 'program_elements',
      sourceStatus: 'unavailable',
      stopReason: 'exact_lexical_service_not_registered',
    });
  });

  it('rejects typed exact intent on a non-lookup query class', () => {
    const planner = new RetrievalPlannerV2Service(new SemanticDataCatalogService());
    expect(() => planner.plan({ ...request(), queryClass: 'comparison' })).toThrow(
      'Phase 11 exact lexical retrieval requires queryClass=lookup',
    );
  });
});
