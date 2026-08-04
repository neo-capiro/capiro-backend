import { RDTE_SUMMARY_DETAIL_RULE } from './rdte-summary-detail.rules.js';

function funding(assertionId: string, peCode: string, valueMillions: string) {
  return {
    assertionId,
    assertionKind: 'funding' as const,
    sourceFactIds: [],
    evidenceIds: [`evidence-${assertionId}`],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE' as const, peCode },
    fiscalYear: 2027,
    field: 'request' as const,
    money: {
      originalValue: valueMillions,
      originalUnit: 'millions' as const,
      valueMillions,
    },
  };
}

function artifact(
  exhibit: 'R-1' | 'R-2',
  artifactId: string,
  assertions: ReturnType<typeof funding>[],
) {
  return {
    artifactId,
    source: { exhibit },
    assertions,
  } as never;
}

function context(
  candidateExhibit: 'R-1' | 'R-2',
  candidateAssertions: ReturnType<typeof funding>[],
  referenceAssertions: ReturnType<typeof funding>[],
) {
  const referenceExhibit = candidateExhibit === 'R-1' ? 'R-2' : 'R-1';
  return {
    verificationRunId: 'run-1',
    policy: {
      requiredComparisonRules: ['rdte_summary_detail'],
      arithmeticRules: ['rdte_summary_detail'],
    },
    input: {
      artifact: artifact(candidateExhibit, 'candidate', candidateAssertions),
      referenceArtifacts: [artifact(referenceExhibit, 'reference', referenceAssertions)],
    },
  } as never;
}

describe('R8.3 bidirectional R-1/R-2 required comparison', () => {
  it.each(['R-1', 'R-2'] as const)(
    'passes a fully covered %s candidate and retains matched IDs',
    (candidateExhibit) => {
      const result = RDTE_SUMMARY_DETAIL_RULE.execute(
        context(
          candidateExhibit,
          [funding('candidate-1', '0601000A', '10')],
          [funding('reference-1', '0601000A', '10')],
        ),
      );
      expect(result.check?.outcome).toBe('PASS');
      expect(result.check?.required).toBe(true);
      expect(result.check?.assertionIds).toEqual(['candidate-1']);
    },
  );

  it('returns required NOT_RUN when candidate coverage is partial', () => {
    const result = RDTE_SUMMARY_DETAIL_RULE.execute(
      context(
        'R-2',
        [
          funding('candidate-1', '0601000A', '10'),
          funding('candidate-2', '0602000A', '20'),
        ],
        [funding('reference-1', '0601000A', '10')],
      ),
    );
    expect(result.check?.outcome).toBe('NOT_RUN');
    expect(result.check?.required).toBe(true);
    expect(result.check?.assertionIds).toEqual(['candidate-1']);
    expect(result.discrepancies[0]?.code).toBe('rdte_summary_detail_unmatched');
  });

  it('rejects ambiguous opposite-exhibit matches', () => {
    const result = RDTE_SUMMARY_DETAIL_RULE.execute(
      context(
        'R-1',
        [funding('candidate-1', '0601000A', '10')],
        [
          funding('reference-1', '0601000A', '10'),
          funding('reference-2', '0601000A', '10'),
        ],
      ),
    );
    expect(result.check?.outcome).toBe('FAIL');
    expect(result.discrepancies[0]?.code).toBe('rdte_summary_detail_ambiguous');
  });
});
