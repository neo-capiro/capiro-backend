import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { SemanticSearchService } from './semantic-search.service.js';
import { SEMANTIC_SEARCH_LIMITS } from './semantic-search.js';

// The query-vector port is scripted exactly as defense-research.semantic.spec
// does: the service must use the selected provider and its model, never Bedrock.
jest.mock('../embeddings/embedding-provider.factory.js', () => {
  const port = {
    metadata: { provider: 'owned-test-port', model: 'amazon.titan-embed-text-v2:0', modelVersion: 'v2', dimensions: 1024 },
    embed: jest.fn(),
    embedBatch: jest.fn(),
  };
  return { getDefaultEmbeddingProvider: () => port };
});
import { getDefaultEmbeddingProvider } from '../embeddings/embedding-provider.factory.js';

const ctx = {
  tenantId: 'ed202609-2800-4000-8000-000000009700',
  userId: 'ed202609-2800-4000-8000-000000009710',
  role: 'standard_user',
} as TenantContext;
const unit = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const port = () => getDefaultEmbeddingProvider() as unknown as { metadata: { model: string }; embed: jest.Mock };
const statementOf = (tx: { $queryRaw: jest.Mock }, call: number) =>
  (tx.$queryRaw.mock.calls as unknown as Array<[{ sql: string; values: unknown[] }]>)[call]![0];

function fixture(rows: unknown[] = [], coverage = { indexed: 43424, total: 48497 }) {
  const data = { active: true, rows };
  const tx = {
    tenantMembership: { findFirst: jest.fn(async () => (data.active ? { id: 'membership' } : null)) },
    $executeRaw: jest.fn(async () => 1),
    // The ranking statement answers first, the coverage statement second.
    $queryRaw: jest.fn(async (statement: { sql: string }) => (statement.sql.includes('AS indexed') ? [coverage] : data.rows)),
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { data, tx, prisma, service: new SemanticSearchService(prisma as never) };
}

beforeEach(() => {
  port().metadata.model = 'amazon.titan-embed-text-v2:0';
  port().embed.mockReset().mockResolvedValue(unit);
});
afterEach(() => jest.useRealTimers());

test('embeds the normalized query with the selected port and ranks under the member transaction', async () => {
  const { tx, prisma, service } = fixture([
    { parent_id: '119-hr-10', score: 0.71, snippet: 'HR 10 (119th Congress) Rural broadband', record: { id: '119-hr-10', title: 'Rural broadband' } },
  ]);
  const result = await service.read(ctx, 'semantic_search_bills', { query: '  rural   broadband ', congress: 119 });
  expect(port().embed).toHaveBeenCalledWith('rural broadband');
  expect(prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function), {
    timeoutMs: SEMANTIC_SEARCH_LIMITS.statementTimeoutMs,
  });
  expect(tx.tenantMembership.findFirst).toHaveBeenCalledWith({
    where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' }, select: { id: true },
  });
  const executeCalls = tx.$executeRaw.mock.calls as unknown as string[][][];
  expect(executeCalls[0]![0]!.join('?')).toContain("set_config('hnsw.ef_search'");
  const statement = statementOf(tx, 0);
  expect(statement.sql).toContain('FROM context_embeddings ce');
  expect(statement.values).toContain('bill');
  expect(statement.values).toContain('amazon.titan-embed-text-v2:0');
  expect(statement.values).toContain(`[${unit.join(',')}]`);
  expect(statement.values).toContain(119);
  expect(result).toMatchObject({
    tool: 'semantic_search_bills', query: 'rural broadband', model: 'amazon.titan-embed-text-v2:0', total: 1,
    coverage: { indexedRecords: 43424, totalRecords: 48497 },
    results: [{ reference: 'congress_bill:119-hr-10', score: 0.71 }],
  });
  expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  expect(statementOf(tx, 1).sql).toContain('AS indexed');
  expect(statementOf(tx, 1).values).toEqual(['amazon.titan-embed-text-v2:0']);
  expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
});

test('ranks grants and contract opportunities under their own source types', async () => {
  const { tx, service } = fixture();
  await service.read(ctx, 'semantic_search_grants', { query: 'clean water' });
  await service.read(ctx, 'semantic_search_contract_opportunities', { query: 'clean water', includeInactive: true });
  expect(statementOf(tx, 0).values).toContain('funding_grant_chunk');
  expect(statementOf(tx, 1).sql).toContain('FROM federal_grant WHERE embedded_at IS NOT NULL');
  expect(statementOf(tx, 2).values).toContain('funding_notice_chunk');
  expect(statementOf(tx, 3).sql).toContain('FROM sam_opportunity WHERE embedded_at IS NOT NULL');
});

test('refuses invalid input before the provider or database is touched', async () => {
  const { tx, prisma, service } = fixture();
  await expect(service.read(ctx, 'semantic_search_grants', { query: 'water', congress: 119 })).rejects.toThrow(/does not accept/);
  expect(port().embed).not.toHaveBeenCalled();
  expect(prisma.withTenantUser).not.toHaveBeenCalled();
  expect(tx.$queryRaw).not.toHaveBeenCalled();
});

test('a lost membership inside the transaction is refused and nothing is ranked', async () => {
  const { data, tx, service } = fixture();
  data.active = false;
  await expect(service.read(ctx, 'semantic_search_bills', { query: 'water' })).rejects.toThrow(ForbiddenException);
  expect(tx.$queryRaw).not.toHaveBeenCalled();
});

test.each([
  ['a provider failure', () => port().embed.mockRejectedValue(new Error('bedrock down'))],
  ['a wrong-width vector', () => port().embed.mockResolvedValue([1, 0, 0])],
  ['a zero vector', () => port().embed.mockResolvedValue(new Array(1024).fill(0))],
  ['a non-finite vector', () => port().embed.mockResolvedValue([Number.NaN, ...unit.slice(1)])],
])('%s is a closed 503 with no database access', async (_name, script) => {
  script();
  const { prisma, service } = fixture();
  await expect(service.read(ctx, 'semantic_search_bills', { query: 'water' })).rejects.toThrow(ServiceUnavailableException);
  expect(prisma.withTenantUser).not.toHaveBeenCalled();
});

test('bounds a hung query-vector port and leaves no timer behind', async () => {
  jest.useFakeTimers();
  port().embed.mockReturnValue(new Promise(() => undefined));
  const { prisma, service } = fixture();
  const pending = service.read(ctx, 'semantic_search_bills', { query: 'water' });
  const outcome = expect(pending).rejects.toThrow(ServiceUnavailableException);
  await jest.advanceTimersByTimeAsync(SEMANTIC_SEARCH_LIMITS.embedTimeoutMs + 1);
  await outcome;
  expect(prisma.withTenantUser).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test('a hit whose score is outside the admitted band is dropped from the page', async () => {
  const { service } = fixture([
    { parent_id: 'G-1', score: 0.9, snippet: 's', record: { id: 'G-1' } },
    { parent_id: 'G-2', score: 0.1, snippet: 's', record: { id: 'G-2' } },
  ]);
  const result = await service.read(ctx, 'semantic_search_grants', { query: 'water' });
  expect(result.results.map((r) => r.reference)).toEqual(['federal_grant:G-1']);
  expect(result.total).toBe(1);
});
