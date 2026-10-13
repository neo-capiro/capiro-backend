import {
  harness,
  testimonyRow,
  installHooks,
  now,
  ctx,
  clientId,
  runId,
  type Options,
} from '../../test/fixtures/client-profile-fill-advocacy-history.js';

installHooks();
type Row = ReturnType<typeof testimonyRow>;
const key = (row: Row) => `${row.hearingId}::${row.witnessText}`;
const sqlText = (value: string) => value.replace(/\s+/g, ' ').trim();
const confirmedSql = `SELECT ch.id AS "hearingId", ch.title, ch.committee_name AS "committeeName",
  ch.chamber, ch.date, ch.url, w AS "witnessText"
  FROM federal_committee_hearing ch, unnest(ch.witnesses) AS w
  WHERE (ch.id || '::' || w) = ANY($1::text[])`;
const scanSql = `SELECT ch.id AS "hearingId", ch.title, ch.committee_name AS "committeeName",
  ch.chamber, ch.date, ch.url, ch.synced_at AS "syncedAt", w AS "witnessText",
  GREATEST(similarity(w, $3), word_similarity($3, w))::float AS similarity
  FROM federal_committee_hearing ch, unnest(ch.witnesses) AS w
  WHERE ($1::timestamptz IS NULL) OR (ch.synced_at > $1::timestamptz)
    OR (ch.synced_at = $1::timestamptz AND (ch.id || '::' || w) > $2::text)
  ORDER BY ch.synced_at ASC, (ch.id || '::' || w) ASC LIMIT $4`;
const scan = (rows: Row[], options: Options = {}) =>
  harness({ ...options, globalRows: { ...options.globalRows, testimonyScan: rows } });
const confirmed = (row: Row, rows: Row[] = [], options: Options = {}) =>
  scan(rows, {
    ...options,
    confirmedKeys: { testimony: [key(row)] },
    globalRows: { testimonyConfirmed: [row] },
  });

describe('Testimony query scope and source-state defaults', () => {
  it('does not touch I/O after the shared findings cap and retains the old checkpoint', async () => {
    const h = harness();
    expect(
      await h.testimony({
        currentCount: 200,
        lastSyncedAt: '2025-01-01',
        lastKey: 'old',
        priorState: { startedAt: 'start', historyStart: 'history', examined: '3', candidates: '2' },
      }),
    ).toEqual({
      count: 0,
      newestSyncedAt: '2025-01-01',
      newestKey: 'old',
      backfill: {
        status: 'in_progress',
        startedAt: 'start',
        checkpoint: { syncedAt: '2025-01-01', key: 'old' },
        historyStart: 'history',
        examined: 3,
        candidates: 2,
        lastError: null,
      },
    });
    expect(h.captures.global).toEqual([]);
    expect(h.captures.models).toEqual([]);
  });
  it('keeps a missing-name source in progress without a FARA-style completion', async () => {
    const h = harness({ clientName: null });
    expect(await h.testimony()).toEqual({
      count: 0,
      newestSyncedAt: null,
      newestKey: null,
      backfill: {
        status: 'in_progress',
        startedAt: now.toISOString(),
        checkpoint: null,
        historyStart: null,
        examined: 0,
        candidates: 0,
        lastError: null,
      },
    });
    expect(h.captures.models.map((call) => call.operation)).toEqual(['name']);
    expect(h.captures.global).toEqual([]);
  });
  it('uses the canonical global table, exact keyset query and the 500-row bound', async () => {
    const h = harness();
    await h.testimony({ lastSyncedAt: '2025-01-01', lastKey: 'hearing::witness' });
    expect(h.captures.global).toHaveLength(1);
    expect(sqlText(h.captures.global[0]!.sql)).toBe(sqlText(scanSql));
    expect(h.captures.global[0]!).toMatchObject({
      transaction: null,
      args: ['2025-01-01', 'hearing::witness', 'Acme Research', 500],
    });
    expect(h.captures.models[1]).toMatchObject({
      tenantId: ctx.tenantId,
      args: [
        { where: { clientId, source: 'testimony', confirmed: true }, select: { externalId: true } },
      ],
    });
  });
  it('starts at an unbounded timestamp with an empty tie-break key', async () => {
    const h = harness();
    expect((await h.testimony()).backfill).toMatchObject({
      status: 'complete',
      completedAt: now.toISOString(),
      checkpoint: null,
    });
    expect(h.captures.global[0]!.args).toEqual([null, '', 'Acme Research', 500]);
  });
});

describe('Testimony confirmed lookup and source-specific finding', () => {
  it('queries confirmed keys before the scan with no cursor, date or similarity filter', async () => {
    const row = testimonyRow();
    const h = confirmed(row);
    await h.testimony({ lastSyncedAt: '2026-01-01', lastKey: 'past-all-old-rows' });
    expect(h.captures.global.map((call) => call.rail)).toEqual([
      'testimonyConfirmed',
      'testimonyScan',
    ]);
    expect(sqlText(h.captures.global[0]!.sql)).toBe(sqlText(confirmedSql));
    expect(h.captures.global[0]!).toMatchObject({ transaction: null, args: [[key(row)]] });
  });
  it('accepts a confirmed unrelated affiliation at full confidence without fabricating testimony documents', async () => {
    const row = testimonyRow({ witnessText: 'Ada Example, Other Organization', similarity: 0 });
    const h = confirmed(row);
    expect((await h.testimony()).count).toBe(1);
    const finding = h.captures.findings[0]!;
    expect(finding).toMatchObject({
      runId,
      tenantId: ctx.tenantId,
      clientId,
      kind: 'advocacy_record',
      targetKey: `advocacy:testimony:${key(row)}`,
      source: 'advocacy_history',
      factKind: 'fact',
      currentValue: null,
      confidence: 1,
      status: 'pending',
    });
    expect(finding.proposedValue).toMatchObject({
      externalKey: `testimony:${key(row)}`,
      recordType: 'congressional_testimony',
      title: `Congressional testimony — ${row.witnessText} at ${row.title}`,
      summary: 'House Science',
      activityDate: row.date.toISOString(),
      status: null,
      outcome: null,
      sourceType: 'testimony',
      sourceId: row.hearingId,
      sourceUrl: row.url,
      evidenceClass: 'PUBLIC_VERIFIED',
      confidence: 1,
      metadata: {
        hearingId: row.hearingId,
        witness: row.witnessText,
        committeeName: row.committeeName,
        chamber: row.chamber,
        clientMatch: { method: 'confirmed_client_intel_mapping', confidence: 1, similarity: null },
      },
    });
    expect(finding.evidence).toEqual([
      {
        label: finding.proposedValue.title,
        source: 'Congressional committee hearing witness list',
        metadata: { hearingId: row.hearingId, witness: row.witnessText },
      },
    ]);
    expect(Object.keys(finding.proposedValue.metadata as object).sort()).toEqual([
      'chamber',
      'clientMatch',
      'committeeName',
      'hearingId',
      'witness',
    ]);
  });
  it('does not move the scan cursor through an old confirmed-only row', async () => {
    const h = confirmed(testimonyRow({ syncedAt: new Date('2020-01-01') }));
    expect(await h.testimony({ lastSyncedAt: '2025-01-01', lastKey: 'old' })).toMatchObject({
      count: 1,
      newestSyncedAt: '2025-01-01',
      newestKey: 'old',
      backfill: { examined: 0, candidates: 1, status: 'complete' },
    });
  });
});

describe('Testimony scan attribution and confidence', () => {
  it('uses a full organization segment at the threshold with independently tuned inferred confidence', async () => {
    const row = testimonyRow({
      witnessText: 'Ada Example; Director; ACME RESEARCH Inc.',
      similarity: 0.55,
      url: null,
    });
    const h = scan([row]);
    expect((await h.testimony()).count).toBe(1);
    expect(h.captures.findings[0]!).toMatchObject({ factKind: 'recommendation', confidence: 0.77 });
    expect(h.captures.findings[0]!.proposedValue).toMatchObject({
      evidenceClass: 'INFERRED',
      sourceUrl: null,
      confidence: 0.77,
      metadata: {
        clientMatch: { method: 'organization_name', confidence: 0.77, similarity: 0.55 },
      },
    });
  });
  it.each([
    'Acme Research, Director, Unrelated Organization',
    'Ada Example, Director, Acme Research Center',
  ])(
    'rejects person/partial-organization matches despite a high score: %s',
    async (witnessText) => {
      const row = testimonyRow({ witnessText });
      const h = scan([row]);
      expect(await h.testimony()).toMatchObject({
        count: 0,
        newestKey: key(row),
        backfill: { examined: 1, candidates: 0, status: 'complete' },
      });
      expect(h.captures.findings).toEqual([]);
    },
  );
  it('advances through a below-threshold full-name row without emitting a finding', async () => {
    const row = testimonyRow({ similarity: 0.549 });
    const h = scan([row]);
    expect(await h.testimony()).toMatchObject({
      count: 0,
      newestSyncedAt: row.syncedAt.toISOString(),
      newestKey: key(row),
      backfill: { examined: 1 },
    });
    expect(h.captures.findings).toEqual([]);
  });
  it('caps the inferred confidence below human-confirmed certainty', async () => {
    const h = scan([testimonyRow({ similarity: 1 })]);
    await h.testimony();
    expect(h.captures.findings[0]!.confidence).toBe(0.95);
  });
});

describe('Testimony scan frontier and durable duplicates', () => {
  it('advances through already-confirmed scan rows without emitting them again', async () => {
    const row = testimonyRow();
    const h = confirmed(row, [row]);
    expect(await h.testimony()).toMatchObject({
      count: 1,
      newestKey: key(row),
      newestSyncedAt: row.syncedAt.toISOString(),
      backfill: { examined: 1, candidates: 1 },
    });
    expect(h.captures.findings).toHaveLength(1);
  });
  it('continues through a full 500-row zero-match page and advances to its final compound key', async () => {
    const rows = Array.from({ length: 500 }, (_, index) =>
      testimonyRow({ hearingId: `hearing-${String(index).padStart(3, '0')}`, similarity: 0.1 }),
    );
    const h = scan(rows);
    expect(await h.testimony({ priorState: { examined: 7, candidates: 2 } })).toMatchObject({
      count: 0,
      newestKey: key(rows[499]!),
      newestSyncedAt: rows[499]!.syncedAt.toISOString(),
      backfill: { status: 'in_progress', examined: 507, candidates: 2 },
    });
    expect(h.captures.findings).toEqual([]);
  });
  it('stops the cursor at the last examined row when the plan reserves the remaining budget', async () => {
    const rows = [
      testimonyRow({ hearingId: 'a', similarity: 0.1 }),
      testimonyRow({ hearingId: 'b' }),
      testimonyRow({ hearingId: 'c' }),
    ];
    const h = scan(rows);
    expect(await h.testimony({ currentCount: 199 })).toMatchObject({
      count: 1,
      newestKey: key(rows[1]!),
      backfill: { status: 'in_progress', examined: 2, candidates: 1 },
    });
    expect(h.captures.findings.map((finding) => finding.targetKey)).toEqual([
      `advocacy:testimony:${key(rows[1]!)}`,
    ]);
  });
  it('still consumes the planned scan budget when its first eligible row fails full-organization attribution', async () => {
    const rows = [
      testimonyRow({ hearingId: 'a', witnessText: 'Ada Example, Another Organization' }),
      testimonyRow({ hearingId: 'b' }),
    ];
    const h = scan(rows);
    expect(await h.testimony({ currentCount: 199 })).toMatchObject({
      count: 0,
      newestKey: key(rows[0]!),
      backfill: { status: 'in_progress', examined: 1, candidates: 0 },
    });
    expect(h.captures.findings).toEqual([]);
  });
});

describe('Testimony ledger limits and error containment', () => {
  it('does not retry a terminal duplicate within the same reserved scan budget', async () => {
    const rows = [testimonyRow({ hearingId: 'a' }), testimonyRow({ hearingId: 'b' })];
    const h = scan(rows, { terminalResults: [true] });
    expect(await h.testimony({ currentCount: 199 })).toMatchObject({
      count: 0,
      newestKey: key(rows[0]!),
      backfill: { status: 'in_progress', examined: 1 },
    });
    expect(h.captures.tenant.map((call) => call.rail)).toEqual(['terminal']);
    expect(h.captures.findings).toEqual([]);
  });
  it('does not increase candidate counts for a conflicting insert although the cursor advances', async () => {
    const row = testimonyRow();
    const h = scan([row], { insertResults: [false] });
    expect(await h.testimony()).toMatchObject({
      count: 0,
      newestKey: key(row),
      backfill: { status: 'complete', candidates: 0, examined: 1 },
    });
    expect(h.captures.tenant.map((call) => call.rail)).toEqual(['terminal', 'retire', 'insert']);
  });
  it('skips the scan after a confirmed insert fills the cap while retaining the old frontier', async () => {
    const h = confirmed(testimonyRow());
    expect(
      await h.testimony({
        currentCount: 199,
        lastSyncedAt: '2025-01-01',
        lastKey: 'old',
        priorState: { examined: 4, candidates: 3 },
      }),
    ).toMatchObject({
      count: 1,
      newestSyncedAt: '2025-01-01',
      newestKey: 'old',
      backfill: { status: 'complete', examined: 4, candidates: 4 },
    });
    expect(h.captures.global.map((call) => call.rail)).toEqual(['testimonyConfirmed']);
  });
  it('warns on a confirmed lookup failure and continues the independent scan', async () => {
    const row = testimonyRow();
    const h = confirmed(row, [testimonyRow({ hearingId: 'new' })], {
      railErrors: { testimonyConfirmed: new Error('api_key=secret unavailable') },
    });
    expect(await h.testimony()).toMatchObject({
      count: 1,
      backfill: { status: 'complete', lastError: null },
    });
    expect(h.captures.warnings).toEqual([
      'Testimony discovery confirmed-mapping lookup unavailable: api_key=[redacted] unavailable',
    ]);
  });
});

describe('Testimony scan failure after confirmed emission', () => {
  it('keeps confirmed findings and the prior frontier, with partial candidate accounting distinct from prior totals', async () => {
    const h = confirmed(testimonyRow(), [], {
      railErrors: { testimonyScan: new Error('bearer secret scan unavailable') },
    });
    expect(
      await h.testimony({
        lastSyncedAt: '2025-01-01',
        lastKey: 'old',
        priorState: { startedAt: 'start', historyStart: 'history', examined: 8, candidates: 9 },
      }),
    ).toEqual({
      count: 1,
      newestSyncedAt: '2025-01-01',
      newestKey: 'old',
      backfill: {
        status: 'partial',
        startedAt: 'start',
        checkpoint: { syncedAt: '2025-01-01', key: 'old' },
        historyStart: 'history',
        examined: 8,
        candidates: 1,
        lastError: 'bearer=[redacted] scan unavailable',
      },
    });
    expect(h.captures.findings).toHaveLength(1);
    expect(h.captures.warnings).toEqual([
      'Testimony discovery scan rail unavailable: bearer=[redacted] scan unavailable',
    ]);
    expect(h.captures.phases).toContain(`${h.captures.findings[0]!.transaction}:commit`);
  });
  it('bounds a scan failure message while preserving an unstarted null frontier', async () => {
    const h = harness({ railErrors: { testimonyScan: new Error('x'.repeat(900)) } });
    const result = await h.testimony();
    expect(result).toMatchObject({
      count: 0,
      newestSyncedAt: null,
      newestKey: null,
      backfill: { status: 'partial', checkpoint: null, lastError: 'x'.repeat(800) },
    });
    expect(result.backfill.completedAt).toBeUndefined();
  });
});
