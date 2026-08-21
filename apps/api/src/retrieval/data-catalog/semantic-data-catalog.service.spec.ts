import { SemanticDataCatalogService } from './semantic-data-catalog.service.js';
import { RETRIEVAL_DOMAINS, RETRIEVAL_QUERY_CLASSES } from '../retrieval-v2.types.js';

describe('SemanticDataCatalogService', () => {
  it('catalogs every Phase 9 priority domain exactly once', () => {
    const catalog = new SemanticDataCatalogService();
    const domains = catalog.list().map((dataset) => dataset.domain);

    expect(domains).toHaveLength(RETRIEVAL_DOMAINS.length);
    expect(new Set(domains).size).toBe(RETRIEVAL_DOMAINS.length);
    expect(new Set(domains)).toEqual(new Set(RETRIEVAL_DOMAINS));
  });

  it('only advertises declared Retrieval V2 query classes', () => {
    const catalog = new SemanticDataCatalogService();
    const declared = new Set(RETRIEVAL_QUERY_CLASSES);

    for (const dataset of catalog.list()) {
      for (const queryClass of dataset.supportedQueryClasses) {
        expect(declared.has(queryClass)).toBe(true);
      }
      expect(dataset.adapterKey.length).toBeGreaterThan(0);
      expect(dataset.entityKinds.length).toBeGreaterThan(0);
    }
  });

  it('keeps live government data in source-system authority and institutional history in the knowledge plane', () => {
    const catalog = new SemanticDataCatalogService();

    for (const domain of [
      'program_elements',
      'legiwatch_bills',
      'hearings',
      'grants',
      'contracts_opportunities',
      'federal_awards',
      'directory',
    ] as const) {
      expect(catalog.get(domain).sourceKind).toBe('live_structured');
      expect(catalog.get(domain).authority).toBe('public_system_of_record');
    }

    expect(catalog.get('institutional_knowledge')).toMatchObject({
      sourceKind: 'knowledge_plane',
      authority: 'knowledge_plane',
      adapterKey: 'knowledge-plane-temporal-graph',
    });
  });

  /**
   * This assertion used to be a blanket "nothing advertises semantic_recall",
   * which was correct only while NO shared semantic retriever existed. Phase 19
   * shipped one: InstitutionalKnowledgeRetrievalAdapter serves semantic_recall
   * over governed memory (MEMORY_QUERY_CLASSES) and reports semanticDegraded
   * when an embedding is missing rather than pretending the recall was complete.
   * The blanket form therefore failed on every run from Phase 19 onward.
   *
   * The invariant that actually matters is unchanged and is now pinned to the
   * implementation instead of to a moment in time: a dataset may advertise
   * semantic_recall ONLY if its adapter implements it. Any other domain
   * claiming semantic recall is still a false advertisement and still fails.
   * This is strictly stronger than deleting the test, and stronger than the old
   * form, which would also have passed if semantic support were ripped out.
   */
  it('advertises semantic recall only for datasets whose adapter implements it', () => {
    const catalog = new SemanticDataCatalogService();

    const semanticDatasets = catalog
      .list()
      .filter((dataset) => dataset.supportedQueryClasses.includes('semantic_recall'));

    expect(
      semanticDatasets.map((dataset) => ({
        domain: dataset.domain,
        adapterKey: dataset.adapterKey,
      })),
    ).toEqual([
      { domain: 'institutional_knowledge', adapterKey: 'knowledge-plane-temporal-graph' },
    ]);
  });
});
