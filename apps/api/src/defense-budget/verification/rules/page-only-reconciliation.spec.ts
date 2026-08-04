import { reconcilePageOnlyEvidence } from './page-only-reconciliation.js';

const SHA = 'a'.repeat(64);

function makeInput(assertionIds: string[], referenceFindingSeverity?: 'blocking' | 'review') {
  const evidence = assertionIds.map((assertionId, index) => ({
    evidenceId: `ev-${index + 1}`,
    sourcePdfSha256: SHA,
    parserRunId: 'parser-1',
    granularity: 'page_only' as const,
    page: index + 1,
  }));
  return {
    artifact: {
      evidence,
      assertions: assertionIds.map((assertionId, index) => ({
        assertionId,
        assertionKind: 'funding' as const,
        sourceFactIds: [],
        evidenceIds: [evidence[index]!.evidenceId],
        confidence: 1,
        identity: { lineKind: 'RDTE_PE' as const, peCode: `060100${index}A` },
        fiscalYear: 2027,
        field: 'request' as const,
        money: { originalValue: '1', originalUnit: 'millions' as const, valueMillions: '1' },
      })),
    },
    referenceArtifacts: [{ artifactId: 'reference-1' }],
    referenceArtifactsFindings: referenceFindingSeverity
      ? [
          {
            code: 'reference_artifact_proof_failed',
            severity: referenceFindingSeverity,
            message: 'reference finding',
          },
        ]
      : [],
  } as never;
}

const policy = {
  pageOnlyMayPassWithIndependentReconciliation: true,
  requiredComparisonRules: ['cross_document_summary_detail'],
  reviewComparisonRules: [],
} as never;

function comparisonCheck(
  outcome: 'PASS' | 'FAIL' | 'NOT_RUN',
  assertionIds: string[],
) {
  return {
    checkId: `check-${outcome}-${assertionIds.join('-')}`,
    code: 'cross_document_summary_detail',
    ruleVersion: 'defense_budget_verification_rule_v1',
    outcome,
    required: true,
    blocking: true,
    riskPoints: outcome === 'PASS' ? 0 : 30,
    message: 'comparison',
    assertionIds,
    evidenceIds: [],
    referenceArtifactIds: ['reference-1'],
  } as never;
}

describe('R8.3 page-only reconciliation', () => {
  it('emits PASS when every page-only assertion is independently corroborated', () => {
    const result = reconcilePageOnlyEvidence(
      makeInput(['assertion-1', 'assertion-2']),
      policy,
      [comparisonCheck('PASS', ['assertion-1', 'assertion-2'])],
      'run-1',
    );
    expect(result.check.code).toBe('page_only_reconciliation');
    expect(result.check.outcome).toBe('PASS');
    expect(result.check.required).toBe(true);
    expect(result.reconciledAssertionIds).toEqual(['assertion-1', 'assertion-2']);
    expect(result.unreconciledAssertionIds).toEqual([]);
  });

  it('emits required NOT_RUN when coverage is partial', () => {
    const result = reconcilePageOnlyEvidence(
      makeInput(['assertion-1', 'assertion-2']),
      policy,
      [comparisonCheck('PASS', ['assertion-1'])],
      'run-1',
    );
    expect(result.check.outcome).toBe('NOT_RUN');
    expect(result.check.required).toBe(true);
    expect(result.reconciledAssertionIds).toEqual(['assertion-1']);
    expect(result.unreconciledAssertionIds).toEqual(['assertion-2']);
    expect(result.discrepancies[0]?.severity).toBe('review');
  });

  it('emits blocking FAIL when a covering comparison fails', () => {
    const result = reconcilePageOnlyEvidence(
      makeInput(['assertion-1']),
      policy,
      [comparisonCheck('FAIL', ['assertion-1'])],
      'run-1',
    );
    expect(result.check.outcome).toBe('FAIL');
    expect(result.check.blocking).toBe(true);
    expect(result.discrepancies[0]?.severity).toBe('blocking');
  });

  it('cannot pass when reference proof is blocking', () => {
    const result = reconcilePageOnlyEvidence(
      makeInput(['assertion-1'], 'blocking'),
      policy,
      [comparisonCheck('PASS', ['assertion-1'])],
      'run-1',
    );
    expect(result.check.outcome).toBe('NOT_RUN');
    expect(result.reconciledAssertionIds).toEqual([]);
  });

  it('emits non-required SKIPPED when no page-only money exists', () => {
    const result = reconcilePageOnlyEvidence(
      {
        artifact: { evidence: [], assertions: [] },
        referenceArtifacts: [],
        referenceArtifactsFindings: [],
      } as never,
      policy,
      [],
      'run-1',
    );
    expect(result.check.outcome).toBe('SKIPPED');
    expect(result.check.required).toBe(false);
  });
});
