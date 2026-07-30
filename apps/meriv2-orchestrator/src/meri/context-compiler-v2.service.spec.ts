import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OrchestratorContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';

const CANARY = {
  clioFeatureFlags: {
    'meriv2.contextPacketV2': true,
    'meriv2.contextPacketV2.ga-chat': true,
    'meriv2.contextPacketV2.strategy': true,
  },
};

describe('OrchestratorContextCompilerService — Phase 8', () => {
  const ROW = {
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
    asOf: '2026-07-01T00:00:00.000Z',
    sensitivity: 'normal',
    instructionsAllowed: true,
    conflictStatus: 'none',
  };

  function makePrisma(
    rows: unknown[] = [ROW],
    options: { createFails?: boolean; readBack?: boolean; settings?: unknown } = {},
  ) {
    const packetCreates: Array<{ data: Record<string, unknown> }> = [];
    const queries: unknown[] = [];
    const executions: unknown[] = [];
    const tx = {
      tenant: { findFirst: jest.fn().mockResolvedValue({ settings: options.settings ?? CANARY }) },
      $queryRaw: jest.fn(async (arg: unknown) => {
        queries.push(arg);
        return rows;
      }),
      $executeRaw: jest.fn(async (arg: unknown) => {
        executions.push(arg);
        return 1;
      }),
      contextPacket: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          if (options.createFails) throw new Error('private db detail');
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
    return { prisma, tx, packetCreates, queries, executions };
  }

  const selectListOf = (arg: unknown): string => {
    const sql = ((arg as { strings?: string[] }).strings ?? []).join('?');
    return sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM memory_items'));
  };

  const original = process.env.MERIV2_CONTEXT_PACKET_V2;
  beforeEach(() => {
    delete process.env.MERIV2_CONTEXT_PACKET_V2;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MERIV2_CONTEXT_PACKET_V2;
    else process.env.MERIV2_CONTEXT_PACKET_V2 = original;
  });

  it('off reads v1 and references no governed column', async () => {
    const { prisma, queries } = makePrisma();
    const packet = await new OrchestratorContextCompilerService(prisma).compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
      contractVersion: 2,
    });
    expect(packet.version).toBe(1);
    expect(packet).not.toHaveProperty('rolloutMode');
    const select = selectListOf(queries[0]);
    expect(select).not.toContain('memory_class');
    expect(select).not.toContain('memory_authority');
  });

  it('enforce plus explicit surface canary reads governed columns and persists v2', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma, queries, packetCreates } = makePrisma();
    const packet = await new OrchestratorContextCompilerService(prisma).compile({
      tenantId: 't1',
      effectiveTenantId: 'effective-t1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
      traceId: 'trace-1',
    });
    expect(packet.version).toBe(2);
    const select = selectListOf(queries[0]);
    expect(select).toContain('memory_class AS "memoryClass"');
    expect(select).toContain('approved_by_user_id AS "approvedByUserId"');
    expect(select).not.toContain('source_excerpt');
    const data = packetCreates[0]!.data;
    expect(data.packetVersion).toBe(2);
    expect(data.compilerVersion).toBe('context-compiler-v2.1');
    expect(data.effectiveTenantId).toBe('effective-t1');
    expect(packet.persisted).toBe(true);
  });

  it('tenant umbrella without the exact surface canary stays on v1 under global enforce', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma } = makePrisma([ROW], {
      settings: { clioFeatureFlags: { 'meriv2.contextPacketV2': true } },
    });
    const packet = await new OrchestratorContextCompilerService(prisma).compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
    });
    expect(packet.version).toBe(1);
  });

  it('shadow persists v1 and v2 while returning unchanged v1', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'shadow';
    const { prisma, packetCreates, executions } = makePrisma();
    const packet = await new OrchestratorContextCompilerService(prisma).compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'ga-chat',
      layers: ['firm-identity'],
    });
    expect(packet.version).toBe(1);
    expect(packet).not.toHaveProperty('rolloutMode');
    expect(packet).not.toHaveProperty('shadowComparison');
    expect(packetCreates.map((entry) => entry.data.packetVersion)).toEqual([1, 2]);
    expect(executions).toHaveLength(1);
  });

  it('holds a required strategy surface when persistence verification fails', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma } = makePrisma([ROW], { readBack: false });
    await expect(
      new OrchestratorContextCompilerService(prisma).compile({
        tenantId: 't1',
        userId: 'u1',
        surface: 'strategy',
        layers: ['firm-identity'],
      }),
    ).rejects.toMatchObject({ name: 'ContextPacketPersistenceError' });
  });
});
