import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import {
  inspectFrozenStateDataset,
  importFrozenStateDataset,
} from './legiscan-historical-research.js';
import { upsertNormalizedStateBill, upsertStateRollCallVote } from './legiscan-normalize.js';
import { persistPublishedRecords } from './legiscan-published-records.js';
import { queueBillDocumentChecks } from './bill-document-queue.js';
import {
  getDataset,
  getDatasetList,
  getSessionList,
} from '../external/legiscan/legiscan.client.js';

jest.mock('./state-bill-writer.js', () => ({
  withStateBillWriter: (_db: any, _states: any, run: any) => run(_db),
}));
jest.mock('./legiscan-normalize.js', () => ({
  ...jest.requireActual('./legiscan-normalize.js'),
  upsertNormalizedStateBill: jest.fn(),
  upsertStateRollCallVote: jest.fn(),
  upsertStateSession: jest.fn(),
}));
jest.mock('./legiscan-published-records.js', () => ({ persistPublishedRecords: jest.fn() }));
jest.mock('./bill-document-queue.js', () => ({ queueBillDocumentChecks: jest.fn() }));
jest.mock('../external/legiscan/legiscan.client.js', () => ({
  getDataset: jest.fn(),
  getDatasetList: jest.fn(),
  getSessionList: jest.fn(),
}));
const bill = (id: number, overrides: any = {}) => ({
  state: 'TX',
  bill_id: id,
  bill_number: `HB${id}`,
  change_hash: 'a'.repeat(32),
  title: 'Frozen title',
  status: 1,
  session: {
    session_id: 1,
    year_start: 2025,
    year_end: 2026,
    special: 0,
    prior: 0,
    session_name: 'Regular',
  },
  history: [{ date: '2025-10-01', action: 'Filed' }],
  progress: [],
  texts: [
    {
      doc_id: id,
      text_hash: 'b'.repeat(32),
      text_size: 4,
      mime: 'text/plain',
      state_link: 'https://capitol.texas.gov/a.txt',
      date: '2024-01-01',
    },
  ],
  amendments: [],
  supplements: [],
  votes: [],
  sponsors: [],
  ...overrides,
});
async function fixture(bills: any[], votes: any[] = []) {
  const zip = new JSZip();
  bills.forEach((b, i) => zip.file(`TX/bill/${i}.json`, JSON.stringify({ bill: b })));
  votes.forEach((v, i) => zip.file(`TX/vote/${i}.json`, JSON.stringify({ roll_call: v })));
  const archive = await zip.generateAsync({ type: 'nodebuffer' });
  return {
    archive,
    scope: {
      state: 'TX',
      sessionId: 1,
      expectedBills: bills.length,
      archiveHash: createHash('sha256').update(archive).digest('hex'),
    },
  };
}
function database(existing: Record<string, any> = {}) {
  let checkpoint: any = null;
  const events: string[] = [];
  const db: any = {
    stateSession: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ state: 'TX', legiscanSessionId: 1, sessionKey: '2025' }),
    },
    stateSyncCursor: { upsert: jest.fn() },
    stateBill: {
      findUnique: jest.fn(({ where }: any) => existing[where.id] ?? null),
      update: jest.fn(),
    },
    stateBillVersion: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...args: any[]) => {
      const text = sql.join('?');
      events.push(text);
      if (text.startsWith('INSERT INTO federal_evidence_checkpoint') && !checkpoint)
        checkpoint = JSON.parse(args[1]);
      if (text.startsWith('UPDATE federal_evidence_checkpoint')) checkpoint = JSON.parse(args[0]);
      return 1;
    }),
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...args: any[]) =>
      sql.join('').includes('legal_source_receipt')
        ? [{ id: args[0] }]
        : [{ cursor: { ...checkpoint } }],
    ),
  };
  db.$transaction = jest.fn(async (fn: any) => {
    const before = checkpoint && { ...checkpoint };
    try {
      return await fn(db);
    } catch (error) {
      checkpoint = before;
      throw error;
    }
  });
  return { db, events, progress: () => checkpoint };
}
beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  expect(getDataset).not.toHaveBeenCalled();
  expect(getDatasetList).not.toHaveBeenCalled();
  expect(getSessionList).not.toHaveBeenCalled();
});

it('freezes only admitted parents but retains every dated version and full primary metadata', async () => {
  const { archive, scope } = await fixture([
    bill(1),
    bill(2, { history: [{ date: '2025-09-30', action: 'Filed' }] }),
  ]);
  const result = await inspectFrozenStateDataset(archive, scope);
  expect(result.manifest).toMatchObject({
    inspectedBills: 2,
    eligibleBills: 1,
    sourceListComplete: true,
  });
  expect(result.manifest.bills[0]!.documents[0]).toMatchObject({
    providerId: 1,
    providerHash: 'b'.repeat(32),
    size: 4,
    mime: 'text/plain',
    date: '2024-01-01',
  });
});
it('rejects wrong SHA, state, session, expected count, duplicates and malformed arrays before writes', async () => {
  const f = await fixture([bill(1)]);
  for (const change of [
    { archiveHash: '0'.repeat(64) },
    { state: 'CA' },
    { sessionId: 2 },
    { expectedBills: 2 },
  ])
    await expect(inspectFrozenStateDataset(f.archive, { ...f.scope, ...change })).rejects.toThrow();
  for (const rows of [[bill(1), bill(1)], [bill(1, { texts: null })]]) {
    const b = await fixture(rows);
    await expect(inspectFrozenStateDataset(b.archive, b.scope)).rejects.toThrow('IDENTITY');
  }
  // Reviewed largest inventory exceeds the old 20k historical cap. The bound
  // accepts 25,453 but still rejects a mismatched actual parent count.
  await expect(
    inspectFrozenStateDataset(f.archive, { ...f.scope, expectedBills: 25453 }),
  ).rejects.toThrow('INCOMPLETE');
  await expect(
    inspectFrozenStateDataset(f.archive, { ...f.scope, expectedBills: 50001 }),
  ).rejects.toThrow('SCOPE');
});
it('refuses absent or cross-parent vote details', async () => {
  for (const votes of [[], [{ roll_call_id: 9, bill_id: 2 }]]) {
    const f = await fixture([bill(1, { votes: [{ roll_call_id: 9 }] }), bill(2)], votes);
    await expect(inspectFrozenStateDataset(f.archive, f.scope)).rejects.toThrow('VOTE_COVERAGE');
  }
});
it('persists authoritative archive/inventory before any metadata and can stage only', async () => {
  const f = await fixture([bill(1)]),
    { db, events } = database();
  const result = await importFrozenStateDataset(db, f.archive, f.scope, {
    limit: 1,
    inventoryOnly: true,
  });
  expect(result).toMatchObject({
    inventoryBills: 1,
    processed: 0,
    providerCalls: 0,
    metadataComplete: false,
  });
  expect(events[0]).toContain('legal_dataset_archive');
  expect(events[1]).toContain('fy26-state-frozen-inventory');
  expect(upsertNormalizedStateBill).not.toHaveBeenCalled();
  expect(db.stateSyncCursor.upsert).not.toHaveBeenCalled();
});
it('refuses conflicting retained receipt/archive before parent work',async()=>{
  const f=await fixture([bill(1)]),{db}=database();
  db.$queryRaw.mockResolvedValue([]);
  await expect(importFrozenStateDataset(db,f.archive,f.scope,{limit:1})).rejects.toThrow('RECEIPT_CONFLICT');
  expect(upsertNormalizedStateBill).not.toHaveBeenCalled();
  expect(db.stateSyncCursor.upsert).not.toHaveBeenCalled();
});
it('preserves current canonical metadata while appending independently attributable frozen stubs', async () => {
  const f = await fixture([bill(1), bill(2), bill(3)]);
  const { db } = database({
    'tx-2025-hb1': { legiscanBillId: 1, legiscanChangeHash: 'new' },
    'tx-2025-hb2': { legiscanBillId: 999, legiscanChangeHash: 'new' },
    'tx-2025-hb3': { legiscanBillId: 3, legiscanChangeHash: 'a'.repeat(32) },
  });
  const result = await importFrozenStateDataset(db, f.archive, f.scope, { limit: 3 });
  expect(result).toMatchObject({
    held: 2,
    retained: 1,
    scanComplete: true,
    metadataComplete: false,
  });
  expect(upsertNormalizedStateBill).not.toHaveBeenCalled();
  expect(upsertStateRollCallVote).not.toHaveBeenCalled();
  expect(persistPublishedRecords).toHaveBeenCalledTimes(2);
  expect(persistPublishedRecords).toHaveBeenCalledWith(db, 'tx-2025-hb1', expect.anything(), {
    historical: true,
    preserveCurrentFacts: true,
  });
  expect(queueBillDocumentChecks).toHaveBeenCalledTimes(2);
  expect(db.stateBillVersion.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { legiscanDocId: 1 },
      create: expect.objectContaining({ billKey: 'tx-2025-hb1', legiscanDocId: 1 }),
      update: {},
    }),
  );
  expect(
    db.$executeRaw.mock.calls.filter((call: any) =>
      call[0].join('').includes('UPDATE state_sync_cursor'),
    ),
  ).toHaveLength(1);
});
it('resumes from atomically committed parent checkpoints and preserves pending cursor work', async () => {
  const f = await fixture([bill(1), bill(2)]),
    { db, progress } = database();
  expect(await importFrozenStateDataset(db, f.archive, f.scope, { limit: 1 })).toMatchObject({
    offset: 1,
    imported: 1,
    scanComplete: false,
  });
  expect(await importFrozenStateDataset(db, f.archive, f.scope, { limit: 1 })).toMatchObject({
    offset: 2,
    imported: 2,
    scanComplete: true,
  });
  expect(upsertNormalizedStateBill).toHaveBeenCalledTimes(2);
  expect(progress().offset).toBe(2);
  for (const call of db.$executeRaw.mock.calls) {
    expect(call[0].join('')).not.toContain('pending_bills');
    expect(call[0].join('')).not.toContain('last_list_at');
  }
  expect(
    db.$executeRaw.mock.calls.some((call: any) =>
      call[0].join('').includes("|| COALESCE(bill_hashes,'{}'::jsonb)"),
    ),
  ).toBe(true);
});
it('does not advance the durable cursor when a child write fails', async () => {
  const f = await fixture([bill(1)]),
    { db, progress } = database();
  jest.mocked(queueBillDocumentChecks).mockRejectedValueOnce(Error('synthetic child failure'));
  await expect(importFrozenStateDataset(db, f.archive, f.scope, { limit: 1 })).rejects.toThrow(
    'synthetic child failure',
  );
  expect(progress().offset).toBe(0);
  expect(await importFrozenStateDataset(db, f.archive, f.scope, { limit: 1 })).toMatchObject({
    offset: 1,
    imported: 1,
  });
});
it('uses canonical completed checkpoint status for empty and fully processed scopes',async()=>{
  for(const admitted of [false,true]){
    const f=await fixture([bill(1,admitted?{}:{history:[]})]),{db}=database();
    expect(await importFrozenStateDataset(db,f.archive,f.scope,{limit:1})).toMatchObject({scanComplete:true});
    const calls=db.$executeRaw.mock.calls.filter((call:any)=>call[0].join('').includes('federal_evidence_checkpoint'));
    expect(calls.at(-1).slice(1)).toContain('completed');
    expect(calls.flatMap((call:any)=>call.slice(1))).not.toContain('complete');
  }
});
