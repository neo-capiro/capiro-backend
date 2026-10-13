import {
  clientId,
  ctx,
  federalSuggestion,
  harness,
  installHooks,
  ldaRow,
  now,
  privateRow,
  runId,
  submissionRow,
  faraRow,
  testimonyRow,
  communityRow,
} from '../../test/fixtures/client-profile-fill-advocacy-history.js';

installHooks();
const attemptedAt = now.toISOString();
const nextRunAt = new Date('2026-10-14T03:00:00.000Z');
const schedule = { enabled: true, cadenceHours: 6, nextRunAt, sources: ['advocacy_history'] };

// advocacy history coordinator scope and source order.
it('passes run/tenant/client scope and the complete source frontier to the actual cursor write', async () => {
  const h = harness({ schedule });
  const result = await h.discover();
  expect(h.callsOf('run')[0]!.args).toEqual([runId, ctx.tenantId, clientId]);
  expect(h.callsOf('cursor')[0]!.args).toEqual([ctx.tenantId, clientId, 'advocacy_history']);
  expect(Object.keys(result.sources)).toEqual([
    'lda',
    'client_submission',
    'private_evidence',
    'fara',
    'testimony',
    'regulations_gov',
    'federal_register',
    'community_funding',
  ]);
  expect(result).toMatchObject({
    count: 0,
    overallStatus: 'backfill_partial',
    overallHealth: 'partial',
  });
  expect(h.captures.cursors).toHaveLength(1);
  expect(h.captures.cursors[0]).toMatchObject({
    tenantId: ctx.tenantId,
    clientId,
    source: 'advocacy_history',
    watermark: {
      lastLdaPostedAt: null,
      lastLdaKey: null,
      lastLdaActivityIndex: -1,
      lastClientSubmissionAt: null,
      lastRelationshipLinkAppliedAt: null,
      lastTestimonySyncedAt: null,
      lastTestimonyKey: null,
      lastCommunityFundingCreatedAt: null,
      lastCommunityFundingKey: null,
      refreshedAt: attemptedAt,
      backfill: { status: 'backfill_partial', updatedAt: attemptedAt },
    },
  });
  expect(h.captures.cursors[0]!.watermark.backfill).toEqual({
    status: 'backfill_partial',
    updatedAt: attemptedAt,
    sources: JSON.parse(JSON.stringify(result.sources)),
  });
  expect(h.callsOf('cursorWrite')[0]!.sql).toContain(
    'watermark_jsonb = client_profile_fill_source_cursor.watermark_jsonb || EXCLUDED.watermark_jsonb',
  );
  expect(h.callsOf('lda')[0]!.transaction).toBeNull();
  expect(h.captures.global.map((call) => call.rail)).toEqual([
    'lda',
    'fara',
    'testimonyScan',
    'communityScan',
    'communityCoverage',
  ]);
});

it('emits source findings sequentially while Federal Register enrichment stays outside the aggregate count', async () => {
  const h = harness({
    globalRows: {
      lda: [ldaRow()],
      fara: [faraRow()],
      testimonyScan: [testimonyRow()],
      communityScan: [communityRow()],
    },
    tenantRows: {
      submissions: [submissionRow()],
      privateEvidence: [privateRow()],
      federalMatters: [{ id: 'matter-one' }],
    },
    correlationRows: { 'matter-one': [federalSuggestion()] },
  });
  const result = await h.discover();
  expect(result.count).toBe(6);
  expect(h.captures.findings.map((row) => row.proposedValue.sourceType ?? row.kind)).toEqual([
    'lda',
    'client_submission',
    'meeting',
    'fara',
    'testimony',
    'regulatory_outcome',
    'community_funding',
  ]);
  expect(h.captures.findings.map((row) => [row.tenantId, row.clientId, row.runId])).toEqual(
    Array.from({ length: 7 }, () => [ctx.tenantId, clientId, runId]),
  );
  expect(result.sources.federal_register).toMatchObject({
    examined: 1,
    candidates: 1,
    status: 'complete',
  });
  expect(result.sources.client_submission!.candidates).toBe(1);
  expect(result.sources.private_evidence!.candidates).toBe(1);
  const transactions = h.captures.findings.map((row) => row.transaction);
  expect(new Set(transactions).size).toBe(7);
  for (const transaction of transactions) {
    expect(h.captures.phases.filter((phase) => phase.startsWith(`${transaction}:`))).toEqual([
      `${transaction}:begin`,
      `${transaction}:terminal`,
      `${transaction}:retire`,
      `${transaction}:insert`,
      `${transaction}:commit`,
    ]);
  }
  expect(h.captures.cursors[0]!.transaction).toBeGreaterThan(Math.max(...transactions));
});

// advocacy history coordinator budgets and failures.
it('counts only inserts while allowing duplicate source candidates to be examined', async () => {
  const h = harness({
    globalRows: { lda: [ldaRow()], fara: [faraRow()] },
    tenantRows: { submissions: [submissionRow()], privateEvidence: [privateRow()] },
    insertResults: [false, true, false, true],
  });
  const result = await h.discover();
  expect(result.count).toBe(2);
  expect(h.captures.findings).toHaveLength(4);
  expect(result.sources.lda).toMatchObject({ examined: 1, candidates: 0 });
  expect(result.sources.client_submission).toMatchObject({ examined: 1, candidates: 1 });
  expect(result.sources.private_evidence).toMatchObject({ examined: 1, candidates: 0 });
  expect(result.sources.fara).toMatchObject({ examined: 1, candidates: 1 });
});

it('keeps Federal Register correlation active at the 200-finding budget and leaves other rails unfinished', async () => {
  const activities = Array.from({ length: 201 }, (_, index) => ({
    description: `Activity ${index}`,
  }));
  const h = harness({
    globalRows: { lda: [ldaRow({ lobbyingActivities: activities })] },
    tenantRows: { federalMatters: [{ id: 'matter-one' }] },
    correlationRows: { 'matter-one': [federalSuggestion()] },
  });
  const result = await h.discover();
  expect(result.count).toBe(200);
  expect(h.captures.findings).toHaveLength(201);
  expect(h.captures.correlations).toEqual([[ctx, clientId, 'matter-one']]);
  expect(h.captures.global.map((call) => call.rail)).toEqual(['lda']);
  for (const source of [
    'client_submission',
    'private_evidence',
    'fara',
    'testimony',
    'regulations_gov',
    'community_funding',
  ]) {
    expect(result.sources[source]).toMatchObject({
      status: 'in_progress',
      examined: 0,
      candidates: 0,
    });
  }
  expect(result.sources.federal_register).toMatchObject({
    status: 'complete',
    examined: 1,
    candidates: 1,
  });
  expect(result.overallStatus).toBe('backfill_running');
  expect(result.overallHealth).toBe('building_history');
});

it('preserves committed findings and propagates schedule authorization failure before checkpoint persistence', async () => {
  const h = harness({ authorized: false, globalRows: { lda: [ldaRow()] } });
  await expect(h.discover()).rejects.toThrow('Client not found');
  expect(h.captures.findings).toHaveLength(1);
  expect(h.captures.phases).toContain(`${h.captures.findings[0]!.transaction}:commit`);
  expect(h.captures.cursors).toEqual([]);
  expect(h.callsOf('schedule')).toEqual([]);
  expect(h.prisma.withTenantUser).toHaveBeenCalledWith(
    ctx.tenantId,
    ctx.userId,
    expect.any(Function),
  );
});

// advocacy history refresh schedule and health merge.
it('uses the actual memory-wall scope and configured refresh time for every source health result', async () => {
  const h = harness({ schedule });
  const result = await h.discover();
  expect(h.prisma.withTenantUser).toHaveBeenCalledTimes(1);
  expect(h.prisma.withTenantUser).toHaveBeenCalledWith(
    ctx.tenantId,
    ctx.userId,
    expect.any(Function),
  );
  expect(h.captures.models.find((call) => call.operation === 'authorize')?.args).toEqual([
    {
      where: {
        id: clientId,
        tenantId: ctx.tenantId,
        status: { not: 'archived' },
        OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: ctx.userId } } }],
      },
      select: { id: true },
    },
  ]);
  expect(h.callsOf('schedule')[0]!.args).toEqual([ctx.tenantId, clientId]);
  for (const [source, state] of Object.entries(result.sources)) {
    expect(state).toMatchObject({
      lastAttemptAt: attemptedAt,
      nextRefreshAt: nextRunAt.toISOString(),
    });
    if (source !== 'regulations_gov')
      expect(state).toMatchObject({ lastSuccessAt: attemptedAt, freshness: 'fresh' });
  }
  expect(result.sources.regulations_gov).toMatchObject({
    status: 'partial',
    availability: 'unavailable',
    freshness: 'unknown',
    lastError: 'Regulations.gov is unavailable because it is not configured',
    lastErrorAt: attemptedAt,
  });
});

it('retains prior complete history, checkpoint and freshness evidence when a source refresh fails', async () => {
  const success = '2026-10-13T10:00:00.000Z';
  const checkpoint = {
    scanAt: '2025-04-01T00:00:00.000Z',
    key: 'filing-prior',
    activityIndex: 2,
  };
  const h = harness({
    schedule,
    cursor: {
      lastLdaPostedAt: checkpoint.scanAt,
      lastLdaKey: checkpoint.key,
      lastLdaActivityIndex: 2,
      backfill: {
        sources: {
          lda: {
            status: 'complete',
            completedAt: success,
            startedAt: '2025-01-01T00:00:00.000Z',
            lastSuccessAt: success,
            examined: 8,
            candidates: 5,
            checkpoint,
            historyStart: '2025-01-01T00:00:00.000Z',
          },
        },
      },
    },
    railErrors: { lda: new Error('authorization: bearer-secret') },
  });
  const result = await h.discover();
  expect(result.sources.lda).toMatchObject({
    status: 'complete',
    availability: 'degraded',
    freshness: 'fresh',
    checkpoint,
    examined: 8,
    candidates: 5,
    lastSuccessAt: success,
    completedAt: attemptedAt,
    lastError: 'LDA is temporarily unavailable',
    lastErrorAt: attemptedAt,
  });
  expect(h.captures.warnings[0]).toBe(
    'LDA historical backfill unavailable: authorization=[redacted]',
  );
  expect(h.captures.cursors[0]!.watermark).toMatchObject({
    lastLdaPostedAt: checkpoint.scanAt,
    lastLdaKey: checkpoint.key,
    lastLdaActivityIndex: 2,
  });
});
