/**
 * REGRESSION (2026-07-10 hot-fix): a failed getRollCall must not let a
 * bill's change_hash advance in state_sync_cursor.billHashes — otherwise the
 * next masterlist diff sees a hash that already matches LegiScan's and never
 * re-queues the bill, permanently losing that vote. This script has no
 * existing test infra (no pure exported helpers besides the ones this file
 * adds), so this mocks at the module boundary: @prisma/client (a fake
 * PrismaClient instance), the LegiScan client (getBill/getRollCall), and the
 * normalize module (real DB-writing upserts stubbed to no-ops) — exercising
 * `main()`'s real control flow end to end.
 */
process.env.LEGISCAN_API_KEY = 'test-key';
process.env.LEGISCAN_STATES = 'TX';
process.env.LEGISCAN_DRAIN_CAP = '10';
process.env.LEGISCAN_MONTHLY_BUDGET = '28000';

let fakePrisma: any;

jest.mock('@prisma/client', () => ({
  __esModule: true,
  PrismaClient: jest.fn(() => fakePrisma),
}));

const getBillMock = jest.fn();
const getRollCallMock = jest.fn();
jest.mock('../src/external/legiscan/legiscan.client.js', () => ({
  __esModule: true,
  getBill: (...args: unknown[]) => getBillMock(...args),
  getRollCall: (...args: unknown[]) => getRollCallMock(...args),
}));

const upsertStateRollCallVoteMock = jest.fn();
jest.mock('../src/ingestion/legiscan-normalize.js', () => ({
  __esModule: true,
  normalizeLegiscanBill: jest.fn((raw: any, state: string) => ({
    billKey: `${state.toLowerCase()}-2025-hb${raw.bill_id}`,
  })),
  upsertNormalizedStateBill: jest.fn(async () => ({ isNew: true })),
  upsertStateRollCallVote: (...args: unknown[]) => upsertStateRollCallVoteMock(...args),
  crosswalkStateBill: jest.fn(async () => undefined),
  stateRollCallId: (state: string, rollCallId: number) => `${state}-rc-${rollCallId}`,
}));

function makeFakePrisma(opts: { pendingBills: number[]; billHashes?: Record<string, string> }) {
  const cursorRow = {
    id: 'cursor-tx',
    state: 'TX',
    pendingBills: opts.pendingBills,
    billHashes: opts.billHashes ?? {},
    quotaMonth: null as string | null,
    queriesUsed: 0,
  };
  const updateCalls: Array<{ where: unknown; data: unknown }> = [];
  return {
    __cursorRow: cursorRow,
    __updateCalls: updateCalls,
    stateSyncCursor: {
      findMany: jest.fn(async (args: any) => {
        // Distinguish the two call sites by whether a `select` is present
        // (the quota-check scan) vs a `where` filter (the drain-cursor scan).
        if (args?.select)
          return [{ queriesUsed: cursorRow.queriesUsed, quotaMonth: cursorRow.quotaMonth }];
        return [{ ...cursorRow }];
      }),
      findUnique: jest.fn(async () => ({ ...cursorRow })),
      update: jest.fn(async ({ where, data }: any) => {
        updateCalls.push({ where, data });
        if (data.billHashes) cursorRow.billHashes = data.billHashes;
        if (data.pendingBills?.set) cursorRow.pendingBills = data.pendingBills.set;
        if (typeof data.queriesUsed === 'number') cursorRow.queriesUsed = data.queriesUsed;
        if (data.queriesUsed?.increment) cursorRow.queriesUsed += data.queriesUsed.increment;
        if (data.quotaMonth) cursorRow.quotaMonth = data.quotaMonth;
        return { ...cursorRow };
      }),
    },
    stateRollCallVote: {
      findUnique: jest.fn(async () => null), // no existing vote -> always attempt getRollCall
    },
    syncRun: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'run-1' })),
      update: jest.fn(async () => ({})),
    },
    $disconnect: jest.fn(async () => undefined),
  };
}

beforeEach(() => {
  jest.resetModules();
  getBillMock.mockReset();
  getRollCallMock.mockReset();
  upsertStateRollCallVoteMock.mockReset();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('sync-legiscan-bills — getRollCall failure (2026-07-10 hot-fix)', () => {
  it('all votes succeed: billHashes advances to the new change_hash', async () => {
    fakePrisma = makeFakePrisma({ pendingBills: [42] });
    getBillMock.mockResolvedValue({
      bill_id: 42,
      change_hash: 'hash-v2',
      votes: [{ roll_call_id: 1001, yea: 20, nay: 10, nv: 0, absent: 0 }],
    });
    getRollCallMock.mockResolvedValue({ roll_call_id: 1001, yea: 20, nay: 10 });

    const mod = await import('./sync-legiscan-bills.js');
    await mod.main();

    expect(fakePrisma.__cursorRow.billHashes['42']).toBe('hash-v2');
    expect(upsertStateRollCallVoteMock).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: a failed getRollCall leaves billHashes UNCHANGED for that bill (never silently loses the vote)', async () => {
    fakePrisma = makeFakePrisma({ pendingBills: [42], billHashes: { '42': 'hash-v1' } });
    getBillMock.mockResolvedValue({
      bill_id: 42,
      change_hash: 'hash-v2', // masterlist says this bill changed
      votes: [{ roll_call_id: 1001, yea: 20, nay: 10, nv: 0, absent: 0 }],
    });
    getRollCallMock.mockRejectedValue(new Error('LegiScan 500'));

    const mod = await import('./sync-legiscan-bills.js');
    await mod.main();

    // The stale hash is preserved — NOT advanced to hash-v2 — so the next
    // masterlist diff sees a mismatch and re-queues this bill.
    expect(fakePrisma.__cursorRow.billHashes['42']).toBe('hash-v1');
    expect(upsertStateRollCallVoteMock).not.toHaveBeenCalled();
  });

  it('a bill with NO votes still advances billHashes normally (no regression to the common case)', async () => {
    fakePrisma = makeFakePrisma({ pendingBills: [7] });
    getBillMock.mockResolvedValue({ bill_id: 7, change_hash: 'hash-only', votes: [] });

    const mod = await import('./sync-legiscan-bills.js');
    await mod.main();

    expect(fakePrisma.__cursorRow.billHashes['7']).toBe('hash-only');
    expect(getRollCallMock).not.toHaveBeenCalled();
  });

  it('one failing vote among several blocks the advance even though the others succeeded', async () => {
    fakePrisma = makeFakePrisma({ pendingBills: [99], billHashes: { '99': 'hash-old' } });
    getBillMock.mockResolvedValue({
      bill_id: 99,
      change_hash: 'hash-new',
      votes: [
        { roll_call_id: 1, yea: 5, nay: 1, nv: 0, absent: 0 },
        { roll_call_id: 2, yea: 3, nay: 2, nv: 0, absent: 0 },
      ],
    });
    getRollCallMock.mockImplementation(async (...args: any[]) => {
      if (args[1] === 1) return { roll_call_id: 1, yea: 5, nay: 1 };
      throw new Error('roll call 2 unavailable');
    });

    const mod = await import('./sync-legiscan-bills.js');
    await mod.main();

    expect(fakePrisma.__cursorRow.billHashes['99']).toBe('hash-old');
    expect(upsertStateRollCallVoteMock).toHaveBeenCalledTimes(1); // only roll call 1 succeeded
  });
});
