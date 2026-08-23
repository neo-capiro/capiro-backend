import {
  buildClientProfileFillCompletionPlan,
  calculateProfileCompletion,
  mergeFillProgress,
  scoreAdvocacyOutcome,
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
});
