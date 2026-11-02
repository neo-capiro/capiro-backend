import { backfillState } from './backfill-legiscan-datasets.js';
import {
  normalizeLegiscanBill,
  upsertNormalizedStateBill,
} from '../src/ingestion/legiscan-normalize.js';

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
