import {
  failedSectionNames,
  finalizeGenerationRun,
  generationFailure,
  type GenerationSectionResult,
} from './generation-run';

const NOW = '2026-07-28T12:00:00.000Z';

function run(sectionResults: GenerationSectionResult[], warnings = 0) {
  return finalizeGenerationRun({
    id: '11111111-1111-4111-8111-111111111111',
    requestedSections: sectionResults.map((result) => result.section),
    sectionResults,
    invalidCitations: Array.from({ length: warnings }, (_, index) => ({
      section: 'Overview',
      token: `[S:invalid-${index}]`,
    })),
    structuralFindings: [],
    groundingFindings: [],
    model: 'claude-sonnet-test',
    credentialSource: 'tenant',
    contextPacketId: '22222222-2222-4222-8222-222222222222',
    contextTraceHash: 'abc123',
    snapshot: { status: 'created', versionId: '33333333-3333-4333-8333-333333333333' },
    startedAt: NOW,
    completedAt: NOW,
  });
}

describe('finalizeGenerationRun', () => {
  it('reports complete only when every requested section succeeded without warnings', () => {
    const summary = run([
      { section: 'Overview', status: 'succeeded', contentChars: 120 },
      { section: 'Request', status: 'succeeded', contentChars: 80 },
    ]);
    expect(summary.status).toBe('complete');
    expect(summary.succeededSections).toEqual(['Overview', 'Request']);
    expect(summary.failedSections).toEqual([]);
  });

  it('reports complete_with_warnings for invalid citations or a failed snapshot', () => {
    expect(run([{ section: 'Overview', status: 'succeeded', contentChars: 120 }], 1).status).toBe(
      'complete_with_warnings',
    );

    const snapshotWarning = finalizeGenerationRun({
      requestedSections: ['Overview'],
      sectionResults: [{ section: 'Overview', status: 'succeeded', contentChars: 120 }],
      model: 'claude-sonnet-test',
      credentialSource: 'platform',
      snapshot: { status: 'failed', versionId: null, errorCode: 'snapshot_persistence_failed' },
      startedAt: NOW,
      completedAt: NOW,
    });
    expect(snapshotWarning.status).toBe('complete_with_warnings');
  });

  it('reports partial and preserves the exact failed-section retry list', () => {
    const failure = generationFailure('Budget Request', new Error('HTTP 503 unavailable'));
    const summary = run([{ section: 'Overview', status: 'succeeded', contentChars: 120 }, failure]);
    expect(summary.status).toBe('partial');
    expect(summary.failedSections).toEqual([
      expect.objectContaining({
        section: 'Budget Request',
        errorCode: 'provider_unavailable',
        staleContentPreserved: true,
      }),
    ]);
    expect(failedSectionNames(summary)).toEqual(['Budget Request']);
  });

  it('reports failed when no requested section succeeded', () => {
    const summary = run([
      generationFailure('Overview', new Error('timeout')),
      generationFailure('Request', new Error('timeout')),
    ]);
    expect(summary.status).toBe('failed');
    expect(summary.succeededSections).toEqual([]);
  });

  it('never persists a provider error body in the bounded failure message', () => {
    const secretBody = 'HTTP 429 rate limit; request body included api-key=sk-secret';
    const failure = generationFailure('Overview', new Error(secretBody));
    expect(failure.errorCode).toBe('provider_rate_limited');
    expect(failure.message).not.toContain('sk-secret');
    expect(failure.message.length).toBeLessThanOrEqual(240);
  });
});
