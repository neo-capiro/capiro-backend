import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import { RetrievalPlannerV2Service } from './retrieval-planner-v2.service.js';
import type { RetrievalSourceAdapter } from './retrieval-source.adapter.js';
import type {
  RetrievalRecord,
  RetrievalRequest,
  RetrievalSourceResult,
} from './retrieval-v2.types.js';
import { RetrievalV2Service } from './retrieval-v2.service.js';

const baseRequest = (overrides: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  queryClass: 'lookup',
  requestedDomains: ['clients'],
  caller: { tenantId: 'tenant-1', userId: 'user-1' },
  ...overrides,
});

const record = (id: string): RetrievalRecord => ({
  domain: 'clients',
  recordId: id,
  entityRef: { type: 'client', id },
  payload: { name: id },
});

const page = (overrides: Partial<RetrievalSourceResult> = {}): RetrievalSourceResult => ({
  domain: 'clients',
  records: [],
  total: 0,
  returned: 0,
  hasMore: false,
  truncated: false,
  sourceStatus: 'healthy',
  recordsEvaluated: 0,
  requestedEntityCount: 0,
  searchedEntityCount: 0,
  pagesRead: 1,
  paginationComplete: true,
  coverageComplete: true,
  stopReason: 'authoritative_page_complete',
  ...overrides,
});

function service(adapters: readonly RetrievalSourceAdapter[]): RetrievalV2Service {
  const planner = new RetrievalPlannerV2Service(new SemanticDataCatalogService());
  return new RetrievalV2Service(planner, adapters);
}

describe('RetrievalV2Service', () => {
  it.each([true, false])(
    'uses oldest source sync across pages and preserves unknown freshness (allKnown=%s)',
    async (allKnown) => {
      const older = new Date('2026-01-01');
      const newer = new Date('2026-09-01');
      const adapter: RetrievalSourceAdapter = {
        key: 'core-prisma',
        domains: ['clients'],
        retrieve: jest
          .fn()
          .mockResolvedValueOnce(
            page({
              hasMore: true,
              nextCursor: 'next',
              coverageComplete: false,
              paginationComplete: false,
              lastSyncAt: allKnown ? older : undefined,
            }),
          )
          .mockResolvedValueOnce(page({ lastSyncAt: newer })),
      };
      const response = await service([adapter]).retrieve(
        baseRequest({ queryClass: 'exhaustive_search' }),
      );
      expect(response.coverage.sources[0]!.lastSyncAt).toEqual(allKnown ? older : undefined);
      expect(response.observability.freshnessByDomain.clients).toEqual(allKnown ? older : null);
    },
  );

  it('makes a missing domain adapter explicit in coverage instead of silently omitting it', async () => {
    const response = await service([]).retrieve(
      baseRequest({ queryClass: 'exhaustive_search', requestedDomains: ['grants'] }),
    );

    expect(response.records).toEqual([]);
    expect(response.coverage.complete).toBe(false);
    expect(response.coverage.unavailableSources).toEqual(['grants']);
    expect(response.coverage.sources[0]).toMatchObject({
      domain: 'grants',
      sourceStatus: 'unavailable',
      coverageComplete: false,
      stopReason: 'adapter_not_registered:public-domain-services',
    });
  });

  it('drains cursor pagination for exhaustive search and reports complete only after the terminal page proves coverage', async () => {
    const retrieve = jest
      .fn()
      .mockResolvedValueOnce(
        page({
          records: [record('a')],
          total: 2,
          returned: 1,
          hasMore: true,
          nextCursor: 'a',
          truncated: true,
          paginationComplete: false,
          coverageComplete: false,
          recordsEvaluated: 2,
          stopReason: 'page_boundary_reached',
        }),
      )
      .mockResolvedValueOnce(
        page({
          records: [record('b')],
          total: 2,
          returned: 1,
          recordsEvaluated: 1,
        }),
      );
    const adapter: RetrievalSourceAdapter = {
      key: 'core-prisma',
      domains: ['clients'],
      retrieve: retrieve as RetrievalSourceAdapter['retrieve'],
    };

    const response = await service([adapter]).retrieve(
      baseRequest({ queryClass: 'exhaustive_search', requireComplete: true }),
    );

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve.mock.calls[0]?.[2]).toBeUndefined();
    expect(retrieve.mock.calls[1]?.[2]).toBe('a');
    expect(response.records.map((item) => item.recordId)).toEqual(['a', 'b']);
    expect(response.coverage).toMatchObject({
      complete: true,
      paginationComplete: true,
      recordsReturned: 2,
      stopReason: 'complete',
    });
    expect(response.coverage.sources[0]).toMatchObject({
      returned: 2,
      pagesRead: 2,
      hasMore: false,
      truncated: false,
      coverageComplete: true,
    });
  });

  it('fails completeness when a source claims more data but provides no cursor', async () => {
    const adapter: RetrievalSourceAdapter = {
      key: 'core-prisma',
      domains: ['clients'],
      retrieve: jest.fn().mockResolvedValue(
        page({
          hasMore: true,
          truncated: true,
          paginationComplete: false,
          coverageComplete: false,
          stopReason: 'page_boundary_reached',
        }),
      ) as RetrievalSourceAdapter['retrieve'],
    };

    const response = await service([adapter]).retrieve(
      baseRequest({ queryClass: 'exhaustive_search' }),
    );

    expect(response.coverage.complete).toBe(false);
    expect(response.coverage.sources[0]).toMatchObject({
      truncated: true,
      paginationComplete: false,
      coverageComplete: false,
      stopReason: 'source_has_more_without_cursor',
    });
  });

  it('converts adapter failures to source error coverage without leaking the exception text', async () => {
    const adapter: RetrievalSourceAdapter = {
      key: 'core-prisma',
      domains: ['clients'],
      retrieve: jest
        .fn()
        .mockRejectedValue(
          new Error('secret database detail'),
        ) as RetrievalSourceAdapter['retrieve'],
    };

    const response = await service([adapter]).retrieve(baseRequest());

    expect(response.coverage.complete).toBe(false);
    expect(response.coverage.sources[0]).toMatchObject({
      sourceStatus: 'error',
      coverageComplete: false,
      stopReason: 'adapter_execution_failed',
    });
    expect(JSON.stringify(response)).not.toContain('secret database detail');
  });

  it('emits query/source/page/freshness observability for every requested source result', async () => {
    const lastSyncAt = new Date('2026-08-16T12:00:00.000Z');
    const adapter: RetrievalSourceAdapter = {
      key: 'core-prisma',
      domains: ['clients'],
      retrieve: jest.fn().mockResolvedValue(
        page({
          records: [record('a')],
          returned: 1,
          recordsEvaluated: 1,
          searchedEntityCount: 1,
          lastSyncAt,
        }),
      ) as RetrievalSourceAdapter['retrieve'],
    };

    const response = await service([adapter]).retrieve(baseRequest());

    expect(response.observability).toMatchObject({
      queryClass: 'lookup',
      requestedDomains: ['clients'],
      queriedDatasets: ['clients'],
      queriedEntityCount: 1,
      coverageComplete: true,
      pagesByDomain: { clients: 1 },
      sourceHealth: { clients: 'healthy' },
      freshnessByDomain: { clients: lastSyncAt },
    });
  });
});

it('counts one governed-memory record set once while draining its distinct returned pages', async () => {
  const adapter: RetrievalSourceAdapter = {
    key: 'knowledge-plane-temporal-graph',
    domains: ['institutional_knowledge'],
    retrieve: jest
      .fn()
      .mockResolvedValueOnce(
        page({
          domain: 'institutional_knowledge',
          records: [{ ...record('a'), domain: 'institutional_knowledge' }],
          total: 2,
          returned: 1,
          recordsEvaluated: 2,
          evaluatedRecordSetId: 'snapshot-a',
          hasMore: true,
          nextCursor: 'next',
          coverageComplete: false,
          paginationComplete: false,
        }),
      )
      .mockResolvedValueOnce(
        page({
          domain: 'institutional_knowledge',
          records: [{ ...record('b'), domain: 'institutional_knowledge' }],
          total: 2,
          returned: 1,
          recordsEvaluated: 2,
          evaluatedRecordSetId: 'snapshot-a',
        }),
      ),
  };
  const response = await service([adapter]).retrieve(
    baseRequest({ requestedDomains: ['institutional_knowledge'], requireComplete: true }),
  );
  expect(response.coverage.sources[0]).toMatchObject({
    total: 2,
    returned: 2,
    recordsEvaluated: 2,
    pagesRead: 2,
    coverageComplete: true,
  });
});
