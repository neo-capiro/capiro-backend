/**
 * Tests for verification-contract-v1 (Workstream A).
 *
 * Tests:
 * - strict unknown-field rejection
 * - valid timestamps/order
 * - deterministic IDs
 * - prohibited canonical properties absent
 * - rejected result exposes no accepted assertion IDs
 */
import { describe, it, expect } from '@jest/globals';
import {
  verificationRequestV1Schema,
  verificationCheckV1Schema,
  verificationDiscrepancyV1Schema,
  defenseBudgetVerificationResultV1Schema,
  computeVerificationCheckId,
  computeVerificationDiscrepancyId,
  DEFENSE_BUDGET_VERIFIER_VERSION,
  DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
} from './verification-contract-v1.js';

const VALID_SHA = 'a'.repeat(64);
const ISO_NOW = '2026-01-01T00:00:00Z';
const ISO_LATER = '2026-01-01T00:05:00Z';

describe('verification-contract-v1 — version constants', () => {
  it('exports exact verifier version', () => {
    expect(DEFENSE_BUDGET_VERIFIER_VERSION).toBe('defense_budget_verifier_v1');
  });

  it('exports exact policy version', () => {
    expect(DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION).toBe(
      'defense_budget_verification_policy_v1',
    );
  });
});

describe('verificationRequestV1Schema', () => {
  it('accepts a valid request', () => {
    const request = {
      manifestLocator: '/path/to/manifest.json',
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactLocator: '/path/to/artifact.json',
      sourceDocumentId: 'src-123',
      mode: 'inspect',
    };
    expect(verificationRequestV1Schema.parse(request)).toEqual(request);
  });

  it('accepts persist_audit mode with expected hashes', () => {
    const request = {
      manifestLocator: '/path/to/manifest.json',
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactLocator: '/path/to/artifact.json',
      sourceDocumentId: 'src-123',
      mode: 'persist_audit',
      expectedSourcePdfSha256: VALID_SHA,
      expectedExtractionArtifactSha256: VALID_SHA,
    };
    expect(verificationRequestV1Schema.parse(request)).toEqual(request);
  });

  it('rejects unknown fields (strict)', () => {
    const request = {
      manifestLocator: '/path/to/manifest.json',
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactLocator: '/path/to/artifact.json',
      sourceDocumentId: 'src-123',
      mode: 'inspect',
      // Prohibited:
      archiveProof: { bucket: 'b', key: 'k', versionId: 'v', sha256: VALID_SHA },
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('rejects archiveProof field', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      archiveProof: {},
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('rejects parseProof field', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      parseProof: {},
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('rejects approvedSha256 field', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      approvedSha256: VALID_SHA,
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('rejects promotionReady field', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      promotionReady: true,
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('rejects canonicalEligible field', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      canonicalEligible: true,
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('rejects the removed flat referenceArtifactLocators field', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      referenceArtifactLocators: ['/ref.json'],
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('accepts structured referenceArtifacts with explicit sourceDocumentId', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      referenceArtifacts: [
        {
          artifactLocator: '/ref1.json',
          sourceDocumentId: 'ref-src-1',
          manifestDocumentKey: 'r2_army_fy2027',
        },
        // R8.2-D: manifestDocumentKey is mandatory for every reference.
        {
          artifactLocator: '/ref2.json',
          sourceDocumentId: 'ref-src-2',
          manifestDocumentKey: 'r3_army_fy2027',
          manifestLocator: '/other-manifest.json',
        },
      ],
    };
    const parsed = verificationRequestV1Schema.parse(request);
    expect(parsed.referenceArtifacts).toHaveLength(2);
    expect(parsed.referenceArtifacts?.[0]?.sourceDocumentId).toBe('ref-src-1');
    expect(parsed.referenceArtifacts?.[1]?.sourceDocumentId).toBe('ref-src-2');
    expect(parsed.referenceArtifacts?.[1]?.manifestDocumentKey).toBe('r3_army_fy2027');
    expect(parsed.referenceArtifacts?.[1]?.manifestLocator).toBe('/other-manifest.json');
  });

  it('rejects a reference without sourceDocumentId', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      referenceArtifacts: [{ artifactLocator: '/ref.json' }],
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('rejects a reference without artifactLocator', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      referenceArtifacts: [{ sourceDocumentId: 'ref-src' }],
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('rejects unknown properties on a reference descriptor (strict)', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      referenceArtifacts: [
        {
          artifactLocator: '/ref.json',
          sourceDocumentId: 'ref-src',
          archiveProof: {},
        },
      ],
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('multiple references preserve correct source-document pairing', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'candidate-src',
      mode: 'inspect',
      referenceArtifacts: [
        {
          artifactLocator: '/r1.json',
          sourceDocumentId: 'src-r1',
          manifestDocumentKey: 'r1_army_fy2027',
        },
        {
          artifactLocator: '/r2.json',
          sourceDocumentId: 'src-r2',
          manifestDocumentKey: 'r2_army_fy2027',
        },
      ],
    };
    const parsed = verificationRequestV1Schema.parse(request);
    expect(parsed.sourceDocumentId).toBe('candidate-src');
    expect(parsed.referenceArtifacts?.map((r) => r.sourceDocumentId)).toEqual(['src-r1', 'src-r2']);
    // Candidate ID is never substituted into a reference
    expect(parsed.referenceArtifacts?.every((r) => r.sourceDocumentId !== 'candidate-src')).toBe(
      true,
    );
  });

  it('rejects a reference without manifestDocumentKey (R8.2-D: mandatory)', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      referenceArtifacts: [{ artifactLocator: '/ref.json', sourceDocumentId: 'ref-src' }],
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('rejects a reference with unknown properties (R8.2-D: fail closed)', () => {
    const request = {
      manifestLocator: '/path',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      referenceArtifacts: [
        {
          artifactLocator: '/ref.json',
          sourceDocumentId: 'ref-src',
          manifestDocumentKey: 'r1_army_fy2027',
          attemptId: 'extra-field',
        },
      ],
    };
    expect(() => verificationRequestV1Schema.parse(request)).toThrow();
  });

  it('manifestLocator defaults only to the candidate manifest (never required)', () => {
    const request = {
      manifestLocator: '/candidate-manifest.json',
      manifestDocumentKey: 'key',
      extractionArtifactLocator: '/path',
      sourceDocumentId: 'id',
      mode: 'inspect',
      referenceArtifacts: [
        {
          artifactLocator: '/ref.json',
          sourceDocumentId: 'ref-src',
          manifestDocumentKey: 'r1_army_fy2027',
        },
      ],
    };
    const parsed = verificationRequestV1Schema.parse(request);
    // Absent manifestLocator means "use the candidate manifest" — resolved by
    // the resolver, never stored as a defaulted value.
    expect(parsed.referenceArtifacts?.[0]?.manifestLocator).toBeUndefined();
  });
});

describe('verificationCheckV1Schema', () => {
  it('accepts a valid check', () => {
    const check = {
      checkId: 'vc1_abc',
      code: 'source_sha',
      ruleVersion: '1.0',
      outcome: 'PASS',
      required: true,
      blocking: true,
      riskPoints: 0,
      message: 'Source SHA verified',
      assertionIds: ['a1'],
      evidenceIds: ['e1'],
      referenceArtifactIds: [],
    };
    expect(verificationCheckV1Schema.parse(check)).toEqual(check);
  });

  it('rejects unknown fields', () => {
    const check = {
      checkId: 'vc1_abc',
      code: 'source_sha',
      ruleVersion: '1.0',
      outcome: 'PASS',
      required: true,
      blocking: true,
      riskPoints: 0,
      message: 'ok',
      assertionIds: [],
      evidenceIds: [],
      referenceArtifactIds: [],
      extraField: true,
    };
    expect(() => verificationCheckV1Schema.parse(check)).toThrow();
  });

  it('rejects riskPoints > 100', () => {
    const check = {
      checkId: 'vc1',
      code: 'c',
      ruleVersion: '1',
      outcome: 'FAIL',
      required: true,
      blocking: true,
      riskPoints: 101,
      message: 'fail',
      assertionIds: [],
      evidenceIds: [],
      referenceArtifactIds: [],
    };
    expect(() => verificationCheckV1Schema.parse(check)).toThrow();
  });
});

describe('computeVerificationCheckId — deterministic IDs', () => {
  it('produces the same ID for the same inputs', () => {
    const input = {
      verificationRunId: 'run-1',
      code: 'source_sha',
      assertionIds: ['a3', 'a1', 'a2'],
      evidenceIds: ['e2', 'e1'],
      referenceArtifactIds: [],
    };
    const id1 = computeVerificationCheckId(input);
    const id2 = computeVerificationCheckId(input);
    expect(id1).toBe(id2);
    expect(id1.startsWith('vc1_')).toBe(true);
  });

  it('produces different IDs for different codes', () => {
    const base = {
      verificationRunId: 'run-1',
      assertionIds: ['a1'],
      evidenceIds: ['e1'],
      referenceArtifactIds: [],
    };
    const id1 = computeVerificationCheckId({ ...base, code: 'check_a' });
    const id2 = computeVerificationCheckId({ ...base, code: 'check_b' });
    expect(id1).not.toBe(id2);
  });

  it('is order-independent for assertion/evidence IDs', () => {
    const base = {
      verificationRunId: 'run-1',
      code: 'check_a',
      referenceArtifactIds: [],
    };
    const id1 = computeVerificationCheckId({
      ...base,
      assertionIds: ['a1', 'a2'],
      evidenceIds: ['e1', 'e2'],
    });
    const id2 = computeVerificationCheckId({
      ...base,
      assertionIds: ['a2', 'a1'],
      evidenceIds: ['e2', 'e1'],
    });
    expect(id1).toBe(id2);
  });
});

describe('computeVerificationDiscrepancyId — deterministic IDs', () => {
  it('produces the same ID for the same inputs', () => {
    const input = {
      code: 'duplicate_funding',
      assertionIds: ['a1', 'a2'],
      evidenceIds: ['e1'],
      referenceArtifactIds: [],
    };
    expect(computeVerificationDiscrepancyId(input)).toBe(computeVerificationDiscrepancyId(input));
  });
});

describe('defenseBudgetVerificationResultV1Schema', () => {
  const validResult = {
    verifierVersion: 'defense_budget_verifier_v1',
    policyVersion: 'defense_budget_verification_policy_v1',
    policySha256: VALID_SHA,
    verificationRunId: 'run-1',
    candidateId: 'cand-1',
    cycleId: 'fy2027',
    manifestContentSha256: VALID_SHA,
    manifestDocumentKey: 'r1_fy2027',
    extractionArtifactId: 'art-1',
    extractionArtifactSha256: VALID_SHA,
    sourceDocumentId: 'src-1',
    sourcePdfSha256: VALID_SHA,
    decision: 'PASS',
    status: 'VERIFICATION_PASSED',
    route: 'none',
    riskScore: 0,
    checks: [],
    discrepancies: [],
    acceptedAssertionIds: ['a1'],
    rejectedAssertionIds: [],
    referenceArtifactIds: [],
    startedAt: ISO_NOW,
    completedAt: ISO_LATER,
  };

  it('accepts a valid PASS result', () => {
    expect(defenseBudgetVerificationResultV1Schema.parse(validResult)).toEqual(validResult);
  });

  it('rejects completedAt < startedAt', () => {
    const bad = { ...validResult, startedAt: ISO_LATER, completedAt: ISO_NOW };
    expect(() => defenseBudgetVerificationResultV1Schema.parse(bad)).toThrow();
  });

  it('rejects riskScore > 100', () => {
    const bad = { ...validResult, riskScore: 101 };
    expect(() => defenseBudgetVerificationResultV1Schema.parse(bad)).toThrow();
  });

  it('rejects a REJECT result with non-empty acceptedAssertionIds', () => {
    const bad = {
      ...validResult,
      decision: 'REJECT' as const,
      status: 'REJECTED' as const,
      route: 'none' as const,
      acceptedAssertionIds: ['a1'],
    };
    expect(() => defenseBudgetVerificationResultV1Schema.parse(bad)).toThrow();
  });

  it('accepts a REJECT result with empty acceptedAssertionIds', () => {
    const reject = {
      ...validResult,
      decision: 'REJECT' as const,
      status: 'REJECTED' as const,
      route: 'none' as const,
      acceptedAssertionIds: [],
      rejectedAssertionIds: ['a1'],
    };
    expect(defenseBudgetVerificationResultV1Schema.parse(reject)).toEqual(reject);
  });

  it('rejects prohibited CANONICAL status', () => {
    const bad = { ...validResult, status: 'CANONICAL' };
    expect(() => defenseBudgetVerificationResultV1Schema.parse(bad)).toThrow();
  });

  it('rejects prohibited PROMOTED status', () => {
    const bad = { ...validResult, status: 'PROMOTED' };
    expect(() => defenseBudgetVerificationResultV1Schema.parse(bad)).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    const bad = { ...validResult, promotionReady: true };
    expect(() => defenseBudgetVerificationResultV1Schema.parse(bad)).toThrow();
  });
});
