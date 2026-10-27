import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { DefenseBudgetClientWatchService } from './defense-budget-client-watch.service.js';

const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000002',
  clerkUserId: 'synthetic-watch-actor',
  role: 'standard_user',
} as TenantContext;
const clientId = '10000000-0000-4000-8000-000000000003';
const watchId = 'watch-a';

function fixture(foundClient = true, foundWatch = true) {
  const events: Array<Record<string, unknown>> = [];
  const authority = { archived: false, wallAllowed: true, memberActive: true, revokeWhileLocking: false };
  const tx = {
    tenantMembership: { findFirst: jest.fn(async () => authority.memberActive ? { role: ctx.role } : null) },
    $queryRaw: jest.fn(async (query: { sql?: string } | TemplateStringsArray) => {
      const sql = Array.isArray(query) ? query.join('?') : (query as { sql: string }).sql;
      if (sql.includes('FROM clients')) {
        if (authority.revokeWhileLocking) authority.memberActive = false;
        return foundClient && !authority.archived ? [{ version: 0, primary: null }] : [];
      }
      if (sql.includes('FROM tenant_memberships')) return authority.memberActive ? [{ role: ctx.role }] : [];
      if (sql.includes('FROM client_memory_access')) return [];
      throw new Error('Unexpected authority query');
    }),
    $queryRawUnsafe: jest.fn(async () => [{ allowed: authority.wallAllowed }]),
    defenseBudgetClientWatch: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: watchId, ...data })),
      findFirst: jest.fn(async () => foundWatch ? { id: watchId } : null),
      findMany: jest.fn(async () => []),
    },
    defenseBudgetClientWatchEvent: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `event-${events.length + 1}`, ...data };
        events.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id) return events.find((e) => e.id === where.id && e.eventType === where.eventType) ?? null;
        return events.find((e) => Object.entries(where).every(([key, value]) => {
          if (typeof value === 'object' && value && 'in' in value) return (value.in as unknown[]).includes(e[key]);
          return e[key] === value;
        })) ?? null;
      }),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (
      _tenantId: string,
      fn: (tenantTx: typeof tx) => Promise<unknown>,
    ) => fn(tx)),
  };
  return { tx, prisma, events, authority, service: new DefenseBudgetClientWatchService(prisma as never) };
}

describe('DefenseBudgetClientWatchService', () => {
  test('requires a client-specific reason and known client before subscribing', async () => {
    const { service, tx, prisma } = fixture();
    await expect(service.subscribe(ctx, { clientId, targetType: 'pe', targetKey: '0603270A', clientReason: ' ' }))
      .rejects.toThrow('Client reason');
    expect(prisma.withTenant).not.toHaveBeenCalled();
    await service.subscribe(ctx, { clientId, targetType: 'pe', targetKey: '0603270A', clientReason: 'Relevant to client X' });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('client_memory_access'), ctx.tenantId, clientId, ctx.userId);
    expect(tx.defenseBudgetClientWatchEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'subscribed' }) });
  });

  test('fails closed on a foreign client or watch', async () => {
    const absentClient = fixture(false);
    await expect(absentClient.service.list(ctx, clientId)).rejects.toThrow('Client not found');
    const absentWatch = fixture(true, false);
    await expect(absentWatch.service.recordMaterialUpdate(ctx, {
      clientId, watchId, logicalEventKey: 'change-1', materialReason: 'Funding changed',
    })).rejects.toThrow('Watch not found');
  });

  test('keeps the material event and decision as separate records', async () => {
    const { service, events } = fixture();
    const update = await service.recordMaterialUpdate(ctx, {
      clientId, watchId, logicalEventKey: 'change-1', materialReason: 'FY amount changed',
    });
    const replay = await service.recordMaterialUpdate(ctx, {
      clientId, watchId, logicalEventKey: 'change-1', materialReason: 'FY amount changed',
    });
    expect(replay.id).toBe(update.id);
    await service.decide(ctx, { clientId, watchId, updateEventId: update.id, decision: 'acknowledged' });
    expect(events.map((e) => e.eventType)).toEqual(['material_update', 'acknowledged']);
    await expect(service.decide(ctx, { clientId, watchId, updateEventId: update.id, decision: 'dismissed' }))
      .rejects.toThrow('already decided');
  });
});

const clientOperations: Array<[string, (service: DefenseBudgetClientWatchService) => Promise<unknown>]> = [
  ['list', (service: DefenseBudgetClientWatchService) => service.list(ctx, clientId)],
  ['subscribe', (service: DefenseBudgetClientWatchService) => service.subscribe(ctx, {
    clientId, targetType: 'pe', targetKey: 'synthetic-pe', clientReason: 'Synthetic client reason',
  })],
  ['subscription', (service: DefenseBudgetClientWatchService) => service.setSubscribed(ctx, {
    clientId, watchId, subscribed: false,
  })],
  ['material update', (service: DefenseBudgetClientWatchService) => service.recordMaterialUpdate(ctx, {
    clientId, watchId, logicalEventKey: 'synthetic-update', materialReason: 'Synthetic source change',
  })],
  ['decision', (service: DefenseBudgetClientWatchService) => service.decide(ctx, {
    clientId, watchId, updateEventId: 'synthetic-update', decision: 'acknowledged',
  })],
];

describe('current client authority for defense watches', () => {
  test.each(clientOperations)('%s refuses an archived client before observing or changing its watch', async (_name, operation) => {
    const { service, authority, tx } = fixture();
    authority.archived = true;
    await expect(operation(service)).rejects.toThrow('Client not found');
    expect(tx.defenseBudgetClientWatch.findMany).not.toHaveBeenCalled();
    expect(tx.defenseBudgetClientWatch.findFirst).not.toHaveBeenCalled();
    expect(tx.defenseBudgetClientWatch.create).not.toHaveBeenCalled();
    expect(tx.defenseBudgetClientWatchEvent.create).not.toHaveBeenCalled();
  });

  test.each(clientOperations)('%s refuses a revoked wall grant before observing or changing its watch', async (_name, operation) => {
    const { service, authority, tx } = fixture();
    authority.wallAllowed = false;
    await expect(operation(service)).rejects.toThrow('Client not found');
    expect(tx.defenseBudgetClientWatch.findMany).not.toHaveBeenCalled();
    expect(tx.defenseBudgetClientWatch.findFirst).not.toHaveBeenCalled();
    expect(tx.defenseBudgetClientWatch.create).not.toHaveBeenCalled();
    expect(tx.defenseBudgetClientWatchEvent.create).not.toHaveBeenCalled();
  });

  test('rechecks membership after the client lock wait before releasing watch rows', async () => {
    const { service, authority, tx } = fixture();
    authority.revokeWhileLocking = true;
    await expect(service.list(ctx, clientId)).rejects.toThrow('Account owner access denied');
    expect(tx.defenseBudgetClientWatch.findMany).not.toHaveBeenCalled();
  });

  test('permits the current standard user through the canonical client boundary', async () => {
    const { service, tx } = fixture();
    await expect(service.list(ctx, clientId)).resolves.toEqual([]);
    expect(tx.tenantMembership.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: ctx.tenantId, userId: ctx.userId, status: 'active',
        user: { clerkUserId: ctx.clerkUserId }, tenant: { status: 'active' },
      },
      select: { role: true },
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('client_memory_access'), ctx.tenantId, clientId, ctx.userId);
    expect(tx.defenseBudgetClientWatch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: ctx.tenantId, clientId } }));
  });
});
