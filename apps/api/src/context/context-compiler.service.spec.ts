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
    expect(data.id).toBe(packet.packetId);
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
      // (type, slug, id) is total — id breaks any remaining tie.
      expect(sql).toMatch(/ORDER BY\s+type ASC,\s*slug ASC,\s*id ASC/);
    });

    /** Row shape the adapter query selects. */
    type SteeringRowLike = { id: string; type: string; slug: string };

    /** What Postgres returns once the ORDER BY is applied. */
    const applyOrderBy = <T extends SteeringRowLike>(rows: T[]): T[] =>
      [...rows].sort(
        (a, b) =>
          a.type.localeCompare(b.type) || a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id),
      );

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
      });
    };

    it('the compiler PRESERVES adapter row order — which is why the ORDER BY matters', async () => {
      // Documents the precondition rather than asserting the fix: fed unsorted
      // rows (what an unordered query can legitimately return), the compiled
      // block differs. This is the failure mode §3.c2 closes, and it is why the
      // ordering has to be enforced in SQL rather than assumed.
      const asStored = await signatureFor(ROWS);
      const shuffled = await signatureFor([...ROWS].reverse());
      expect(shuffled).not.toBe(asStored);
    });

    it('WITH the ORDER BY applied, output is identical however the heap was arranged', async () => {
      // Model the real query: whatever physical order the rows sit in, Postgres
      // returns them per (type, slug, id) — so the compiled artifact is stable.
      const base = await signatureFor(applyOrderBy(ROWS));
      const fromReversedHeap = await signatureFor(applyOrderBy([...ROWS].reverse()));
      const fromRotatedHeap = await signatureFor(applyOrderBy([ROWS[2]!, ROWS[0]!, ROWS[1]!]));

      expect(fromReversedHeap).toBe(base);
      expect(fromRotatedHeap).toBe(base);
      // And the order is the one the SQL declares: firm-compass < firm-soul < user-voice.
      expect(base).toMatch(/firm-compass:firm:mi-2.*firm-soul:firm:mi-1.*user-voice:me:mi-3/);
    });
  });
});
