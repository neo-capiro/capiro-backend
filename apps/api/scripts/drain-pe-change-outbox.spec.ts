import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';
import { ProgramElementChangeOutboxService } from '../src/program-element/program-element-change-outbox.service.js';
import { peChangeOutboxPrismaFromClient } from './drain-pe-change-outbox.js';

const source = readFileSync(resolve(process.cwd(), 'scripts/drain-pe-change-outbox.ts'), 'utf8');

describe('drain-pe-change-outbox command safety', () => {
  test('reports only in the default posture and requires --commit to drain', () => {
    expect(source).toContain("const commit = flag('commit')");
    expect(source).toMatch(/if \(!commit\) return;/);
    expect(source.indexOf('if (!commit) return;')).toBeLessThan(source.indexOf('service.drain(limit)'));
  });

  test('committed runs are bounded and SyncRun-audited', () => {
    expect(source).toContain("runWithSyncRun(client, 'drain-pe-change-outbox'");
    expect(source).toContain('Math.min(500');
    expect(source).not.toMatch(/sendEmail|SES|LlamaParse|SecretString/);
  });

  test('script wires withSystem shim (identity-outbox pattern), not a bare cast', () => {
    expect(source).toContain('peChangeOutboxPrismaFromClient');
    expect(source).toContain("set_config('app.bypass_rls'");
    expect(source).toContain('withSystem:');
    // Hard fail if the broken cast-only path returns.
    expect(source).not.toMatch(/const prisma = client as unknown as PrismaService/);
  });
});

describe('drain-pe-change-outbox bare-client runtime', () => {
  test('peChangeOutboxPrismaFromClient + OutboxService drain without Nest withSystem', async () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000099',
      status: 'pending' as string,
      attempts: 0,
      lastError: null as string | null,
      dedupeKey: 'pe-year:0603270A:2027:request:bare',
      peCode: '0603270A',
      eventType: 'pe_value_increased',
      payload: {
        peCode: '0603270A',
        fy: 2027,
        field: 'request',
        oldValue: 1,
        newValue: 2,
        dataCorrection: false,
        suppressAlerts: false,
        emission: {
          changeType: 'pe_value_increased',
          severity: 'info',
          title: 't',
          description: 'd',
          data: {},
        },
      },
    };

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
            if (value && typeof value === 'object' && 'increment' in (value as object)) {
              (row as any)[key] += Number((value as { increment: number }).increment);
            } else {
              (row as any)[key] = value;
            }
          }
          return row;
        }),
      },
      programElementWatch: { findMany: jest.fn(async () => []) },
      clientCapability: { findMany: jest.fn(async () => []) },
      intelligenceChange: { upsert: jest.fn(async () => ({})) },
    };

    // Bare PrismaClient shape — NO withSystem on the root client (B1 regressor).
    const bareClient = {
      $transaction: jest.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)),
      programElementChangeOutbox: {
        findMany: jest.fn(async () => [{ id: row.id }]),
        updateMany: jest.fn(async () => ({ count: 0 })),
        count: jest.fn(async () => 1),
      },
    };

    expect((bareClient as { withSystem?: unknown }).withSystem).toBeUndefined();

    const prisma = peChangeOutboxPrismaFromClient(bareClient as never);
    expect(typeof prisma.withSystem).toBe('function');

    const service = new ProgramElementChangeOutboxService(prisma);
    const drained = await service.drain(5);
    expect(drained).toEqual({ processed: 1, failed: 0 });
    expect(row.status).toBe('processed');
    expect(bareClient.$transaction).toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalled();
  });

  test('OutboxService alone completes on bare $transaction client (writer autowire path)', async () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000098',
      status: 'pending' as string,
      attempts: 0,
      lastError: null as string | null,
      dedupeKey: 'k',
      peCode: '0603270A',
      eventType: 'pe_value_increased',
      payload: {
        peCode: '0603270A',
        fy: 2027,
        field: 'request',
        oldValue: null,
        newValue: 3,
        emission: {
          changeType: 'pe_value_increased',
          severity: 'info',
          title: 't',
          description: 'd',
          data: {},
        },
      },
    };
    const tx = {
      $executeRaw: jest.fn(async () => 0),
      $queryRaw: jest.fn(async () => [
        {
          id: row.id,
          dedupe_key: row.dedupeKey,
          pe_code: row.peCode,
          event_type: row.eventType,
          payload_jsonb: row.payload,
          status: row.status,
        },
      ]),
      programElementChangeOutbox: {
        update: jest.fn(async ({ data }: any) => {
          Object.assign(row, data);
          if (data.attempts?.increment) row.attempts += data.attempts.increment;
          return row;
        }),
      },
      programElementWatch: { findMany: jest.fn(async () => []) },
      clientCapability: { findMany: jest.fn(async () => []) },
      intelligenceChange: { upsert: jest.fn(async () => ({})) },
    };
    const bare = {
      // intentionally no withSystem — matches new ProgramElementChangeOutboxService(prismaClient)
      $transaction: jest.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)),
      programElementChangeOutbox: {
        findMany: jest.fn(async () => [{ id: row.id }]),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    };
    const service = new ProgramElementChangeOutboxService(bare as never);
    expect(await service.processById(row.id)).toBe('processed');
    expect(row.status).toBe('processed');
  });
});
