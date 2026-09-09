import { describe, expect, it } from '@jest/globals';
import { evaluateCandidateCorrectionEligibilityV1 } from './candidate-correction-policy-v1.js';

const BASE_OLD = { id: 'old-1', status: 'NEEDS_REVIEW', sourceDocumentId: 'doc-1', sourceSha256: 'a'.repeat(64) };
const BASE_NEW = { id: 'new-1', status: 'NEEDS_REVIEW', sourceDocumentId: 'doc-1', sourceSha256: 'a'.repeat(64) };

describe('evaluateCandidateCorrectionEligibilityV1', () => {
  it('is eligible when old is NEEDS_REVIEW, new is a distinct candidate on the same source', () => {
    const result = evaluateCandidateCorrectionEligibilityV1({ oldCandidate: BASE_OLD, newCandidate: BASE_NEW });
    expect(result.eligible).toBe(true);
    expect(result.refusalReasons).toEqual([]);
  });

  it('is eligible when old is REJECTED (a genuinely broken extraction may also need a corrected re-verification)', () => {
    const result = evaluateCandidateCorrectionEligibilityV1({
      oldCandidate: { ...BASE_OLD, status: 'REJECTED' },
      newCandidate: BASE_NEW,
    });
    expect(result.eligible).toBe(true);
  });

  it("refuses when the old candidate is REVIEW_ACCEPTED (already-accepted candidates are out of this mechanism's scope)", () => {
    const result = evaluateCandidateCorrectionEligibilityV1({
      oldCandidate: { ...BASE_OLD, status: 'REVIEW_ACCEPTED' },
      newCandidate: BASE_NEW,
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toEqual(['old_candidate_status_not_correctable']);
  });

  it('refuses when the old candidate is some other/unknown status', () => {
    const result = evaluateCandidateCorrectionEligibilityV1({
      oldCandidate: { ...BASE_OLD, status: 'EXTRACTED' },
      newCandidate: BASE_NEW,
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toEqual(['old_candidate_status_not_correctable']);
  });

  it('refuses when the new candidate is itself REJECTED', () => {
    const result = evaluateCandidateCorrectionEligibilityV1({
      oldCandidate: BASE_OLD,
      newCandidate: { ...BASE_NEW, status: 'REJECTED' },
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toEqual(['new_candidate_status_ineligible']);
  });

  it('refuses when old and new are the same candidate id', () => {
    const result = evaluateCandidateCorrectionEligibilityV1({
      oldCandidate: BASE_OLD,
      newCandidate: { ...BASE_NEW, id: BASE_OLD.id },
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toContain('old_equals_new');
  });

  it('refuses when the two candidates do not share the same source document', () => {
    const result = evaluateCandidateCorrectionEligibilityV1({
      oldCandidate: BASE_OLD,
      newCandidate: { ...BASE_NEW, sourceDocumentId: 'doc-2' },
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toEqual(['source_identity_mismatch']);
  });

  it('refuses when the two candidates do not share the same source bytes (same document row, different sha -- e.g. a re-upload)', () => {
    const result = evaluateCandidateCorrectionEligibilityV1({
      oldCandidate: BASE_OLD,
      newCandidate: { ...BASE_NEW, sourceSha256: 'b'.repeat(64) },
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code)).toEqual(['source_identity_mismatch']);
  });

  it('accumulates every applicable refusal reason rather than short-circuiting on the first', () => {
    const result = evaluateCandidateCorrectionEligibilityV1({
      oldCandidate: { ...BASE_OLD, status: 'REVIEW_ACCEPTED' },
      newCandidate: { ...BASE_NEW, status: 'REJECTED', sourceDocumentId: 'doc-2' },
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.map((r) => r.code).sort()).toEqual(
      ['new_candidate_status_ineligible', 'old_candidate_status_not_correctable', 'source_identity_mismatch'].sort(),
    );
  });

  it('reports its own policy id/version on both eligible and refused results', () => {
    const eligible = evaluateCandidateCorrectionEligibilityV1({ oldCandidate: BASE_OLD, newCandidate: BASE_NEW });
    const refused = evaluateCandidateCorrectionEligibilityV1({
      oldCandidate: { ...BASE_OLD, status: 'REVIEW_ACCEPTED' },
      newCandidate: BASE_NEW,
    });
    expect(eligible.policy).toEqual(refused.policy);
    expect(eligible.policy.id).toBe('phase10b35c-candidate-correction-v1');
  });
});
