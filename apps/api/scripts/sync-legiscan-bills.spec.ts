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
const getBillTextMock = jest.fn();
const getSupportingDocumentMock = jest.fn();
jest.mock('../src/external/legiscan/legiscan.client.js', () => ({
  __esModule: true,
  getBill: (...args: unknown[]) => getBillMock(...args),
  getRollCall: (...args: unknown[]) => getRollCallMock(...args),
  getBillText: (...args: unknown[]) => getBillTextMock(...args),
  getSupportingDocument: (...args: unknown[]) => getSupportingDocumentMock(...args),
}));

// queueEventRecordRefresh is mocked at the module boundary, but its return
// shape — including the new in-lock `admittedByCursor` provenance — is the
// real contract the drain consumes.
const queueEventRecordRefreshMock = jest.fn(
  async (_prisma?: unknown, _states?: unknown) => ({
    events: 0,
    eligible: 0,
    queued: 0,
    cap: 100,
    admittedByCursor: {} as Record<string, number[]>,
  }),
);
jest.mock('../src/ingestion/legiwatch-event-record-refresh.js', () => ({
  __esModule: true,
  queueEventRecordRefresh: (...args: unknown[]) =>
    (queueEventRecordRefreshMock as (...a: unknown[]) => unknown)(...args),
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

// Document evidence persistence is dynamically imported inside the drain;
// mock it so document fetches complete for real (state 'extracted') instead
// of dying on an unmocked import.
jest.mock('../src/ingestion/legiscan-document-evidence.js', () => ({
  __esModule: true,
  persistDocumentEvidence: jest.fn(async () => 'extracted'),
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
  const executeRawCalls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    __cursorRow: cursorRow,
    __updateCalls: updateCalls,
    __executeRawCalls: executeRawCalls,
    stateBill: { updateMany: jest.fn(async () => ({ count: 1 })), update: jest.fn(async () => ({})) },
    stateBillPublishedRecord: { createMany: jest.fn(async () => ({ count: 0 })) },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(fakePrisma),
    $queryRaw: jest.fn(async () => [] as unknown[]),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      executeRawCalls.push({ sql, values });
      // Model the atomic deferral: UPDATE state_sync_cursor SET
      // pending_bills=array_remove(pending_bills, <billId>) WHERE id=<cursorId>.
      if (sql.includes('array_remove')) {
        const billId = Number(values[0]);
        cursorRow.pendingBills = cursorRow.pendingBills.filter((id) => id !== billId);
      }
      return 0;
    }),
    stateSyncCursor: {
      findMany: jest.fn(async (args: any) => {
        if (args?.select?.queriesUsed)
          return [{ queriesUsed: cursorRow.queriesUsed, quotaMonth: cursorRow.quotaMonth }];
        return [{ ...cursorRow, pendingBills: [...cursorRow.pendingBills] }];
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
  getBillTextMock.mockReset();
  getSupportingDocumentMock.mockReset();
  upsertStateRollCallVoteMock.mockReset();
  queueEventRecordRefreshMock.mockClear();
  // Default: any document fetch returns a valid subject-matched synthetic
  // body so document attempts complete for real.
  getBillTextMock.mockImplementation(async (_k: string, docId: number) => ({
    doc_id: docId,
    bill_id: Number(docId) - 100,
  }));
  getSupportingDocumentMock.mockImplementation(async (_k: string, _kind: string, id: number) => ({
    doc_id: id,
    bill_id: Number(id) - 100,
  }));
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

  it('a null vote response stays partial and does not advance the bill hash', async () => {
    fakePrisma = makeFakePrisma({ pendingBills: [42], billHashes: { '42': 'old' } });
    getBillMock.mockResolvedValue({
      bill_id: 42,
      change_hash: 'new',
      votes: [{ roll_call_id: 1001, yea: 20, nay: 10 }],
    });
    getRollCallMock.mockResolvedValue(null);
    const mod = await import('./sync-legiscan-bills.js');
    await mod.main();
    expect(fakePrisma.__cursorRow.billHashes['42']).toBe('old');
    expect(fakePrisma.stateBill.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sourceCheckStatus: 'partial' }) }),
    );
    expect(fakePrisma.stateBill.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sourceCheckStatus: 'success' }) }),
    );
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

/**
 * 2026-09-15 research-queue-budget fix: only bill ids the refresh PROVABLY
 * appended this run (returned as `admittedByCursor` from inside its cursor
 * lock) may be deferred once the per-run document cap is spent. Anything
 * already pending — masterlist-changed spines, vote retries, ambiguous
 * legacy entries — drains normally. No provider is contacted: getBill /
 * getRollCall are jest mocks that fail the test when called unexpectedly.
 */
describe('sync-legiscan-bills — doc-only deferral (2026-09-15 research-queue-budget)', () => {
  const enableRefreshAndDocs = () => {
    process.env.LEGIWATCH_PUBLISHED_RECORD_REFRESH_ENABLED = 'true';
    process.env.LEGISCAN_DOCUMENT_EVIDENCE_ENABLED = 'true';
    process.env.LEGISCAN_DOCUMENT_REFRESH_CAP = '1';
  };
  const restoreEnv = () => {
    delete process.env.LEGIWATCH_PUBLISHED_RECORD_REFRESH_ENABLED;
    delete process.env.LEGISCAN_DOCUMENT_EVIDENCE_ENABLED;
    delete process.env.LEGISCAN_DOCUMENT_REFRESH_CAP;
  };
  afterEach(restoreEnv);

  const billPayload = (id: number, changeHash: string, withDoc = true) => ({
    bill_id: id,
    change_hash: changeHash,
    votes: [] as unknown[],
    texts: withDoc ? [{ doc_id: 100 + id, text_hash: `t${id}` }] : [],
    amendments: [],
    supplements: [],
  });

  it('ordinary pre-existing pending changed spine behind the doc cap still gets getBill + votes', async () => {
    enableRefreshAndDocs();
    // Both ids were pending BEFORE the refresh (ordinary queue); the refresh
    // admits nothing. Bill 4 spends the document cap; bill 5 must NOT defer.
    fakePrisma = makeFakePrisma({ pendingBills: [4, 5], billHashes: { '4': 'h4', '5': 'h5' } });
    getBillMock.mockImplementation(async (_k: string, id: number) => billPayload(id, `new-${id}`));

    const mod = await import('./sync-legiscan-bills.js');
    await mod.main();

    expect(getBillMock).toHaveBeenCalledTimes(2);
    expect(getBillMock.mock.calls.map((c) => c[1])).toEqual([4, 5]);
    expect(fakePrisma.__cursorRow.billHashes['5']).toBe('new-5');
  });

  it('REVIEW CASE (review29 A->B): masterlist-changed spine with preserved last-drained hash is NEVER deferred', async () => {
    enableRefreshAndDocs();
    // The auditor's concrete counterexample: the cursor preserves bill 5's
    // LAST-DRAINED hash ('h5-old') after diffMasterlist queued it as changed
    // (provider hash would be 'h5-NEW'). A hash-presence classifier wrongly
    // defers this as "unchanged doc-only" (review29-hash-provenance-before
    // .json: expected false, classifier said true). Admission provenance must
    // not: 5 was in the ordinary pending queue before the refresh ran, so it
    // drains fully — real getBill, vote processed, hash advanced to the REAL
    // provider hash.
    fakePrisma = makeFakePrisma({
      pendingBills: [4, 5],
      billHashes: { '4': 'h4', '5': 'h5-old' },
    });
    getBillMock.mockImplementation(async (_k: string, id: number) => ({
      ...billPayload(id, id === 5 ? 'h5-NEW' : 'new-4'),
      votes: id === 5 ? [{ roll_call_id: 900, yea: 3, nay: 1, nv: 0, absent: 0 }] : [],
    }));
    getRollCallMock.mockResolvedValue({ roll_call_id: 900, yea: 3, nay: 1 });

    const mod = await import('./sync-legiscan-bills.js');
    await mod.main();

    expect(getBillMock).toHaveBeenCalledTimes(2);
    expect(getRollCallMock).toHaveBeenCalledTimes(1);
    expect(upsertStateRollCallVoteMock).toHaveBeenCalledTimes(1);
    expect(fakePrisma.__cursorRow.billHashes['5']).toBe('h5-NEW');
    expect(fakePrisma.__cursorRow.pendingBills).not.toContain(5);
  });

  it('proven doc-only admission after the doc cap: no getBill, durably un-queued, no fake writes', async () => {
    enableRefreshAndDocs();
    // Ordinary queue holds only bill 4 (spends the doc cap). The refresh's
    // locked transaction appends bill 6 and reports it in admittedByCursor.
    fakePrisma = makeFakePrisma({ pendingBills: [4], billHashes: { '4': 'h4' } });
    queueEventRecordRefreshMock.mockImplementation(async () => {
      fakePrisma.__cursorRow.pendingBills = [...fakePrisma.__cursorRow.pendingBills, 6];
      return { events: 1, eligible: 1, queued: 1, cap: 100, admittedByCursor: { 'cursor-tx': [6] } };
    });
    getBillMock.mockImplementation(async (_k: string, id: number) => {
      if (id === 6) throw new Error('getBill must NOT be called for deferred doc-only bill 6');
      return billPayload(id, 'new-4');
    });

    const mod = await import('./sync-legiscan-bills.js');
    await mod.main();

    expect(getBillMock).toHaveBeenCalledTimes(1);
    expect(getBillMock.mock.calls[0][1]).toBe(4);
    // Durably un-queued: NOT back in ordinary pending (the atomic array_remove
    // modelled in the fake dropped it)...
    expect(fakePrisma.__cursorRow.pendingBills).not.toContain(6);
    // ...and the deferral wrote NO state_bill_record_check row for bill 6 at
    // all — its pre-existing due checks are simply left due (no invented
    // timing, no fake attempt). Assert on the interpolated VALUES, not the
    // placeholder SQL text.
    expect(
      fakePrisma.__executeRawCalls.some(
        (c: { sql: string; values: unknown[] }) =>
          c.sql.includes('state_bill_record_check') &&
          c.values.some((v) => typeof v === 'string' && v.includes('hb6')),
      ),
    ).toBe(false);
    // No fake attempt/success recorded against the deferred bill.
    expect(
      fakePrisma.stateBill.updateMany.mock.calls.some(
        (c: any[]) => c[0]?.where?.legiscanBillId === 6,
      ),
    ).toBe(false);
  });

  it('deferred admission resumes through the next run: re-admitted by refresh, then really fetched + completed', async () => {
    enableRefreshAndDocs();
    // Next scheduled run with fresh document budget: the deferred bill's
    // checks are due again, the refresh re-admits it, and it is fetched and
    // completed for real.
    process.env.LEGISCAN_DOCUMENT_REFRESH_CAP = '10';
    fakePrisma = makeFakePrisma({ pendingBills: [], billHashes: {} });
    queueEventRecordRefreshMock.mockImplementation(async () => {
      fakePrisma.__cursorRow.pendingBills = [...fakePrisma.__cursorRow.pendingBills, 6];
      return { events: 1, eligible: 1, queued: 1, cap: 100, admittedByCursor: { 'cursor-tx': [6] } };
    });
    getBillMock.mockResolvedValue(billPayload(6, 'h6'));
    const mod = await import('./sync-legiscan-bills.js');
    await mod.main();
    expect(getBillMock).toHaveBeenCalledTimes(1);
    expect(getBillMock.mock.calls[0][1]).toBe(6);
    // Real document completion: getBillText actually ran and the row was
    // marked available with a checked timestamp and 7-day re-check — not
    // merely an INSERT attempt.
    expect(getBillTextMock).toHaveBeenCalledTimes(1);
    expect(
      fakePrisma.__executeRawCalls.some(
        (c: { sql: string; values: unknown[] }) =>
          c.sql.includes('UPDATE state_bill_record_check') &&
          c.sql.includes('checked_at=now()') &&
          c.values[0] === 'available',
      ),
    ).toBe(true);
    // Source success + hash advance on the spine.
    expect(fakePrisma.stateBill.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { legiscanBillId: 6 },
        data: expect.objectContaining({ sourceCheckStatus: 'success' }),
      }),
    );
    expect(fakePrisma.__cursorRow.billHashes['6']).toBe('h6');
  });

  it('injected failure boundary: a mid-drain throw preserves ordinary pending, due checks, and the deferred admission', async () => {
    enableRefreshAndDocs();
    fakePrisma = makeFakePrisma({ pendingBills: [4, 5], billHashes: { '4': 'h4', '5': 'h5' } });
    queueEventRecordRefreshMock.mockImplementation(async () => {
      fakePrisma.__cursorRow.pendingBills = [...fakePrisma.__cursorRow.pendingBills, 6];
      return { events: 1, eligible: 1, queued: 1, cap: 100, admittedByCursor: { 'cursor-tx': [6] } };
    });
    // Bill 4 drains (spends the doc cap), bill 5 (ordinary) hits an injected
    // storage failure mid-drain, bill 6 (admission) is deferred. The run must
    // not lose any of the three. The failure is injected at the real DB
    // boundary the script awaits (stateBill.update inside
    // persistPublishedRecords -> tx.stateBill.update), not a mocked shortcut.
    const baseStateBillUpdate = fakePrisma.stateBill.update.getMockImplementation();
    fakePrisma.stateBill.update.mockImplementation(async (args: any) => {
      if (args?.where?.id === 'tx-2025-hb5')
        throw new Error('injected storage failure at bill 5');
      return baseStateBillUpdate?.(args) ?? {};
    });
    getBillMock.mockImplementation(async (_k: string, id: number) => {
      if (id === 6) throw new Error('getBill must NOT be called for deferred doc-only bill 6');
      return billPayload(id, id === 4 ? 'new-4' : 'new-5');
    });
    const mod = await import('./sync-legiscan-bills.js');
    await mod.main();

    // Bill 5's failure was honestly recorded (existing catch semantics): the
    // id is drained from this run's queue but its billHashes entry is left
    // stale, so the NEXT masterlist diff re-queues it — the existing recovery
    // path. We do NOT claim it stayed queued.
    expect(fakePrisma.__cursorRow.pendingBills).not.toContain(5);
    expect(fakePrisma.__cursorRow.billHashes['5']).toBe('h5');
    // ...an honest failure was recorded (no fake success)...
    expect(fakePrisma.stateBill.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { legiscanBillId: 5 },
        data: expect.objectContaining({ sourceCheckStatus: 'failed' }),
      }),
    );
    // ...the deferred admission 6 stayed out of pending (durable deferral)...
    expect(fakePrisma.__cursorRow.pendingBills).not.toContain(6);
    // ...and quota reflects the real provider requests: bill 4 (getBill + 1
    // document) and bill 5 (getBill before the injected failure) = 3.
    expect(fakePrisma.__cursorRow.queriesUsed).toBe(3);
  });
});
