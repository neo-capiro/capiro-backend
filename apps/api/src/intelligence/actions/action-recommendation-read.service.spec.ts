import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ActionRecommendationReadService } from './action-recommendation-read.service.js';

/**
 * Step 3.2 — ActionRecommendationReadService list/get/patch behaviour.
 *
 * Uses an in-memory prisma double: `withTenant` runs the callback against a fake tx whose
 * `actionRecommendation` store is seeded per test, and whose `auditLog.create` records every
 * write. The PURE `validateTransition` (§19 lifecycle) runs for real — we only fake the DB.
 */

const ctx: TenantContext = {
  tenantId: '00000000-0000-0000-0000-0000000000a1',
  tenantSlug: 'capiro',
  userId: '00000000-0000-0000-0000-0000000000b2',
  clerkUserId: 'user_test',
  role: 'standard_user',
};

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-1',
    tenantId: ctx.tenantId,
    clientId: '11111111-1111-1111-1111-111111111111',
    peCode: '0604123A',
    programId: null,
    deltaId: 'delta-1',
    actionType: 'restore_cut',
    issueTitle: 'House cut to PE 0604123A',
    whatChanged: 'House mark below request',
    whyItMatters: 'Affects ClientCo',
    recommendedAction: 'Push to restore the cut',
    targetAudience: [{ kind: 'committee', id: 'cmte-hasc', label: 'HASC' }],
    suggestedArtifactType: 'committee_staff_memo',
    deadline: new Date('2026-07-01T00:00:00.000Z'),
    deadlineSource: 'markup_window',
    ownerUserId: null,
    priority: 80,
    confidence: { delta: 'high' },
    uncertainty: null,
    evidence: [{ kind: 'delta', deltaId: 'delta-1' }],
    status: 'new',
    dismissalReason: null,
    outcome: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    client: { name: 'ClientCo' },
    ...overrides,
  };
}

/**
 * In-memory prisma double. `rows` is the seeded action_recommendation store. The fake tx
 * applies the where/orderBy/skip/take of findMany in a simplified-but-faithful way for the
 * sort assertion; findFirst/update operate on the store by id.
 */
function makePrisma(rows: Array<Record<string, unknown>>) {
  const auditLogCalls: Array<Record<string, unknown>> = [];
  const store = rows.map((r) => ({ ...r }));

  const tx = {
    actionRecommendation: {
      findMany: jest.fn(
        async (args: {
          orderBy: Array<Record<string, unknown>>;
          skip?: number;
          take?: number;
        }) => {
          const sorted = [...store].sort((a, b) => compareByOrderBy(a, b, args.orderBy));
          const skip = args.skip ?? 0;
          const take = args.take ?? sorted.length;
          return sorted.slice(skip, skip + take);
        },
      ),
      count: jest.fn(async () => store.length),
      findFirst: jest.fn(async (args: { where: { id: string } }) => {
        // Prisma never hands back a live reference; return a copy so a later
        // `update` mutation does not retroactively change a captured `before` snapshot.
        const row = store.find((r) => r.id === args.where.id);
        return row ? { ...row } : null;
      }),
      update: jest.fn(
        async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = store.find((r) => r.id === args.where.id);
          if (!row) throw new Error('row not found in fake store');
          Object.assign(row, args.data);
          return { ...row };
        },
      ),
      // Tenant-scoped write used by updateStatus/updateOwner: matches on id + tenantId,
      // mutates every match in place, and returns Prisma's `{ count }` batch payload.
      updateMany: jest.fn(
        async (args: {
          where: { id: string; tenantId?: string };
          data: Record<string, unknown>;
        }) => {
          const matches = store.filter(
            (r) =>
              r.id === args.where.id &&
              (args.where.tenantId === undefined || r.tenantId === args.where.tenantId),
          );
          for (const row of matches) Object.assign(row, args.data);
          return { count: matches.length };
        },
      ),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditLogCalls.push(data);
        return data;
      }),
    },
  };

  const prisma = {
    __auditLogCalls: auditLogCalls,
    __tx: tx,
    withTenant: jest.fn(async (_tenantId: string, fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  return prisma;
}

/** Minimal multi-key orderBy comparator supporting `{ field: 'asc'|'desc' }` and
 * `{ field: { sort, nulls: 'last' } }` (NULLs always last). */
function compareByOrderBy(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  orderBy: Array<Record<string, unknown>>,
): number {
  for (const clause of orderBy) {
    const [field, spec] = Object.entries(clause)[0]!;
    const dir = typeof spec === 'string' ? spec : (spec as { sort: string }).sort;
    const nullsLast = typeof spec === 'object' && (spec as { nulls?: string }).nulls === 'last';
    const av = a[field] as unknown;
    const bv = b[field] as unknown;
    const an = av === null || av === undefined;
    const bn = bv === null || bv === undefined;
    if (an && bn) continue;
    if (an) return nullsLast ? 1 : -1;
    if (bn) return nullsLast ? -1 : 1;
    const ax = av instanceof Date ? av.getTime() : (av as number);
    const bx = bv instanceof Date ? bv.getTime() : (bv as number);
    if (ax === bx) continue;
    return dir === 'desc' ? (ax < bx ? 1 : -1) : ax < bx ? -1 : 1;
  }
  return 0;
}

describe('ActionRecommendationReadService', () => {
  describe('list', () => {
    test('returns tenant rows sorted deadline-first (nulls last), with clientName joined', async () => {
      const prisma = makePrisma([
        makeRow({ id: 'undated', deadline: null, priority: 99 }),
        makeRow({ id: 'later', deadline: new Date('2026-08-01T00:00:00.000Z'), priority: 10 }),
        makeRow({ id: 'sooner', deadline: new Date('2026-06-15T00:00:00.000Z'), priority: 20 }),
      ]);
      const service = new ActionRecommendationReadService(prisma as never);

      const result = await service.list(ctx, {});

      expect(prisma.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
      // deadline asc, nulls last: sooner, later, then undated.
      expect(result.data.map((c) => c.id)).toEqual(['sooner', 'later', 'undated']);
      // deadline serialized to ISO; client name joined.
      expect(result.data[0]?.deadline).toBe('2026-06-15T00:00:00.000Z');
      expect(result.data[0]?.clientName).toBe('ClientCo');
    });

    test('sort=priority orders by priority desc', async () => {
      const prisma = makePrisma([
        makeRow({ id: 'lo', priority: 10 }),
        makeRow({ id: 'hi', priority: 90 }),
      ]);
      const service = new ActionRecommendationReadService(prisma as never);

      const result = await service.list(ctx, { sort: 'priority' });

      expect(result.data.map((c) => c.id)).toEqual(['hi', 'lo']);
    });
  });

  describe('updateStatus', () => {
    test('rejects an illegal transition with 400 (validateTransition)', async () => {
      // new -> sent_to_client is not allowed (§19).
      const prisma = makePrisma([makeRow({ status: 'new' })]);
      const service = new ActionRecommendationReadService(prisma as never);

      await expect(service.updateStatus(ctx, 'card-1', 'sent_to_client')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.__tx.actionRecommendation.updateMany).not.toHaveBeenCalled();
      expect(prisma.__auditLogCalls).toHaveLength(0);
    });

    test('dismiss without a dismissalReason is rejected', async () => {
      const prisma = makePrisma([makeRow({ status: 'new' })]);
      const service = new ActionRecommendationReadService(prisma as never);

      await expect(service.updateStatus(ctx, 'card-1', 'dismissed')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.__tx.actionRecommendation.updateMany).not.toHaveBeenCalled();
    });

    test('a legal transition persists status and writes an AuditLog', async () => {
      const prisma = makePrisma([makeRow({ status: 'new' })]);
      const service = new ActionRecommendationReadService(prisma as never);

      const card = await service.updateStatus(ctx, 'card-1', 'triaged');

      expect(card.status).toBe('triaged');
      expect(prisma.__tx.actionRecommendation.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.__auditLogCalls).toHaveLength(1);
      expect(prisma.__auditLogCalls[0]).toMatchObject({
        action: 'intelligence.action.status',
        entityType: 'action_recommendation',
        entityId: 'card-1',
        actorUserId: ctx.userId,
        before: { status: 'new' },
        after: { status: 'triaged' },
      });
    });

    test('dismiss with a reason persists the reason', async () => {
      const prisma = makePrisma([makeRow({ status: 'new' })]);
      const service = new ActionRecommendationReadService(prisma as never);

      const card = await service.updateStatus(ctx, 'card-1', 'dismissed', 'not relevant');

      expect(card.status).toBe('dismissed');
      expect(card.dismissalReason).toBe('not relevant');
    });

    test('404 when the card is not visible to the tenant', async () => {
      const prisma = makePrisma([]);
      const service = new ActionRecommendationReadService(prisma as never);

      await expect(service.updateStatus(ctx, 'missing', 'triaged')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    test('a foreign-tenant row is never written (tenant-scoped updateMany → 404)', async () => {
      // Row exists in the store but belongs to a different tenant. The findFirst is
      // tenant-scoped (so `current` is null) — but even if it leaked, the tenant-scoped
      // updateMany would match 0 rows and throw NotFound rather than write.
      const prisma = makePrisma([makeRow({ tenantId: 'other-tenant', status: 'new' })]);
      const service = new ActionRecommendationReadService(prisma as never);

      await expect(service.updateStatus(ctx, 'card-1', 'triaged')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.__auditLogCalls).toHaveLength(0);
    });
  });

  describe('updateOwner', () => {
    test('persists the owner and writes an AuditLog', async () => {
      const prisma = makePrisma([makeRow({ ownerUserId: null })]);
      const service = new ActionRecommendationReadService(prisma as never);
      const newOwner = '99999999-9999-9999-9999-999999999999';

      const card = await service.updateOwner(ctx, 'card-1', newOwner);

      expect(card.ownerUserId).toBe(newOwner);
      expect(prisma.__auditLogCalls).toHaveLength(1);
      expect(prisma.__auditLogCalls[0]).toMatchObject({
        action: 'intelligence.action.owner',
        entityType: 'action_recommendation',
        entityId: 'card-1',
        before: { ownerUserId: null },
        after: { ownerUserId: newOwner },
      });
    });
  });

  describe('getOne', () => {
    test('returns the card mapped to the DTO shape', async () => {
      const prisma = makePrisma([makeRow()]);
      const service = new ActionRecommendationReadService(prisma as never);

      const card = await service.getOne(ctx, 'card-1');

      expect(card.id).toBe('card-1');
      expect(card.clientName).toBe('ClientCo');
      expect(card.createdAt).toBe('2026-06-01T00:00:00.000Z');
      expect(card.targetAudience).toEqual([
        { kind: 'committee', id: 'cmte-hasc', label: 'HASC' },
      ]);
    });

    test('404 when not found', async () => {
      const prisma = makePrisma([]);
      const service = new ActionRecommendationReadService(prisma as never);

      await expect(service.getOne(ctx, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
