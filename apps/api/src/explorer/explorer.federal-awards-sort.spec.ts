import { ExplorerService } from './explorer.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * `federal_award.amount` (Decimal?) and `action_date` (DateTime?) are both
 * nullable, and Postgres defaults DESC to NULLS FIRST.
 *
 * So the descending sorts had to state `nulls: 'last'` explicitly, or the least
 * informative rows sort to the very top: "Largest obligated first" led with
 * awards reporting NO amount, and "Most recent" led with awards carrying no
 * action date. Both read to an operator as a data-quality problem in the
 * product rather than in the source row.
 *
 * These pin the orderBy that reaches Prisma, because the defect is invisible in
 * the returned rows — a hand-mocked findMany returns whatever it is given
 * regardless of sort, and only the real database reveals the ordering. ASC is
 * pinned too: it is already NULLS LAST by default, and stating it keeps the
 * three branches symmetrical so the next sort added copies the right shape.
 */

type CapturedArgs = { orderBy?: unknown; where?: unknown };

function makePrisma() {
  const findMany = jest.fn(async (_args: CapturedArgs) => []);
  return {
    prisma: {
      federalAward: {
        findMany,
        count: jest.fn(async () => 0),
      },
    } as unknown as PrismaService,
    findMany,
  };
}

describe('ExplorerService.federalAwards — nullable sorts put NULLs last', () => {
  it('defaults to amount desc with nulls last, so no-amount rows never lead "largest first"', async () => {
    const { prisma, findMany } = makePrisma();
    const svc = new ExplorerService(prisma);
    await svc.federalAwards({});
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0]!.orderBy).toEqual({
      amount: { sort: 'desc', nulls: 'last' },
    });
  });

  it('sorts recent by actionDate desc with nulls last, so undated rows never lead', async () => {
    const { prisma, findMany } = makePrisma();
    const svc = new ExplorerService(prisma);
    await svc.federalAwards({ sort: 'recent' });
    expect(findMany.mock.calls[0]![0]!.orderBy).toEqual({
      actionDate: { sort: 'desc', nulls: 'last' },
    });
  });

  it('sorts oldest by actionDate asc with nulls last', async () => {
    const { prisma, findMany } = makePrisma();
    const svc = new ExplorerService(prisma);
    await svc.federalAwards({ sort: 'oldest' });
    expect(findMany.mock.calls[0]![0]!.orderBy).toEqual({
      actionDate: { sort: 'asc', nulls: 'last' },
    });
  });

  it('an unrecognised sort falls back to the amount default rather than no ordering', async () => {
    const { prisma, findMany } = makePrisma();
    const svc = new ExplorerService(prisma);
    await svc.federalAwards({ sort: 'not-a-sort' });
    expect(findMany.mock.calls[0]![0]!.orderBy).toEqual({
      amount: { sort: 'desc', nulls: 'last' },
    });
  });
});
