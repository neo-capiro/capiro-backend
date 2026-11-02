import JSZip from 'jszip';
import {
  newStateDatasetCycle,
  nextStateDatasetSlice,
  refreshedDiscoveryBytes,
  refreshStateDatasetSlice,
  type StateDatasetCycle,
} from './state-dataset-refresh.js';
import { ALL_US_STATE_CODES } from '../external/legiscan/us-states.js';
import {
  getSessionList,
  getDatasetList,
  getDataset,
} from '../external/legiscan/legiscan.client.js';
import { loadPinnedStateInventory } from './state-bill-inventory-read.js';
import { reservedLegiscanQuery } from './legiscan-query-reservation.js';
import { importFrozenStateDataset } from './legiscan-historical-research.js';
import { retainStateDiscovery } from './state-discovery-inventory.js';
import { withStateBillWriter } from './state-bill-writer.js';
jest.mock('../external/legiscan/legiscan.client.js', () => ({
  getSessionList: jest.fn(),
  getDatasetList: jest.fn(),
  getDataset: jest.fn(),
}));
jest.mock('./state-bill-inventory-read.js', () => ({ loadPinnedStateInventory: jest.fn() }));
jest.mock('./legiscan-query-reservation.js', () => ({ reservedLegiscanQuery: jest.fn() }));
jest.mock('./legiscan-historical-research.js', () => ({ importFrozenStateDataset: jest.fn() }));
jest.mock('./state-discovery-inventory.js', () => ({
  retainStateDiscovery: jest.fn(async () => ({ receiptId: 'new-global' })),
}));
jest.mock('./state-bill-writer.js', () => ({
  withStateBillWriter: jest.fn((db, _states, run) => run(db)),
}));
const sha = 'a'.repeat(40),
  session = {
    session_id: 1,
    year_start: 2025,
    year_end: 2026,
    session_name: 'Regular',
    special: 0 as const,
    prior: 0 as const,
  };
let zip: Buffer;
function database(initial: StateDatasetCycle | null = null, ageDays = 8) {
  let cursor = initial,
    status = initial ? 'running' : 'idle';
  const db: any = {
    stateSyncCursor: { findFirst: jest.fn(async () => ({ id: 'AL-1' })) },
    $queryRaw: jest.fn(async () => [{ bytes: zip.toString('base64') }]),
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT cursor_jsonb')) return cursor ? [{ cursor, status }] : [];
      if (sql.includes('SELECT observed_at'))
        return [{ observedAt: new Date(Date.now() - ageDays * 86400000) }];
      if (sql.includes('INSERT INTO federal_evidence_checkpoint')) return [{ cursor, status }];
      throw Error('unexpected SQL');
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: any[]) => {
      if (sql.includes('cursor_jsonb=$3')) {
        cursor = JSON.parse(args[2]);
        status = args[3];
      }
      return 1;
    }),
  };
  return { db, cursor: () => cursor, status: () => status };
}
beforeAll(async () => {
  const z = new JSZip();
  z.file('AL/bill/1.json', '{"bill":{"bill_id":1}}');
  zip = await z.generateAsync({ type: 'nodebuffer' });
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadPinnedStateInventory).mockResolvedValue({
    discovery: {
      receiptId: 'old-global',
      manifestSha256: 'c'.repeat(64),
      states: ALL_US_STATE_CODES.map((state) => ({
        state,
        sessions:
          state === 'AL' ? [{ sessionId: 1, archiveHash: 'b'.repeat(64), expectedBills: 1 }] : [],
      })),
    },
    sessions: [],
    qualifiedReceiptIds: [],
    inventories: ALL_US_STATE_CODES.map((jurisdiction) => ({
      jurisdiction,
      known: true,
      expectedSessions: 0,
      qualifiedSessions: 0,
      missingSessions: [],
    })),
  });
  jest.mocked(reservedLegiscanQuery).mockImplementation(async (_db, _scope, call) => ({
    value: await call(() => {}),
    attempts: 1,
  }));
  jest.mocked(getSessionList).mockResolvedValue([session]);
  jest
    .mocked(getDatasetList)
    .mockResolvedValue([{ session_id: 1, dataset_hash: 'd'.repeat(32), access_key: 'synthetic' }]);
  jest.mocked(getDataset).mockResolvedValue({
    session_id: 1,
    dataset_hash: 'd'.repeat(32),
    zip: zip.toString('base64'),
  });
  jest
    .mocked(importFrozenStateDataset)
    .mockResolvedValue({ processed: 1000, scanComplete: false, metadataComplete: false } as any);
});
it('does not start a new cycle until seven days after completed global receipt, and requires complete pinned discovery', async () => {
  expect(await refreshStateDatasetSlice(database(null, 6).db, 'synthetic', sha)).toMatchObject({
    status: 'not_due',
    providerCalls: 0,
  });
  jest
    .mocked(loadPinnedStateInventory)
    .mockResolvedValue({ discovery: null, sessions: [], inventories: [], qualifiedReceiptIds: [] });
  expect(await refreshStateDatasetSlice(database().db, 'synthetic', sha)).toMatchObject({
    status: 'held',
  });
  expect(getSessionList).not.toHaveBeenCalled();
  expect(getDataset).not.toHaveBeenCalled();
});
it('processes one state discovery, one retained session, then bounded resumable metadata on separate invocations', async () => {
  const { db, cursor } = database();
  expect(await refreshStateDatasetSlice(db, 'synthetic', sha)).toMatchObject({
    phase: 'state_discovery',
    state: 'AL',
    providerCalls: 1,
  });
  expect(getSessionList).toHaveBeenCalledWith(
    'synthetic',
    'AL',
    { maxAttempts: 1, timeoutMs: 60000 },
    expect.any(Function),
    true,
  );
  expect(await refreshStateDatasetSlice(db, 'synthetic', sha)).toMatchObject({
    phase: 'archive_retained',
    state: 'AL',
    providerCalls: 2,
  });
  expect(importFrozenStateDataset).toHaveBeenLastCalledWith(
    db,
    expect.any(Buffer),
    expect.objectContaining({ state: 'AL', sessionId: 1, expectedBills: 1 }),
    expect.objectContaining({ inventoryOnly: true }),
  );
  expect(await refreshStateDatasetSlice(db, 'synthetic', sha)).toMatchObject({
    phase: 'metadata',
    processed: 1000,
    providerCalls: 0,
    sessionScanComplete: false,
  });
  const options = jest.mocked(importFrozenStateDataset).mock.calls.at(-1)![3];
  expect(options.limit).toBe(1000);
  expect(options.deadline! - Date.now()).toBeLessThanOrEqual(600000);
  expect(cursor()!.states[0]!.complete).toBe(false);
  expect(withStateBillWriter).toHaveBeenCalledTimes(3);
  expect(
    jest
      .mocked(withStateBillWriter)
      .mock.calls.every((call) => JSON.stringify(call[1]) === '["AL"]'),
  ).toBe(true);
  expect(retainStateDiscovery).not.toHaveBeenCalled();
});
it('retains prior global discovery on missing historical session, quota hold or mismatched archive', async () => {
  jest.mocked(getSessionList).mockResolvedValue([]);
  expect(await refreshStateDatasetSlice(database().db, 'synthetic', sha)).toMatchObject({
    status: 'failed',
    reason: 'DATASET_REFRESH_KNOWN_SESSION_DISAPPEARED',
  });
  jest.mocked(reservedLegiscanQuery).mockRejectedValue(Error('EXISTING_PROVIDER_BUDGET_HOLD'));
  expect(await refreshStateDatasetSlice(database().db, 'synthetic', sha)).toMatchObject({
    status: 'held',
    providerCalls: 0,
  });
  expect(retainStateDiscovery).not.toHaveBeenCalled();
});
it.each([
  { year_start: undefined },
  { year_end: undefined },
  { year_start: '2025' },
  { year_end: 'unknown' },
  { year_start: 2027, year_end: 2025 },
  { year_start: 2019, year_end: 2020, special: undefined },
  { session_id: 0, year_start: 2019, year_end: 2020 },
  { session_id: 1, year_start: 2019, year_end: 2020 },
])('rejects an unresolved new source session before overlap filtering: %j', async (invalid) => {
  // The valid previously pinned session is still present, so only full-list
  // validation can prevent the malformed new entry from being silently lost.
  jest
    .mocked(getSessionList)
    .mockResolvedValue([session, { ...session, session_id: 2, ...invalid }] as any);
  const { db, cursor } = database();
  expect(await refreshStateDatasetSlice(db, 'synthetic', sha)).toMatchObject({
    status: 'failed',
    reason: 'DATASET_REFRESH_SESSION_LIST_INVALID',
  });
  expect(cursor()!.states[0]).toMatchObject({ complete: false, sessions: null });
  expect(retainStateDiscovery).not.toHaveBeenCalled();
  expect(getDataset).not.toHaveBeenCalled();
});
it('publishes a replacement only after every state/session archive is qualified and marks canonical completed status', async () => {
  const cycle = newStateDatasetCycle(sha);
  cycle.states.forEach((state) => {
    state.complete = true;
    state.sessions = [];
  });
  cycle.states[0]!.sessions = [
    { session, done: true, archiveHash: 'b'.repeat(64), archiveBytes: 123, bills: 2 },
  ];
  expect(nextStateDatasetSlice(cycle)).toBeNull();
  expect(JSON.parse(refreshedDiscoveryBytes(cycle).toString()).states).toHaveLength(51);
  const { db, status } = database(cycle);
  expect(await refreshStateDatasetSlice(db, 'synthetic', sha)).toMatchObject({
    status: 'completed',
    providerCalls: 0,
  });
  expect(retainStateDiscovery).toHaveBeenCalledTimes(1);
  expect(status()).toBe('completed');
  cycle.states[1]!.complete = false;
  expect(() => refreshedDiscoveryBytes(cycle)).toThrow('CYCLE_INCOMPLETE');
});
it('losing cycle claim cannot call providers or change source inventory', async () => {
  const { db } = database(newStateDatasetCycle(sha));
  db.$queryRawUnsafe.mockImplementation(async (sql: string) =>
    sql.includes('INSERT') ? [] : [{ cursor: newStateDatasetCycle(sha), status: 'running' }],
  );
  expect(await refreshStateDatasetSlice(db, 'synthetic', sha)).toMatchObject({
    status: 'held',
    reason: 'DATASET_REFRESH_ALREADY_RUNNING',
  });
  expect(getSessionList).not.toHaveBeenCalled();
  expect(retainStateDiscovery).not.toHaveBeenCalled();
});
