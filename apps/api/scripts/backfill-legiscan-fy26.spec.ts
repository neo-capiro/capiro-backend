import { getSessionList } from '../src/external/legiscan/legiscan.client.js';
import {
  normalizeLegiscanBill,
  upsertNormalizedStateBill,
} from '../src/ingestion/legiscan-normalize.js';

let backfillState: typeof import('./backfill-legiscan-datasets.js').backfillState;
const fixtureEnv = {
  LEGISCAN_API_KEY: 'synthetic-fy26-dataset-fixture',
  LEGISCAN_STATES: 'TX',
  LEGISCAN_SESSIONS: 'all',
  LEGISCAN_SESSION_IDS: '',
  LEGISCAN_DATASET_DRY_RUN: 'false',
};
const previousEnv = Object.fromEntries(
  Object.keys(fixtureEnv).map((key) => [key, process.env[key]]),
);
let fetchSpy: jest.SpyInstance;
beforeAll(async () => {
  Object.assign(process.env, fixtureEnv);
  fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(Error('UNEXPECTED_NETWORK_IN_FIXTURE'));
  // The job captures configuration during import; supply only synthetic values
  // before loading it, independent of the developer's provider configuration.
  ({ backfillState } = await import('./backfill-legiscan-datasets.js'));
});
afterAll(() => {
  fetchSpy.mockRestore();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

jest.mock('../src/external/legiscan/legiscan.client.js', () => ({
  getSessionList: jest.fn(async () => [
    { session_id: 1, year_start: 2025, year_end: 2026, special: 0 },
  ]),
  getDatasetList: jest.fn(async () => [{ session_id: 1, access_key: 'synthetic' }]),
  getDataset: jest.fn(async () => ({ zip: Buffer.from('synthetic archive').toString('base64') })),
}));
jest.mock('../src/external/legiscan/legiscan-dataset.util.js', () => ({
  parseDatasetZip: jest.fn(async () => ({
    bills: [
      {
        bill_id: 42,
        state: 'TX',
        session: { session_id: 1 },
        change_hash: 'unconsumed-v2',
        history: [{ date: '2025-09-30' }],
      },
    ],
    people: [],
    votes: [],
    skipped: { bills: 0, people: 0, votes: 0 },
  })),
}));
jest.mock('../src/ingestion/legiscan-normalize.js', () => ({
  normalizeLegiscanBill: jest.fn(),
  upsertNormalizedStateBill: jest.fn(),
  upsertStateSession: jest.fn(),
  upsertStateRollCallVote: jest.fn(),
  crosswalkStateBill: jest.fn(),
  crosswalkLegiscanPerson: jest.fn(),
  backfillStateBillLinkTargets: jest.fn(),
}));

it.each([true, false])(
  'does not adopt excluded parent hashes in a dataset cursor (existing=%p)',
  async (existing) => {
    const db: any = {
      $transaction: jest.fn(async (run) => run(db)),
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT cursor_jsonb AS cursor')) return []; // No capacity hold.
        if (
          sql.includes('INSERT INTO federal_evidence_checkpoint') ||
          sql.includes('SELECT source')
        )
          return [{ source: 'state-bills:TX' }]; // The actual shared writer acquires/fences.
        throw Error('UNEXPECTED_CHECKPOINT_QUERY');
      }),
      $executeRawUnsafe: jest.fn(async () => 1),
      stateSyncCursor: {
        findUnique: jest.fn(async () =>
          existing
            ? { quotaMonth: '2026-11', pendingBills: [42], billHashes: { '42': 'consumed-v1' } }
            : null,
        ),
        update: jest.fn(),
        create: jest.fn(),
      },
    };
    const counts = await backfillState(db, 'TX', 2026);
    expect(getSessionList).toHaveBeenCalledWith(fixtureEnv.LEGISCAN_API_KEY, 'TX');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      db.$queryRawUnsafe.mock.calls.some(([sql]: [string]) =>
        sql.includes('SELECT cursor_jsonb AS cursor'),
      ),
    ).toBe(true);
    expect(counts).toMatchObject({ bills: 0, errors: 0 });
    expect(normalizeLegiscanBill).not.toHaveBeenCalled();
    expect(upsertNormalizedStateBill).not.toHaveBeenCalled();
    if (existing) {
      expect(db.stateSyncCursor.update.mock.calls[0][0].data).toMatchObject({
        billHashes: { '42': 'consumed-v1' },
        pendingBills: [42],
      });
    } else {
      expect(db.stateSyncCursor.create.mock.calls[0][0].data.billHashes).toEqual({});
    }
  },
);
