import { knownParentDiff, wideListDue, refreshKnownFy26Wide } from './state-wide-refresh.js';
import { loadPinnedStateInventory } from './state-bill-inventory-read.js';
import { reservedLegiscanQuery } from './legiscan-query-reservation.js';
import { getMasterListRaw } from '../external/legiscan/legiscan.client.js';
jest.mock('./state-bill-inventory-read.js', () => ({ loadPinnedStateInventory: jest.fn() }));
jest.mock('./legiscan-query-reservation.js', () => ({ reservedLegiscanQuery: jest.fn() }));
jest.mock('../external/legiscan/legiscan.client.js', () => ({ getMasterListRaw: jest.fn() }));
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(loadPinnedStateInventory)
    .mockResolvedValue({
      discovery: null,
      sessions: [],
      inventories: [
        {
          jurisdiction: 'AK',
          known: true,
          expectedSessions: 1,
          qualifiedSessions: 1,
          missingSessions: [],
        },
      ],
      qualifiedReceiptIds: ['receipt'],
    });
  jest
    .mocked(reservedLegiscanQuery)
    .mockImplementation(async (_db, _scope, call) => ({
      value: await call(() => {}),
      attempts: 1,
    }));
  jest.mocked(getMasterListRaw).mockResolvedValue([
    { bill_id: 1, change_hash: 'new', number: 'HB1' },
    { bill_id: 2, change_hash: 'excluded', number: 'HB2' },
  ]);
});
function db(lastListAt: Date | null = null) {
  return {
    $queryRawUnsafe: jest.fn(async (sql: string) =>
      sql.includes('max(observed_at)')
        ? [{ at: null }]
        : [{ state: 'AK', sessionId: 7, providerId: 1, billKey: 'ak-2025-hb1' }],
    ),
    stateSyncCursor: {
      findUnique: jest.fn(async () => ({
        lastListAt,
        pendingBills: [99],
        billHashes: { '1': 'old' },
      })),
      update: jest.fn(),
    },
  } as any;
}
it('queues only persisted known admitted parents, not excluded/new IDs or unprimed hashes', () => {
  const rows = [
    { bill_id: 1, change_hash: 'new' },
    { bill_id: 2, change_hash: 'excluded' },
    { bill_id: 3, change_hash: 'unimported' },
  ];
  expect(knownParentDiff(rows, new Set([1, 3]), { '1': 'old' }, new Set([99]))).toEqual([1]);
  expect(knownParentDiff(rows, new Set([1]), {}, new Set())).toEqual([]);
  expect(knownParentDiff(rows, new Set([1]), { '1': 'old' }, new Set([1]))).toEqual([]);
});
it('enforces daily wide cadence and preserves unrelated pending work without advancing hashes', async () => {
  const prisma = db();
  expect(await refreshKnownFy26Wide(prisma, 'synthetic')).toMatchObject({
    queries: 1,
    queued: 1,
    errors: 0,
  });
  expect(prisma.stateSyncCursor.update).toHaveBeenCalledWith({
    where: { id: 'AK-7' },
    data: { pendingBills: [99, 1], lastListAt: expect.any(Date) },
  });
  expect(getMasterListRaw).toHaveBeenCalledWith('synthetic', 7, undefined, expect.any(Function));
  expect(wideListDue(new Date(Date.now() - 23 * 3600000))).toBe(false);
  jest.clearAllMocks();
  await refreshKnownFy26Wide(db(new Date()), 'synthetic');
  expect(reservedLegiscanQuery).not.toHaveBeenCalled();
});
it('unknown discovery or recent failed attempt makes zero provider calls', async () => {
  const prisma = db();
  prisma.$queryRawUnsafe.mockImplementation(async (sql: string) =>
    sql.includes('max(observed_at)')
      ? [{ at: new Date() }]
      : [{ state: 'AK', sessionId: 7, providerId: 1, billKey: 'ak-2025-hb1' }],
  );
  await refreshKnownFy26Wide(prisma, 'synthetic');
  expect(reservedLegiscanQuery).not.toHaveBeenCalled();
  jest
    .mocked(loadPinnedStateInventory)
    .mockResolvedValue({ discovery: null, sessions: [], inventories: [], qualifiedReceiptIds: [] });
  await refreshKnownFy26Wide(db(), 'synthetic');
  expect(getMasterListRaw).not.toHaveBeenCalled();
});
it('budget hold leaves cursor pending/hashes/list freshness untouched', async () => {
  const prisma = db();
  jest.mocked(reservedLegiscanQuery).mockRejectedValue(Error('EXISTING_PROVIDER_BUDGET_HOLD'));
  expect(await refreshKnownFy26Wide(prisma, 'synthetic')).toMatchObject({
    budgetHeld: true,
    queued: 0,
  });
  expect(getMasterListRaw).not.toHaveBeenCalled();
  expect(prisma.stateSyncCursor.update).not.toHaveBeenCalled();
});
