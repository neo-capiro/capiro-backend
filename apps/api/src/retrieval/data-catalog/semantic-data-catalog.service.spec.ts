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

  it('does not falsely advertise semantic recall before a shared semantic retriever exists', () => {
    const catalog = new SemanticDataCatalogService();

    expect(
      catalog.list().some((dataset) => dataset.supportedQueryClasses.includes('semantic_recall')),
    ).toBe(false);
  });
});
