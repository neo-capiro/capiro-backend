import { describe, expect, it, jest } from '@jest/globals';
import { EMBEDDING_DIM } from '../embeddings/embedder.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { LearningSignalMemoryConflictService } from './learning-signal-memory-conflict.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

function fakeProvider(vector: number[] = Array(EMBEDDING_DIM).fill(0.1)): EmbeddingProvider {
  return {
    metadata: { provider: 'test', model: 'test-model', modelVersion: 'v1', dimensions: EMBEDDING_DIM },
    embed: jest.fn(async (..._args: unknown[]): Promise<number[]> => vector),
    embedBatch: jest.fn(async (inputs: readonly string[]) => inputs.map(() => vector)),
  };
}

/** The wall-check query runs first; find this service's own similarity
 *  query among the recorded calls by excluding that one. */
function realQuerySql(tx: { $queryRawUnsafe: { mock: { calls: unknown[][] } } }): string {
  const call = tx.$queryRawUnsafe.mock.calls.find(
    (args) => !/FROM\s+clients\s+c/i.test(args[0] as string),
  );
  if (!call) throw new Error('similarity query was never issued');
  return call[0] as string;
}

/** The full recorded call (SQL + bound parameters) for this service's own
 *  similarity query — used to prove placeholders and arguments agree. */
function realQueryCall(tx: { $queryRawUnsafe: { mock: { calls: unknown[][] } } }): unknown[] {
  const call = tx.$queryRawUnsafe.mock.calls.find(
    (args) => !/FROM\s+clients\s+c/i.test(args[0] as string),
  );
  if (!call) throw new Error('similarity query was never issued');
  return call;
}

/** Highest $N placeholder actually referenced by the SQL. */
function highestPlaceholder(sql: string): number {
  const found = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  return found.length === 0 ? 0 : Math.max(...found);
}

function buildHarness(rows: Array<{ id: string; slug: string; title: string; content_text: string; score: number }>) {
  const tx = {
    // fetchDeniedClientIds (memory-wall.helpers.ts) issues its OWN
    // $queryRawUnsafe against `clients c` before this service's own
    // similarity query runs — distinguish by SQL text so the wall check
    // always sees "no denied clients" and only the real query sees `rows`.
    $queryRawUnsafe: jest.fn(async (sql: string, ..._rest: unknown[]): Promise<unknown[]> =>
      /FROM\s+clients\s+c/i.test(sql) ? [] : rows,
    ),
  };
  const prisma = { withTenant: jest.fn((_tenantId: string, cb: (tx: unknown) => unknown) => cb(tx)) };
  const provider = fakeProvider();
  const service = new LearningSignalMemoryConflictService(prisma as never);
  service.setEmbeddingProviderForTests(provider);
  return { service, tx, prisma, provider };
}

describe('LearningSignalMemoryConflictService (Phase 27C)', () => {
  it('returns null for text too short to search meaningfully, without calling the embedding provider', async () => {
    const { service, provider } = buildHarness([]);
    const result = await service.findBestActiveMemoryMatch(
      { tenantId: TENANT, clientId: null, actorUserId: ACTOR },
      'short',
    );
    expect(result).toBeNull();
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it('returns null when nothing scores at/above the review threshold', async () => {
    const { service } = buildHarness([
      { id: 'item-1', slug: 'clio:item-1', title: 'Unrelated item', content_text: 'unrelated', score: 0.4 },
    ]);
    const result = await service.findBestActiveMemoryMatch(
      { tenantId: TENANT, clientId: null, actorUserId: ACTOR },
      'Client wants weekly congressional updates',
    );
    expect(result).toBeNull();
  });

  it("CORE EXAMPLE: high score + different text (monthly active item vs weekly candidate) = probable_contradiction, active item preserved", async () => {
    const { service, tx } = buildHarness([
      {
        id: 'item-monthly',
        slug: 'clio:item-monthly',
        title: 'Update cadence',
        content_text: 'Client wants monthly congressional updates',
        score: 0.94,
      },
    ]);
    const result = await service.findBestActiveMemoryMatch(
      { tenantId: TENANT, clientId: CLIENT, actorUserId: ACTOR },
      'Client wants weekly congressional updates',
    );
    expect(result).toEqual({
      kind: 'probable_contradiction',
      score: 0.94,
      memoryItemId: 'item-monthly',
      slug: 'clio:item-monthly',
      title: 'Update cadence',
    });
    // Read-only: both calls (the ethical-wall check and the similarity
    // search itself) are SELECTs — the fake tx exposes only
    // $queryRawUnsafe, proving no write call is even attempted (a write
    // call would throw "not a function").
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    const sql = realQuerySql(tx as any);
    expect(sql).toMatch(/^\s*SELECT/i);
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/i);
  });

  it('high score + equal text (after normalization) = duplicate', async () => {
    const { service } = buildHarness([
      {
        id: 'item-1',
        slug: 'clio:item-1',
        title: 'Cadence',
        content_text: '  Client Wants Weekly   Congressional Updates  ',
        score: 0.96,
      },
    ]);
    const result = await service.findBestActiveMemoryMatch(
      { tenantId: TENANT, clientId: CLIENT, actorUserId: ACTOR },
      'client wants weekly congressional updates',
    );
    expect(result?.kind).toBe('duplicate');
  });

  it('mid score = possible_related, not a confident contradiction claim', async () => {
    const { service } = buildHarness([
      { id: 'item-1', slug: 'clio:item-1', title: 'Loosely related', content_text: 'something else', score: 0.8 },
    ]);
    const result = await service.findBestActiveMemoryMatch(
      { tenantId: TENANT, clientId: null, actorUserId: ACTOR },
      'Client wants weekly congressional updates',
    );
    expect(result?.kind).toBe('possible_related');
  });

  it('client-scoped candidates search with the client predicate, not the owner predicate', async () => {
    const { service, tx } = buildHarness([]);
    await service.findBestActiveMemoryMatch({ tenantId: TENANT, clientId: CLIENT, actorUserId: ACTOR }, 'x'.repeat(20));
    const sql = realQuerySql(tx as any);
    expect(sql).toMatch(/mi\.client_id/);
  });

  it('personal (user_private) candidates search with the owner predicate, not the client predicate', async () => {
    const { service, tx } = buildHarness([]);
    await service.findBestActiveMemoryMatch({ tenantId: TENANT, clientId: null, actorUserId: ACTOR }, 'x'.repeat(20));
    const sql = realQuerySql(tx as any);
    expect(sql).toMatch(/mi\.owner_user_id/);
  });

  it('fails OPEN (returns null, never throws) when the embedding provider errors — a search outage must never block candidate generation', async () => {
    const { service, provider } = buildHarness([]);
    (provider.embed as any).mockRejectedValueOnce(new Error('bedrock unavailable'));
    const result = await service.findBestActiveMemoryMatch(
      { tenantId: TENANT, clientId: null, actorUserId: ACTOR },
      'Client wants weekly congressional updates',
    );
    expect(result).toBeNull();
  });

  it('fails OPEN when the query itself (or the wall check inside it) throws', async () => {
    const { service, tx } = buildHarness([]);
    (tx.$queryRawUnsafe as any).mockRejectedValueOnce(new Error('db unavailable'));
    const result = await service.findBestActiveMemoryMatch(
      { tenantId: TENANT, clientId: null, actorUserId: ACTOR },
      'Client wants weekly congressional updates',
    );
    expect(result).toBeNull();
  });

  it('only ever queries memory_items with status = active — no pending/superseded/revoked row can be "contradicted"', async () => {
    const { service, tx } = buildHarness([]);
    await service.findBestActiveMemoryMatch({ tenantId: TENANT, clientId: null, actorUserId: ACTOR }, 'x'.repeat(20));
    const sql = realQuerySql(tx as any);
    expect(sql).toMatch(/mi\.status\s*=\s*'active'/);
  });

  // ── Phase 27G regression: placeholder/argument arity must agree ──────────
  //
  // The client-scoped and user-scoped branches reference DIFFERENT
  // placeholders ($3 vs only $1/$2). Binding a third argument on the
  // user-scoped branch makes Postgres reject the whole statement with 42P18
  // "could not determine data type of parameter $3" — which this service's
  // deliberate fail-open catch then swallows as "no match found". The result
  // is invisible in every mocked test and in the logs' happy path: active
  // memory conflict/duplicate detection silently never runs for client-less
  // (user-voice) signals. Caught by the Phase 27G production canary. These
  // tests assert the invariant a mock can actually see — that the number of
  // bound arguments equals the highest placeholder the SQL references.

  it('binds exactly as many parameters as the SQL references, for a CLIENT-scoped signal', async () => {
    const { service, tx } = buildHarness([]);
    await service.findBestActiveMemoryMatch(
      { tenantId: TENANT, clientId: CLIENT, actorUserId: ACTOR },
      'a fact long enough to be searched against active memory',
    );
    const call = realQueryCall(tx);
    const sql = call[0] as string;
    const params = call.slice(1);
    expect(sql).toContain('$3::uuid');
    expect(highestPlaceholder(sql)).toBe(3);
    expect(params).toEqual([TENANT, ACTOR, CLIENT]);
  });

  it('binds exactly as many parameters as the SQL references, for a USER-scoped signal', async () => {
    const { service, tx } = buildHarness([]);
    await service.findBestActiveMemoryMatch(
      { tenantId: TENANT, clientId: null, actorUserId: ACTOR },
      'a fact long enough to be searched against active memory',
    );
    const call = realQueryCall(tx);
    const sql = call[0] as string;
    const params = call.slice(1);
    // The user-scoped branch must not mention $3 at all...
    expect(sql).not.toContain('$3');
    expect(highestPlaceholder(sql)).toBe(2);
    // ...and must therefore bind only two arguments. Binding a third (the
    // null clientId) is the 42P18 bug this test exists to prevent.
    expect(params).toEqual([TENANT, ACTOR]);
    expect(params).toHaveLength(2);
  });

  it('never binds an undefined/null positional parameter on either branch', async () => {
    for (const clientId of [CLIENT, null]) {
      const { service, tx } = buildHarness([]);
      await service.findBestActiveMemoryMatch(
        { tenantId: TENANT, clientId, actorUserId: ACTOR },
        'a fact long enough to be searched against active memory',
      );
      const params = realQueryCall(tx).slice(1);
      expect(params.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
    }
  });

});
