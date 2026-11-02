import { RecordedActivityBudget } from './client-recorded-activity-budget.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function harness() {
  const calls: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (..._args: unknown[]) => {
      calls.push('timeout');
      return 1;
    }),
    meeting: {
      count: jest.fn(async () => {
        calls.push('count');
        return 0;
      }),
    },
  };
  const withTenant = jest.fn(async (_tenant, read, _options) => {
    try {
      return await read(tx);
    } finally {
      calls.push('closed');
    }
  });
  return { tx, calls, withTenant, prisma: { withTenant } as unknown as PrismaService };
}
it('passes the remaining whole-request budget into each actual transaction', async () => {
  let now = 0;
  const h = harness();
  const budget = new RecordedActivityBudget(undefined, () => now);
  now = 100;
  await budget.transaction(h.prisma, 'tenant', async (tx) => {
    now = 6_000;
    return tx.meeting.count();
  });
  await budget.transaction(h.prisma, 'tenant', (tx) => tx.meeting.count());
  expect(h.withTenant.mock.calls.map((call) => call[2])).toEqual([
    { timeoutMs: 9_900, isolationLevel: 'RepeatableRead' },
    { timeoutMs: 4_000, isolationLevel: 'RepeatableRead' },
  ]);
});
it('sets a real bounded LOCAL SQL/lock timeout before every guarded query, including concurrent guards', async () => {
  const h = harness();
  const budget = new RecordedActivityBudget();
  await budget.transaction(h.prisma, 'tenant', (tx) =>
    Promise.all([tx.meeting.count(), tx.meeting.count()]),
  );
  expect(h.calls).toEqual(['timeout', 'count', 'timeout', 'count', 'closed']);
  const [sql, statement, lock] = h.tx.$executeRaw.mock.calls[0]!;
  expect((sql as unknown as string[]).join('')).toContain("set_config('statement_timeout'");
  expect((sql as unknown as string[]).join('')).toContain("set_config('lock_timeout'");
  expect(statement).toBe('1000ms');
  expect(lock).toBe('1000ms');
});
it('shrinks SQL timeout below one second near deadline', async () => {
  let now = 0;
  const h = harness();
  const budget = new RecordedActivityBudget(undefined, () => now);
  now = 9_750;
  await budget.transaction(h.prisma, 'tenant', (tx) => tx.meeting.count());
  expect(h.tx.$executeRaw.mock.calls[0]?.slice(1)).toEqual(['250ms', '250ms']);
});
it('awaits SQL cancellation and transaction cleanup before rejecting, without abandoned work', async () => {
  const h = harness();
  const budget = new RecordedActivityBudget();
  let finish!: () => void;
  let entered!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.tx.meeting.count.mockImplementationOnce(async () => {
    entered();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    throw Object.assign(new Error('SQL canceled by statement_timeout'), { code: '57014' });
  });
  const result = budget.transaction(h.prisma, 'tenant', (tx) => tx.meeting.count());
  let settled = false;
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await active;
  expect(settled).toBe(false);
  expect(h.calls).not.toContain('closed');
  finish();
  await expect(result).rejects.toMatchObject({ code: '57014' });
  expect(h.calls.at(-1)).toBe('closed');
});
it('does not run queued queries after cancellation; drains the active query before closing', async () => {
  const h = harness();
  const abort = new AbortController();
  const budget = new RecordedActivityBudget(abort.signal);
  h.tx.meeting.count.mockImplementationOnce(async () => {
    abort.abort();
    return 0;
  });
  await expect(
    budget.transaction(h.prisma, 'tenant', (tx) =>
      Promise.all([tx.meeting.count(), tx.meeting.count()]),
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(h.tx.meeting.count).toHaveBeenCalledTimes(1);
  expect(h.calls.at(-1)).toBe('closed');
});
it('rejects after deadline even when the database completes successfully', async () => {
  let now = 0;
  const h = harness();
  const budget = new RecordedActivityBudget(undefined, () => now);
  h.tx.meeting.count.mockImplementationOnce(async () => {
    now = 10_001;
    return 0;
  });
  await expect(
    budget.transaction(h.prisma, 'tenant', (tx) => tx.meeting.count()),
  ).rejects.toMatchObject({ status: 503 });
  expect(h.calls.at(-1)).toBe('closed');
});
