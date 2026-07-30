import { OrchestratorContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';

/** Adapter-contract tests for the orchestrator Context Compiler. */
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

  function makePrisma(
    rows: unknown[] = [VOICE_ROW, SUPERSEDED_ROW],
    options: { createFails?: boolean; readBack?: boolean } = {},
  ) {
    const packetCreates: Array<{ data: Record<string, unknown> }> = [];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      contextPacket: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          if (options.createFails) throw new Error('db down');
          packetCreates.push(args);
          return args;
        }),
        findFirst: jest.fn(async (args: { where: { id: string } }) =>
          options.readBack === false ? null : { id: args.where.id },
        ),
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

  it('rides withTenantUser when a userId is present', async () => {
    const { prisma } = makePrisma();
    const service = new OrchestratorContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity', 'user-voice'],
    });
    expect(prisma.withTenantUser).toHaveBeenCalledTimes(1);
    expect(prisma.withTenantUser).toHaveBeenCalledWith('t1', 'u1', expect.any(Function));
  });

  it('query carries no status filter; superseded rows become traced exclusions', async () => {
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

  it('exposes the packet id only after exact readback succeeds', async () => {
    const { prisma, tx, packetCreates } = makePrisma();
    const service = new OrchestratorContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['user-voice'],
    });

    expect(packetCreates).toHaveLength(1);
    expect(packetCreates[0]!.data.id).toBe(packet.generatedPacketId);
    expect(packetCreates[0]!.data.surface).toBe('ga-chat');
    expect(tx.contextPacket.findFirst).toHaveBeenCalled();
    expect(packet.persisted).toBe(true);
    expect(packet.packetId).toBe(packet.generatedPacketId);
  });

  it('returns null durable identity when best-effort persistence fails', async () => {
    const { prisma } = makePrisma([VOICE_ROW], { createFails: true });
    const service = new OrchestratorContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['user-voice'],
      persistence: 'best-effort',
    });

    expect(packet.persisted).toBe(false);
    expect(packet.packetId).toBeNull();
    expect(packet.persistedPacketId).toBeNull();
    expect(packet.persistenceErrorCode).toBe('context_packet_error');
  });

  it('throws on a required persistence failure', async () => {
    const { prisma } = makePrisma([VOICE_ROW], { readBack: false });
    const service = new OrchestratorContextCompilerService(prisma);
    await expect(
      service.compile({
        tenantId: 't1',
        userId: 'u1',
        surface: 'strategy',
        layers: ['user-voice'],
        persistence: 'required',
      }),
    ).rejects.toMatchObject({ name: 'ContextPacketPersistenceError' });
  });
});
