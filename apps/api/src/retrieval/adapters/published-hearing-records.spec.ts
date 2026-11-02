import { createHash } from 'node:crypto';
import type { RetrievalRequest } from '../retrieval-v2.types.js';
import { retrievePublishedHearingRecords } from './published-hearing-records.js';
import { encodeHearingContentCursor, parseHearingContentCursor } from './hearing-content-chunks.js';

type View = 'published' | 'briefs' | 'reconciliation';
const at = '2026-10-01T00:00:00.000Z';
const text = 'Synthetic published hearing evidence. '.repeat(220);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const request = (view: View): RetrievalRequest => ({
  queryClass: 'lookup',
  requestedDomains: ['hearings'],
  pageSize: 1,
  caller: {
    tenantId: 'synthetic-tenant',
    userId: 'synthetic-user',
    clientIds: ['synthetic-client'],
    authorizedClientIds: ['synthetic-client'],
  },
  hearingFilters: { hearingId: 'synthetic-event', recordId: 'synthetic-record', recordsView: view },
});

/** Existing Intel owner packet shapes; source evidence is long enough to require JSON fragments. */
function ownerPacket(view: Exclude<View, 'published'>) {
  const records = [
    {
      id: 'synthetic-source',
      billId: null,
      kind: 'official_transcript',
      hash: 'a'.repeat(64),
      identity: 'govinfo:synthetic-package',
      date: '2026-10-01',
      observedAt: at,
      evidence: { text },
      association: 'explicit_event',
    },
  ];
  const common = {
    records,
    sourceHash: 'a'.repeat(64),
    claims: [],
    observation: null,
    cutoff: at,
    coverage: [],
  };
  if (view === 'briefs') {
    const payload = {
      ...common,
      schema: 'legiwatch.published-record-brief.v1',
      label: 'Brief based on published records',
      author: 'Capiro',
      title: 'Synthetic assessment',
      eventId: 'synthetic-event',
      runId: 'synthetic-run',
      clientId: 'synthetic-client',
      folders: [],
      selectedObservationIds: [],
      provenance: { promptVersion: 'published-record-brief-v1', clientContext: 'applied' },
    };
    return {
      kind: 'capiro_published_record_brief',
      id: 'synthetic-record',
      seriesId: 'synthetic-series',
      version: 1,
      createdAt: at,
      contentHash: hash(payload),
      payload,
      current: true,
      approvedAt: at,
      status: 'reviewed',
      historical: false,
      authority: 'Capiro assessment; source citations retain separate publisher authority',
    };
  }
  return {
    kind: 'capiro_record_reconciliation',
    id: 'synthetic-record',
    inputHash: 'synthetic-input',
    payload: {
      ...common,
      schema: 'legiwatch.record-reconciliation.v1',
      event: {
        id: 'synthetic-event',
        title: 'Synthetic hearing',
        jurisdiction: null,
        session: null,
        date: '2026-10-01',
        body: null,
        revision: 0,
      },
      originalClaims: [],
      sourceSelections: [],
    },
    current: true,
    createdAt: at,
    assessments: [],
    historical: false,
    authority: 'Capiro assessment of the preserved captured account',
  };
}

function harness(view: View = 'published') {
  const input = request(view);
  const row = {
    id: 'synthetic-record',
    hash: 'a'.repeat(64),
    evidence: { text },
    observed: new Date(at),
    date: '2026-10-01',
    billId: null,
    kind: 'official_transcript',
    current: true,
  };
  const owner = view === 'published' ? null : ownerPacket(view);
  const tx = {
    client: {
      findMany: jest.fn().mockResolvedValue([{ id: 'synthetic-client', status: 'active' }]),
    },
    $queryRaw: jest.fn().mockImplementation(async (query: { strings?: string[] } | string[]) => {
      const sql = Array.isArray(query) ? query.join('') : query.strings!.join('');
      if (sql.includes('SELECT u.clerk_user_id')) return [{ actor: 'synthetic-clerk-actor' }];
      if (sql.includes('SELECT enabled FROM intel_feature_flag')) return [{ enabled: true }];
      return [row];
    }),
  };
  const prisma = { withTenantUser: jest.fn().mockImplementation((_tenant, _user, run) => run(tx)) };
  const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => owner,
  } as Response);
  const read = (cursor?: string, selected = input) =>
    retrievePublishedHearingRecords(prisma as never, selected, cursor);
  return { input, row, owner, tx, prisma, fetcher, read };
}

describe('published hearing exact-record continuation', () => {
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-test-service-secret';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });

  it.each<View>(['published', 'briefs', 'reconciliation'])(
    'reassembles Unicode %s pages with stable content hash and part cursors',
    async (view) => {
      const f = harness(view),
        unicode = 'x' + '😀'.repeat(5000);
      if (f.owner) {
        f.owner.payload.records[0]!.evidence.text = unicode;
        if ('contentHash' in f.owner) f.owner.contentHash = hash(f.owner.payload);
      } else f.row.evidence.text = unicode;
      let cursor: string | undefined,
        joined = '',
        part = 0,
        contentHash: unknown;
      do {
        const result = await f.read(cursor),
          record = result.records[0]!;
        const fragment = record.payload as Record<string, unknown>;
        if (!record.provenance) throw new Error('Published hearing fragment has no provenance');
        contentHash ??= record.provenance.contentHash;
        expect(Buffer.from(fragment.text as string, 'utf8').toString('utf8')).toBe(fragment.text);
        expect(fragment.characterStart).toBe(joined.length);
        joined += fragment.text as string;
        expect(fragment.characterEnd).toBe(joined.length);
        expect(record.recordId).toBe(`${view}:synthetic-record:${contentHash}:${part}`);
        expect(result.coverageComplete).toBe(false);
        cursor = result.nextCursor;
        if (cursor)
          expect(parseHearingContentCursor(cursor, 'published-record')).toEqual({
            key: `${view}:synthetic-record`,
            hash: contentHash,
            part: part + 1,
          });
        expect(++part).toBeLessThan(20);
      } while (cursor);
      expect(createHash('sha256').update(joined).digest('hex')).toBe(contentHash);
      const packet = JSON.parse(joined);
      expect(f.owner ? packet.payload.records[0].evidence.text : packet.evidence.text).toBe(
        unicode,
      );
    },
  );

  it.each<View>(['published', 'briefs', 'reconciliation'])(
    'continues %s through the final exact fragment',
    async (view) => {
      const f = harness(view);
      let cursor: string | undefined;
      let serialized = '';
      let expectedHash: string | undefined;
      let part = 0;
      do {
        const result = await f.read(cursor);
        expect(result.records).toHaveLength(1);
        const record = result.records[0]!;
        const fragment = record.payload as Record<string, unknown>;
        if (!record.provenance) throw new Error('Published hearing fragment has no provenance');
        expectedHash ??= record.provenance.contentHash as string;
        expect(record.recordId).toBe(`${view}:synthetic-record:${expectedHash}:${part}`);
        expect(record.provenance).toMatchObject({
          sourceRecordId: 'synthetic-record',
          hearingId: 'synthetic-event',
          contentHash: expectedHash,
        });
        expect(fragment).toMatchObject({
          kind: 'hearing_evidence_json_chunk',
          contentFormat: 'json_fragment',
          chunk: part + 1,
          characterStart: serialized.length,
          contentHash: expectedHash,
        });
        serialized += fragment.text as string;
        expect(fragment.characterEnd).toBe(serialized.length);
        expect(result).toMatchObject({
          sourceStatus: 'degraded',
          coverageComplete: false,
          paginationComplete: !result.hasMore,
          truncated: result.hasMore,
        });
        cursor = result.nextCursor;
        if (result.hasMore) expect(cursor).toBeDefined();
        else {
          expect(cursor).toBeUndefined();
          expect(fragment.chunk).toBe(fragment.chunkCount);
          expect(fragment.characterEnd).toBe(fragment.totalCharacters);
          expect(result.stopReason).toBe(
            'exact_selected_version_complete_publisher_coverage_not_asserted',
          );
        }
        expect(++part).toBeLessThan(20);
      } while (cursor);
      expect(part).toBeGreaterThan(1);
      const expected = f.owner ?? {
        ...f.row,
        eventId: 'synthetic-event',
        historical: false,
        authority:
          'Published source version; bill agenda membership alone does not establish hearing occurrence',
      };
      expect(JSON.parse(serialized)).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(createHash('sha256').update(serialized).digest('hex')).toBe(expectedHash);
      expect(f.prisma.withTenantUser).toHaveBeenCalledWith(
        'synthetic-tenant',
        'synthetic-user',
        expect.any(Function),
        { timeoutMs: 25000 },
      );
      if (view === 'published') expect(f.fetcher).not.toHaveBeenCalled();
      else
        expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({
          tenantId: 'synthetic-tenant',
          actor: 'synthetic-clerk-actor',
          eventId: 'synthetic-event',
          view,
          id: 'synthetic-record',
          clientId: 'synthetic-client',
        });
    },
  );

  it('rejects substituted record/hash/family and out-of-range parts', async () => {
    const f = harness();
    const first = await f.read();
    const saved = parseHearingContentCursor(first.nextCursor!, 'published-record')!;
    const chunkCount = (first.records[0]!.payload as Record<string, unknown>).chunkCount;
    if (typeof chunkCount !== 'number') throw new Error('Published fragment has no chunk count');
    for (const changed of [
      { ...saved, key: 'published:other-record' },
      { ...saved, key: 'event:synthetic-record' },
      { ...saved, hash: 'b'.repeat(64) },
      { ...saved, part: 0 },
      { ...saved, part: 1.5 },
      { ...saved, part: chunkCount },
    ])
      expect(await f.read(encodeHearingContentCursor(changed))).toMatchObject({
        records: [],
        coverageComplete: false,
        paginationComplete: false,
        stopReason: 'record_content_changed_restart_read',
      });
  });

  it('rejects the saved cursor after event substitution or content changes', async () => {
    const f = harness();
    const first = await f.read();
    const differentEvent = {
      ...f.input,
      hearingFilters: { ...f.input.hearingFilters!, hearingId: 'other-event' },
    };
    expect(await f.read(first.nextCursor, differentEvent)).toMatchObject({
      records: [],
      stopReason: 'record_content_changed_restart_read',
    });
    f.row.evidence.text += 'Changed source';
    expect(await f.read(first.nextCursor)).toMatchObject({
      records: [],
      stopReason: 'record_content_changed_restart_read',
    });
  });

  it('withholds superseded current records and keeps explicit historical reads distinct', async () => {
    const f = harness();
    const first = await f.read();
    const historical = { ...f.input, asOf: new Date('2026-10-02T00:00:00.000Z') };
    expect(await f.read(first.nextCursor, historical)).toMatchObject({
      records: [],
      stopReason: 'record_content_changed_restart_read',
    });
    f.row.current = false;
    expect(await f.read(first.nextCursor)).toMatchObject({
      records: [],
      stopReason: 'record_superseded_explicit_historical_read_required',
    });
    const historicalFirst = await f.read(undefined, historical);
    expect((await f.read(historicalFirst.nextCursor, historical)).records).toHaveLength(1);
    const query = f.tx.$queryRaw.mock.calls.at(-1)![0] as { values: unknown[] };
    expect(query.values).toContain(historical.asOf);
  });

  it.each<View>(['briefs', 'reconciliation'])(
    'preserves %s owner cutoff and current denial',
    async (view) => {
      const f = harness(view);
      const historical = { ...f.input, asOf: new Date('2026-10-02T00:00:00.000Z') };
      await f.read(undefined, historical);
      expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string).asOf).toBe(
        historical.asOf.toISOString(),
      );
      f.fetcher.mockResolvedValue({ ok: false } as Response);
      expect(await f.read()).toMatchObject({
        records: [],
        sourceStatus: 'degraded',
        stopReason: 'record_owner_version_or_access_unavailable',
      });
    },
  );

  it('rechecks client walls before a continuation and does not contact the record owner on denial', async () => {
    const f = harness('briefs');
    const first = await f.read();
    f.tx.client.findMany.mockResolvedValue([]);
    f.fetcher.mockClear();
    expect(await f.read(first.nextCursor)).toMatchObject({
      records: [],
      sourceStatus: 'unauthorized',
      stopReason: 'client_wall_or_security_envelope_denied',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
