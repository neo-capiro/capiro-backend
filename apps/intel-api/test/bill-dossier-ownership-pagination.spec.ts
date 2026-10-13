import { deferred, harness, installHooks } from './fixtures/bill-dossier-ownership/harness.js';
import { stateId } from './fixtures/bill-dossier-ownership/rows.js';

installHooks();

it('awaits real state existence before validating section or cursor', async () => {
  const existence = deferred<unknown>();
  const h = harness({ results: { getStateBillById: existence.promise } });
  const pending = h.service.getSourceRecords(stateId, 'bad-section', 'bad-cursor');
  expect(h.calls.map((call) => call.operation)).toEqual(['getStateBillById']);
  existence.resolve(null);
  await expect(pending).rejects.toThrow('STATE_BILL_NOT_FOUND');
  expect(h.callsOf('getRecordPage')).toHaveLength(0);
});

it('rejects non-state record keys before any repository call', async () => {
  const h = harness();
  await expect(h.service.getSourceRecords('119-hr-1', 'history')).rejects.toThrow(
    'STATE_BILL_NOT_FOUND',
  );
  expect(h.calls).toEqual([]);
});

it('validates the section before parsing a malformed cursor after confirmed existence', async () => {
  const h = harness();
  await expect(h.service.getSourceRecords(stateId, 'bad-section', 'bad-cursor')).rejects.toThrow(
    'INVALID_RECORD_SECTION',
  );
  expect(h.calls.map((call) => call.operation)).toEqual(['getStateBillById']);
});

it.each(['history', 'documents', 'votes'])(
  'starts %s records at offset zero and preserves the returned rows by reference',
  async (section) => {
    const rows = [{ id: 'row-one', metadata: { source: 'official' } }];
    const h = harness({ results: { getRecordPage: { rows, total: 3 } } });
    const result = await h.service.getSourceRecords(stateId, section);
    expect(h.callsOf('getRecordPage')[0]!.args).toEqual([stateId, section, 0]);
    expect(result.rows).toBe(rows);
    expect(result.total).toBe(3);
    expect(result.availability).toBe('available');
    expect(result.reason).toBeNull();
    expect(result.coverage).toBe(
      'Provider metadata and original source links; retained document text is available through Research',
    );
    expect(JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString())).toEqual({
      billId: stateId,
      section,
      offset: 1,
    });
  },
);

it('uses the bound cursor offset and returned count to advance rather than imposing a local page size', async () => {
  const cursor = Buffer.from(
    JSON.stringify({ billId: stateId, section: 'votes', offset: 50 }),
  ).toString('base64url');
  const h = harness({ results: { getRecordPage: { rows: [{ id: 1 }, { id: 2 }], total: 55 } } });
  const result = await h.service.getSourceRecords(stateId, 'votes', cursor);
  expect(h.callsOf('getRecordPage')[0]!.args).toEqual([stateId, 'votes', 50]);
  expect(JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString()).offset).toBe(52);
});

it.each([
  { billId: 'fl-2026-hb200', section: 'history', offset: 0 },
  { billId: stateId, section: 'votes', offset: 0 },
  { billId: stateId, section: 'history', offset: -1 },
  { billId: stateId, section: 'history', offset: 0.5 },
  { billId: stateId, section: 'history', offset: '1' },
  { billId: stateId, section: 'history', offset: Number.MAX_SAFE_INTEGER + 1 },
])('rejects a noncanonical record cursor %j without page I/O', async (data) => {
  const h = harness();
  const cursor = Buffer.from(JSON.stringify(data)).toString('base64url');
  await expect(h.service.getSourceRecords(stateId, 'history', cursor)).rejects.toThrow(
    'INVALID_RECORD_CURSOR',
  );
  expect(h.calls.map((call) => call.operation)).toEqual(['getStateBillById']);
});

it('reports availability from total even when a cursor beyond the end returns no rows', async () => {
  const h = harness({ results: { getRecordPage: { rows: [], total: 5 } } });
  const cursor = Buffer.from(
    JSON.stringify({ billId: stateId, section: 'history', offset: 20 }),
  ).toString('base64url');
  const result = await h.service.getSourceRecords(stateId, 'history', cursor);
  expect(result).toMatchObject({
    rows: [],
    total: 5,
    nextCursor: null,
    availability: 'available',
    reason: null,
  });
  expect(h.callsOf('getRecordPage')[0]!.args).toEqual([stateId, 'history', 20]);
});

it('returns explicit unavailable coverage and no cursor for a zero-total record page', async () => {
  const h = harness();
  expect(await h.service.getSourceRecords(stateId, 'documents', '')).toMatchObject({
    rows: [],
    total: 0,
    nextCursor: null,
    availability: 'unavailable',
    reason: 'No records have been ingested for this section',
  });
});

it.each(['getStateBillById', 'getRecordPage'] as const)(
  'propagates %s record I/O failures unchanged',
  async (operation) => {
    const error = new Error('source unavailable');
    const h = harness({ errors: { [operation]: error } });
    await expect(h.service.getSourceRecords(stateId, 'history')).rejects.toBe(error);
  },
);

it('passes state vote-member arguments directly without an added existence read', async () => {
  const rows = [{ providerPersonId: 1, voteCast: 'Yea' }];
  const h = harness({ results: { getVoteMembers: rows } });
  expect(await h.service.getStateVoteMembers(stateId, 'vote-one')).toBe(rows);
  expect(h.calls).toEqual([
    { operation: 'getVoteMembers', scope: 'global-state', args: [stateId, 'vote-one'] },
  ]);
});
