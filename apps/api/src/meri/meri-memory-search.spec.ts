import type { TenantContext } from '@capiro/shared';
import type { RetrievalRecord } from '../retrieval/retrieval-v2.types.js';
import { buildCoverageManifest } from '../retrieval/coverage-manifest.js';
import { searchGovernedMemory } from './meri-memory-search.js';

const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000001',
  role: 'standard_user',
} as TenantContext;
const clientId = '30000000-0000-4000-8000-000000000001';
function page(
  nextCursor?: string,
  records: RetrievalRecord[] = [],
  sourceStatus: 'healthy' | 'unauthorized' = 'healthy',
) {
  const source = {
    domain: 'institutional_knowledge' as const,
    records,
    returned: records.length,
    requestedEntityCount: 1,
    searchedEntityCount: 1,
    recordsEvaluated: records.length,
    pagesRead: 1,
    truncated: false,
    sourceStatus,
    hasMore: Boolean(nextCursor),
    nextCursor,
    paginationComplete: !nextCursor,
    coverageComplete: !nextCursor && sourceStatus === 'healthy',
    stopReason: 'fixture',
  };
  return {
    records,
    coverage: buildCoverageManifest(['institutional_knowledge'], [source]),
    observability: {
      queryClass: 'lookup' as const,
      requestedDomains: ['institutional_knowledge' as const],
      queriedDatasets: ['institutional_knowledge' as const],
      requestedEntityCount: 1,
      queriedEntityCount: 1,
      pagesByDomain: { institutional_knowledge: 1 },
      sourceHealth: { institutional_knowledge: sourceStatus },
      freshnessByDomain: {},
      coverageComplete: source.coverageComplete,
      stopReason: 'fixture',
    },
  };
}
const row = {
  domain: 'institutional_knowledge',
  recordId: '40000000-0000-4000-8000-000000000001',
  payload: { value: 'Approved next-page content', governance: {} },
  provenance: {},
} as RetrievalRecord;

it('advances an empty visible page through the canonical owner with the same actor and client', async () => {
  const searchToolData = jest
    .fn()
    .mockResolvedValueOnce(page('next'))
    .mockResolvedValueOnce(page(undefined, [row]));
  const result = await searchGovernedMemory(
    ctx,
    { query: 'approved', clientId },
    { searchToolData },
  );
  expect(searchToolData).toHaveBeenNthCalledWith(
    2,
    ctx,
    expect.objectContaining({ clientId, cursors: { institutional_knowledge: 'next' } }),
  );
  expect(result).toMatchObject({ nextCursor: null, contentStatus: 'available' });
  expect(JSON.stringify(result)).toContain('Approved next-page content');
});

it('bounds empty-page draining and preserves a partial continuation', async () => {
  const searchToolData = jest
    .fn()
    .mockResolvedValueOnce(page('one'))
    .mockResolvedValueOnce(page('two'))
    .mockResolvedValueOnce(page('three'));
  const result = await searchGovernedMemory(ctx, { query: 'approved' }, { searchToolData });
  expect(searchToolData).toHaveBeenCalledTimes(3);
  expect(result).toMatchObject({
    nextCursor: 'three',
    records: [],
    coverage: { complete: false, paginationComplete: false },
  });
  for (const call of searchToolData.mock.calls) expect(call[1]).not.toHaveProperty('clientId');
});

it('stops on a repeated cursor rather than spinning or claiming completion', async () => {
  const searchToolData = jest.fn().mockResolvedValue(page('same'));
  await expect(
    searchGovernedMemory(ctx, { query: 'approved', cursor: 'same' }, { searchToolData }),
  ).rejects.toThrow('Memory cursor did not advance');
  expect(searchToolData).toHaveBeenCalledTimes(1);
});

it('does not continue a denied page even if it carries a cursor', async () => {
  const searchToolData = jest.fn().mockResolvedValue(page('forbidden', [], 'unauthorized'));
  const result = await searchGovernedMemory(
    ctx,
    { query: 'approved', clientId },
    { searchToolData },
  );
  expect(searchToolData).toHaveBeenCalledTimes(1);
  if (!('coverage' in result)) throw new Error('Expected a governed search result');
  expect(result.coverage.sources[0]?.sourceStatus).toBe('unauthorized');
});
