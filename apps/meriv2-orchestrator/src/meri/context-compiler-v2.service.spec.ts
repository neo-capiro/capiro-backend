import { OrchestratorContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';

/** ContextPacket v2 on the orchestrator adapter. */
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

  function makePrisma(
    rows: unknown[] = [APPROVED_FIRM_ROW],
    options: { createFails?: boolean; readBack?: boolean } = {},
  ) {
    const packetCreates: Array<{ data: Record<string, unknown> }> = [];
    const queries: unknown[] = [];
    const tx = {
      $queryRaw: jest.fn(async (arg: unknown) => {
        queries.push(arg);
        return rows;
      }),
      contextPacket: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          if (options.createFails) throw new Error('db down with private detail');
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
    return { prisma, tx, packetCreates, queries };
  }

  const selectListOf = (arg: unknown): string => {
    const sql = ((arg as { strings?: string[] }).strings ?? []).join('?');
    return sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM memory_items'));
  };

  it('the v1 read references no governed column', async () => {
    const { prisma, queries } = makePrisma();
    const service = new OrchestratorContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
    });
    const selectList = selectListOf(queries[0]);
    for (const column of [
      'memory_class',
      'memory_authority',
      'approved_by_user_id',
      'visibility',
    ]) {
      expect(selectList).not.toContain(column);
    }
  });

  it('the v2 read adds governed and ordering columns without confidential excerpts', async () => {
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
    expect(selectList).toContain('updated_at AS "updatedAt"');
    expect(selectList).toContain('last_confirmed_at AS "confirmedAt"');
    expect(selectList).toContain('provenance AS authority');
    expect(selectList).not.toContain('source_excerpt');
  });

  it('writes packet versions with full provenance and exact readback identity', async () => {
    const { prisma, tx, packetCreates } = makePrisma();
    const service = new OrchestratorContextCompilerService(prisma);

    const v1Packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
    });
    expect(packetCreates[0]!.data.packetVersion).toBe(1);
    expect(packetCreates[0]!.data).not.toHaveProperty('health');
    expect(v1Packet.packetId).toBe(v1Packet.generatedPacketId);

    const v2Packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
      contractVersion: 2,
      traceId: 'trace-1',
      tokenBudget: 5_000,
      budgetUnit: 'tokens',
    });
    const v2 = packetCreates[1]!.data;
    expect(v2.packetVersion).toBe(2);
    expect(v2.traceId).toBe('trace-1');
    expect(v2.compilerVersion).toBe('context-compiler-v2.0');
    expect(v2.requiredLayers).toEqual(['firm-identity']);
    expect(v2.health).toEqual(expect.objectContaining({ status: 'healthy' }));
    expect(v2.totalTokenBudget).toBe(5_000);
    expect(JSON.stringify(v2.items)).not.toContain('We are a GA firm.');
    expect(tx.contextPacket.findFirst).toHaveBeenCalled();
    expect(v2Packet.persisted).toBe(true);
    expect(v2Packet.packetId).toBe(v2Packet.generatedPacketId);
  });

  it('returns truthful degraded provenance when a best-effort v2 write fails', async () => {
    const { prisma } = makePrisma([APPROVED_FIRM_ROW], { createFails: true });
    const service = new OrchestratorContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
      contractVersion: 2,
      persistence: 'best-effort',
    });
    expect(packet.persisted).toBe(false);
    expect(packet.packetId).toBeNull();
    expect(packet.persistenceErrorCode).toBe('context_packet_error');
    expect(JSON.stringify(packet)).not.toContain('private detail');
  });

  it('holds a required strategy surface when write verification fails', async () => {
    const { prisma } = makePrisma([APPROVED_FIRM_ROW], { readBack: false });
    const service = new OrchestratorContextCompilerService(prisma);
    await expect(
      service.compile({
        tenantId: 't1',
        userId: 'u1',
        surface: 'strategy',
        layers: ['firm-identity'],
        contractVersion: 2,
        persistence: 'required',
      }),
    ).rejects.toMatchObject({ name: 'ContextPacketPersistenceError' });
  });
});
