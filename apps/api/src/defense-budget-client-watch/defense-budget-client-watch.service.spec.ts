import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { DefenseBudgetClientWatchService } from './defense-budget-client-watch.service.js';

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;
const clientId = 'client-a';
const watchId = 'watch-a';

function fixture(foundClient = true, foundWatch = true) {
  const events: Array<Record<string, unknown>> = [];
  const tx = {
    client: { findFirst: jest.fn(async () => foundClient ? { id: clientId } : null) },
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
  return { tx, prisma, events, service: new DefenseBudgetClientWatchService(prisma as never) };
}

describe('DefenseBudgetClientWatchService', () => {
  test('requires a client-specific reason and known client before subscribing', async () => {
    const { service, tx, prisma } = fixture();
    await expect(service.subscribe(ctx, { clientId, targetType: 'pe', targetKey: '0603270A', clientReason: ' ' }))
      .rejects.toThrow('Client reason');
    expect(prisma.withTenant).not.toHaveBeenCalled();
    await service.subscribe(ctx, { clientId, targetType: 'pe', targetKey: '0603270A', clientReason: 'Relevant to client X' });
    expect(tx.client.findFirst).toHaveBeenCalledWith({ where: { id: clientId, tenantId: ctx.tenantId }, select: { id: true } });
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
