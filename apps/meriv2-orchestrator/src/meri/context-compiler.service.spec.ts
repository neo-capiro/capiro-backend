import { OrchestratorContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Adapter-contract tests for the orchestrator's Context Compiler (G1-b) —
 * the same locks as apps/api's context-compiler.service.spec, because this is
 * the surface where the withTenantUser/1C drift actually bit (GA-chat voice
 * silently zeroed, 2026-07-12):
 *   1. a request WITH a userId rides withTenantUser (both GUCs);
 *   2. the steering query never filters on status (governance is
 *      compiler-side so withholding is traced);
 *   3. the packet trace lands in context_packet and its failure never
 *      rejects compile().
 */
describe('OrchestratorContextCompilerService (adapter contract)', () => {
  const VOICE_ROW = {
    id: 'mi-v',
    type: 'user-voice',
    slug: 'voice',
    title: 'My Writing Style',
    clientId: null,
    status: 'active',
    sections: [{ owner: 'human', heading: 'Tone', body: 'Direct.' }],
  };
  const SUPERSEDED_ROW = {
    id: 'mi-old',
    type: 'firm-soul',
    slug: 'firm',
    title: 'Firm Soul',
    clientId: null,
    status: 'superseded',
    sections: [{ owner: 'human', heading: 'Old', body: 'Stale identity.' }],
  };

  function makePrisma(rows: unknown[] = [VOICE_ROW, SUPERSEDED_ROW]) {
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

  it('rides withTenantUser when a userId is present (the 1C GA-chat regression lock)', async () => {
    const { prisma } = makePrisma();
    const service = new OrchestratorContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity', 'user-voice'],
    });
    // The STEERING QUERY must ride withTenantUser (the packet-trace write
    // legitimately rides withTenant afterwards — that's persistence, not a
    // private-row read).
    expect(prisma.withTenantUser).toHaveBeenCalledTimes(1);
    expect(prisma.withTenantUser).toHaveBeenCalledWith('t1', 'u1', expect.any(Function));
  });

  it('query carries no status filter; superseded rows surface as traced exclusions', async () => {
    const { prisma, tx } = makePrisma();
    const service = new OrchestratorContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity', 'user-voice'],
    });

    const arg = (tx.$queryRaw as jest.Mock).mock.calls[0]![0] as { strings?: string[] };
    const sql = (arg.strings ?? []).join('?');
    expect(sql).toContain('FROM memory_items');
    expect(sql).not.toMatch(/status\s*=/i);

    expect(packet.rendered.map((r) => r.id)).toEqual(['mi-v']);
    expect(packet.exclusions).toEqual([
      expect.objectContaining({ id: 'mi-old', reason: 'superseded' }),
    ]);
  });

  it('persists the trace fire-and-forget and survives its failure', async () => {
    const { prisma, tx, packetCreates } = makePrisma();
    const service = new OrchestratorContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['user-voice'],
    });
    await new Promise((r) => setImmediate(r));
    expect(packetCreates).toHaveLength(1);
    expect(packetCreates[0]!.data.id).toBe(packet.packetId);
    expect(packetCreates[0]!.data.surface).toBe('ga-chat');

    (tx.contextPacket.create as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(
      service.compile({ tenantId: 't1', userId: 'u1', surface: 'ga-chat', layers: ['user-voice'] }),
    ).resolves.toBeTruthy();
  });
});
