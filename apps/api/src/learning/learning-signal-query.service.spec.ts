import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { LearningSignalQueryService } from './learning-signal-query.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const WALLED_CLIENT = '33333333-3333-4333-8333-333333333333';
const OPEN_CLIENT = '44444444-4444-4444-8444-444444444444';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: USER,
  clerkUserId: 'user_x',
  role: 'standard_user',
};

interface FakeSignalRow {
  id: string;
  clientId: string | null;
  sourceSurface: string;
  signalType: string;
  status: string;
  createdAt: Date;
}

const SIGNAL_ROW: FakeSignalRow = {
  id: 'signal-1',
  clientId: WALLED_CLIENT,
  sourceSurface: 'crm.fill_with_meri',
  signalType: 'crm_finding_accepted',
  status: 'captured',
  createdAt: new Date('2026-08-21T00:00:00.000Z'),
};

/**
 * Fakes clientMemoryAllowed/fetchDeniedClientIds's raw-SQL backing query via
 * `$queryRawUnsafe`, exactly as memory-wall.helpers.ts implements them —
 * `allowed` drives clientMemoryAllowed, `deniedIds` drives fetchDeniedClientIds.
 */
function harness(opts: { allowed: boolean; deniedIds?: string[]; row?: FakeSignalRow | null; rows?: FakeSignalRow[] }) {
  const learningSignal = {
    findFirst: jest.fn(async () => opts.row ?? SIGNAL_ROW),
    findMany: jest.fn(async () => opts.rows ?? [SIGNAL_ROW]),
  };
  const tx = {
    learningSignal,
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      // Both real queries mention `c.memory_wall`; the reliable discriminator
      // is the SELECT list — clientMemoryAllowed's is `... AS allowed`,
      // fetchDeniedClientIds' is a bare `SELECT c.id`.
      if (sql.includes('AS allowed')) {
        return [{ allowed: opts.allowed }];
      }
      return (opts.deniedIds ?? []).map((id) => ({ id }));
    }),
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { prisma, tx, learningSignal };
}

describe('LearningSignalQueryService — ethical-wall fail-closed enforcement', () => {
  it('findById returns a signal for an unwalled/allowed client', async () => {
    const { prisma } = harness({ allowed: true });
    const service = new LearningSignalQueryService(prisma);
    const result = await service.findById(ctx, 'signal-1');
    expect(result?.id).toBe('signal-1');
  });

  it('findById denies a walled client\'s signal for a user with no grant — the row exists but is not returned', async () => {
    const { prisma, tx } = harness({ allowed: false });
    const service = new LearningSignalQueryService(prisma);
    const result = await service.findById(ctx, 'signal-1');
    expect(result).toBeNull();
    // The row really was found in the DB — this proves it was the WALL, not
    // a missing row, that produced the null.
    expect((tx.learningSignal.findFirst as jest.Mock).mock.results[0]).toBeDefined();
  });

  it('findById returns a client-less signal (clientId null) without consulting the wall at all', async () => {
    const clientless = { ...SIGNAL_ROW, clientId: null };
    const { prisma, tx } = harness({ allowed: false, row: clientless });
    const service = new LearningSignalQueryService(prisma);
    const result = await service.findById(ctx, 'signal-1');
    expect(result?.id).toBe('signal-1');
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('listRecentForClient returns [] for a walled client the actor cannot access — never leaks a row', async () => {
    const { prisma, learningSignal } = harness({ allowed: false });
    const service = new LearningSignalQueryService(prisma);
    const result = await service.listRecentForClient(ctx, WALLED_CLIENT);
    expect(result).toEqual([]);
    // The query must not even run once the wall denies — defense in depth,
    // not just post-filtering.
    expect(learningSignal.findMany).not.toHaveBeenCalled();
  });

  it('listRecentForClient returns rows for an open client', async () => {
    const { prisma } = harness({ allowed: true });
    const service = new LearningSignalQueryService(prisma);
    const result = await service.listRecentForClient(ctx, OPEN_CLIENT);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('signal-1');
  });

  it('listRecentForTenant excludes every denied client id from the query', async () => {
    const { prisma, learningSignal } = harness({ allowed: true, deniedIds: [WALLED_CLIENT] });
    const service = new LearningSignalQueryService(prisma);
    await service.listRecentForTenant(ctx);
    const call = (learningSignal.findMany as jest.Mock).mock.calls[0] as [{ where: Record<string, unknown> }];
    const where = call[0].where as { NOT?: { clientId: { in: string[] } } };
    expect(where.NOT?.clientId.in).toEqual([WALLED_CLIENT]);
  });

  it('listRecentForTenant omits the NOT filter entirely when nothing is denied (common, unwalled case)', async () => {
    const { prisma, learningSignal } = harness({ allowed: true, deniedIds: [] });
    const service = new LearningSignalQueryService(prisma);
    await service.listRecentForTenant(ctx);
    const call = (learningSignal.findMany as jest.Mock).mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(call[0].where.NOT).toBeUndefined();
  });

  it('a fail-closed wall check runs with THIS actor\'s userId, not a caller-substituted one', async () => {
    const { prisma, tx } = harness({ allowed: true });
    const service = new LearningSignalQueryService(prisma);
    await service.findById(ctx, 'signal-1');
    const call = (tx.$queryRawUnsafe as jest.Mock).mock.calls[0] as [string, string, string, string];
    // clientMemoryAllowed's query binds $queryRawUnsafe(sql, tenantId, clientId, userId) —
    // userId is arg index 3, not 2 (index 2 is clientId).
    expect(call[3]).toBe(USER);
    expect(call[3]).not.toBe(OTHER_USER);
  });
});
