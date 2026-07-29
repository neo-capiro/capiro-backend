import { MemoryCandidateService } from './memory-candidate.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { AppConfig } from '../config/config.schema.js';
import type { ConfigService } from '@nestjs/config';

/**
 * Closeout §4 — "Embeddings and secondary projections cannot cross-contaminate
 * clients or users."
 *
 * `clio_memory` is unique on (tenant, scope, owner_user_id, client_id, key), NOT
 * on (tenant, key). The same key therefore legitimately exists many times inside
 * one tenant: once per client for client-scope rows, once per user for
 * user_private rows, plus the firm-scope row.
 *
 * The embedding writeback used to be
 *
 *     UPDATE clio_memory SET embedding = $1 WHERE tenant_id = $2 AND key = $3
 *
 * so saving ONE memory overwrote the vector of EVERY same-key row in the tenant.
 * Concretely: client A's save repointed client B's semantic recall at A's
 * content, and one user's private note overwrote another user's private note with
 * a colliding key. Nothing surfaced the error — the rows kept their own `value`,
 * only the vector (what semantic search actually matches on) was wrong.
 *
 * These tests assert the SQL shape and its bound parameters directly, because
 * that predicate IS the isolation boundary. A test that only checked "an update
 * happened" would have passed against the buggy version.
 */

const EMBEDDING = Array.from({ length: 1536 }, (_, i) => i / 1536);

interface Captured {
  sql: string;
  params: unknown[];
}

function makeService(captured: Captured[]) {
  const executeRawUnsafe = jest.fn(async (sql: string, ...params: unknown[]) => {
    captured.push({ sql, params });
    return 1;
  });
  // clio_memory create/find path: report "no existing row", then return a known id.
  const tx = {
    clioMemory: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'row-under-test' })),
      update: jest.fn(async () => ({})),
    },
    $queryRaw: jest.fn(async () => []),
    $executeRawUnsafe: executeRawUnsafe,
  };
  const withTenant = jest.fn(async (_tenantId: string, fn: (t: unknown) => unknown) => fn(tx));
  const prisma = { withTenant } as unknown as PrismaService;
  const ingest = { projectClioMemory: jest.fn(async () => {}) } as unknown as MemoryIngestService;
  const config = {
    get: jest.fn((key: string) => (key === 'OPENAI_API_KEY' ? 'test-key' : undefined)),
  } as unknown as ConfigService<AppConfig, true>;
  return { service: new MemoryCandidateService(prisma, ingest, config), tx };
}

/** Reach the private embed path the way production does, via commitToClioMemory. */
async function commit(
  service: MemoryCandidateService,
  record: Record<string, unknown>,
): Promise<string> {
  return (
    service as unknown as {
      commitToClioMemory: (t: string, r: unknown) => Promise<string>;
    }
  ).commitToClioMemory('11111111-1111-4111-8111-111111111111', record);
}

describe('memory embedding writeback — row isolation', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: EMBEDDING }] }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  /** Wait out the deliberately un-awaited embed dispatch inside commitToClioMemory. */
  const settle = () => new Promise((r) => setImmediate(r));

  it('targets the exact committed row id, never (tenant_id, key)', async () => {
    const captured: Captured[] = [];
    const { service } = makeService(captured);

    await commit(service, {
      scope: 'client',
      ownerUserId: null,
      clientId: '22222222-2222-4222-8222-222222222222',
      key: 'position:fy27-shipbuilding',
      value: 'Client A supports the plus-up.',
      source: 'save_memory',
    });
    await settle();

    const embedWrite = captured.find((c) => c.sql.includes('SET embedding'));
    expect(embedWrite).toBeDefined();

    // The predicate must key off the row id.
    expect(embedWrite!.sql).toMatch(/WHERE\s+id\s*=\s*\$2::uuid/i);
    // tenant_id stays as defence in depth behind RLS...
    expect(embedWrite!.sql).toMatch(/tenant_id\s*=\s*\$3::uuid/i);
    // ...but the memory KEY must not appear in the predicate at all. This is the
    // assertion that actually fails against the old implementation.
    expect(embedWrite!.sql).not.toMatch(/\bkey\s*=/i);

    expect(embedWrite!.params[1]).toBe('row-under-test');
    expect(embedWrite!.params[2]).toBe('11111111-1111-4111-8111-111111111111');
  });

  it.each([
    [
      'two clients in one tenant sharing a key',
      { scope: 'client', ownerUserId: null, clientId: '22222222-2222-4222-8222-222222222222' },
      { scope: 'client', ownerUserId: null, clientId: '33333333-3333-4333-8333-333333333333' },
    ],
    [
      'two users in one tenant sharing a key',
      { scope: 'user_private', ownerUserId: '44444444-4444-4444-8444-444444444444', clientId: null },
      { scope: 'user_private', ownerUserId: '55555555-5555-4555-8555-555555555555', clientId: null },
    ],
    [
      'firm scope and client scope sharing a key',
      { scope: 'firm', ownerUserId: null, clientId: null },
      { scope: 'client', ownerUserId: null, clientId: '22222222-2222-4222-8222-222222222222' },
    ],
  ])('scopes the write to one row: %s', async (_label, subjectA, subjectB) => {
    const KEY = 'position:fy27-shipbuilding';

    const capturedA: Captured[] = [];
    const a = makeService(capturedA);
    a.tx.clioMemory.create = jest.fn(async () => ({ id: 'row-a' }));
    await commit(a.service, { ...subjectA, key: KEY, value: 'A', source: 'save_memory' });
    await settle();

    const capturedB: Captured[] = [];
    const b = makeService(capturedB);
    b.tx.clioMemory.create = jest.fn(async () => ({ id: 'row-b' }));
    await commit(b.service, { ...subjectB, key: KEY, value: 'B', source: 'save_memory' });
    await settle();

    const idOf = (c: Captured[]) =>
      c.find((x) => x.sql.includes('SET embedding'))?.params[1] ?? null;

    // Same key, different subjects — each write must name its own row, so neither
    // save can reach the other's vector.
    expect(idOf(capturedA)).toBe('row-a');
    expect(idOf(capturedB)).toBe('row-b');
    expect(idOf(capturedA)).not.toBe(idOf(capturedB));
  });

  it('does not call the embedding API when no OpenAI key is configured', async () => {
    const captured: Captured[] = [];
    const executeRawUnsafe = jest.fn(async (sql: string, ...params: unknown[]) => {
      captured.push({ sql, params });
      return 1;
    });
    const tx = {
      clioMemory: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 'row-x' })),
        update: jest.fn(async () => ({})),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRawUnsafe: executeRawUnsafe,
    };
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const service = new MemoryCandidateService(
      prisma,
      { projectClioMemory: jest.fn(async () => {}) } as unknown as MemoryIngestService,
      { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>,
    );

    await commit(service, {
      scope: 'firm',
      ownerUserId: null,
      clientId: null,
      key: 'k',
      value: 'v',
      source: 'save_memory',
    });
    await settle();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(captured.some((c) => c.sql.includes('SET embedding'))).toBe(false);
  });
});
