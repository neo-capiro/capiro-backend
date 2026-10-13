import {
  clientId,
  ctx,
  harness,
  installHooks,
  now,
  privateRow as privateEvidenceRow,
  submissionRow,
} from '../../test/fixtures/client-profile-fill-advocacy-history.js';

installHooks();
const oldAt = '2025-01-01T00:00:00.000Z';
const firstAt = new Date('2026-01-02T00:00:00.000Z');
const lastAt = new Date('2026-01-03T00:00:00.000Z');
const prior = { startedAt: oldAt, historyStart: oldAt, examined: 4, candidates: 2 };
const submission = (id: string, overrides: Record<string, unknown> = {}) =>
  submissionRow({ id, data: { id }, createdAt: firstAt, ...overrides });
const privateRow = (id: string, overrides: Record<string, unknown> = {}) =>
  privateEvidenceRow({ id, appliedAt: firstAt, ...overrides });

describe('Tenant submission discovery — scoped continuation', () => {
  test('exhausted shared budget preserves the prior frontier without any database read', async () => {
    const h = harness();
    const checkpoint = { createdAt: oldAt, key: 'prior-submission' };
    expect(
      await h.submissions({
        currentCount: 200,
        lastCreatedAt: oldAt,
        priorState: { ...prior, checkpoint },
      }),
    ).toMatchObject({
      count: 0,
      newestCreatedAt: oldAt,
      backfill: { status: 'in_progress', examined: 4, candidates: 2, checkpoint },
    });
    expect(h.captures.tenant).toEqual([]);
    expect(h.captures.findings).toEqual([]);
  });

  test('tenant and client keyset uses ascending SQL, and skipped malformed data still advances the examined frontier', async () => {
    const h = harness({
      tenantRows: {
        submissions: [
          submission('valid'),
          submission('malformed', { createdAt: lastAt, data: { title: 'Missing identity' } }),
        ],
      },
    });
    const checkpoint = { createdAt: oldAt, key: 'prior-submission' };
    expect(
      await h.submissions({ lastCreatedAt: oldAt, priorState: { ...prior, checkpoint } }),
    ).toMatchObject({
      count: 1,
      newestCreatedAt: lastAt.toISOString(),
      backfill: {
        status: 'complete',
        startedAt: oldAt,
        historyStart: oldAt,
        completedAt: now.toISOString(),
        examined: 6,
        candidates: 3,
        checkpoint: { createdAt: lastAt.toISOString(), key: 'malformed' },
      },
    });
    const query = h.captures.tenant.find((call) => call.rail === 'submissions')!;
    expect(query.args).toEqual([ctx.tenantId, clientId, oldAt, 'prior-submission']);
    expect(query.sql).toContain('WHERE c.tenant_id = $1::uuid AND c.client_id = $2::uuid');
    expect(query.sql).toContain('s.created_at = $3::timestamptz AND s.id::text > $4::text');
    expect(query.sql).toContain('ORDER BY s.created_at ASC, s.id::text ASC');
    expect(query.sql).toContain('LIMIT 100');
    expect(query.transaction).not.toBeNull();
  });
});

describe('Tenant submission discovery — authoritative content', () => {
  test('client-verified findings retain authoritative data, fallback titles and timestamp precedence', async () => {
    const data = {
      id: 'submission',
      detail: 'Detailed advocacy activity',
      description: 'Lesser description',
      submitted_at: oldAt,
      created_at: firstAt.toISOString(),
      updated_at: lastAt.toISOString(),
      status: 'submitted',
      outcome: 'under_review',
      custom: 'retained',
    };
    const h = harness({
      tenantRows: { submissions: [submission('row-id', { capabilityName: 'Defense', data })] },
    });
    expect(await h.submissions({})).toMatchObject({
      count: 1,
      backfill: { historyStart: firstAt.toISOString() },
    });
    expect(h.captures.findings[0]).toMatchObject({
      kind: 'advocacy_record',
      targetKey: 'advocacy:client-submission:submission',
      source: 'advocacy_history',
      factKind: 'fact',
      status: 'pending',
      confidence: 1,
      proposedValue: {
        externalKey: 'client-submission:submission',
        title: 'Defense submission',
        summary: data.detail,
        activityDate: oldAt,
        evidenceClass: 'CLIENT_VERIFIED',
        sourceType: 'client_submission',
        sourceId: 'submission',
        metadata: { ...data, capabilityName: 'Defense' },
      },
      evidence: [
        {
          label: 'Existing client submission history',
          source: 'Capiro client record',
          metadata: { submissionId: 'submission', capabilityName: 'Defense' },
        },
      ],
    });
  });
});

describe('Tenant submission discovery — bounded progress and errors', () => {
  test('successful insertion alone consumes the budget and caps the frontier at the last examined row', async () => {
    const h = harness({
      tenantRows: {
        submissions: [
          submission('duplicate'),
          submission('fresh'),
          submission('unexamined', { createdAt: lastAt }),
        ],
      },
      insertResults: [false, true],
    });
    expect(
      await h.submissions({ currentCount: 199, lastCreatedAt: oldAt, priorState: prior }),
    ).toMatchObject({
      count: 1,
      newestCreatedAt: oldAt,
      backfill: {
        status: 'in_progress',
        examined: 6,
        candidates: 3,
        checkpoint: { createdAt: firstAt.toISOString(), key: 'fresh' },
      },
    });
    expect(h.captures.findings.map((finding) => finding.proposedValue.sourceId)).toEqual([
      'duplicate',
      'fresh',
    ]);
  });

  test('a fully examined 100-row page remains incomplete and preserves the published watermark', async () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      submission(`submission-${index}`, { data: {} }),
    );
    const h = harness({ tenantRows: { submissions: rows } });
    expect(await h.submissions({ lastCreatedAt: oldAt })).toMatchObject({
      count: 0,
      newestCreatedAt: oldAt,
      backfill: {
        status: 'in_progress',
        examined: 100,
        candidates: 0,
        checkpoint: { createdAt: firstAt.toISOString(), key: 'submission-99' },
      },
    });
    expect(h.captures.findings).toEqual([]);
  });

  test('query failure warns and preserves prior state without finding or watermark writes', async () => {
    const checkpoint = { createdAt: oldAt, key: 'prior-submission' };
    const h = harness({ railErrors: { submissions: new Error('submission offline') } });
    expect(
      await h.submissions({ lastCreatedAt: oldAt, priorState: { ...prior, checkpoint } }),
    ).toMatchObject({
      count: 0,
      newestCreatedAt: oldAt,
      backfill: {
        status: 'partial',
        checkpoint,
        examined: 4,
        candidates: 2,
        lastError: 'submission offline',
      },
    });
    expect(h.captures.warnings).toEqual([
      'Client submission advocacy rail unavailable: submission offline',
    ]);
    expect(h.captures.findings).toEqual([]);
    expect(h.captures.cursors).toEqual([]);
  });
});

describe('Private activity discovery — scoped evidence and continuation', () => {
  test('exhausted shared budget leaves private history untouched', async () => {
    const checkpoint = { appliedAt: oldAt, key: 'prior-private' };
    const h = harness();
    expect(
      await h.privateEvidence({
        currentCount: 200,
        lastAppliedAt: oldAt,
        priorState: { ...prior, checkpoint },
      }),
    ).toMatchObject({
      count: 0,
      newestAppliedAt: oldAt,
      backfill: { status: 'in_progress', checkpoint, examined: 4, candidates: 2 },
    });
    expect(h.captures.tenant).toEqual([]);
  });

  test('accepted relationship keyset stays tenant and client scoped, ascending and bounded at 250 rows', async () => {
    const h = harness({ tenantRows: { privateEvidence: [privateRow('relationship')] } });
    const checkpoint = { appliedAt: oldAt, key: 'prior-private' };
    expect(
      await h.privateEvidence({ lastAppliedAt: oldAt, priorState: { ...prior, checkpoint } }),
    ).toMatchObject({
      count: 1,
      newestAppliedAt: firstAt.toISOString(),
      backfill: {
        status: 'complete',
        checkpoint: { appliedAt: firstAt.toISOString(), key: 'relationship' },
        examined: 5,
        candidates: 3,
      },
    });
    const query = h.captures.tenant.find((call) => call.rail === 'privateEvidence')!;
    expect(query.args).toEqual([ctx.tenantId, clientId, oldAt, 'prior-private']);
    expect(query.sql).toContain('WHERE tenant_id = $1::uuid AND client_id = $2::uuid');
    expect(query.sql).toContain("kind = 'relationship_link' AND status = 'accepted'");
    expect(query.sql).toContain('applied_at IS NOT NULL');
    expect(query.sql).toContain('ORDER BY applied_at ASC, id::text ASC');
    expect(query.sql).toContain('LIMIT 250');
    expect(query.transaction).not.toBeNull();
  });
});

describe('Private activity discovery — privacy and authoritative evidence', () => {
  test('classification emits a recommendation without copying private bodies or unrelated proposal fields', async () => {
    const proposal = {
      title: 'Advocacy meeting about acquisition policy',
      entityType: 'meeting',
      entityId: 'meeting-id',
      occurredAt: oldAt,
      matchReason: 'domain',
      matchedDomains: ['acme.test'],
      body: 'Private meeting body',
      messageBody: 'Private mail body',
      unrelated: 'drop',
    };
    const evidence = [
      {
        label: 'Authoritative source pointer',
        source: 'Private source',
        metadata: { id: 'meeting-id' },
      },
    ];
    const h = harness({
      tenantRows: {
        privateEvidence: [privateRow('relationship', { proposedValue: proposal, evidence })],
      },
    });
    await h.privateEvidence({});
    const finding = h.captures.findings[0]!;
    expect(finding).toMatchObject({
      targetKey: 'advocacy:relationship:meeting:meeting-id',
      source: 'advocacy_history',
      factKind: 'recommendation',
      confidence: 0.72,
      status: 'pending',
      evidence,
      proposedValue: {
        recordType: 'advocacy_meeting',
        evidenceClass: 'PRIVATE_ACTIVITY',
        sourceType: 'meeting',
        sourceId: 'meeting-id',
        activityDate: oldAt,
        metadata: {
          relationshipFindingId: 'relationship',
          matchReason: 'domain',
          matchedDomains: ['acme.test'],
        },
      },
    });
    expect(finding.proposedValue.summary).toContain('source record remains authoritative');
    expect(JSON.stringify(finding.proposedValue)).not.toContain('Private meeting body');
    expect(JSON.stringify(finding.proposedValue)).not.toContain('Private mail body');
    expect(finding.proposedValue.metadata).not.toHaveProperty('unrelated');
  });
});

describe('Private activity discovery — examined frontier', () => {
  test('nonadvocacy and missing-entity rows are skipped but still count toward the examined frontier', async () => {
    const h = harness({
      tenantRows: {
        privateEvidence: [
          privateRow('not-advocacy', {
            proposedValue: { title: 'Coffee break', entityType: 'meeting', entityId: 'one' },
          }),
          privateRow('no-entity', {
            appliedAt: lastAt,
            proposedValue: { title: 'Funding policy discussion' },
          }),
        ],
      },
    });
    expect(await h.privateEvidence({ lastAppliedAt: oldAt })).toMatchObject({
      count: 0,
      newestAppliedAt: lastAt.toISOString(),
      backfill: {
        status: 'complete',
        examined: 2,
        candidates: 0,
        checkpoint: { appliedAt: lastAt.toISOString(), key: 'no-entity' },
      },
    });
    expect(h.captures.findings).toEqual([]);
  });

  test('successful insert caps private frontier and full 250-row pages retain the published watermark', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => privateRow(`relationship-${index}`));
    const h = harness({ tenantRows: { privateEvidence: rows }, insertResults: [false, true] });
    expect(await h.privateEvidence({ currentCount: 199, lastAppliedAt: oldAt })).toMatchObject({
      count: 1,
      newestAppliedAt: oldAt,
      backfill: {
        status: 'in_progress',
        examined: 2,
        candidates: 1,
        checkpoint: { appliedAt: firstAt.toISOString(), key: 'relationship-1' },
      },
    });
    const full = harness({
      tenantRows: { privateEvidence: rows },
      terminalResults: Array(250).fill(true),
    });
    expect(await full.privateEvidence({ lastAppliedAt: oldAt })).toMatchObject({
      count: 0,
      newestAppliedAt: oldAt,
      backfill: {
        status: 'in_progress',
        examined: 250,
        checkpoint: { appliedAt: firstAt.toISOString(), key: 'relationship-249' },
      },
    });
  });

  test('a null applied-at result retains its prior watermark and checkpoint while normalizing invalid evidence', async () => {
    const checkpoint = { appliedAt: oldAt, key: 'prior-private' };
    const h = harness({
      tenantRows: {
        privateEvidence: [
          privateRow('relationship', { appliedAt: null, evidence: { privateBody: 'not copied' } }),
        ],
      },
    });
    expect(
      await h.privateEvidence({ lastAppliedAt: oldAt, priorState: { ...prior, checkpoint } }),
    ).toMatchObject({
      count: 1,
      newestAppliedAt: oldAt,
      backfill: { status: 'complete', checkpoint, historyStart: oldAt, examined: 5, candidates: 3 },
    });
    expect(h.captures.findings[0]!.evidence).toEqual([]);
  });
});

describe('Private activity discovery — failure state', () => {
  test('private query failure preserves prior counters and records its distinct warning and error state', async () => {
    const checkpoint = { appliedAt: oldAt, key: 'prior-private' };
    const h = harness({ railErrors: { privateEvidence: new Error('private offline') } });
    expect(
      await h.privateEvidence({ lastAppliedAt: oldAt, priorState: { ...prior, checkpoint } }),
    ).toMatchObject({
      count: 0,
      newestAppliedAt: oldAt,
      backfill: {
        status: 'partial',
        checkpoint,
        examined: 4,
        candidates: 2,
        lastError: 'private offline',
      },
    });
    expect(h.captures.warnings).toEqual(['Private advocacy rail unavailable: private offline']);
    expect(h.captures.findings).toEqual([]);
    expect(h.captures.cursors).toEqual([]);
  });
});
