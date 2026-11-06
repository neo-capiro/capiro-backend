import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { SemanticSearchService } from './semantic-search.service.js';
import { SEMANTIC_SEARCH_LIMITS } from './semantic-search.js';
import { PrismaTransactionDeadlineError } from '../prisma/prisma-transaction-deadline.js';
import { withMeriToolExecutionControl } from './meri-tool-request-control.js';

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
    deadline: { at: expect.any(Number) },
  });
  expect(tx.tenantMembership.findFirst).toHaveBeenCalledWith({
    where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' }, select: { id: true },
  });
  const executeCalls = tx.$executeRaw.mock.calls as unknown as string[][][];
  expect(executeCalls[0]![0]!.join('?')).toContain("set_config('hnsw.ef_search'");
  const statement = statementOf(tx, 0);
  expect(statement.sql).toContain('FROM context_embeddings ce');
  expect(statement.sql).toContain("ce.source_type = 'bill'");
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
  expect(statementOf(tx, 0).sql).toContain("ce.source_type = 'funding_grant_chunk'");
  expect(statementOf(tx, 1).sql).toContain('FROM federal_grant r JOIN indexed_parents');
  expect(statementOf(tx, 2).sql).toContain("ce.source_type = 'funding_notice_chunk'");
  expect(statementOf(tx, 3).sql).toContain('FROM sam_opportunity r JOIN indexed_parents');
});

test('keeps semantic reads in the existing deadline without per-request JIT compilation', async () => {
  const { tx, service } = fixture();
  await service.read(ctx, 'semantic_search_bills', { query: 'unmanned aircraft' });
  const statements = (tx.$executeRaw.mock.calls as unknown as Array<[string[]]>).map(([parts]) => parts.join('?'));
  expect(statements.some(sql => sql.includes("set_config('jit', 'off', true)"))).toBe(true);
});

test('passes an absolute deadline so the database server cancels abandoned semantic queries', async () => {
  jest.useFakeTimers({ now: new Date('2026-11-05T12:00:00Z') });
  const { prisma, service } = fixture();
  await service.read(ctx, 'semantic_search_bills', { query: 'unmanned aircraft' });
  expect(prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function), {
    timeoutMs: SEMANTIC_SEARCH_LIMITS.statementTimeoutMs,
    deadline: { at: Date.now() + SEMANTIC_SEARCH_LIMITS.statementTimeoutMs },
  });
});

test('provider latency does not consume a database allowance that starts after embedding', async () => {
  jest.useFakeTimers({ now: new Date('2026-11-05T12:00:00Z') });
  port().embed.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(unit), 3500)));
  const { prisma, service } = fixture();
  const pending = service.read(ctx, 'semantic_search_bills', { query: 'unmanned aircraft' });
  await jest.advanceTimersByTimeAsync(3500);
  await pending;
  expect(prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function), {
    timeoutMs: SEMANTIC_SEARCH_LIMITS.statementTimeoutMs,
    deadline: { at: Date.now() + SEMANTIC_SEARCH_LIMITS.statementTimeoutMs },
  });
});

test('a shorter caller deadline is not renewed by the semantic database allowance', async () => {
  jest.useFakeTimers({ now: new Date('2026-11-05T12:00:00Z') });
  const { prisma, service } = fixture();
  const deadlineAt = Date.now() + 1000;
  await withMeriToolExecutionControl({ deadlineAt }, () =>
    service.read(ctx, 'semantic_search_grants', { query: 'water' }));
  expect(prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function), {
    timeoutMs: SEMANTIC_SEARCH_LIMITS.statementTimeoutMs, deadline: { at: deadlineAt },
  });
});

test.each(['semantic_search_dibbs_solicitations', 'semantic_search_sbir_topics'] as const)(
  '%s uses one bounded query embedding and the existing member transaction', async operation => {
    const { tx, prisma, service } = fixture([], { indexed: 0, total: 2 });
    await service.read(ctx, operation, { query: '  water   sensors ', agency: 'Defense' });
    expect(port().embed).toHaveBeenCalledTimes(1);
    expect(port().embed).toHaveBeenCalledWith('water sensors');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(statementOf(tx,0).values).toContain(port().metadata.model);
    expect(statementOf(tx,1).values).toEqual([port().metadata.model]);
    expect(prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId,ctx.userId,expect.any(Function),
      { timeoutMs: SEMANTIC_SEARCH_LIMITS.statementTimeoutMs, deadline: { at: expect.any(Number) } });
  },
);

test.each(['semantic_search_dibbs_solicitations', 'semantic_search_sbir_topics'] as const)(
  '%s rejects revoked membership and unsupported history without ranking', async operation => {
    const { data,tx,service } = fixture(); data.active=false;
    await expect(service.read(ctx,operation,{query:'water'})).rejects.toThrow(ForbiddenException);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    port().embed.mockClear();
    await expect(service.read(ctx,operation,{query:'water',includeInactive:true})).rejects.toThrow(/does not accept/);
    expect(port().embed).not.toHaveBeenCalled();
  },
);

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

test.each([
  ['a statement cancelled by statement_timeout', new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 'test', meta: { code: '57014' } })],
  ['an exhausted absolute database deadline', new PrismaTransactionDeadlineError()],
  ['a pool wait that ran out', new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the pool', { code: 'P2024', clientVersion: 'test' })],
])('%s is the same closed 503, not a 500', async (_name, error) => {
  const { prisma, service } = fixture();
  prisma.withTenantUser.mockRejectedValueOnce(error);
  await expect(service.read(ctx, 'semantic_search_bills', { query: 'water' })).rejects.toThrow(ServiceUnavailableException);
});

test('any other database failure is not masked as unavailable', async () => {
  const { prisma, service } = fixture();
  prisma.withTenantUser.mockRejectedValueOnce(new Error('relation "congress_bill" does not exist'));
  await expect(service.read(ctx, 'semantic_search_bills', { query: 'water' })).rejects.toThrow('does not exist');
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
