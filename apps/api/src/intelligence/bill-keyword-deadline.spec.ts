import { Prisma } from '@prisma/client';
import { IntelligenceService } from './intelligence.service.js';
import {
  BillKeywordDeadlineExceeded,
  withBillKeywordProfileDeadline,
  withBillKeywordSqlDeadline,
} from './bill-keyword-deadline.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fakePrisma() {
  const tx = { $executeRaw: jest.fn(async () => 1), $queryRaw: jest.fn() };
  const prisma = {
    $transaction: jest.fn(async (run: (arg: typeof tx) => Promise<unknown>) => run(tx)),
  };
  return { prisma: prisma as any, tx };
}

describe('bill keyword server deadlines', () => {
  for (const method of ['findRelevantBillsByKeyword', 'findTrackedBillsByKeyword']) {
    it(`${method} preserves exact successful SQL/result under one count-and-row transaction`, async () => {
      const { prisma, tx } = fakePrisma();
      tx.$queryRaw.mockResolvedValueOnce([{ total: 7n }]).mockResolvedValueOnce([
        {
          id: 'bill-1',
          congress: 119,
          bill_type: 'hr',
          bill_number: '1',
          title: 'Synthetic bill',
          subjects: ['Science'],
          sponsor_name: 'Synthetic Sponsor',
          sponsor_party: 'I',
          sponsor_state: 'VA',
          status: 'introduced',
          action_texts: ['Introduced'],
        },
      ]);
      const service = new IntelligenceService(prisma);
      const terms = Array.from({ length: 126 }, (_, i) => `term-${i}`);
      const result = await (service as any)[method](terms);
      expect(result.total).toBe(7);
      expect(result.bills).toHaveLength(1);
      expect(result.bills[0]).toMatchObject({ title: 'Synthetic bill' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      const [countSql, rowsSql] = tx.$queryRaw.mock.calls.map(([sql]) => sql as Prisma.Sql);
      if (!countSql || !rowsSql) throw new Error('Both expected SQL statements must be observed');
      expect(countSql.sql).toContain('COUNT(*)::bigint AS total');
      expect(rowsSql.sql).toContain('ORDER BY cb.latest_action_date DESC NULLS LAST, cb.id');
      expect(rowsSql.sql).toContain(
        method === 'findRelevantBillsByKeyword' ? 'LIMIT 25' : 'LIMIT 50',
      );
      expect(countSql.values.flat()).toEqual(expect.arrayContaining(terms));
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
      for (const call of tx.$executeRaw.mock.calls as unknown as Array<[unknown, string]>)
        expect(parseInt(call[1], 10)).toBeGreaterThan(0);
    });
    it(`${method} propagates cancellation instead of a false zero/empty result`, async () => {
      const { prisma, tx } = fakePrisma();
      const cancelled = Object.assign(new Error('statement cancelled'), {
        code: 'P2010',
        meta: { code: '57014' },
      });
      tx.$queryRaw.mockRejectedValueOnce(cancelled);
      await expect((new IntelligenceService(prisma) as any)[method](['science'])).rejects.toBe(
        cancelled,
      );
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });
  }

  it('spends one deadline across count and rows instead of resetting the budget', async () => {
    const { prisma, tx } = fakePrisma();
    tx.$queryRaw.mockImplementationOnce(async () => {
      await delay(35);
      return [{ total: 2n }];
    });
    tx.$queryRaw.mockResolvedValueOnce([{ n: 2 }]);
    await withBillKeywordSqlDeadline(
      prisma,
      async (query) => {
        await query(Prisma.sql`SELECT 1`);
        return query(Prisma.sql`SELECT 2`);
      },
      150,
    );
    const timeouts = (tx.$executeRaw.mock.calls as unknown as Array<[unknown, string]>).map((c) =>
      parseInt(c[1], 10),
    );
    expect(timeouts).toHaveLength(2);
    expect(timeouts[1]).toBeLessThan(timeouts[0]! - 20);
  });

  it('does not start row SQL when count exhausted the deadline', async () => {
    const { prisma, tx } = fakePrisma();
    tx.$queryRaw.mockImplementationOnce(async () => {
      await delay(35);
      return [{ total: 1n }];
    });
    await expect(
      withBillKeywordSqlDeadline(
        prisma,
        async (query) => {
          await query(Prisma.sql`SELECT 1`);
          return query(Prisma.sql`SELECT 2`);
        },
        20,
      ),
    ).rejects.toBeInstanceOf(BillKeywordDeadlineExceeded);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('expired profile scope refuses late fallback before acquiring any connection', async () => {
    const { prisma } = fakePrisma();
    await expect(
      withBillKeywordProfileDeadline(async () => {
        await delay(25);
        return withBillKeywordSqlDeadline(prisma, (query) => query(Prisma.sql`SELECT 1`));
      }, 10),
    ).rejects.toBeInstanceOf(BillKeywordDeadlineExceeded);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('isolates concurrent request deadlines and never extends an inherited deadline', async () => {
    const expired = fakePrisma();
    const fresh = fakePrisma();
    fresh.tx.$queryRaw.mockResolvedValue([{ n: 1 }]);
    const results = await Promise.allSettled([
      withBillKeywordProfileDeadline(async () => {
        await delay(30);
        return withBillKeywordProfileDeadline(
          () => withBillKeywordSqlDeadline(expired.prisma, (q) => q(Prisma.sql`SELECT 1`)),
          100,
        );
      }, 10),
      withBillKeywordProfileDeadline(async () => {
        await delay(30);
        return withBillKeywordSqlDeadline(fresh.prisma, (q) => q(Prisma.sql`SELECT 1`));
      }, 150),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(expired.prisma.$transaction).not.toHaveBeenCalled();
    expect(fresh.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('validates caller budgets before pool acquisition', async () => {
    const { prisma } = fakePrisma();
    for (const ms of [0, -1, NaN, Infinity, 5_001])
      await expect(
        withBillKeywordSqlDeadline(prisma, (q) => q(Prisma.sql`SELECT 1`), ms),
      ).rejects.toThrow(RangeError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
