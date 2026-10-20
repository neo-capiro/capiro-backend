import { ContextCompilerService } from './context-compiler.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Adapter-contract tests for apps/api's Context Compiler (G1). The compiler's
 * assembly logic is tested in meriv2-core; what THIS app owns — and what has
 * historically drifted — is the tenancy discipline and the trace write:
 *   1. a request WITH a userId rides withTenantUser (both GUCs — the 1C
 *      owner-aware RLS policy hides private user-voice rows otherwise);
 *   2. a request WITHOUT a userId rides withTenant;
 *   3. the steering query withholds inactive and Clio-derived rows before a
 *      v1 packet can render or persist them, even with lifecycle enforcement off;
 *   4. the packet trace lands in context_packet with the compiler's packetId
 *      and the item/exclusion counts, and a trace failure never rejects
 *      compile().
 */
describe('ContextCompilerService (apps/api adapter)', () => {
  const FIRM_ROW = {
    id: 'mi-f',
    type: 'firm-soul',
    slug: 'firm',
    title: 'Firm Soul',
    clientId: null,
    status: 'active',
    sections: [{ owner: 'human', heading: 'Who', body: 'Us.' }],
  };
  const REVOKED_ROW = {
    id: 'mi-r',
    type: 'firm-compass',
    slug: 'firm',
    title: 'Firm Compass',
    clientId: null,
    status: 'revoked',
    sections: [{ owner: 'human', heading: 'Where', body: 'Gone.' }],
  };

  function makePrisma(rows: unknown[] = [FIRM_ROW, REVOKED_ROW], governedColumnsAvailable = false) {
    const packetCreates: Array<{ data: Record<string, unknown> }> = [];
    const tx = {
      $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
      $queryRaw: jest.fn(async (sql: { strings?: string[] } | TemplateStringsArray) =>
        (Array.isArray(sql) ? sql : ((sql as { strings?: string[] }).strings ?? []))
          .join('?')
          .includes('pg_catalog.pg_attribute')
          ? [{ ready: governedColumnsAvailable }]
          : rows,
      ),
      contextPacket: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          packetCreates.push(args);
          return args;
        }),
        // Phase 7 persistence is truthful: the adapter re-reads the row it just
        // wrote and only reports success when the id reads back. A mock without
        // findFirst makes every persist fail read-after-write, which leaves
        // packetId null by design. Model the real store.
        findFirst: jest.fn(async (args: { where?: { id?: string } }) => {
          const id = args?.where?.id;
          const written = packetCreates.some((entry) => entry.data.id === id);
          return written && id ? { id } : null;
        }),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (t: unknown) => unknown) => fn(tx)),
      withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: unknown) => unknown) =>
        fn(tx),
      ),
    } as unknown as PrismaService;
    return { prisma, tx, packetCreates };
  }

  it('userId present → withTenantUser; absent → withTenant', async () => {
    const { prisma } = makePrisma();
    const service = new ContextCompilerService(prisma);

    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'chat',
      layers: ['firm-identity', 'user-voice'],
    });
    expect(prisma.withTenantUser).toHaveBeenCalledWith('t1', 'u1', expect.any(Function));

    await service.compile({
      tenantId: 't1',
      userId: null,
      surface: 'memo',
      layers: ['firm-identity'],
    });
    expect(prisma.withTenant).toHaveBeenCalled();
  });

  it('off-mode v1 query withholds Clio rows before packet persistence on the old schema', async () => {
    const { prisma, tx } = makePrisma();
    const service = new ContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'chat',
      layers: ['firm-identity'],
    });

    // Prisma.sql produces { strings, values }; assert on the SQL text.
    const arg = (tx.$queryRaw as jest.Mock).mock.calls.find(([sql]) =>
      (sql as { strings?: string[] }).strings?.join('?').includes('FROM memory_items'),
    )?.[0] as { strings?: string[] };
    const sql = (arg.strings ?? []).join('?');
    expect(sql).toContain('FROM memory_items');
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("slug NOT LIKE 'clio:%'");
    expect(sql).not.toContain('governed_status');
  });

  it('off-mode v1 query applies effective dates and terminal suppression when migrated', async () => {
    const { prisma, tx } = makePrisma([FIRM_ROW], true);
    const service = new ContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'chat',
      layers: ['firm-identity'],
    });
    const arg = (tx.$queryRaw as jest.Mock).mock.calls.find(([query]) =>
      (query as { strings?: string[] }).strings?.join('?').includes('FROM memory_items'),
    )?.[0] as { strings?: string[] };
    const sql = (arg.strings ?? []).join('?');
    expect(sql).toContain("governed_status IN ('active', 'stale')");
    expect(sql).toContain('effective_from <= now()');
    expect(sql).toContain('controlling_item_id = id');
  });

  it('requires exact owner shape and the selected client wall for steering', async () => {
    const { prisma, tx } = makePrisma([FIRM_ROW]);
    const service = new ContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      clientId: 'c1',
      surface: 'chat',
      layers: ['firm-identity', 'user-voice', 'client-steering'],
    });
    const arg = (tx.$queryRaw as jest.Mock).mock.calls.find(([query]) =>
      (query as { strings?: string[] }).strings?.join('?').includes('FROM memory_items'),
    )?.[0] as { strings?: string[] };
    const sql = (arg.strings ?? []).join('?');
    expect(sql).toContain('WHERE tenant_id = ?::uuid AND (');
    expect((arg as { values?: unknown[] }).values).toContain('t1');
    expect(sql).toContain("slug = 'firm'\n              AND visibility = 'tenant' AND owner_user_id IS NULL AND client_id IS NULL");
    expect(sql).toContain("AND visibility = 'user' AND owner_user_id = ?::uuid");
    expect(sql).toContain('AND (client_id IS NULL OR (?');
    expect(sql).toContain("AND visibility = 'tenant' AND owner_user_id IS NULL");
  });

  it('persists the trace with packetId + counts, and revoked rows land as exclusions', async () => {
    const { prisma, packetCreates } = makePrisma();
    const service = new ContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'chat',
      layers: ['firm-identity'],
      ref: { conversationId: 'conv-9' },
    });
    await new Promise((r) => setImmediate(r)); // fire-and-forget settle

    expect(packet.exclusions).toEqual([expect.objectContaining({ id: 'mi-r', reason: 'revoked' })]);
    expect(packetCreates).toHaveLength(1);
    const data = packetCreates[0]!.data;
    // The compiler generates the id; packetId is only populated once the
    // read-after-write confirms persistence, and both must be that same id.
    expect(data.id).toBe(packet.generatedPacketId);
    expect(packet.persisted).toBe(true);
    expect(packet.packetId).toBe(packet.generatedPacketId);
    expect(data.surface).toBe('chat');
    expect(data.itemCount).toBe(1);
    expect(data.exclusionCount).toBe(1);
    expect(data.ref).toEqual({ conversationId: 'conv-9' });
  });

  it('a trace-write failure never rejects compile()', async () => {
    const { prisma, tx } = makePrisma();
    (tx.contextPacket.create as jest.Mock).mockRejectedValue(new Error('db down'));
    const service = new ContextCompilerService(prisma);
    await expect(
      service.compile({ tenantId: 't1', userId: 'u1', surface: 'chat', layers: ['firm-identity'] }),
    ).resolves.toBeTruthy();
  });

  // ── Phase 1 §3.c2 — deterministic adapter row order ──────────────────────
  //
  // ContextCompiler.compile() preserves adapter row order within each requested
  // layer, and Postgres guarantees no order without ORDER BY. So two identical
  // requests could render steering blocks in different orders purely from plan
  // or heap variation — which would make the Evidence Packet hash meaningless
  // (§5.7.4) and break the byte-stable cacheable prompt prefix.
  describe('deterministic steering order (Phase 1 §3.c2)', () => {
    const ROWS = [
      {
        id: 'mi-3',
        type: 'user-voice',
        slug: 'me',
        title: 'My Voice',
        clientId: null,
        status: 'active',
        sections: [{ owner: 'human', heading: 'Style', body: 'Direct.' }],
      },
      {
        id: 'mi-1',
        type: 'firm-soul',
        slug: 'firm',
        title: 'Firm Soul',
        clientId: null,
        status: 'active',
        sections: [{ owner: 'human', heading: 'Who', body: 'Us.' }],
      },
      {
        id: 'mi-2',
        type: 'firm-compass',
        slug: 'firm',
        title: 'Firm Compass',
        clientId: null,
        status: 'active',
        sections: [{ owner: 'human', heading: 'Where', body: 'Forward.' }],
      },
    ];

    it('the steering query carries an explicit total ORDER BY', async () => {
      const { prisma, tx } = makePrisma(ROWS);
      const service = new ContextCompilerService(prisma);
      await service.compile({
        tenantId: 't1',
        userId: 'u1',
        surface: 'outreach',
        layers: ['firm-identity', 'user-voice'],
      });
      const arg = (tx.$queryRaw as jest.Mock).mock.calls.find(([query]) =>
        (query as { strings?: string[] }).strings?.join('?').includes('FROM memory_items'),
      )?.[0] as { strings?: string[] };
      const sql = (arg.strings ?? []).join('?');
      // Semantic rank first (Firm Soul before Firm Compass), then authority
      // recency, and finally (type, slug, id) — which is total, so `id` breaks any
      // remaining tie and the query can never depend on PostgreSQL's heap order.
      expect(sql).toMatch(/ORDER BY/);
      expect(sql).toMatch(/CASE type[\s\S]*'firm-soul'[\s\S]*'firm-compass'/);
      expect(sql).toMatch(/CASE status[\s\S]*'active'/);
      expect(sql).toMatch(/type ASC,\s*slug ASC,\s*id ASC/);
    });

    const signatureFor = async (rows: unknown[]) => {
      const { prisma } = makePrisma(rows);
      const service = new ContextCompilerService(prisma);
      const packet = await service.compile({
        tenantId: 't1',
        userId: 'u1',
        surface: 'outreach',
        layers: ['firm-identity', 'user-voice'],
      });
      return JSON.stringify({
        items: packet.items.map((i) => `${i.layer}:${i.type}:${i.slug}:${i.id}`),
        rendered: packet.rendered.map((r) => `${r.layer}:${r.type}:${r.body}`),
        traceHash: packet.traceHash,
      });
    };

    it('is order-INDEPENDENT: any adapter row order compiles the same packet', async () => {
      // Phase 1 inverted the earlier §3.c2 contract. The compiler no longer
      // PRESERVES adapter order — it sorts independently — so a query that
      // returned rows in a different heap order can no longer change the compiled
      // block or its trace hash. The SQL ORDER BY is now defence-in-depth rather
      // than the only thing standing between us and a nondeterministic prompt.
      const base = await signatureFor(ROWS);
      expect(await signatureFor([...ROWS].reverse())).toBe(base);
      expect(await signatureFor([ROWS[2]!, ROWS[0]!, ROWS[1]!])).toBe(base);
      expect(await signatureFor([ROWS[1]!, ROWS[2]!, ROWS[0]!])).toBe(base);
    });

    it('orders by canonical rank — Firm Soul before Firm Compass, not alphabetically', async () => {
      const base = await signatureFor([...ROWS].reverse());
      expect(base).toMatch(/firm-soul:firm:mi-1.*firm-compass:firm:mi-2.*user-voice:me:mi-3/);
    });

    it('produces a stable trace hash across shuffled input', async () => {
      const hashOf = (signature: string) =>
        (JSON.parse(signature) as { traceHash: string }).traceHash;
      const base = hashOf(await signatureFor(ROWS));
      expect(base).toMatch(/^[a-f0-9]{64}$/);
      expect(hashOf(await signatureFor([...ROWS].reverse()))).toBe(base);
    });
  });
});
