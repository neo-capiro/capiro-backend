import { OrchestratorContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * ContextPacket v2 on the orchestrator adapter — the twin of apps/api's
 * context-compiler-v2.service.spec.
 *
 * The specific drift this locks: the orchestrator's v1 SELECT does not fetch
 * `updated_at` / `last_confirmed_at` / `provenance`, which `compareSteeringRows`
 * sorts on, so the same rows would compile to a DIFFERENTLY ORDERED packet than
 * apps/api produces. The governed (v2) read closes that. The v1 read is left alone
 * on purpose — changing it would reorder a live prompt with no switch to hide the
 * change behind.
 */
describe('OrchestratorContextCompilerService — ContextPacket v2', () => {
  const APPROVED_FIRM_ROW = {
    id: '11111111-1111-1111-1111-111111111111',
    type: 'firm-soul',
    slug: 'firm',
    title: 'Firm Soul',
    clientId: null,
    status: 'active',
    sections: [{ owner: 'human', heading: 'Who', body: 'We are a GA firm.' }],
    visibility: 'tenant',
    ownerUserId: null,
    memoryClass: 'institutional_authoritative',
    governedAuthority: 'firm_approved',
    sourceType: 'firm_playbook',
    sourceId: 'src-1',
    approvedByUserId: '22222222-2222-2222-2222-222222222222',
    approvedAt: '2026-07-01T00:00:00.000Z',
    sensitivity: 'normal',
    instructionsAllowed: true,
    conflictStatus: 'none',
  };

  function makePrisma(rows: unknown[] = [APPROVED_FIRM_ROW]) {
    const packetCreates: Array<{ data: Record<string, unknown> }> = [];
    const queries: unknown[] = [];
    const tx = {
      $queryRaw: jest.fn(async (arg: unknown) => {
        queries.push(arg);
        return rows;
      }),
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
    return { prisma, tx, packetCreates, queries };
  }

  const selectListOf = (arg: unknown): string => {
    const sql = ((arg as { strings?: string[] }).strings ?? []).join('?');
    return sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM memory_items'));
  };

  it('the v1 read references no governed column (they come from an unapplied migration)', async () => {
    const { prisma, queries } = makePrisma();
    const service = new OrchestratorContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
    });
    const selectList = selectListOf(queries[0]);
    for (const column of ['memory_class', 'memory_authority', 'approved_by_user_id', 'visibility']) {
      expect(selectList).not.toContain(column);
    }
  });

  it('the v2 read adds the governed columns AND the ordering columns apps/api already had', async () => {
    const { prisma, queries } = makePrisma();
    const service = new OrchestratorContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
      contractVersion: 2,
    });
    const selectList = selectListOf(queries[0]);
    expect(selectList).toContain('memory_class AS "memoryClass"');
    expect(selectList).toContain('approved_by_user_id AS "approvedByUserId"');
    // Cross-path ordering parity with apps/api.
    expect(selectList).toContain('updated_at AS "updatedAt"');
    expect(selectList).toContain('last_confirmed_at AS "confirmedAt"');
    expect(selectList).toContain('provenance AS authority');
    // Never the confidential body.
    expect(selectList).not.toContain('source_excerpt');
  });

  it('writes packet_version 1 for a v1 trace and 2 with full provenance for a v2 packet', async () => {
    const { prisma, packetCreates } = makePrisma();
    const service = new OrchestratorContextCompilerService(prisma);

    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
    });
    await new Promise((r) => setImmediate(r));
    expect(packetCreates[0]!.data.packetVersion).toBe(1);
    expect(packetCreates[0]!.data).not.toHaveProperty('health');

    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
      contractVersion: 2,
      traceId: 'trace-1',
      tokenBudget: 5_000,
      budgetUnit: 'tokens',
    });
    await new Promise((r) => setImmediate(r));
    const v2 = packetCreates[1]!.data;
    expect(v2.packetVersion).toBe(2);
    expect(v2.traceId).toBe('trace-1');
    expect(v2.compilerVersion).toBe('context-compiler-v2.0');
    expect(v2.requiredLayers).toEqual(['firm-identity']);
    expect(v2.health).toEqual(expect.objectContaining({ status: 'healthy' }));
    expect(v2.totalTokenBudget).toBe(5_000);
    expect(JSON.stringify(v2.items)).not.toContain('We are a GA firm.');
  });

  it('a v2 trace-write failure stays fire-and-forget', async () => {
    const { prisma, tx } = makePrisma();
    (tx.contextPacket.create as jest.Mock).mockRejectedValue(new Error('db down'));
    const service = new OrchestratorContextCompilerService(prisma);
    await expect(
      service.compile({
        tenantId: 't1',
        userId: 'u1',
        surface: 'ga-chat',
        layers: ['firm-identity'],
        contractVersion: 2,
      }),
    ).resolves.toBeTruthy();
  });
});
