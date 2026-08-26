import {
  buildClientProfileFillCompletionPlan,
  calculateProfileCompletion,
  faraMatchConfidence,
  mergeFillProgress,
  matchAdvocacyOutcomeDeterministically,
  sameActivityDay,
  scoreAdvocacyOutcome,
  testimonyMatchConfidence,
  titleOverlapRatio,
} from './client-profile-fill-completion.service.js';

describe('Fill with Meri completion workflow', () => {
  test('builds the downstream graph in dependency order', () => {
    const plan = buildClientProfileFillCompletionPlan();
    const byKey = new Map(plan.map((task) => [task.taskKey, task]));

    expect(plan.map((task) => task.taskKey)).toEqual([
      'federal_market',
      'facility_resolution',
      'district_nexus',
      'advocacy_history',
      'lifecycle_outcomes',
      'reconciliation',
      'completion_audit',
    ]);
    expect(byKey.get('district_nexus')?.dependsOn).toEqual(['facility_resolution']);
    expect(byKey.get('lifecycle_outcomes')?.dependsOn).toEqual([
      'advocacy_history',
      'federal_market',
    ]);
    expect(byKey.get('completion_audit')?.dependsOn).toEqual(['reconciliation']);
  });

  test('merges progress across the core and completion ledgers', () => {
    expect(
      mergeFillProgress([
        { status: 'completed' },
        { status: 'completed' },
        { status: 'running' },
        { status: 'queued' },
        { status: 'failed' },
        { status: 'cancelled' },
      ]),
    ).toEqual({
      total: 6,
      queued: 1,
      running: 1,
      completed: 2,
      failed: 1,
      cancelled: 1,
    });
  });

  test('calculates completion only from the declared profile domains', () => {
    const result = calculateProfileCompletion({
      federalIdentity: true,
      website: true,
      overview: true,
      governmentIdentity: true,
      capabilities: true,
      relationships: false,
      facilities: true,
      districtNexus: false,
      federalMarket: true,
      lobbyingHistory: true,
      advocacyHistory: true,
      programElements: true,
      bills: false,
    });

    expect(result.score).toBe(77);
    expect(result.completed).toContain('Advocacy history');
    expect(result.missing).toEqual([
      'Relationships and history',
      'District Nexus',
      'Bill recommendations',
    ]);
  });

  test('scores an exact authoritative source link above a loose textual overlap', () => {
    const advocacy = {
      title: 'FY27 autonomous systems funding request',
      summary: 'Request funding for Army ground robotics.',
      sourceType: 'submission',
      sourceId: 'submission-1',
      metadata: { programElement: '0605053A' },
    };
    const exact = scoreAdvocacyOutcome(advocacy, {
      kind: 'funding_changed',
      sourceType: 'submission',
      sourceId: 'submission-1',
      notes: 'Army ground robotics funding changed.',
      evidence: { programElement: '0605053A' },
    });
    const loose = scoreAdvocacyOutcome(advocacy, {
      kind: 'meeting_held',
      sourceType: 'meeting',
      sourceId: 'meeting-2',
      notes: 'General autonomous systems discussion.',
      evidence: {},
    });

    expect(exact).toBeGreaterThan(loose);
    expect(exact).toBeLessThanOrEqual(0.99);
  });

  test('matches deterministically on exact PE code before any semantic scoring is even needed (§16 priority 1)', () => {
    const matched = matchAdvocacyOutcomeDeterministically(
      { primaryPeCode: '0605053A', primaryBillId: null },
      { peCode: '0605053A', fiscalYear: 2027, stage: 'HAC-D', amountFrom: 12_000_000, amountTo: 30_000_000 },
    );
    expect(matched).toEqual({ matchedOn: 'pe_code', score: 0.95 });
  });

  test('matches deterministically on exact bill ID (§16 priority 2)', () => {
    const matched = matchAdvocacyOutcomeDeterministically(
      { primaryPeCode: null, primaryBillId: '119-hr-1234' },
      { billNumber: '119-hr-1234' },
    );
    expect(matched).toEqual({ matchedOn: 'bill_id', score: 0.95 });
  });

  test('never fabricates a deterministic match — a different PE code, an undefined Matter, or empty evidence all fall through to null', () => {
    expect(
      matchAdvocacyOutcomeDeterministically({ primaryPeCode: '0605053A', primaryBillId: null }, { peCode: '0605055A' }),
    ).toBeNull();
    expect(
      matchAdvocacyOutcomeDeterministically(undefined, { peCode: '0605053A' }),
    ).toBeNull();
    expect(
      matchAdvocacyOutcomeDeterministically({ primaryPeCode: '0605053A', primaryBillId: null }, {}),
    ).toBeNull();
    // A Matter with no PE/bill identifiers of its own can never deterministically match anything.
    expect(
      matchAdvocacyOutcomeDeterministically({ primaryPeCode: null, primaryBillId: null }, { peCode: '0605053A', billNumber: '119-hr-1234' }),
    ).toBeNull();
  });

  test('§27: sameActivityDay is the deterministic gate before any text-similarity check', () => {
    expect(sameActivityDay('2026-03-12T14:00:00.000Z', '2026-03-12T09:00:00.000Z')).toBe(true); // same day, different time
    expect(sameActivityDay('2026-03-12T00:00:00.000Z', '2026-03-13T00:00:00.000Z')).toBe(false); // one day apart
    expect(sameActivityDay(null, '2026-03-12T00:00:00.000Z')).toBe(false); // an undated record never matches anything
    expect(sameActivityDay(undefined, undefined)).toBe(false);
  });

  test('§27: titleOverlapRatio never collapses two dissimilar titles, and is symmetric', () => {
    const ratio = titleOverlapRatio('HASC staff meeting on ground robotics', 'Staff meeting HASC ground robotics funding');
    expect(ratio).toBeGreaterThan(0.5);
    expect(titleOverlapRatio('HASC staff meeting on ground robotics', 'SASC hearing on shipbuilding budget')).toBeLessThan(0.3);
    expect(titleOverlapRatio(null, 'anything')).toBe(0);
    expect(titleOverlapRatio('anything', null)).toBe(0);
  });

  test('faraMatchConfidence: a confirmed client_intel_mapping always yields full confidence regardless of similarity', () => {
    expect(faraMatchConfidence(true, 0)).toBe(1);
    expect(faraMatchConfidence(true, 0.03)).toBe(1);
    expect(faraMatchConfidence(true, 0.99)).toBe(1);
  });

  test('faraMatchConfidence: an unconfirmed match is scaled by similarity but never reaches 1 and never drops below the auto-match floor', () => {
    expect(faraMatchConfidence(false, 0.5)).toBe(0.725);
    expect(faraMatchConfidence(false, 1)).toBe(0.95);
    // Even a similarity below the query's own >= 0.5 gate (defensive floor,
    // in case this helper is ever called before that gate is applied) never
    // produces a confidence below 0.5 — an unconfirmed public-source match
    // is never presented as less certain than the discovery threshold itself.
    expect(faraMatchConfidence(false, 0)).toBe(0.5);
  });

  test('testimonyMatchConfidence: a confirmed client_intel_mapping always yields full confidence regardless of similarity', () => {
    expect(testimonyMatchConfidence(true, 0)).toBe(1);
    expect(testimonyMatchConfidence(true, 0.1)).toBe(1);
    expect(testimonyMatchConfidence(true, 0.99)).toBe(1);
  });

  test('testimonyMatchConfidence: an unconfirmed match is scaled by similarity but never reaches 1 and never drops below the auto-match floor', () => {
    expect(testimonyMatchConfidence(false, 0.55)).toBe(0.77);
    expect(testimonyMatchConfidence(false, 1)).toBe(0.95);
    // Defensive floor mirrors faraMatchConfidence's own defensive floor test:
    // even a similarity below the query's own >= 0.55 gate never produces a
    // confidence below the discovery threshold itself.
    expect(testimonyMatchConfidence(false, 0)).toBe(0.55);
  });
});
