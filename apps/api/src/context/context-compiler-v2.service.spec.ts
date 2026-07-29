import { ContextCompilerService } from './context-compiler.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * ContextPacket v2 on the apps/api adapter.
 *
 * Three things this app owns and meriv2-core cannot test for it:
 *   1. the v1 path stays byte-for-byte identical (v2 is dark);
 *   2. the v2 path SELECTs the governed columns — without them
 *      `filterGovernedMemory` withholds every firm/client item as `unapproved`
 *      and mislabels a private item as firm scope, and the UI reports success;
 *   3. `persistPacket` writes the v2 provenance columns and an HONEST
 *      `packet_version` (1 for a legacy steering trace, 2 for a compiled v2
 *      packet), without ever rewriting an existing row.
 */
describe('ContextCompilerService — ContextPacket v2', () => {
  const APPROVED_FIRM_ROW = {
    id: '11111111-1111-1111-1111-111111111111',
    type: 'firm-soul',
    slug: 'firm',
    title: 'Firm Soul',
    clientId: null,
    status: 'active',
    sections: [{ owner: 'human', heading: 'Who', body: 'We are a GA firm.' }],
    // Governed metadata, as the v2 SELECT returns it.
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

  const CONFIDENTIAL_ROW = {
    ...APPROVED_FIRM_ROW,
    id: '33333333-3333-3333-3333-333333333333',
    type: 'firm-compass',
    title: 'Firm Compass (restricted)',
    sections: [{ owner: 'human', heading: 'Secret', body: 'Highly confidential framing.' }],
    sensitivity: 'restricted',
  };

  function makePrisma(rows: unknown[]) {
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

  const sqlTextOf = (arg: unknown): string =>
    ((arg as { strings?: string[] }).strings ?? []).join('?');

  /**
   * Only the SELECT list. `owner_user_id` legitimately appears in the WHERE clause
   * on both paths (it is the pre-governance owner column), so asserting on the whole
   * statement would be asserting the wrong thing.
   */
  const selectListOf = (arg: unknown): string => {
    const sql = sqlTextOf(arg);
    return sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM memory_items'));
  };

  it('the v1 path never references a governed column (they are added by an unapplied migration)', async () => {
    const { prisma, queries } = makePrisma([APPROVED_FIRM_ROW]);
    const service = new ContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'chat',
      layers: ['firm-identity'],
    });
    expect(packet.version).toBe(1);
    const selectList = selectListOf(queries[0]);
    for (const column of [
      'memory_class',
      'memory_authority',
      'approved_by_user_id',
      'sensitivity',
      'instructions_allowed',
      'visibility',
      'governed_status',
    ]) {
      expect(selectList).not.toContain(column);
    }
  });

  it('the v2 path selects the governed columns — but never source_excerpt', async () => {
    const { prisma, queries } = makePrisma([APPROVED_FIRM_ROW]);
    const service = new ContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'in-editor',
      layers: ['firm-identity'],
      contractVersion: 2,
    });
    const sql = selectListOf(queries[0]);
    for (const column of [
      'memory_class AS "memoryClass"',
      'memory_authority AS "governedAuthority"',
      'approved_by_user_id AS "approvedByUserId"',
      'second_approved_by_user_id AS "secondApprovedByUserId"',
      'owner_user_id AS "ownerUserId"',
      'visibility',
      'sensitivity',
      'instructions_allowed AS "instructionsAllowed"',
      'conflict_status AS "conflictStatus"',
    ]) {
      expect(sql).toContain(column);
    }
    // A packet records refs, hashes and metadata — never confidential bodies.
    expect(sql).not.toContain('source_excerpt');
  });

  it('an approved, classified firm item survives the governed filter on v2', async () => {
    const { prisma } = makePrisma([APPROVED_FIRM_ROW]);
    const service = new ContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'in-editor',
      layers: ['firm-identity'],
      contractVersion: 2,
    });
    expect(packet.version).toBe(2);
    expect(packet.items).toHaveLength(1);
    expect(packet.exclusions).toEqual([]);
    const item = packet.items[0] as { authority: string; memoryClass: string; scope: string };
    expect(item.authority).toBe('firm_approved');
    expect(item.memoryClass).toBe('institutional_authoritative');
    expect(item.scope).toBe('firm');
  });

  /**
   * The privacy contract: a withholding the caller is not cleared to know about
   * must be recorded WITHOUT its identity and without any excerpt of its content.
   */
  it('withholds a restricted item without leaking its identity, title or body', async () => {
    const { prisma } = makePrisma([CONFIDENTIAL_ROW]);
    const service = new ContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'in-editor',
      layers: ['firm-identity'],
      contractVersion: 2,
    });
    expect(packet.items).toEqual([]);
    expect(packet.exclusions).toEqual([
      { layer: 'firm-identity', reason: 'sensitivity-denied' },
    ]);
    const serialized = JSON.stringify(packet.exclusions);
    expect(serialized).not.toContain(CONFIDENTIAL_ROW.id);
    expect(serialized).not.toContain('firm-compass');
    expect(serialized).not.toContain('Highly confidential framing.');
  });

  it('writes packet_version 1 for a v1 steering trace and no v2 columns', async () => {
    const { prisma, packetCreates } = makePrisma([APPROVED_FIRM_ROW]);
    const service = new ContextCompilerService(prisma);
    await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'chat',
      layers: ['firm-identity'],
    });
    await new Promise((r) => setImmediate(r));
    const data = packetCreates[0]!.data;
    expect(data.packetVersion).toBe(1);
    expect(data).not.toHaveProperty('traceId');
    expect(data).not.toHaveProperty('health');
  });

  it('writes packet_version 2 plus the v2 provenance columns for a compiled v2 packet', async () => {
    const { prisma, packetCreates } = makePrisma([APPROVED_FIRM_ROW]);
    const service = new ContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'in-editor',
      layers: ['firm-identity'],
      contractVersion: 2,
      traceId: 'trace-abc',
      promptVersion: 'legacy-in-editor-v2',
      policyVersion: 'context-policy-v2.0',
      tokenBudget: 6_000,
      budgetUnit: 'tokens',
      ref: { documentId: 'doc-1' },
    });
    await new Promise((r) => setImmediate(r));
    const data = packetCreates[0]!.data;
    expect(data.packetVersion).toBe(2);
    expect(data.traceId).toBe('trace-abc');
    expect(data.promptVersion).toBe('legacy-in-editor-v2');
    expect(data.policyVersion).toBe('context-policy-v2.0');
    expect(data.compilerVersion).toBe('context-compiler-v2.0');
    expect(data.requiredLayers).toEqual(['firm-identity']);
    expect(data.health).toEqual(expect.objectContaining({ status: 'healthy' }));
    expect(data.totalTokenBudget).toBe(6_000);
    expect(data.usedTokens).toBeGreaterThan(0);
    expect(data.truncated).toBe(false);
    expect(data.incomplete).toBe(false);
    expect(data.effectiveTenantId).toBe('t1');
    expect(data.ref).toEqual({ documentId: 'doc-1' });
    // The persisted trace never carries body text.
    expect(JSON.stringify(data.items)).not.toContain('We are a GA firm.');
    expect(packet.persisted).toBe(true);
  });

  it('a v2 trace-write failure still never rejects compile()', async () => {
    const { prisma, tx } = makePrisma([APPROVED_FIRM_ROW]);
    (tx.contextPacket.create as jest.Mock).mockRejectedValue(new Error('db down'));
    const service = new ContextCompilerService(prisma);
    const packet = await service.compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'in-editor',
      layers: ['firm-identity'],
      contractVersion: 2,
    });
    expect(packet.persisted).toBe(false);
  });
});
