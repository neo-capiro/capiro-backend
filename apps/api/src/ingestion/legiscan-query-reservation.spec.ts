import { reservedLegiscanQuery } from './legiscan-query-reservation.js';
import { currentQuotaMonth } from './legiscan-quota.util.js';
const scope = { state: 'AK', cursorId: 'AK-7', operation: 'getMasterListRaw', providerId: 7 };
function db(used = 0) {
  const prisma: any = {
    $executeRaw: jest.fn(async () => 1),
    stateSyncCursor: {
      findMany: jest.fn(async () => [{ queriesUsed: used, quotaMonth: currentQuotaMonth() }]),
    },
  };
  prisma.$transaction = (fn: any) => fn(prisma);
  return prisma;
}
it('reserves before network and charges failures plus retries while refunding only unused attempts', async () => {
  const prisma = db(),
    call = jest.fn(async (retry) => {
      expect(prisma.$executeRaw).toHaveBeenCalled();
      retry();
      throw Error('synthetic failure');
    });
  await expect(reservedLegiscanQuery(prisma, scope, call)).rejects.toThrow('synthetic failure');
  const refund = prisma.$executeRaw.mock.calls.find((args: any) =>
    args[0].join('').includes('greatest'),
  );
  expect(refund[1]).toBe(2);
});
it('makes zero network calls when reserve would exceed the27000soft or30000hard allowance', async () => {
  for (const used of [26997, 27000, 30000]) {
    const call = jest.fn();
    await expect(reservedLegiscanQuery(db(used), scope, call)).rejects.toThrow('BUDGET_HOLD');
    expect(call).not.toHaveBeenCalled();
  }
});
it('keeps all four failed attempts charged and refuses excess retries', async () => {
  const prisma = db();
  await expect(
    reservedLegiscanQuery(prisma, scope, async (retry) => {
      retry();
      retry();
      retry();
      retry();
    }),
  ).rejects.toThrow('ATTEMPTS_EXCEEDED');
  expect(
    prisma.$executeRaw.mock.calls.some((args: any) => args[0].join('').includes('greatest')),
  ).toBe(false);
});
