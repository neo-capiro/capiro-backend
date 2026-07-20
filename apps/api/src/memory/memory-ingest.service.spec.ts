import { MemoryIngestService } from './memory-ingest.service.js';
import type { MemoryItem } from './memory.types.js';

/**
 * GAP 1 + GAP 2 regression guards for Phase E of the memory backfill.
 *
 * Phase E used to read the now-dropped `chat_message` table (broken in prod). It
 * must now read the LIVE Meri store — clio_conversations JOIN clio_messages —
 * group by conversation, alias body->content, filter to user/assistant turns,
 * and emit a user-PRIVATE meri-session item with clientId=null (client-linking
 * is deferred until the Phase 3 owner-gating). Phase F must additionally report
 * {failed, failures[]} so the "Populate graph" UI can show outcomes.
 */
describe('MemoryIngestService — Phase E (Meri sessions from clio_*)', () => {
  function makeService() {
    const capturedSql: string[] = [];
    const upserted: MemoryItem[] = [];

    const tx = {
      // Phase 6: provenance ledger writes (open/close memory_ingest_run) go
      // through $executeRaw — the ingest run is inert audit plumbing here.
      $executeRaw: (_strings: TemplateStringsArray, ..._vals: unknown[]) => Promise.resolve(1),
      $queryRaw: (strings: TemplateStringsArray, ..._vals: unknown[]) => {
        const sql = strings.join(' ? ');
        capturedSql.push(sql);
        // Phase E sessions query (grouped over the conversation).
        if (sql.includes('FROM clio_conversations')) {
          return Promise.resolve([
            {
              session_id: '33333333-3333-3333-3333-333333333333',
              user_id: '44444444-4444-4444-4444-444444444444',
              // Present on the conversation but MUST NOT propagate to the item.
              client_id: '55555555-5555-5555-5555-555555555555',
              ended_at: new Date('2026-07-01T12:00:00.000Z'),
              turns: BigInt(3),
            },
          ]);
        }
        // Phase E per-session turns query.
        if (sql.includes('FROM clio_messages')) {
          return Promise.resolve([
            { role: 'user', content: 'Help me draft a memo on the FY27 mark' },
            { role: 'assistant', content: 'Here is a draft outline.' },
          ]);
        }
        // Phase B (clio_memory unification): one client-scoped + one ephemeral
        // row so we can prove the batch projection carries client_id/expires_at
        // (the nightly sweep silently nulled them before this fix).
        if (sql.includes('FROM clio_memory')) {
          return Promise.resolve([
            {
              id: '66666666-6666-6666-6666-666666666666',
              tenantId: '11111111-1111-1111-1111-111111111111',
              scope: 'client',
              ownerUserId: null,
              clientId: '77777777-7777-7777-7777-777777777777',
              expiresAt: null,
              key: 'acme-red-line',
              value: 'Never support Section 852 offsets.',
              source: 'user_requested',
              metadata: {},
              createdAt: new Date('2026-07-01T00:00:00.000Z'),
              updatedAt: new Date('2026-07-01T00:00:00.000Z'),
            },
          ]);
        }
        // Every other phase (clients, meetings, mail_threads, memory_items)
        // returns no rows so those loops are inert.
        return Promise.resolve([]);
      },
    };

    const prisma = {
      withSystem: (fn: (t: typeof tx) => unknown) => fn(tx),
    } as unknown as ConstructorParameters<typeof MemoryIngestService>[0];

    const store = {
      upsertSystem: (item: MemoryItem) => {
        upserted.push(item);
        return Promise.resolve('item-id');
      },
    } as unknown as ConstructorParameters<typeof MemoryIngestService>[1];

    const tenantCtx = {
      require: () => ({
        tenantId: '11111111-1111-1111-1111-111111111111',
        tenantSlug: 'acme',
        userId: '22222222-2222-2222-2222-222222222222',
        clerkUserId: 'system:test',
        role: 'capiro_admin',
      }),
    } as unknown as ConstructorParameters<typeof MemoryIngestService>[2];

    const svc = new MemoryIngestService(prisma, store, tenantCtx);
    return { svc, capturedSql, upserted };
  }

  it('reads clio_conversations/clio_messages (never chat_message), groups by conversation, aliases body->content, filters roles', async () => {
    const { svc, capturedSql } = makeService();
    await svc.backfillCurrentTenant();

    const joined = capturedSql.join('\n---\n');
    expect(joined).toContain('FROM clio_conversations');
    expect(joined).toContain('JOIN clio_messages');
    expect(joined).toContain('body AS content');
    expect(joined).toContain("role IN ('user', 'assistant')");
    expect(joined).toContain('GROUP BY c.id');
    // The dropped legacy table must never be referenced again.
    expect(joined).not.toContain('chat_message');
  });

  // Regression: the nightly batch projection MUST carry client_id + expires_at
  // (G2). Before this fix, Phase B omitted them, so upsertSystem's ON CONFLICT
  // set them from EXCLUDED → NULL, silently reverting client-scope/ephemeral on
  // every projected memory_items row each night.
  it('projects clio_memory client_id + expires_at (does not null G2 fields on the batch sweep)', async () => {
    const { svc, capturedSql, upserted } = makeService();
    await svc.backfillCurrentTenant();

    const clioSelect = capturedSql.find((s) => s.includes('FROM clio_memory'));
    expect(clioSelect).toBeDefined();
    expect(clioSelect).toContain('client_id');
    expect(clioSelect).toContain('expires_at');

    // …and the projected item carries the client through (not nulled).
    const clioItem = upserted.find((i) => i.slug?.startsWith('clio:'));
    expect(clioItem).toBeDefined();
    expect(clioItem!.clientId).toBe('77777777-7777-7777-7777-777777777777');
    expect(clioItem!.visibility).toBe('tenant');
  });

  it('emits a user-private meri-session item with clientId=null even when the conversation is client-linked', async () => {
    const { svc, upserted } = makeService();
    await svc.backfillCurrentTenant();

    const session = upserted.find((i) => i.type === 'meri-session');
    expect(session).toBeDefined();
    // The conversation carried a client_id, but the item stays private + unlinked.
    expect(session!.clientId).toBeNull();
    expect(session!.visibility).toBe('user');
    expect(session!.ownerUserId).toBe('44444444-4444-4444-4444-444444444444');
  });

  it('reports embedding outcomes as {failed, failures[]} (GAP 2 shape)', async () => {
    const { svc } = makeService();
    const counts = await svc.backfillCurrentTenant();
    expect(counts.meriSessions).toBe(1);
    expect(counts.failed).toBe(0);
    expect(Array.isArray(counts.failures)).toBe(true);
  });
});
