import {
  clientId,
  ctx,
  harness,
  installHooks,
  ldaRow,
  now,
  runId,
} from '../../test/fixtures/client-profile-fill-advocacy-history.js';

installHooks();
const postedAt = '2025-04-01T00:00:00.000Z';
const checkpoint = { scanAt: postedAt, key: 'filing-one', activityIndex: 0 };

// LDA history scope and finding payload.
it('queries selected ids with the exact initial keyset and 250-row page boundary', async () => {
  const h = harness({ ldaClientIds: [42, 73] });
  await h.discover();
  const query = h.callsOf('lda')[0]!;
  expect(query.args).toEqual([[42, 73], null, '', 250]);
  expect(query.sql).toContain('filing_uuid >= $3::text');
  expect(query.sql).toContain('COALESCE(dt_posted, make_date(filing_year, 1, 1)::timestamptz)');
  expect(query.sql).toContain(
    'ORDER BY COALESCE(dt_posted, make_date(filing_year, 1, 1)::timestamptz) ASC,',
  );
  expect(query.transaction).toBeNull();
});

it.each(['run', 'client', 'tenant'] as const)(
  'does not read the global LDA corpus for a foreign %s scope',
  async (scope) => {
    const h = harness({ globalRows: { lda: [ldaRow()] } });
    const actor = scope === 'tenant' ? { ...ctx, tenantId: 'foreign-tenant' } : ctx;
    const client = scope === 'client' ? 'foreign-client' : clientId;
    const run = scope === 'run' ? 'foreign-run' : runId;
    await h.discover(actor, client, run);
    expect(h.callsOf('run')[0]!.args).toEqual([run, actor.tenantId, client]);
    expect(h.callsOf('lda')).toEqual([]);
    expect(h.captures.findings).toEqual([]);
  },
);

it('emits the entire fallback activity envelope and coerces nullable financial values', async () => {
  const h = harness({
    globalRows: {
      lda: [
        ldaRow({
          dtPosted: null,
          scanAt: new Date('2025-01-01T00:00:00.000Z'),
          income: null,
          expenses: '1500.25',
          lobbyingActivities: [],
          filingPeriod: null,
        }),
      ],
    },
  });
  const result = await h.discover();
  expect(h.captures.findings).toHaveLength(1);
  expect(h.captures.findings[0]).toEqual({
    transaction: expect.any(Number),
    runId,
    tenantId: ctx.tenantId,
    clientId,
    kind: 'advocacy_record',
    targetKey: 'advocacy:lda:filing-one:0',
    source: 'advocacy_history',
    factKind: 'fact',
    currentValue: null,
    proposedValue: {
      externalKey: 'lda:filing-one:0',
      recordType: 'federal_lobbying',
      title: '2025 — SCI',
      summary: 'Research funding',
      activityDate: null,
      status: 'report',
      outcome: null,
      sourceType: 'lda',
      sourceId: 'filing-one',
      sourceUrl: 'https://example.invalid/filing-one',
      evidenceClass: 'PUBLIC_VERIFIED',
      confidence: 1,
      metadata: {
        ldaClientId: 42,
        ldaClientName: 'Acme Research',
        registrantName: 'Public Affairs LLC',
        filingYear: 2025,
        filingPeriod: null,
        income: null,
        expenses: 1500.25,
        issueCodes: ['SCI'],
        governmentEntities: ['House'],
        activity: {},
      },
    },
    confidence: 1,
    status: 'pending',
    contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    evidence: [
      {
        label: '2025 — SCI',
        url: 'https://example.invalid/filing-one',
        source: 'Senate Lobbying Disclosure Act filing',
        metadata: { filingUuid: 'filing-one', activityIndex: 0 },
      },
    ],
  });
  expect(result.sources.lda).toMatchObject({
    historyStart: '2025-01-01T00:00:00.000Z',
    examined: 1,
    candidates: 1,
    checkpoint: { scanAt: '2025-01-01T00:00:00.000Z', key: 'filing-one', activityIndex: 0 },
  });
});

// LDA activity resume and idempotent ledger.
it('resumes the same filing after its saved activity index before processing the next filing', async () => {
  const h = harness({
    cursor: {
      backfill: {
        sources: {
          lda: {
            status: 'in_progress',
            checkpoint,
            examined: 4,
            candidates: 2,
            startedAt: '2025-01-01T00:00:00.000Z',
          },
        },
      },
    },
    globalRows: {
      lda: [
        ldaRow({
          lobbyingActivities: [
            { description: 'Already scanned' },
            { general_issue_code: 'HEA', description: 'Health funding' },
          ],
        }),
        ldaRow({
          filingUuid: 'filing-two',
          scanAt: new Date('2025-04-02T00:00:00.000Z'),
          lobbyingActivities: [{ issue_code: 'DEF', description: 'Defense policy' }],
        }),
      ],
    },
  });
  const result = await h.discover();
  expect(h.callsOf('lda')[0]!.args).toEqual([[42], postedAt, 'filing-one', 250]);
  expect(h.captures.findings.map((row) => row.targetKey)).toEqual([
    'advocacy:lda:filing-one:1',
    'advocacy:lda:filing-two:0',
  ]);
  expect(
    h.captures.findings.map((row) => [row.proposedValue.title, row.proposedValue.summary]),
  ).toEqual([
    ['2025 Q1 — HEA', 'Health funding'],
    ['2025 Q1 — DEF', 'Defense policy'],
  ]);
  expect(result.sources.lda).toMatchObject({
    status: 'complete',
    examined: 6,
    candidates: 4,
    startedAt: '2025-01-01T00:00:00.000Z',
    checkpoint: { scanAt: '2025-04-02T00:00:00.000Z', key: 'filing-two', activityIndex: 0 },
  });
});

it('uses completed watermarks instead of an older backfill checkpoint while retaining that historical checkpoint', async () => {
  const h = harness({
    cursor: {
      lastLdaPostedAt: postedAt,
      lastLdaKey: 'filing-one',
      lastLdaActivityIndex: 0,
      backfill: {
        sources: {
          lda: {
            status: 'complete',
            checkpoint: { scanAt: '2024-01-01T00:00:00.000Z', key: 'old', activityIndex: 8 },
          },
        },
      },
    },
    globalRows: {
      lda: [ldaRow({ lobbyingActivities: [{ description: 'Old' }, { description: 'New' }] })],
    },
  });
  const result = await h.discover();
  expect(h.callsOf('lda')[0]!.args).toEqual([[42], postedAt, 'filing-one', 250]);
  expect(h.captures.findings.map((row) => row.targetKey)).toEqual(['advocacy:lda:filing-one:1']);
  expect(result.sources.lda).toMatchObject({
    status: 'complete',
    checkpoint: { scanAt: '2024-01-01T00:00:00.000Z', key: 'old', activityIndex: 8 },
  });
  expect(h.captures.cursors[0]!.watermark).toMatchObject({
    lastLdaPostedAt: postedAt,
    lastLdaKey: 'filing-one',
    lastLdaActivityIndex: 1,
  });
});

it('skips terminal findings before pending retirement but advances examined activity checkpoints', async () => {
  const h = harness({
    terminalResults: [true, false],
    insertResults: [false],
    globalRows: {
      lda: [
        ldaRow({
          lobbyingActivities: [{ description: 'Accepted' }, { description: 'Duplicate' }],
        }),
      ],
    },
  });
  const result = await h.discover();
  expect(result.count).toBe(0);
  expect(result.sources.lda).toMatchObject({
    examined: 2,
    candidates: 0,
    checkpoint: { ...checkpoint, activityIndex: 1 },
  });
  expect(h.callsOf('terminal')).toHaveLength(2);
  expect(h.callsOf('retire')).toHaveLength(1);
  expect(h.captures.findings).toHaveLength(1);
  const write = h.captures.findings[0]!;
  expect(h.callsOf('retire')[0]!.args).toEqual([ctx.tenantId, clientId, write.contentHash, runId]);
  expect(h.callsOf('terminal')[1]!.args).toEqual([ctx.tenantId, clientId, write.contentHash]);
  expect(h.callsOf('insert')[0]!.sql).toContain('ON CONFLICT (run_id, content_hash) DO NOTHING');
});

// LDA page completion and failure frontiers.
it('leaves a full 250-row page incomplete even when every finding is a terminal duplicate', async () => {
  const rows = Array.from({ length: 250 }, (_, index) =>
    ldaRow({ filingUuid: `filing-${index.toString().padStart(3, '0')}` }),
  );
  const h = harness({
    globalRows: { lda: rows },
    terminalResults: Array.from({ length: 250 }, () => true),
  });
  const result = await h.discover();
  expect(result.sources.lda).toMatchObject({
    status: 'in_progress',
    examined: 250,
    candidates: 0,
    checkpoint: { scanAt: postedAt, key: 'filing-249', activityIndex: 0 },
  });
  expect(h.captures.cursors[0]!.watermark).toMatchObject({
    lastLdaPostedAt: null,
    lastLdaKey: null,
    lastLdaActivityIndex: null,
  });
  expect(h.captures.findings).toEqual([]);
});

it('stops at the last examined activity when inserts exhaust the budget and keeps completion watermarks unchanged', async () => {
  const h = harness({
    cursor: {
      lastLdaPostedAt: '2024-01-01T00:00:00.000Z',
      lastLdaKey: 'prior',
      lastLdaActivityIndex: 3,
    },
    globalRows: {
      lda: [
        ldaRow({
          lobbyingActivities: Array.from({ length: 201 }, (_, index) => ({
            description: `Issue ${index}`,
          })),
        }),
      ],
    },
  });
  const result = await h.discover();
  expect(result.sources.lda).toMatchObject({
    status: 'in_progress',
    examined: 200,
    candidates: 200,
    checkpoint: { scanAt: postedAt, key: 'filing-one', activityIndex: 199 },
  });
  expect(h.captures.cursors[0]!.watermark).toMatchObject({
    lastLdaPostedAt: '2024-01-01T00:00:00.000Z',
    lastLdaKey: 'prior',
    lastLdaActivityIndex: 3,
  });
});

it('preserves an unfinished checkpoint and sanitizes source errors without discarding other rails', async () => {
  const h = harness({
    cursor: {
      backfill: {
        sources: { lda: { status: 'in_progress', checkpoint, examined: 3, candidates: 2 } },
      },
    },
    railErrors: { lda: new Error('api_key=secret-value unavailable') },
  });
  const result = await h.discover();
  expect(result.sources.lda).toMatchObject({
    status: 'partial',
    checkpoint,
    examined: 3,
    candidates: 2,
    lastError: 'LDA is unavailable because it is not configured',
    lastAttemptAt: now.toISOString(),
  });
  expect(h.captures.warnings[0]).toBe(
    'LDA historical backfill unavailable: api_key=[redacted] unavailable',
  );
  expect(h.callsOf('submissions')).toHaveLength(1);
  expect(h.captures.cursors).toHaveLength(1);
});
