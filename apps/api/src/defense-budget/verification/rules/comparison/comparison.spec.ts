/**
 * Workstream I tests — comparison contract and provider.
 */
import { ReferenceArtifactIndexV1, identityNaturalKey } from './reference-artifact-index.js';
import { createComparisonProvider } from './comparison-provider.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../../contracts/extraction-artifact-v1.js';
import type { ProofFindingV1 } from '../../trusted-proof/trusted-proof-types.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function makeArtifact(overrides: Partial<DefenseBudgetExtractionArtifactV1> = {}): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'test-artifact-1',
    contentSha256: 'a'.repeat(64),
    source: {
      manifestDocumentKey: 'r1_fy2027',
      sourcePdfSha256: 'b'.repeat(64),
      sourceLocator: '/test/r1.pdf',
      fiscalYear: 2027,
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r1',
    },
    parserRuns: [],
    evidence: [],
    sourceFacts: [],
    assertions: [],
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: 0,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
    ...overrides,
  };
}

function makeFundingAssertion(id: string, peCode: string, fy: number, field: string, valueMillions: string) {
  return {
    assertionId: id,
    assertionKind: 'funding' as const,
    sourceFactIds: [],
    evidenceIds: ['ev-1'],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE' as const, peCode },
    fiscalYear: fy,
    field: field as 'request',
    money: { originalValue: valueMillions, originalUnit: 'millions' as const, valueMillions },
  };
}

/* ------------------------------------------------------------------ */
/* Identity natural key                                                 */
/* ------------------------------------------------------------------ */

describe('identityNaturalKey', () => {
  it('produces a deterministic key for a funding assertion', () => {
    const a = makeFundingAssertion('a', '0603112A', 2027, 'request', '100');
    const b = makeFundingAssertion('b', '0603112A', 2027, 'request', '200');
    expect(identityNaturalKey(a)).toBe(identityNaturalKey(b));
  });

  it('produces different keys for different PE codes', () => {
    const a = makeFundingAssertion('a', '0603112A', 2027, 'request', '100');
    const b = makeFundingAssertion('b', '0603112B', 2027, 'request', '100');
    expect(identityNaturalKey(a)).not.toBe(identityNaturalKey(b));
  });
});

/* ------------------------------------------------------------------ */
/* Reference artifact index                                             */
/* ------------------------------------------------------------------ */

describe('ReferenceArtifactIndexV1', () => {
  it('returns zero matches when empty', () => {
    const index = ReferenceArtifactIndexV1.fromArtifacts([]);
    const result = index.lookupFunding('someKey', 2027, 'request');
    expect(result.kind).toBe('zero');
  });

  it('returns one match for an exact key', () => {
    const artifact = makeArtifact({
      assertions: [makeFundingAssertion('ref-1', '0603112A', 2027, 'request', '100')],
    });
    const index = ReferenceArtifactIndexV1.fromArtifacts([artifact]);
    const key = identityNaturalKey(artifact.assertions[0] as never);
    const result = index.lookupFunding(key, 2027, 'request');
    expect(result.kind).toBe('one');
    if (result.kind === 'one') {
      expect(result.value.valueMillions).toBe('100');
    }
  });

  it('returns multiple matches for duplicate keys (never silently reduced to one)', () => {
    const a1 = makeArtifact({
      artifactId: 'ref-a',
      assertions: [makeFundingAssertion('ref-1', '0603112A', 2027, 'request', '100')],
    });
    const a2 = makeArtifact({
      artifactId: 'ref-b',
      assertions: [makeFundingAssertion('ref-2', '0603112A', 2027, 'request', '200')],
    });
    const index = ReferenceArtifactIndexV1.fromArtifacts([a1, a2]);
    const key = identityNaturalKey(a1.assertions[0] as never);
    const result = index.lookupFunding(key, 2027, 'request');
    expect(result.kind).toBe('multiple');
    if (result.kind === 'multiple') {
      expect(result.values.length).toBe(2);
    }
  });

  it('uses different source SHAs for candidate and reference', () => {
    const refArtifact = makeArtifact({
      artifactId: 'ref-artifact',
      source: {
        ...makeArtifact().source,
        sourcePdfSha256: 'c'.repeat(64),
        sourceDocumentId: 'ref-source-id',
      },
      assertions: [makeFundingAssertion('ref-1', '0603112A', 2027, 'request', '100')],
    });
    const index = ReferenceArtifactIndexV1.fromArtifacts([refArtifact]);
    const entries = index.allEntries();
    expect(entries[0]!.sourcePdfSha256).toBe('c'.repeat(64));
    expect(entries[0]!.sourceDocumentId).toBe('ref-source-id');
  });
});

/* ------------------------------------------------------------------ */
/* Comparison provider                                                  */
/* ------------------------------------------------------------------ */

describe('createComparisonProvider', () => {
  it('marks all references as proved when no blocking findings', () => {
    const ref = makeArtifact({
      assertions: [makeFundingAssertion('ref-1', '0603112A', 2027, 'request', '100')],
    });
    const provider = createComparisonProvider([ref], [], []);
    expect(provider.allReferencesProved).toBe(true);
  });

  it('marks references as unproved when blocking findings exist', () => {
    const ref = makeArtifact({
      assertions: [makeFundingAssertion('ref-1', '0603112A', 2027, 'request', '100')],
    });
    const blockingFinding: ProofFindingV1 = {
      code: 'reference_artifact_proof_failed',
      severity: 'blocking',
      message: 'reference proof failed',
    };
    const provider = createComparisonProvider([ref], [], [blockingFinding]);
    expect(provider.allReferencesProved).toBe(false);
  });

  it('returns source SHAs from reference artifacts', () => {
    const ref = makeArtifact({
      source: { ...makeArtifact().source, sourcePdfSha256: 'd'.repeat(64) },
    });
    const provider = createComparisonProvider([ref], [], []);
    expect(provider.referenceSourceShas()).toEqual(['d'.repeat(64)]);
  });
});
