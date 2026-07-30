import { describe, expect, jest, test } from '@jest/globals';
import {
  ProgramElementChangeOutboxService,
  runPeOutboxSystemTx,
} from './program-element-change-outbox.service.js';

function makeHarness(
  options: {
    dataCorrection?: boolean;
    failDelivery?: boolean;
    /** bare PrismaClient shape: $transaction only, no withSystem */
    bareClient?: boolean;
  } = {},
) {
  const row = {
    id: '00000000-0000-0000-0000-000000000001',
    dedupeKey: 'pe-year:0603270A:2027:request:10:20:key',
    peCode: '0603270A',
    eventType: 'pe_value_increased',
    status: 'pending',
    attempts: 0,
    lastError: null as string | null,
    processedAt: null as Date | null,
    payload: {
      peCode: '0603270A',
      fy: 2027,
      field: 'request',
      oldValue: 10,
      newValue: 20,
      dataCorrection: options.dataCorrection ?? false,
      suppressAlerts: options.dataCorrection ?? false,
      emission: {
        changeType: 'pe_value_increased',
        severity: 'critical',
        title: 'changed',
        description: 'changed',
        data: { fy: 2027 },
      },
    },
  };
  const changes = new Map<string, Record<string, unknown>>();
  const tx = {
    $executeRaw: jest.fn(async () => 0),
    $queryRaw: jest.fn(async () =>
      row.status === 'pending' || row.status === 'failed'
        ? [
            {
              id: row.id,
              dedupe_key: row.dedupeKey,
              pe_code: row.peCode,
              event_type: row.eventType,
              payload_jsonb: row.payload,
              status: row.status,
            },
          ]
        : [],
    ),
    programElementChangeOutbox: {
      update: jest.fn(async ({ data }: any) => {
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
          if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
            (row as any)[key] += Number((value as { increment: number }).increment);
          } else {
            (row as any)[key] = value;
          }
        }
        return row;
      }),
    },
    programElementWatch: {
      findMany: jest.fn(async () => [{ tenantId: 'tenant-a' }, { tenantId: 'tenant-b' }]),
    },
    clientCapability: {
      findMany: jest.fn(async () => [
        { tenantId: 'tenant-a', clientId: 'client-1' },
        { tenantId: 'tenant-a', clientId: 'client-2' },
      ]),
    },
    intelligenceChange: {
      upsert: jest.fn(async ({ where, create }: any) => {
        if (options.failDelivery) throw new Error('delivery failed');
        if (!changes.has(where.dedupeKey)) changes.set(where.dedupeKey, create);
        return changes.get(where.dedupeKey);
      }),
    },
  };
  const $transaction = jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx));
  const prisma: Record<string, unknown> = {
    $transaction,
    programElementChangeOutbox: {
      updateMany: jest.fn(async ({ data }: any) => {
        row.status = data.status;
        row.lastError = data.lastError;
        row.attempts += Number(data.attempts?.increment ?? 0);
        return { count: 1 };
      }),
      findMany: jest.fn(async () => [{ id: row.id }]),
    },
  };
  if (!options.bareClient) {
    prisma.withSystem = jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx));
  }
  return {
    service: new ProgramElementChangeOutboxService(prisma as never),
    prisma,
    tx,
    row,
    changes,
    $transaction,
  };
}

describe('runPeOutboxSystemTx', () => {
  test('prefers withSystem when present', async () => {
    const calls: string[] = [];
    const result = await runPeOutboxSystemTx(
      {
        withSystem: async (fn) => {
          calls.push('withSystem');
          return fn({} as never);
        },
        $transaction: async (fn) => {
          calls.push('$transaction');
          return fn({} as never);
        },
        programElementChangeOutbox: {} as never,
      },
      async () => 'ok',
    );
    expect(result).toBe('ok');
    expect(calls).toEqual(['withSystem']);
  });

  test('falls back to $transaction + bypass_rls when withSystem is absent', async () => {
    const executeRaw = jest.fn(async () => 0);
    const result = await runPeOutboxSystemTx(
      {
        $transaction: async (fn) => fn({ $executeRaw: executeRaw } as never),
        programElementChangeOutbox: {} as never,
      },
      async () => 42,
    );
    expect(result).toBe(42);
    expect(executeRaw).toHaveBeenCalled();
  });

  test('throws when neither withSystem nor $transaction exists', async () => {
    await expect(
      runPeOutboxSystemTx({ programElementChangeOutbox: {} as never }, async () => null),
    ).rejects.toThrow(/withSystem or PrismaClient\.\$transaction/);
  });
});

describe('ProgramElementChangeOutboxService', () => {
  test('delivers once per affected tenant and marks processed atomically', async () => {
    const h = makeHarness();
    expect(await h.service.processById(h.row.id)).toBe('processed');
    expect(h.row.status).toBe('processed');
    expect(h.changes.size).toBe(2);
    const tenantA = [...h.changes.values()].find((change) =>
      String((change.data as Record<string, unknown>).tenantId).includes('tenant-a'),
    );
    expect(tenantA?.relatedClientIds).toEqual(['client-1', 'client-2']);
    expect(await h.service.processById(h.row.id)).toBe('already_processed');
    expect(h.changes.size).toBe(2);
  });

  test('bare PrismaClient without withSystem still drains processById to processed', async () => {
    // Regression B1/B2: script writers do new OutboxService(PrismaClient);
    // withSystem is undefined. Unfixed tip throws and marks failed forever.
    const h = makeHarness({ bareClient: true });
    expect(typeof (h.prisma as { withSystem?: unknown }).withSystem).toBe('undefined');
    expect(typeof h.$transaction).toBe('function');
    expect(await h.service.processById(h.row.id)).toBe('processed');
    expect(h.row.status).toBe('processed');
    expect(h.changes.size).toBe(2);
    expect(h.$transaction).toHaveBeenCalled();
    expect(h.tx.$executeRaw).toHaveBeenCalled();
    // second claim sees terminal status → already_processed (idempotent retry)
    expect(await h.service.processById(h.row.id)).toBe('already_processed');
  });

  test('data-correction outbox items are processed without user-facing events', async () => {
    const h = makeHarness({ dataCorrection: true });
    expect(await h.service.processById(h.row.id)).toBe('processed');
    expect(h.changes.size).toBe(0);
    expect(h.tx.programElementWatch.findMany).not.toHaveBeenCalled();
  });

  test('fan-out failure leaves a retryable failed outbox item', async () => {
    const h = makeHarness({ failDelivery: true });
    expect(await h.service.processById(h.row.id)).toBe('failed');
    expect(h.row.status).toBe('failed');
    expect(h.row.lastError).toContain('delivery failed');
    expect((h.prisma.programElementChangeOutbox as any).updateMany).toHaveBeenCalled();
  });

  test('drain is bounded and counts failed deliveries', async () => {
    const h = makeHarness({ failDelivery: true });
    expect(await h.service.drain(9999)).toEqual({ processed: 0, failed: 1 });
    expect((h.prisma.programElementChangeOutbox as any).findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );
  });

  test('drain on bare client without withSystem completes process count', async () => {
    const h = makeHarness({ bareClient: true });
    expect(await h.service.drain(10)).toEqual({ processed: 1, failed: 0 });
    expect(h.row.status).toBe('processed');
  });
});
