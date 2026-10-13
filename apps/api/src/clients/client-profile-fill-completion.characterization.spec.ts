import {
  ADVOCACY_SOURCE_NAMES,
  buildAdvocacyHistoryHealth,
  deriveAdvocacyFreshness,
  deriveAdvocacyOverallHealth,
  matchAdvocacyOutcomeDeterministically,
  planTestimonyScanBatch,
  sameActivityDay,
  scoreAdvocacyOutcome,
  titleOverlapRatio,
  updateAdvocacySourceHealth,
} from './client-profile-fill-completion.service.js';
import * as completionFacade from './client-profile-fill-completion.service.js';
import * as completionProjection from './client-profile-fill-completion-projection.js';
import * as advocacyHealth from './client-profile-fill-advocacy-health.js';
import * as advocacyMapping from './client-profile-fill-advocacy-mapping.js';

describe('Client fill completion pure-rule compatibility', () => {
  const now = new Date('2026-08-26T12:00:00.000Z');

  test.each([
    {},
    { backfill: [] },
    { backfill: { sources: 'invalid' } },
    { backfill: { sources: { lda: [] } } },
  ])('malformed cursor %j keeps every canonical health row and explicit defaults', (cursor) => {
    const health = buildAdvocacyHistoryHealth(
      cursor,
      24,
      null,
      { pending: 1, accepted: 2, rejected: 3 },
      now,
    );
    expect(health.sources.map(({ source }) => source)).toEqual([
      'lda',
      'fara',
      'testimony',
      'regulations_gov',
      'federal_register',
      'community_funding',
      'client_submission',
      'private_evidence',
    ]);
    expect(health.sources.map(({ source }) => source)).toEqual([...ADVOCACY_SOURCE_NAMES]);
    expect(health.overall).toBe('not_built');
    expect(health.sources[0]).toEqual({
      source: 'lda',
      status: 'not_started',
      backfillStatus: 'not_started',
      startedAt: undefined,
      completedAt: undefined,
      checkpoint: null,
      historyStart: null,
      examined: 0,
      candidates: 0,
      limitation: null,
      availability: 'unknown',
      lastAttemptAt: undefined,
      lastSuccessAt: undefined,
      freshness: 'unknown',
      nextRefreshAt: undefined,
      lastError: null,
      lastErrorAt: undefined,
    });
    expect(health).toMatchObject({ pendingFindings: 1, acceptedFindings: 2, rejectedFindings: 3 });
    expect(Object.hasOwn(health, 'nextRefreshAt')).toBe(true);
  });

  test('refresh failure retains completed history, checkpoint identity and highest counters', () => {
    const checkpoint = { after: 'retained' };
    const prior = {
      status: 'complete',
      completedAt: '2026-08-20',
      lastSuccessAt: '2026-08-25T12:00:00.000Z',
      checkpoint,
      examined: '9',
      candidates: 4,
    };
    const result = updateAdvocacySourceHealth(
      'regulations_gov',
      prior,
      {
        status: 'failed',
        examined: 2,
        candidates: 1,
        checkpoint: null,
        lastError: 'API key not configured',
      },
      now.toISOString(),
      24,
      'opaque-refresh-value',
    );
    expect(result).toMatchObject({
      status: 'complete',
      completedAt: '2026-08-20',
      examined: 9,
      candidates: 4,
      availability: 'degraded',
      freshness: 'fresh',
      nextRefreshAt: 'opaque-refresh-value',
      lastError: 'Regulations.gov is unavailable because it is not configured',
      lastErrorAt: now.toISOString(),
      lastSuccessAt: prior.lastSuccessAt,
    });
    expect(result.checkpoint).toBe(checkpoint);
    expect(prior.examined).toBe('9');
  });

  test('successful refresh replaces counters and clears errors without normalizing unknown date strings', () => {
    const result = updateAdvocacySourceHealth(
      'lda',
      { examined: 99, candidates: 90, lastError: 'prior' },
      {
        status: 'complete',
        examined: 1,
        candidates: 0,
      },
      now.toISOString(),
      24,
      new Date('2026-08-27T00:00:00.000Z'),
    );
    expect(result).toMatchObject({
      examined: 1,
      candidates: 0,
      availability: 'available',
      lastError: null,
      lastErrorAt: undefined,
      lastSuccessAt: now.toISOString(),
      nextRefreshAt: '2026-08-27T00:00:00.000Z',
    });
    expect(Object.hasOwn(result, 'lastErrorAt')).toBe(true);
  });

  test.each(['fara', 'federal_register', 'community_funding'])(
    '%s keeps the two-cycle freshness boundary',
    (source) => {
      expect(deriveAdvocacyFreshness(source, '2026-08-24T12:00:00.000Z', 24, now)).toBe('fresh');
      expect(deriveAdvocacyFreshness(source, '2026-08-24T11:59:59.999Z', 24, now)).toBe('stale');
    },
  );

  test('freshness retains invalid, future, unknown-source and clamped-cadence behavior', () => {
    expect(deriveAdvocacyFreshness('lda', 'invalid', 24, now)).toBe('unknown');
    expect(deriveAdvocacyFreshness('unknown', '2026-08-25T12:00:00.000Z', 24, now)).toBe('fresh');
    expect(deriveAdvocacyFreshness('unknown', '2026-08-25T11:59:59.999Z', 24, now)).toBe('stale');
    expect(deriveAdvocacyFreshness('lda', '2026-08-27T12:00:00.000Z', 24, now)).toBe('fresh');
    expect(deriveAdvocacyFreshness('lda', '2026-08-26T11:00:00.000Z', -1, now)).toBe('fresh');
    expect(deriveAdvocacyFreshness('lda', '2026-08-26T10:59:59.999Z', 0, now)).toBe('stale');
  });

  test('overall health keeps building, failure, partial and degradation precedence over freshness', () => {
    expect(
      deriveAdvocacyOverallHealth({ a: { status: 'in_progress', availability: 'unavailable' } }),
    ).toBe('building_history');
    expect(
      deriveAdvocacyOverallHealth({ a: { status: 'complete', availability: 'unavailable' } }),
    ).toBe('failed');
    expect(
      deriveAdvocacyOverallHealth({
        a: { status: 'partial', availability: 'degraded', freshness: 'stale' },
      }),
    ).toBe('partial');
    expect(
      deriveAdvocacyOverallHealth({
        a: { status: 'complete', availability: 'degraded', freshness: 'stale' },
      }),
    ).toBe('degraded');
    expect(
      deriveAdvocacyOverallHealth({
        a: { status: 'complete', availability: 'available', freshness: 'fresh' },
      }),
    ).toBe('current');
  });

  test('deterministic PE identity wins over a simultaneous bill identity', () => {
    expect(
      matchAdvocacyOutcomeDeterministically(
        { primaryPeCode: 'PE1', primaryBillId: 'BILL1' },
        { peCode: ' PE1 ', billNumber: 'BILL1' },
      ),
    ).toEqual({ matchedOn: 'pe_code', score: 0.95 });
    expect(
      matchAdvocacyOutcomeDeterministically(
        { primaryPeCode: 'PE1', primaryBillId: null },
        { peCode: 1 },
      ),
    ).toBeNull();
  });

  test('source scoring and duplicate matching retain existing missing-value and tokenizer semantics', () => {
    expect(scoreAdvocacyOutcome({}, {})).toBe(0.24);
    expect(scoreAdvocacyOutcome({ sourceId: 'same' }, { sourceId: 'same' })).toBe(0.79);
    expect(titleOverlapRatio('alpha beta', 'alpha gamma delta')).toBe(1 / 3);
    expect(titleOverlapRatio('and xyz', 'xyz something')).toBe(0);
    expect(sameActivityDay('2026-08-25T23:30:00-05:00', '2026-08-26T04:30:00Z')).toBe(true);
    expect(sameActivityDay(now, now)).toBe(false);
  });

  test('testimony cursor stops at the final permitted emission after confirmed and unmatched rows', () => {
    const row = (hearingId: string, similarity: number) => ({
      hearingId,
      title: hearingId,
      committeeName: 'Committee',
      chamber: 'House',
      date: now,
      url: null,
      syncedAt: now,
      witnessText: 'witness',
      similarity,
    });
    const rows = [
      row('confirmed', 1),
      row('unmatched', 0.1),
      row('eligible', 0.55),
      row('later', 1),
    ];
    const result = planTestimonyScanBatch(rows, new Set(['confirmed::witness']), 0.55, 1);
    expect(result.toEmit).toEqual([rows[2]]);
    expect(result.toEmit[0]).toBe(rows[2]);
    expect(result.cursor).toEqual({ syncedAt: now.toISOString(), key: 'eligible::witness' });
    expect(planTestimonyScanBatch(rows, new Set(), 0.55, -1)).toEqual({ toEmit: [], cursor: null });
    expect(planTestimonyScanBatch([], new Set(), 0.55, 1)).toEqual({ toEmit: [], cursor: null });
  });

  test('the established service facade exposes the canonical pure rules without publishing internal normalizers', () => {
    const publicRules = {
      CLIENT_PROFILE_FILL_COMPLETION_TASK_TYPES:
        completionProjection.CLIENT_PROFILE_FILL_COMPLETION_TASK_TYPES,
      buildClientProfileFillCompletionPlan:
        completionProjection.buildClientProfileFillCompletionPlan,
      calculateProfileCompletion: completionProjection.calculateProfileCompletion,
      mergeFillProgress: completionProjection.mergeFillProgress,
      ADVOCACY_SOURCE_NAMES: advocacyHealth.ADVOCACY_SOURCE_NAMES,
      buildAdvocacyHistoryHealth: advocacyHealth.buildAdvocacyHistoryHealth,
      deriveAdvocacyBackfillOverallStatus: advocacyHealth.deriveAdvocacyBackfillOverallStatus,
      deriveAdvocacyFreshness: advocacyHealth.deriveAdvocacyFreshness,
      deriveAdvocacyOverallHealth: advocacyHealth.deriveAdvocacyOverallHealth,
      updateAdvocacySourceHealth: advocacyHealth.updateAdvocacySourceHealth,
      buildRegulatoryOutcomeFinding: advocacyMapping.buildRegulatoryOutcomeFinding,
      deriveRegulatoryCommentSubmitterLabel: advocacyMapping.deriveRegulatoryCommentSubmitterLabel,
      faraMatchConfidence: advocacyMapping.faraMatchConfidence,
      matchAdvocacyOutcomeDeterministically: advocacyMapping.matchAdvocacyOutcomeDeterministically,
      planTestimonyScanBatch: advocacyMapping.planTestimonyScanBatch,
      resolveFaraMatchedRole: advocacyMapping.resolveFaraMatchedRole,
      sameActivityDay: advocacyMapping.sameActivityDay,
      scoreAdvocacyOutcome: advocacyMapping.scoreAdvocacyOutcome,
      testimonyMatchConfidence: advocacyMapping.testimonyMatchConfidence,
      titleOverlapRatio: advocacyMapping.titleOverlapRatio,
    };
    for (const name of Object.keys(publicRules) as Array<keyof typeof publicRules>) {
      expect(completionFacade[name]).toBe(publicRules[name]);
    }
    for (const name of [
      'recordsFromUnknown',
      'summarizeLdaActivity',
      'normalizePersistedAdvocacy',
      'containsAdvocacyTerm',
      'parseDate',
      'normalizeEvidenceClass',
    ]) {
      expect(Object.hasOwn(completionFacade, name)).toBe(false);
    }
  });
});
