import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import {
  inspectFrozenStateDataset,
  importFrozenStateDataset,
} from './legiscan-historical-research.js';
import { upsertNormalizedStateBill, upsertStateRollCallVote } from './legiscan-normalize.js';
import { persistPublishedRecords } from './legiscan-published-records.js';
import { queueBillDocumentChecks } from './bill-document-queue.js';
import { withStateBillWriter } from './state-bill-writer.js';
import {
  getDataset,
  getDatasetList,
  getSessionList,
} from '../external/legiscan/legiscan.client.js';

jest.mock('./state-bill-writer.js', () => ({
  withStateBillWriter: jest.fn((_db: any, _states: any, run: any) => run(_db)),
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
function database(existing: Record<string, any> = {}, initialPending: number[] = []) {
  let checkpoint: any = null;
  const events: string[] = [];
  let checks = new Map<
    string,
    { billKey: string; state: string; attempts: number; providerHash: string }
  >();
  let pending = [...initialPending];
  let transactionId = 0,
    activeTransaction = 0;
  const writes: Array<{ sql: string; args: any[]; transaction: number }> = [];
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
      writes.push({ sql: text, args, transaction: activeTransaction });
      if (text.startsWith('INSERT INTO state_bill_record_check') && !checks.has(args[1]))
        checks.set(args[1], {
          billKey: args[0],
          state: 'partial',
          attempts: 1,
          providerHash: args[2],
        });
      if (
        text.startsWith('UPDATE state_sync_cursor SET pending_bills') &&
        !pending.includes(args[0])
      )
        pending.push(args[0]);
      if (text.startsWith('INSERT INTO federal_evidence_checkpoint') && !checkpoint)
        checkpoint = JSON.parse(args[1]);
      if (text.startsWith('UPDATE federal_evidence_checkpoint')) checkpoint = JSON.parse(args[0]);
      return 1;
    }),
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...args: any[]) => {
      const text = sql.join('');
      if (text.includes('SELECT count(*)::integer AS count FROM state_bill_record_check'))
        return [{ count: [...checks.values()].filter((c) => c.state === 'partial').length }];
      return text.includes('legal_source_receipt')
        ? [{ id: args[0] }]
        : [{ cursor: { ...checkpoint } }];
    }),
    $queryRawUnsafe: jest.fn(async () => [{ source: 'state-bills:TX' }]),
    $executeRawUnsafe: jest.fn(async () => 1),
  };
  db.$transaction = jest.fn(async (fn: any) => {
    const before = checkpoint && { ...checkpoint },
      beforeChecks = new Map(checks),
      beforePending = [...pending];
    const parentTransaction = activeTransaction;
    activeTransaction = ++transactionId;
    try {
      return await fn(db);
    } catch (error) {
      checkpoint = before;
      checks = beforeChecks;
      pending = beforePending;
      throw error;
    } finally {
      activeTransaction = parentTransaction;
    }
  });
  return {
    db,
    events,
    writes,
    progress: () => checkpoint,
    checks: () => checks,
    pending: () => pending,
  };
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
it('refuses conflicting retained receipt/archive before parent work', async () => {
  const f = await fixture([bill(1)]),
    { db } = database();
  db.$queryRaw.mockResolvedValue([]);
  await expect(importFrozenStateDataset(db, f.archive, f.scope, { limit: 1 })).rejects.toThrow(
    'RECEIPT_CONFLICT',
  );
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
it('uses canonical completed checkpoint status for empty and fully processed scopes', async () => {
  for (const admitted of [false, true]) {
    const f = await fixture([bill(1, admitted ? {} : { history: [] })]),
      { db } = database();
    expect(await importFrozenStateDataset(db, f.archive, f.scope, { limit: 1 })).toMatchObject({
      scanComplete: true,
    });
    const calls = db.$executeRaw.mock.calls.filter((call: any) =>
      call[0].join('').includes('federal_evidence_checkpoint'),
    );
    expect(calls.at(-1).slice(1)).toContain('completed');
    expect(calls.flatMap((call: any) => call.slice(1))).not.toContain('complete');
  }
});
it('seeds a missing hash from the current same-provider parent, never the stale archive hash', async () => {
  const f = await fixture([bill(1)]),
    current = 'e'.repeat(32),
    { db } = database({ 'tx-2025-hb1': { legiscanBillId: 1, legiscanChangeHash: current } });
  await importFrozenStateDataset(db, f.archive, f.scope, { limit: 1 });
  const update = db.$executeRaw.mock.calls.find((call: any) =>
    call[0].join('').includes('UPDATE state_sync_cursor'),
  );
  expect(update.slice(1)).toContain(current);
  expect(update.slice(1)).not.toContain('a'.repeat(32));
  expect(upsertNormalizedStateBill).not.toHaveBeenCalled();
});
it('honors the refresh slice deadline before metadata writes and refuses limits above1000', async () => {
  const f = await fixture([bill(1)]),
    { db } = database();
  await expect(importFrozenStateDataset(db, f.archive, f.scope, { limit: 1001 })).rejects.toThrow(
    'LIMIT',
  );
  await expect(
    importFrozenStateDataset(db, f.archive, f.scope, { limit: 1000, deadline: Date.now() - 1 }),
  ).rejects.toThrow();
  expect(upsertNormalizedStateBill).not.toHaveBeenCalled();
});

const rollCall = (id: number, parent: number, invalid = false) => ({
  roll_call_id: id,
  bill_id: parent,
  date: '2026-02-01',
  chamber: 'H',
  desc: 'Synthetic roll call',
  yea: 1,
  nay: 0,
  nv: 0,
  absent: 0,
  total: invalid ? 2 : 1,
  votes: [{ people_id: 1, vote_text: 'Yea' }],
});

it('commits valid metadata and sibling votes, records exact partial checks, and resumes without duplicate attempts', async () => {
  const f = await fixture(
    [bill(1, { votes: [{ roll_call_id: 9 }, { roll_call_id: 10 }] }), bill(2)],
    [rollCall(9, 1, true), rollCall(10, 1)],
  );
  const h = database({}, [99, 1]);
  expect(await importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 })).toMatchObject({
    offset: 1,
    imported: 1,
    voteImportFailures: 1,
    partialVoteImportBills: 1,
    scanComplete: false,
    parentMetadataComplete: false,
    metadataComplete: false,
    unresolvedVoteChecks: 1,
  });
  expect(h.checks().get('tx-rc-9')).toEqual({
    billKey: 'tx-2025-hb1',
    state: 'partial',
    attempts: 1,
    providerHash: 'a'.repeat(32),
  });
  expect(h.pending()).toEqual([99, 1]);
  expect(upsertNormalizedStateBill).toHaveBeenCalledTimes(1);
  expect(persistPublishedRecords).toHaveBeenCalledTimes(1);
  expect(queueBillDocumentChecks).toHaveBeenCalledTimes(1);
  expect(upsertStateRollCallVote).toHaveBeenCalledTimes(1);
  expect(upsertStateRollCallVote).toHaveBeenCalledWith(
    h.db,
    'TX',
    'tx-2025-hb1',
    expect.objectContaining({ roll_call_id: 10 }),
    expect.objectContaining({ historical: true, providerBillId: 1 }),
  );
  expect(h.db.stateBill.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ sourceCheckStatus: 'partial', sourceCheckedAt: null }),
    }),
  );
  expect(h.writes.some((w) => w.sql.includes('SET bill_hashes'))).toBe(false);
  expect(await importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 })).toMatchObject({
    offset: 2,
    imported: 2,
    scanComplete: true,
    parentMetadataComplete: true,
    metadataComplete: false,
    voteImportPartial: true,
    unresolvedVoteChecks: 1,
  });
  expect(await importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 })).toMatchObject({
    processed: 0,
    voteImportFailures: 1,
    unresolvedVoteChecks: 1,
  });
  expect(h.checks().get('tx-rc-9')?.attempts).toBe(1);
  expect(upsertNormalizedStateBill).toHaveBeenCalledTimes(2);
  // The canonical live vote writer resolves the existing partial check after a complete retry.
  h.checks().get('tx-rc-9')!.state = 'available';
  expect(await importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 })).toMatchObject({
    processed: 0,
    metadataComplete: true,
    parentMetadataComplete: true,
    voteImportPartial: true,
    voteImportFailures: 1,
    unresolvedVoteChecks: 0,
  });
});

it('does not turn a vote database/lease error into a partial import or advance the checkpoint', async () => {
  const f = await fixture(
      [bill(1, { votes: [{ roll_call_id: 9 }, { roll_call_id: 10 }] })],
      [rollCall(9, 1, true), rollCall(10, 1)],
    ),
    h = database({}, [99]);
  jest.mocked(upsertStateRollCallVote).mockRejectedValueOnce(Error('STATE_WRITER_LEASE_LOST'));
  await expect(importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 })).rejects.toThrow(
    'STATE_WRITER_LEASE_LOST',
  );
  expect(h.progress().offset).toBe(0);
  expect(h.checks().size).toBe(0);
  expect(h.pending()).toEqual([99]);
  expect(await importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 })).toMatchObject({
    offset: 1,
    imported: 1,
    partialVoteImportBills: 1,
    voteImportFailures: 1,
  });
  expect(h.pending()).toEqual([99, 1]);
  expect(h.checks().get('tx-rc-9')?.attempts).toBe(1);
});

it('keeps partial checks, retry admission and parent checkpoint inside the real writer fence', async () => {
  jest
    .mocked(withStateBillWriter)
    .mockImplementationOnce(jest.requireActual('./state-bill-writer.js').withStateBillWriter);
  const f = await fixture([bill(1, { votes: [{ roll_call_id: 9 }] })], [rollCall(9, 1, true)]),
    h = database();
  await importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 });
  const partial = h.writes.find((w) => w.sql.startsWith('INSERT INTO state_bill_record_check'))!;
  const pending = h.writes.find((w) =>
    w.sql.startsWith('UPDATE state_sync_cursor SET pending_bills'),
  )!;
  const checkpoint = h.writes.find((w) => w.sql.startsWith('UPDATE federal_evidence_checkpoint'))!;
  expect(partial.transaction).toBeGreaterThan(0);
  expect(pending.transaction).toBe(partial.transaction);
  expect(checkpoint.transaction).toBe(partial.transaction);
  expect(
    h.db.$queryRawUnsafe.mock.calls.some((call: any[]) => call[0].includes('FOR UPDATE')),
  ).toBe(true);
});

it('retains old checkpoint compatibility and refuses a lost state lease before partial writes', async () => {
  const f = await fixture([bill(1)]),
    h = database();
  await importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 });
  delete h.progress().voteImportFailures;
  delete h.progress().partialVoteImportBills;
  expect(await importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 })).toMatchObject({
    processed: 0,
    voteImportFailures: 0,
    metadataComplete: true,
  });
  jest
    .mocked(withStateBillWriter)
    .mockImplementationOnce(jest.requireActual('./state-bill-writer.js').withStateBillWriter);
  h.db.$queryRawUnsafe.mockResolvedValueOnce([]);
  await expect(importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 })).rejects.toThrow(
    'STATE_WRITER_ALREADY_RUNNING',
  );
});

it('counts inconsistent vote details separately from partial parent imports', async () => {
  const f = await fixture(
      [bill(1, { votes: [{ roll_call_id: 9 }, { roll_call_id: 10 }] })],
      [rollCall(9, 1, true), rollCall(10, 1, true)],
    ),
    h = database();
  expect(await importFrozenStateDataset(h.db, f.archive, f.scope, { limit: 1 })).toMatchObject({
    imported: 1,
    partialVoteImportBills: 1,
    voteImportFailures: 2,
    unresolvedVoteChecks: 2,
    parentMetadataComplete: true,
    metadataComplete: false,
    scanComplete: true,
  });
  expect(h.pending()).toEqual([1]);
  expect(upsertStateRollCallVote).not.toHaveBeenCalled();
});
