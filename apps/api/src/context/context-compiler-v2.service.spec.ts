import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ContextCompilerService } from './context-compiler.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const CANARY_SETTINGS = {
  clioFeatureFlags: {
    'meriv2.contextPacketV2': true,
    'meriv2.contextPacketV2.chat': true,
    'meriv2.contextPacketV2.in-editor': true,
  },
};

/** ContextPacket v2, tenant canaries and truthful persistence on apps/api. */
describe('ContextCompilerService — Phase 8', () => {
  const APPROVED_FIRM_ROW = {
    id: '11111111-1111-4111-8111-111111111111',
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
    approvedByUserId: '22222222-2222-4222-8222-222222222222',
    approvedAt: '2026-07-01T00:00:00.000Z',
    asOf: '2026-07-01T00:00:00.000Z',
    sensitivity: 'normal',
    instructionsAllowed: true,
    conflictStatus: 'none',
  };

  function makePrisma(
    rows: unknown[],
    options: {
      createFails?: boolean;
      readBack?: boolean;
      settings?: unknown;
    } = {},
  ) {
    const packetCreates: Array<{ data: Record<string, unknown> }> = [];
    const queries: unknown[] = [];
    const executions: unknown[] = [];
    const tx = {
      tenant: {
        findFirst: jest.fn(async () => ({ settings: options.settings ?? CANARY_SETTINGS })),
      },
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
    return { prisma, tx, packetCreates, queries, executions };
  }

  const sqlTextOf = (arg: unknown): string =>
    ((arg as { strings?: string[] }).strings ?? []).join('?');
  const selectListOf = (arg: unknown): string => {
    const sql = sqlTextOf(arg);
    return sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM memory_items'));
  };

  const originalNew = process.env.MERIV2_CONTEXT_PACKET_V2;
  const originalLegacy = process.env.CONTEXT_PACKET_V2;
  beforeEach(() => {
    delete process.env.MERIV2_CONTEXT_PACKET_V2;
    delete process.env.CONTEXT_PACKET_V2;
  });
  afterEach(() => {
    if (originalNew === undefined) delete process.env.MERIV2_CONTEXT_PACKET_V2;
    else process.env.MERIV2_CONTEXT_PACKET_V2 = originalNew;
    if (originalLegacy === undefined) delete process.env.CONTEXT_PACKET_V2;
    else process.env.CONTEXT_PACKET_V2 = originalLegacy;
  });

  it('off never references a governed column, even when a caller requests v2', async () => {
    process.env.CONTEXT_PACKET_V2 = 'enforce';
    const { prisma, queries } = makePrisma([APPROVED_FIRM_ROW]);
    const service = new ContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'chat',
      layers: ['firm-identity'],
      contractVersion: 2,
    });
    expect(packet.version).toBe(1);
    const selectList = selectListOf(queries[0]);
    for (const column of [
      'memory_class',
      'memory_authority',
      'approved_by_user_id',
      'sensitivity',
      'instructions_allowed',
      'governed_status',
    ]) {
      expect(selectList).not.toContain(column);
    }
  });

  it('tenant canary enforce selects governed columns but never source_excerpt', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma, queries } = makePrisma([APPROVED_FIRM_ROW]);
    const service = new ContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'in-editor',
      layers: ['firm-identity'],
    });
    expect(packet.version).toBe(2);
    const sql = selectListOf(queries[0]);
    expect(sql).toContain('memory_class AS "memoryClass"');
    expect(sql).toContain('approved_by_user_id AS "approvedByUserId"');
    expect(sql).not.toContain('source_excerpt');
  });

  it('a tenant without the surface canary stays on v1 under a global enforce ceiling', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma } = makePrisma([APPROVED_FIRM_ROW], {
      settings: { clioFeatureFlags: { 'meriv2.contextPacketV2': true } },
    });
    const packet = await new ContextCompilerService(prisma).compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'in-editor',
      layers: ['firm-identity'],
    });
    expect(packet.version).toBe(1);
  });

  it('enforce writes v2 provenance and preserves the effective tenant', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma, packetCreates } = makePrisma([APPROVED_FIRM_ROW]);
    const packet = await new ContextCompilerService(prisma).compile({
      tenantId: 't1',
      effectiveTenantId: 'effective-t1',
      userId: 'u1',
      surface: 'in-editor',
      layers: ['firm-identity'],
      traceId: 'trace-abc',
      ref: { documentId: 'doc-1' },
    });
    expect(packet.version).toBe(2);
    const data = packetCreates[0]!.data;
    expect(data.packetVersion).toBe(2);
    expect(data.compilerVersion).toBe('context-compiler-v2.1');
    expect(data.policyVersion).toBe('context-policy-v2.1');
    expect(data.requiredLayers).toEqual(['firm-identity']);
    expect(data.health).toEqual(expect.objectContaining({ status: 'healthy' }));
    expect(data.effectiveTenantId).toBe('effective-t1');
    expect(JSON.stringify(data.items)).not.toContain('We are a GA firm.');
    expect(packet.persisted).toBe(true);
  });

  it('shadow persists both traces, returns unchanged v1, and records comparison evidence', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'shadow';
    const { prisma, packetCreates, executions } = makePrisma([APPROVED_FIRM_ROW]);
    const packet = await new ContextCompilerService(prisma).compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'chat',
      layers: ['firm-identity'],
    });
    expect(packet.version).toBe(1);
    expect(packet).not.toHaveProperty('rolloutMode');
    expect(packet).not.toHaveProperty('shadowComparison');
    expect(packetCreates.map((entry) => entry.data.packetVersion)).toEqual([1, 2]);
    expect(executions).toHaveLength(1);
  });

  it('required persistence failure holds enforce output', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma } = makePrisma([APPROVED_FIRM_ROW], { createFails: true });
    await expect(
      new ContextCompilerService(prisma).compile({
        tenantId: 't1',
        userId: 'u1',
        surface: 'in-editor',
        layers: ['firm-identity'],
      }),
    ).rejects.toMatchObject({ name: 'ContextPacketPersistenceError' });
  });

  it('missing read-after-write evidence cannot produce persisted=true', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma } = makePrisma([APPROVED_FIRM_ROW], { readBack: false });
    await expect(
      new ContextCompilerService(prisma).compile({
        tenantId: 't1',
        userId: 'u1',
        surface: 'in-editor',
        layers: ['firm-identity'],
      }),
    ).rejects.toMatchObject({ name: 'ContextPacketPersistenceError' });
  });
});
