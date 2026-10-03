import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ContextCompilerService } from './context-compiler.service.js';
import { ContextPersistenceBoundaryService } from './context-persistence-boundary.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MERI_FIXTURE_SEMANTIC_INSTANT, MERI_FIXTURE_SEMANTIC_ZONE, type MeriFixtureSemanticClock } from '@capiro/meriv2-core';

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
    legacyStatus: 'active',
    governedStatus: 'active',
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
      clockReadback?: 'missing' | 'changed' | 'extended';
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
        findFirst: jest.fn(async (args: { where: { id: string }; select?: { modelPolicy?: boolean } }) => {
          if (options.readBack === false) return null;
          // A separate JSON serialization round trip exercises the real adapter
          // write/readback contract, without claiming a PostgreSQL integration.
          const stored = JSON.parse(JSON.stringify(packetCreates.find(p => p.data.id === args.where.id)?.data ?? {}));
          const modelPolicy = stored.modelPolicy;
          if (options.clockReadback === 'missing') delete modelPolicy?.contextCompilerClockUse;
          if (options.clockReadback === 'changed' && modelPolicy?.contextCompilerClockUse)
            modelPolicy.contextCompilerClockUse.instant = '2000-01-01T00:00:00.000Z';
          if (options.clockReadback === 'extended' && modelPolicy?.contextCompilerClockUse)
            modelPolicy.contextCompilerClockUse.extra = true;
          return { id: args.where.id, ...(args.select?.modelPolicy ? { modelPolicy } : {}) };
        }),
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
    jest.useRealTimers();
    if (originalNew === undefined) delete process.env.MERIV2_CONTEXT_PACKET_V2;
    else process.env.MERIV2_CONTEXT_PACKET_V2 = originalNew;
    if (originalLegacy === undefined) delete process.env.CONTEXT_PACKET_V2;
    else process.env.CONTEXT_PACKET_V2 = originalLegacy;
  });

  const semanticClock: MeriFixtureSemanticClock = {
    version: 1, kind: 'qualified_original_fixture_semantic_clock',
    instant: MERI_FIXTURE_SEMANTIC_INSTANT, timeZone: MERI_FIXTURE_SEMANTIC_ZONE,
    caseId: '01', captureRunId: '11111111-1111-4111-8111-111111111111',
    currentVerifySha256: 'a'.repeat(64), observedAt: Date.parse('2026-10-03T12:00:00.000Z'),
  };
  const clockRequest = () => ({ tenantId: 't1', actorUserId: 'u1', userId: 'u1', surface: 'chat' as const,
    layers: ['firm-identity' as const], now: new Date(semanticClock.instant), semanticClock,
    ref: { conversationId: 'conversation-1', captureRequestId: 'request-1' } });

  it.each(['off', 'enforce', 'shadow'])('round-trips actual compiler clock metadata in %s mode', async mode => {
    jest.useFakeTimers().setSystemTime(new Date(semanticClock.observedAt));
    process.env.MERIV2_CONTEXT_PACKET_V2 = mode;
    const { prisma, tx, packetCreates } = makePrisma([APPROVED_FIRM_ROW]);
    const packet = await new ContextCompilerService(prisma).compile(clockRequest());
    const expected = { instant: semanticClock.instant, timeZone: semanticClock.timeZone,
      eligibilityAt: new Date(semanticClock.observedAt).toISOString(), scoring: mode === 'enforce' ? 'used' : 'not_run' };
    expect(packet.clockUse).toEqual(expected);
    expect(packet.persisted).toBe(true);
    expect(packetCreates[0]!.data.modelPolicy).toEqual({ contextCompilerClockUse: expected });
    expect(packetCreates[0]!.data.ref).toEqual(clockRequest().ref);
    expect(tx.contextPacket.findFirst).toHaveBeenCalledWith({
      where: { id: packet.packetId, tenantId: 't1' }, select: { id: true, modelPolicy: true },
    });
    if (mode === 'shadow') expect(packetCreates[1]!.data.modelPolicy).toMatchObject({
      contextCompilerClockUse: { ...expected, scoring: 'used' },
    });
  });

  it.each(['off', 'enforce'])('fails closed on missing or changed clock readback in %s mode', async mode => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = mode;
    for (const clockReadback of ['missing', 'changed', 'extended'] as const) {
      const { prisma } = makePrisma([APPROVED_FIRM_ROW], { clockReadback });
      await expect(new ContextCompilerService(prisma).compile(clockRequest())).rejects.toMatchObject({
        name: 'ContextPacketPersistenceError', code: 'context_packet_clock_readback_mismatch',
      });
    }
  });

  it('keeps ordinary off persistence and model policy behavior unchanged', async () => {
    const { prisma, tx, packetCreates } = makePrisma([APPROVED_FIRM_ROW]);
    const { semanticClock: _clock, now: _now, ...ordinary } = clockRequest();
    const packet = await new ContextCompilerService(prisma).compile(ordinary);
    expect(packetCreates[0]!.data).not.toHaveProperty('modelPolicy');
    expect(tx.contextPacket.findFirst).toHaveBeenCalledWith({
      where: { id: packet.packetId, tenantId: 't1' }, select: { id: true },
    });
    const failing = makePrisma([APPROVED_FIRM_ROW], { createFails: true });
    expect((await new ContextCompilerService(failing.prisma).compile(ordinary)).persisted).toBe(false);
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
    expect(sql).toContain('status AS "legacyStatus"');
    expect(sql).toContain('governed_status AS "governedStatus"');
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

  it('legacy active cannot override governed revoked', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma } = makePrisma([
      {
        ...APPROVED_FIRM_ROW,
        status: 'active',
        legacyStatus: 'active',
        governedStatus: 'revoked',
      },
    ]);
    const packet = await new ContextCompilerService(prisma).compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'in-editor',
      layers: ['firm-identity'],
    });
    expect(packet.version).toBe(2);
    if (packet.version !== 2) throw new Error('expected v2');
    expect(packet.items).toEqual([]);
    expect(packet.exclusions).toEqual([
      expect.objectContaining({ id: APPROVED_FIRM_ROW.id, reason: 'revoked' }),
    ]);
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

  it('records the exact required failure so a fail-soft caller cannot release output', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma } = makePrisma([APPROVED_FIRM_ROW], { createFails: true });
    const boundary = new ContextPersistenceBoundaryService();
    const service = new ContextCompilerService(prisma, boundary);

    await boundary.run(async () => {
      let caught: unknown;
      try {
        await service.compile({
          tenantId: 't1',
          userId: 'u1',
          surface: 'in-editor',
          layers: ['firm-identity'],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ name: 'ContextPacketPersistenceError' });
      expect(boundary.failure()).toBe(caught);
    });
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
