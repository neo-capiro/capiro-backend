import { ContextCompilerService } from './context-compiler.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Adapter-contract tests for apps/api's Context Compiler (G1). The compiler's
 * assembly logic is tested in meriv2-core; what THIS app owns — and what has
 * historically drifted — is the tenancy discipline and the trace write:
 *   1. a request WITH a userId rides withTenantUser (both GUCs — the 1C
 *      owner-aware RLS policy hides private user-voice rows otherwise);
 *   2. a request WITHOUT a userId rides withTenant;
 *   3. the steering query NEVER filters on status (the compiler must see
 *      superseded/revoked rows to record them as exclusions);
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

  function makePrisma(rows: unknown[] = [FIRM_ROW, REVOKED_ROW]) {
    const packetCreates: Array<{ data: Record<string, unknown> }> = [];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
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

  it('the steering query carries no status filter (governance is compiler-side)', async () => {
    const { prisma, tx } = makePrisma();
    const service = new ContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'chat',
      layers: ['firm-identity'],
    });

    // Prisma.sql produces { strings, values }; assert on the SQL text.
    const arg = (tx.$queryRaw as jest.Mock).mock.calls[0]![0] as { strings?: string[] };
    const sql = (arg.strings ?? []).join('?');
    expect(sql).toContain('FROM memory_items');
    expect(sql).not.toMatch(/status\s*=/i);
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
      const arg = (tx.$queryRaw as jest.Mock).mock.calls[0]![0] as { strings?: string[] };
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
