/**
 * Workstream K/L tests — persistence mappers, status transitions,
 * and repository contract.
 */
import {
  isValidTransition,
  assertValidTransition,
  statusFromDecision,
  candidateIdempotencyKey,
  mapCheckToRow,
  mapDiscrepancyToRow,
} from './verification-persistence-mappers.js';
import type { VerificationCheckV1, VerificationDiscrepancyV1 } from '../verification-contract-v1.js';

/* ------------------------------------------------------------------ */
/* Status transitions (L5)                                             */
/* ------------------------------------------------------------------ */

describe('isValidTransition', () => {
  it('allows EXTRACTED -> VALIDATING', () => {
    expect(isValidTransition('EXTRACTED', 'VALIDATING')).toBe(true);
  });

  it('allows STRUCTURALLY_VALIDATED -> VALIDATING', () => {
    expect(isValidTransition('STRUCTURALLY_VALIDATED', 'VALIDATING')).toBe(true);
  });

  it('allows VALIDATING -> VERIFICATION_PASSED', () => {
    expect(isValidTransition('VALIDATING', 'VERIFICATION_PASSED')).toBe(true);
  });

  it('allows VALIDATING -> NEEDS_REVIEW', () => {
    expect(isValidTransition('VALIDATING', 'NEEDS_REVIEW')).toBe(true);
  });

  it('allows VALIDATING -> REJECTED', () => {
    expect(isValidTransition('VALIDATING', 'REJECTED')).toBe(true);
  });

  it('allows NEEDS_REVIEW -> REVIEW_ACCEPTED', () => {
    expect(isValidTransition('NEEDS_REVIEW', 'REVIEW_ACCEPTED')).toBe(true);
  });

  it('allows NEEDS_REVIEW -> REJECTED', () => {
    expect(isValidTransition('NEEDS_REVIEW', 'REJECTED')).toBe(true);
  });

  it('allows terminal -> SUPERSEDED', () => {
    expect(isValidTransition('VERIFICATION_PASSED', 'SUPERSEDED')).toBe(true);
    expect(isValidTransition('REVIEW_ACCEPTED', 'SUPERSEDED')).toBe(true);
    expect(isValidTransition('REJECTED', 'SUPERSEDED')).toBe(true);
  });

  it('rejects EXTRACTED -> VERIFICATION_PASSED', () => {
    expect(isValidTransition('EXTRACTED', 'VERIFICATION_PASSED')).toBe(false);
  });

  it('rejects VERIFICATION_PASSED -> NEEDS_REVIEW', () => {
    expect(isValidTransition('VERIFICATION_PASSED', 'NEEDS_REVIEW')).toBe(false);
  });

  it('rejects SUPERSEDED -> anything', () => {
    expect(isValidTransition('SUPERSEDED', 'EXTRACTED')).toBe(false);
    expect(isValidTransition('SUPERSEDED', 'VALIDATING')).toBe(false);
  });

  it('assertValidTransition throws on invalid', () => {
    expect(() => assertValidTransition('EXTRACTED', 'VERIFICATION_PASSED')).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Status from decision                                                */
/* ------------------------------------------------------------------ */

describe('statusFromDecision', () => {
  it('maps PASS -> VERIFICATION_PASSED', () => {
    expect(statusFromDecision('PASS')).toBe('VERIFICATION_PASSED');
  });

  it('maps REVIEW -> NEEDS_REVIEW', () => {
    expect(statusFromDecision('REVIEW')).toBe('NEEDS_REVIEW');
  });

  it('maps REJECT -> REJECTED', () => {
    expect(statusFromDecision('REJECT')).toBe('REJECTED');
  });
});

/* ------------------------------------------------------------------ */
/* Idempotency key                                                     */
/* ------------------------------------------------------------------ */

describe('candidateIdempotencyKey', () => {
  it('produces the same key for the same identity', () => {
    const identity = {
      cycleId: 'fy2027',
      manifestContentSha256: 'a'.repeat(64),
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactId: 'art-1',
      extractionArtifactSha256: 'b'.repeat(64),
      extractionArtifactLocator: '/test/art.json',
      sourceDocumentId: 'src-1',
      sourceSha256: 'c'.repeat(64),
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256: 'd'.repeat(64),
    };
    const key1 = candidateIdempotencyKey(identity);
    const key2 = candidateIdempotencyKey(identity);
    expect(key1).toBe(key2);
  });

  it('produces different keys for different policy SHA', () => {
    const base = {
      cycleId: 'fy2027',
      manifestContentSha256: 'a'.repeat(64),
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactId: 'art-1',
      extractionArtifactSha256: 'b'.repeat(64),
      extractionArtifactLocator: '/test/art.json',
      sourceDocumentId: 'src-1',
      sourceSha256: 'c'.repeat(64),
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256: 'd'.repeat(64),
    };
    const key1 = candidateIdempotencyKey(base);
    const key2 = candidateIdempotencyKey({ ...base, policySha256: 'e'.repeat(64) });
    expect(key1).not.toBe(key2);
  });
});

/* ------------------------------------------------------------------ */
/* Check mapper                                                        */
/* ------------------------------------------------------------------ */

describe('mapCheckToRow', () => {
  it('maps a PASS check with passed=true', () => {
    const check: VerificationCheckV1 = {
      checkId: 'vc1_1',
      code: 'test',
      ruleVersion: 'v1',
      outcome: 'PASS',
      required: true,
      blocking: false,
      riskPoints: 0,
      message: 'ok',
      assertionIds: ['a1'],
      evidenceIds: ['e1'],
      referenceArtifactIds: [],
    };
    const row = mapCheckToRow('run-1', check);
    expect(row.runId).toBe('run-1');
    expect(row.outcome).toBe('PASS');
    expect(row.passed).toBe(true);
    expect(row.checkId).toBe('vc1_1');
  });

  it('maps a FAIL check with passed=false', () => {
    const check: VerificationCheckV1 = {
      checkId: 'vc1_2',
      code: 'test',
      ruleVersion: 'v1',
      outcome: 'FAIL',
      required: true,
      blocking: true,
      riskPoints: 30,
      message: 'fail',
      assertionIds: [],
      evidenceIds: [],
      referenceArtifactIds: [],
    };
    const row = mapCheckToRow('run-1', check);
    expect(row.outcome).toBe('FAIL');
    expect(row.passed).toBe(false);
  });

  it('maps a NOT_RUN check with passed=false', () => {
    const check: VerificationCheckV1 = {
      checkId: 'vc1_3',
      code: 'test',
      ruleVersion: 'v1',
      outcome: 'NOT_RUN',
      required: true,
      blocking: false,
      riskPoints: 10,
      message: 'not run',
      assertionIds: [],
      evidenceIds: [],
      referenceArtifactIds: [],
    };
    const row = mapCheckToRow('run-1', check);
    expect(row.outcome).toBe('NOT_RUN');
    expect(row.passed).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Discrepancy mapper                                                   */
/* ------------------------------------------------------------------ */

describe('mapDiscrepancyToRow', () => {
  it('maps a discrepancy correctly', () => {
    const d: VerificationDiscrepancyV1 = {
      discrepancyId: 'vd1_1',
      code: 'mismatch',
      severity: 'blocking',
      description: 'values do not match',
      assertionIds: ['a1'],
      evidenceIds: ['e1'],
      referenceArtifactIds: ['ref1'],
      details: { diff: '5' },
    };
    const row = mapDiscrepancyToRow('run-1', 'cand-1', d);
    expect(row.runId).toBe('run-1');
    expect(row.candidateId).toBe('cand-1');
    expect(row.discrepancyId).toBe('vd1_1');
    expect(row.severity).toBe('blocking');
  });
});