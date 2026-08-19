import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import { RetrievalPlannerV2Service } from './retrieval-planner-v2.service.js';
import type { RetrievalRequest } from './retrieval-v2.types.js';

const request = (overrides: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  queryClass: 'lookup',
  requestedDomains: ['clients'],
  caller: { tenantId: 'tenant-1', userId: 'user-1' },
  ...overrides,
});

describe('RetrievalPlannerV2Service', () => {
  const planner = new RetrievalPlannerV2Service(new SemanticDataCatalogService());

  it('deduplicates requested domains without broadening the request', () => {
    const plan = planner.plan(request({ requestedDomains: ['clients', 'clients', 'mail'] }));

    expect(plan.requestedDomains).toEqual(['clients', 'mail']);
    expect(plan.entries.map((entry) => entry.dataset.domain)).toEqual(['clients', 'mail']);
  });

  it('keeps unsupported semantic recall explicit while allowing governed institutional memory', () => {
    const plan = planner.plan(
      request({ queryClass: 'semantic_recall', requestedDomains: ['clients', 'institutional_knowledge'] }),
    );

    expect(plan.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          supported: false,
          dataset: expect.objectContaining({ domain: 'clients' }),
        }),
        expect.objectContaining({
          supported: true,
          dataset: expect.objectContaining({ domain: 'institutional_knowledge' }),
        }),
      ]),
    );
  });

  it('catalogs governed institutional memory for lookup as well as semantic recall', () => {
    const catalog = new SemanticDataCatalogService().get('institutional_knowledge');
    expect(catalog.supportedQueryClasses).toEqual(
      expect.arrayContaining(['lookup', 'semantic_recall']),
    );
    expect(
      planner.plan(request({ requestedDomains: ['institutional_knowledge'] })).entries[0]?.supported,
    ).toBe(true);
  });

  it('requires at least one requested domain', () => {
    expect(() => planner.plan(request({ requestedDomains: [] }))).toThrow(
      'Retrieval V2 requires at least one requested domain',
    );
  });
});
