import { describe, expect, jest, test } from '@jest/globals';
import { fecCycles, FEC_PAC_COMMITTEE_TYPES } from '../src/intelligence/fec-cycles.js';
import { fecSchedulePages, type FecFetcher, type FecPage } from './fec-api.js';
import { syncPacCycle, type PacSyncDatabase, type ScheduleBRow } from './fec-pac-sync.js';

// Shape comes from OpenFEC ScheduleBSchema and BaseItemized: sub_id is a string,
// filing_form/line_number are strings, memoed_subtotal is boolean.
const row: ScheduleBRow = {
  committee_id: 'C00100321',
  sub_id: '4023120191899433101',
  transaction_id: 'SB23.12',
  file_number: 1799012,
  filing_form: 'F3X',
  line_number: '23',
  recipient_name: 'Candidate committee',
  disbursement_amount: 5000,
  disbursement_date: '2026-05-12',
  memoed_subtotal: false,
};
function source(pages: Array<FecPage<ScheduleBRow> | Error>) {
  const fn = jest.fn(async (_path: string, _params: Record<string, string>) => {
    const next = pages.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('Unexpected request');
    return next;
  });
  return { fn, fetcher: fn as FecFetcher };
}
const page = (results: ScheduleBRow[], index = '1'): FecPage<ScheduleBRow> => ({
  results,
  pagination: {
    pages: 1,
    last_indexes: { last_index: index, last_disbursement_date: '2026-05-12' },
  },
});

function database() {
  let snapshot: any[] = [{ sourceSubId: 'old', amount: 100 }];
  let state: Record<string, any> = { status: 'complete', completedAt: new Date('2026-01-01') };
  const events: string[] = [];
  const stateDelegate = {
    upsert: async (args: any) => {
      state = { ...state, ...args.update };
      events.push(`state:${state.status}`);
    },
    updateMany: async (args: any) => {
      if (state.runId !== args.where.runId) return { count: 0 };
      state = { ...state, ...args.data };
      events.push(`state:${state.status}`);
      return { count: 1 };
    },
  };
  const db: PacSyncDatabase = {
    fecPacSyncState: stateDelegate,
    $transaction: async (fn) => {
      events.push('transaction');
      const old = snapshot;
      const oldState = state;
      let next: any[] = [];
      try {
        const result = await fn({
          fecPacSyncState: stateDelegate,
          fecPacContribution: {
            deleteMany: async () => {
              events.push('delete');
              next = [];
            },
            createMany: async ({ data }) => {
              events.push('insert');
              next.push(...data);
            },
          },
        });
        snapshot = next;
        return result;
      } catch (error) {
        snapshot = old;
        state = oldState;
        throw error;
      }
    },
  };
  return { db, events, snapshot: () => snapshot, state: () => state };
}

describe('FEC cursor traversal', () => {
  test('passes every cursor field, replaces date cursor for null-date rows, ignores approximate counts', async () => {
    const { fetcher, fn } = source([
      page([row]),
      { results: [row], pagination: { last_indexes: { last_index: '2', sort_null_only: true } } },
      { results: [] },
    ]);
    const batches = [];
    for await (const rows of fecSchedulePages(fetcher, '/schedules/schedule_b/', {
      committee_id: 'C00100321',
    }))
      batches.push(rows);
    expect(batches).toHaveLength(2);
    expect(fn.mock.calls[1]).toEqual([
      '/schedules/schedule_b/',
      {
        committee_id: 'C00100321',
        last_index: '1',
        last_disbursement_date: '2026-05-12',
      },
    ]);
    expect(fn.mock.calls[2]).toEqual([
      '/schedules/schedule_b/',
      {
        committee_id: 'C00100321',
        last_index: '2',
        sort_null_only: 'true',
      },
    ]);
  });
  test('traverses beyond the old ten-page cap', async () => {
    const { fetcher } = source([
      ...Array.from({ length: 12 }, (_, i) => page([row], String(i))),
      { results: [] },
    ]);
    let count = 0;
    for await (const rows of fecSchedulePages(fetcher, '/schedules/schedule_b/', {}))
      count += rows.length;
    expect(count).toBe(12);
  });
  test.each([
    ['missing cursor', [{ results: [row] }]],
    ['repeated cursor', [page([row]), page([row])]],
  ] as Array<[string, FecPage<ScheduleBRow>[]]>)(
    'rejects %s instead of claiming completion',
    async (_, pages) => {
      const { fetcher } = source([...pages]);
      await expect(
        (async () => {
          for await (const _ of fecSchedulePages(fetcher, '/schedules/schedule_b/', {})) {
            /* consume */
          }
        })(),
      ).rejects.toThrow(/cursor/);
    },
  );
});

describe('PAC snapshot reconciliation', () => {
  test('retains distinct same-amount/date gifts, negative adjustments and source provenance', async () => {
    const { fetcher, fn } = source([
      page([
        row,
        { ...row, sub_id: '4023120191899433102' },
        { ...row, sub_id: '4023120191899433103', disbursement_amount: -500 },
        { ...row, sub_id: '4023120191899433104', memoed_subtotal: true },
      ]),
      { results: [] },
    ]);
    const db = database();
    expect(await syncPacCycle(db.db, fetcher, 'C00100321', 2026)).toEqual({
      sourceRowCount: 4,
      contributionCount: 3,
    });
    expect(db.snapshot().map((r) => r.amount)).toEqual([5000, 5000, -500]);
    expect(db.snapshot()[0]).toMatchObject({
      sourceSubId: row.sub_id,
      sourceTransactionId: 'SB23.12',
      sourceFileNumber: '1799012',
    });
    expect(db.state()).toMatchObject({
      status: 'complete',
      sourceRowCount: 4,
      contributionCount: 3,
    });
    expect(fn.mock.calls[0]?.[1]).toMatchObject({ line_number: 'F3X-23' });
  });
  test('replaces a prior amended snapshot instead of retaining its old amount', async () => {
    const db = database();
    await syncPacCycle(db.db, source([page([row]), { results: [] }]).fetcher, 'C00100321', 2026);
    await syncPacCycle(
      db.db,
      source([
        page([{ ...row, sub_id: 'new-amendment', disbursement_amount: 2500 }]),
        { results: [] },
      ]).fetcher,
      'C00100321',
      2026,
    );
    expect(db.snapshot()).toHaveLength(1);
    expect(db.snapshot()[0].amount).toBe(2500);
  });
  test('records genuinely empty completed coverage', async () => {
    const db = database();
    await syncPacCycle(db.db, source([{ results: [] }]).fetcher, 'C00100321', 2026);
    expect(db.snapshot()).toEqual([]);
    expect(db.state()).toMatchObject({ status: 'complete', contributionCount: 0 });
  });
  test('failed later page retains the previous snapshot and its last completed timestamp', async () => {
    const db = database();
    const before = db.state().completedAt;
    await expect(
      syncPacCycle(db.db, source([page([row]), new Error('HTTP 429')]).fetcher, 'C00100321', 2026),
    ).rejects.toThrow('HTTP 429');
    expect(db.snapshot()).toEqual([{ sourceSubId: 'old', amount: 100 }]);
    expect(db.events).not.toContain('delete');
    expect(db.state()).toMatchObject({
      status: 'error',
      completedAt: before,
      lastError: 'HTTP 429',
    });
  });
  test.each([
    ['missing source identity', { ...row, sub_id: undefined }],
    ['changed response scope', { ...row, filing_form: undefined }],
    ['malformed amount', { ...row, disbursement_amount: undefined }],
  ])('fails safely for %s', async (_, invalidRow) => {
    const db = database();
    await expect(
      syncPacCycle(db.db, source([page([invalidRow as ScheduleBRow])]).fetcher, 'C00100321', 2026),
    ).rejects.toThrow();
    expect(db.events).not.toContain('delete');
    expect(db.state().status).toBe('error');
  });
  test('rejects repeated source rows rather than inflating totals', async () => {
    const db = database();
    await expect(
      syncPacCycle(db.db, source([page([row, row])]).fetcher, 'C00100321', 2026),
    ).rejects.toThrow(/repeated/);
    expect(db.events).not.toContain('delete');
  });
  test.each(['complete', 'error'])(
    'superseded run cannot overwrite a newer snapshot when its fetch ends with %s',
    async (outcome) => {
      const db = database();
      let release!: (page: FecPage<ScheduleBRow>) => void;
      let reject!: (error: Error) => void;
      let requested!: () => void;
      const firstRequest = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const oldFetch = (async () => {
        requested();
        return new Promise<FecPage<ScheduleBRow>>((resolve, fail) => {
          release = resolve;
          reject = fail;
        });
      }) as FecFetcher;
      const old = syncPacCycle(db.db, oldFetch, 'C00100321', 2026);
      await firstRequest;
      await syncPacCycle(db.db, source([page([row]), { results: [] }]).fetcher, 'C00100321', 2026);
      const newerState = { ...db.state() };
      if (outcome === 'complete') release({ results: [] });
      else reject(new Error('older request failed'));
      await expect(old).rejects.toThrow(outcome === 'complete' ? /superseded/ : /older request/);
      expect(db.snapshot()).toHaveLength(1);
      expect(db.snapshot()[0].sourceSubId).toBe(row.sub_id);
      expect(db.state()).toEqual(newerState);
    },
  );
});

test('PAC catalog types match discovery and cycles grow with the current election cycle', () => {
  expect(FEC_PAC_COMMITTEE_TYPES).toEqual(['Q', 'N', 'O', 'V', 'W']);
  expect(fecCycles(new Date('2026-09-09Z'))).toEqual([2022, 2024, 2026]);
  expect(fecCycles(new Date('2027-01-01Z'))).toEqual([2022, 2024, 2026, 2028]);
});
