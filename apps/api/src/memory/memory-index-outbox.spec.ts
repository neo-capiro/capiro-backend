import { MemoryCandidateService } from './memory-candidate.service.js';
import {
  DRAINABLE_CLEANUP_OPERATIONS,
  MemoryCleanupOutboxService,
} from './memory-cleanup-outbox.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { AppConfig } from '../config/config.schema.js';
import type { ConfigService } from '@nestjs/config';

/**
 * Closeout §4 / rule 7 — "No fire-and-forget durable work."
 *
 * `commitToClioMemory` used to end with two un-awaited dispatches:
 *
 *     void this.embedMemory(...)
 *     void this.memoryIngest.projectClioMemory(...)
 *
 * If either lost its race with a container stop, a deploy, or an unhandled
 * rejection, the memory existed in `clio_memory` but was never projected into
 * `memory_items` and never embedded. Nothing recorded that the work was owed, so
 * nothing retried it — the memory silently never became recallable, and no
 * operator signal existed to notice.
 *
 * The fix keeps the dispatch NON-BLOCKING (embedding calls Bedrock; awaiting it
 * would add a network round trip to every `save_memory` in a chat turn) but makes
 * it non-forgettable: an `index_memory_item` row is committed in the SAME
 * transaction as the memory, closed on success, and left for the drain on
 * failure.
 *
 * These tests assert the durability contract, not the happy path — a test that
 * only checked "projectClioMemory was called" would have passed against the old
 * lossy code.
 */

interface Captured {
  sql: string;
  params: unknown[];
}

function makeHarness(opts: { projectionFails?: boolean } = {}) {
  const captured: Captured[] = [];
  const enqueuedInTx: string[] = [];
  let txDepth = 0;
  let enqueuedWhileInTx = false;

  const tx = {
    clioMemory: {
      findFirst: async () => null,
      create: async () => ({ id: 'mem-1' }),
      update: async () => ({}),
    },
    // Both the version stamp read and the outbox INSERT arrive here.
    $queryRaw: async (strings: { raw?: string[] } | unknown, ..._p: unknown[]) => {
      const raw = Array.isArray((strings as { raw?: string[] }).raw)
        ? (strings as { raw: string[] }).raw.join('?')
        : String(strings);
      captured.push({ sql: raw, params: _p });
      if (/updated_at\s+FROM\s+clio_memory/i.test(raw)) {
        return [{ updated_at: new Date('2026-07-29T12:00:00.000Z') }];
      }
      return [];
    },
    $executeRaw: async (strings: { raw?: string[] } | unknown, ...p: unknown[]) => {
      const raw = Array.isArray((strings as { raw?: string[] }).raw)
        ? (strings as { raw: string[] }).raw.join('?')
        : String(strings);
      captured.push({ sql: raw, params: p });
      if (/INSERT INTO memory_cleanup_outbox/i.test(raw)) {
        enqueuedInTx.push(raw);
        if (txDepth > 0) enqueuedWhileInTx = true;
      }
      return 1;
    },
    $executeRawUnsafe: async (sql: string, ...p: unknown[]) => {
      captured.push({ sql, params: p });
      return 1;
    },
  };

  const prisma = {
    withTenant: async (_t: string, fn: (t: unknown) => unknown) => {
      txDepth += 1;
      try {
        return await fn(tx);
      } finally {
        txDepth -= 1;
      }
    },
    withSystem: async (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as PrismaService;

  const projectClioMemory = jest.fn(async () => {
    if (opts.projectionFails) throw new Error('bedrock unavailable');
  });
  const ingest = { projectClioMemory } as unknown as MemoryIngestService;
  const config = {
    get: jest.fn(() => undefined), // no OPENAI key -> embed is a no-op
  } as unknown as ConfigService<AppConfig, true>;

  const service = new MemoryCandidateService(prisma, ingest, config);
  return {
    service,
    captured,
    enqueuedInTx,
    projectClioMemory,
    wasEnqueuedInsideTransaction: () => enqueuedWhileInTx,
  };
}

const TENANT = '11111111-1111-4111-8111-111111111111';

async function commit(service: MemoryCandidateService) {
  return (
    service as unknown as { commitToClioMemory: (t: string, r: unknown) => Promise<string> }
  ).commitToClioMemory(TENANT, {
    scope: 'firm',
    ownerUserId: null,
    clientId: null,
    key: 'firm-position:fy27',
    value: 'The firm supports the plus-up.',
    source: 'save_memory',
  });
}

/** Let the deliberately un-awaited fast-path dispatch settle. */
const settle = () => new Promise((r) => setImmediate(r));

describe('committing a memory owes durable indexing work', () => {
  it('enqueues index_memory_item inside the SAME transaction as the memory write', async () => {
    const h = makeHarness();
    await commit(h.service);

    expect(h.enqueuedInTx).toHaveLength(1);
    // The whole point: the job cannot outlive a rolled-back memory write, and a
    // committed memory cannot exist without the job.
    expect(h.wasEnqueuedInsideTransaction()).toBe(true);

    const insert = h.captured.find((c) => /INSERT INTO memory_cleanup_outbox/i.test(c.sql));
    expect(insert!.params).toContain('index_memory_item');
    // Named by clio_memory_id — the memory_items row does not exist yet.
    expect(insert!.params).toContain('mem-1');
  });

  it('keys idempotency on the memory VERSION so a later save owes fresh work', async () => {
    const h = makeHarness();
    await commit(h.service);

    const insert = h.captured.find((c) => /INSERT INTO memory_cleanup_outbox/i.test(c.sql));
    const key = insert!.params.find(
      (p): p is string => typeof p === 'string' && p.startsWith('index_memory_item:'),
    );
    // Row id AND the updated_at stamp: keying on the row alone would make the
    // second edit of the same memory collapse into the first job and never index.
    expect(key).toBe('index_memory_item:mem-1:2026-07-29T12:00:00.000Z');
  });

  it('does not block the caller on the projection', async () => {
    const h = makeHarness();
    // A projection that never settles must not stop the save from returning.
    h.projectClioMemory.mockImplementation(() => new Promise(() => {}));

    const id = await commit(h.service);

    expect(id).toBe('mem-1');
  });

  it('closes the outbox row when the immediate projection succeeds', async () => {
    const h = makeHarness();
    await commit(h.service);
    await settle();

    expect(h.projectClioMemory).toHaveBeenCalledWith(TENANT, 'mem-1');
    const close = h.captured.find(
      (c) => /UPDATE memory_cleanup_outbox/i.test(c.sql) && /'completed'/.test(c.sql),
    );
    expect(close).toBeDefined();
    // Scoped to this tenant + this memory + this operation, and only from a
    // non-terminal state, so it can never close somebody else's job.
    expect(close!.sql).toMatch(/operation = 'index_memory_item'/);
    expect(close!.sql).toMatch(/status IN \('pending', 'failed'\)/);
  });

  it('LEAVES the row pending when the immediate projection fails', async () => {
    const h = makeHarness({ projectionFails: true });
    const id = await commit(h.service);
    await settle();

    // The save still succeeds — the memory is committed and the work is owed.
    expect(id).toBe('mem-1');
    // Nothing marked it completed, so the drain will retry. This is the exact
    // case that used to disappear without a trace.
    const close = h.captured.find(
      (c) => /UPDATE memory_cleanup_outbox/i.test(c.sql) && /'completed'/.test(c.sql),
    );
    expect(close).toBeUndefined();
  });
});

describe('the drain can execute the forward index operation', () => {
  it('lists index_memory_item as drainable', () => {
    // It used to be excluded, and processJob failed such rows as
    // `unsupported operation` — so a queued index job could never be worked off.
    expect(DRAINABLE_CLEANUP_OPERATIONS).toContain('index_memory_item');
  });

  it('fails loudly rather than silently completing when no projector is wired', async () => {
    // Constructed without an ingest service: completing the job here would strand
    // the memory unprojected forever while reporting success.
    const svc = new MemoryCleanupOutboxService({
      withSystem: async (fn: (t: unknown) => unknown) =>
        fn({
          $queryRaw: async () => [
            {
              id: 'job-1',
              tenant_id: TENANT,
              memory_item_id: null,
              clio_memory_id: 'mem-1',
              operation: 'index_memory_item',
              attempts: 1,
            },
          ],
          $executeRaw: async () => 1,
        }),
    } as unknown as PrismaService);

    const outcome = await (
      svc as unknown as { processJob: (id: string) => Promise<string> }
    ).processJob('job-1');

    expect(outcome).toBe('failed');
  });
});
