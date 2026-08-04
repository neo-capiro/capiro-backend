import {
  isUnresolvedComparisonCheck,
  selectCandidateForDocument,
} from '../../../scripts/report-defense-budget-verification-cycle-v1.js';

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'candidate-1',
    manifestDocumentKey: 'r1_fy2027',
    manifestContentSha256: 'a'.repeat(64),
    status: 'VERIFICATION_PASSED',
    currentRunId: 'run-1',
    policySha256: 'b'.repeat(64),
    verifierVersion: 'defense_budget_verifier_v1',
    sourceSha256: 'c'.repeat(64),
    extractionArtifactSha256: 'd'.repeat(64),
    updatedAt: new Date('2026-08-04T12:00:00Z'),
    ...overrides,
  } as never;
}

describe('R8.3 exact-manifest verification cycle reporting', () => {
  it('selects the highest-priority current candidate deterministically', () => {
    const selection = selectCandidateForDocument([
      candidate({
        id: 'candidate-rejected',
        status: 'REJECTED',
        updatedAt: new Date('2026-08-04T13:00:00Z'),
      }),
      candidate({
        id: 'candidate-passed',
        status: 'VERIFICATION_PASSED',
        updatedAt: new Date('2026-08-04T12:00:00Z'),
      }),
    ]);
    expect(selection.candidate?.id).toBe('candidate-passed');
    expect(selection.warning).toMatch(/2 candidates exist/);
  });

  it('uses updatedAt and ID as deterministic tie breakers', () => {
    const selection = selectCandidateForDocument([
      candidate({ id: 'candidate-b', updatedAt: new Date('2026-08-04T12:00:00Z') }),
      candidate({ id: 'candidate-a', updatedAt: new Date('2026-08-04T12:00:00Z') }),
    ]);
    expect(selection.candidate?.id).toBe('candidate-a');
  });

  it('counts only required NOT_RUN comparison and reconciliation checks', () => {
    expect(
      isUnresolvedComparisonCheck({
        code: 'cross_document_summary_detail',
        outcome: 'NOT_RUN',
        required: true,
      }),
    ).toBe(true);
    expect(
      isUnresolvedComparisonCheck({
        code: 'money_evidence_policy',
        outcome: 'NOT_RUN',
        required: true,
      }),
    ).toBe(false);
    expect(
      isUnresolvedComparisonCheck({
        code: 'page_only_reconciliation',
        outcome: 'PASS',
        required: true,
      }),
    ).toBe(false);
  });
});
