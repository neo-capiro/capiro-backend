import { SESv2Client, SESv2ServiceException } from '@aws-sdk/client-sesv2';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { peEmailWindow, runPeEmailWindow, sendPeEmailBatch } from './pe-alert-email-delivery.js';

const mockSend = jest.fn();
const mockDestroy = jest.fn();
jest.mock('@aws-sdk/client-sesv2', () => ({
  ...jest.requireActual('@aws-sdk/client-sesv2'),
  SESv2Client: jest.fn().mockImplementation(() => ({ send: mockSend, destroy: mockDestroy })),
}));
const emails = ['one', 'two', 'three'].map((name) => ({
  to: `${name}@example.test`,
  subject: 'Synthetic',
  html: '<p>Alert</p>',
  text: 'Alert',
}));
const counts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
type Row = Record<string, any>;

function store() {
  const rows: Row[] = [];
  let lock = Promise.resolve();
  let failFinalReceipt = false;
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(
      async (
        _sql: unknown,
        source: string,
        excludedId: string | null,
        _again: unknown,
        policy: string,
      ) => [
        {
          present: rows.some(
            (row) =>
              row.source === source &&
              row.id !== excludedId &&
              row.stats?.deliveryPolicy !== policy,
          ),
        },
      ],
    ),
    syncRun: {
      findFirst: jest.fn(
        async ({ where }: Row) =>
          rows
            .filter(
              (row) =>
                row.source === where.source &&
                (!where.status || row.status === where.status) &&
                (!where.id || row.id !== where.id.not) &&
                (!where.startedAt || row.startedAt >= where.startedAt.gte) &&
                (!where.stats || row.stats?.[where.stats.path[0]] === where.stats.equals) &&
                (!where.AND ||
                  where.AND.every(({ stats }: Row) => row.stats?.[stats.path[0]] === stats.equals)),
            )
            .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null,
      ),
      create: jest.fn(async ({ data }: Row) => {
        const row = { ...data, id: `run-${rows.length}` };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: Row) => {
        if (failFinalReceipt && data.status === 'success') {
          failFinalReceipt = false;
          throw new Error('final receipt unavailable');
        }
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, structuredClone(data));
        return row;
      }),
    },
  };
  const prisma = {
    syncRun: tx.syncRun,
    withSystem: async (fn: (value: typeof tx) => Promise<unknown>) => {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(tx);
      } finally {
        release();
      }
    },
  } as unknown as PrismaService;
  return {
    rows,
    prisma,
    tx,
    failFinalReceipt: () => {
      failFinalReceipt = true;
    },
  };
}

describe('PE best-effort NON-RETRY windows', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-02T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('consumes the exact bounded window before work and records recipient errors truthfully', async () => {
    const f = store();
    const first = await runPeEmailWindow(f.prisma, 25, async (window) => {
      expect(window.since.toISOString()).toBe('2025-12-31T23:00:00.000Z');
      expect(window.until.toISOString()).toBe('2026-01-02T00:00:00.000Z');
      expect(f.rows[0]!.stats).toMatchObject({
        deliveryPolicy: 'best_effort_non_retry',
        outcome: 'outcome_unknown',
      });
      return {
        ...counts,
        inserted: 1,
        errors: 2,
        stats: { accepted: 1, failed: 1, outcome_unknown: 1 },
      };
    });
    expect(first.errors).toBe(2);
    expect(f.rows[0]!.status).toBe('success_with_errors');
    jest.setSystemTime(new Date('2026-01-03T00:00:00Z'));
    await runPeEmailWindow(f.prisma, 25, async (window) => {
      expect(window.since.toISOString()).toBe('2026-01-02T00:00:00.000Z');
      return counts;
    });
    expect(f.rows[0]!.stats).toMatchObject({ accepted: 1, failed: 1, outcome_unknown: 1 });
  });

  it('does not replay a consumed window after a crash/error or a final receipt-write failure', async () => {
    for (const failure of ['crash', 'receipt']) {
      jest.setSystemTime(new Date('2026-01-02T00:00:00Z'));
      const f = store();
      if (failure === 'receipt') f.failFinalReceipt();
      await expect(
        runPeEmailWindow(f.prisma, 25, async () => {
          if (failure === 'crash') throw new Error('process stopped after provider dispatch');
          return counts;
        }),
      ).rejects.toThrow();
      expect(f.rows[0]!).toMatchObject({
        status: 'error',
        stats: { deliveryPolicy: 'best_effort_non_retry', outcome: 'outcome_unknown' },
      });
      jest.setSystemTime(new Date('2026-01-03T00:00:00Z'));
      await runPeEmailWindow(f.prisma, 25, async (window) => {
        expect(window.since.toISOString()).toBe('2026-01-02T00:00:00.000Z');
        return counts;
      });
    }
  });

  it('excludes a hard-crashed running window after the shared stale-run guard expires', async () => {
    const f = store();
    f.rows.push({
      id: 'crashed',
      source: 'send-pe-alert-emails',
      status: 'running',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      stats: { deliveryPolicy: 'best_effort_non_retry', windowConsumed: true },
    });
    await runPeEmailWindow(f.prisma, 25, async (window) => {
      expect(window.since.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      return counts;
    });
  });

  it('serializes racing window claims so their eligible intervals cannot overlap', async () => {
    const f = store();
    const ranges: [number, number][] = [];
    const run = (window: { since: Date; until: Date }) => {
      ranges.push([window.since.getTime(), window.until.getTime()]);
      return Promise.resolve(counts);
    };
    await Promise.all([runPeEmailWindow(f.prisma, 25, run), runPeEmailWindow(f.prisma, 25, run)]);
    expect(ranges.filter(([since, until]) => since < until)).toHaveLength(1);
    expect(f.tx.$executeRaw).toHaveBeenCalled();
  });

  it('fences the unprovable legacy tail on upgrade and makes dry-run window reads inert', async () => {
    const f = store();
    f.rows.push({
      id: 'legacy',
      source: 'send-pe-alert-emails',
      status: 'error',
      startedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const preview = await peEmailWindow(f.tx as any, new Date(), 25);
    expect(preview.since).toEqual(preview.until);
    expect(f.tx.syncRun.update).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
    await runPeEmailWindow(f.prisma, 25, async (window) => {
      expect(window.since).toEqual(window.until);
      return counts;
    });
  });
});

describe('PE recipient outcomes', () => {
  beforeEach(() => jest.clearAllMocks());
  it('records accepted, definite rejection and unknown with one attempt each and cleans up', async () => {
    mockSend
      .mockResolvedValueOnce({ MessageId: 'receipt' })
      .mockRejectedValueOnce(
        new SESv2ServiceException({
          name: 'MessageRejected',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        }),
      )
      .mockRejectedValueOnce(new Error('timeout'));
    const observed: string[][] = [];
    const result = await sendPeEmailBatch(
      emails,
      'alerts@example.test',
      'us-east-1',
      async (outcomes) => {
        observed.push(outcomes.map((outcome) => outcome.status));
      },
    );
    expect(observed[0]).toEqual(['outcome_unknown', 'outcome_unknown', 'outcome_unknown']);
    expect(result.map((r) => r.status)).toEqual(['accepted', 'failed', 'outcome_unknown']);
    expect(SESv2Client).toHaveBeenCalledWith({ region: 'us-east-1', maxAttempts: 1 });
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('refuses all sends when uncertainty cannot be recorded', async () => {
    await expect(
      sendPeEmailBatch(emails, 'alerts@example.test', 'us-east-1', async () => {
        throw new Error('unavailable');
      }),
    ).rejects.toThrow('unavailable');
    expect(mockSend).not.toHaveBeenCalled();
    expect(SESv2Client).not.toHaveBeenCalled();
  });

  it('stops after an accepted send whose receipt cannot be recorded, without retrying it', async () => {
    mockSend.mockResolvedValue({ MessageId: 'receipt' });
    let saved: string[] = [];
    await expect(
      sendPeEmailBatch(emails, 'alerts@example.test', 'us-east-1', async (outcomes) => {
        if (outcomes[0]!.status === 'accepted') throw new Error('receipt unavailable');
        saved = outcomes.map((r) => r.status);
      }),
    ).rejects.toThrow('receipt unavailable');
    expect(saved).toEqual(['outcome_unknown', 'outcome_unknown', 'outcome_unknown']);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});
