import { describe, expect, it } from '@jest/globals';
import {
  classifyLearningSignalEligibility,
  proposeLearningSignalCandidateAuthority,
  LEARNING_SIGNAL_CANDIDATE_ELIGIBILITIES,
  type LearningSignalEligibilityInput,
} from './candidate-contract';
import { MEMORY_AUTHORITIES, MEMORY_CLASSES } from '../memory/governance';

function baseEligibilityInput(
  overrides: Partial<LearningSignalEligibilityInput> = {},
): LearningSignalEligibilityInput {
  return {
    signalType: 'meri_feedback_negative',
    provenanceKind: 'human_explicit',
    proposedMemoryLayer: 'user-voice',
    evidenceRefCount: 2,
    sensitivity: 'normal',
    hasNote: true,
    reasonCount: 0,
    ...overrides,
  };
}

describe('classifyLearningSignalEligibility (Phase 27B)', () => {
  it('is a closed, exhaustive vocabulary of exactly the seven documented categories', () => {
    expect([...LEARNING_SIGNAL_CANDIDATE_ELIGIBILITIES].sort()).toEqual(
      [
        'ai_only',
        'blocked_by_policy',
        'duplicate',
        'eligible',
        'insufficient_evidence',
        'negative_feedback_only',
        'unsupported_scope',
      ].sort(),
    );
  });

  it('CRITICAL RULE: a rejected CRM finding is always negative_feedback_only, never eligible', () => {
    const decision = classifyLearningSignalEligibility(
      baseEligibilityInput({
        signalType: 'crm_finding_rejected',
        proposedMemoryLayer: 'client-steering',
        hasNote: false,
        reasonCount: 0,
      }),
    );
    expect(decision.eligibility).toBe('negative_feedback_only');
  });

  it('a rejected finding stays negative_feedback_only even with strong evidence and a supported layer', () => {
    // Guards against a future "well it has evidence, so surely it's eligible"
    // regression — rejection is checked FIRST, before any evidence look.
    const decision = classifyLearningSignalEligibility(
      baseEligibilityInput({
        signalType: 'crm_finding_rejected',
        proposedMemoryLayer: 'client-people',
        evidenceRefCount: 5,
        provenanceKind: 'human_explicit',
        sensitivity: 'normal',
      }),
    );
    expect(decision.eligibility).toBe('negative_feedback_only');
  });

  it('AI-only provenance is never eligible, even with a note and evidence', () => {
    const decision = classifyLearningSignalEligibility(
      baseEligibilityInput({ provenanceKind: 'ai_generated_only', hasNote: true, evidenceRefCount: 3 }),
    );
    expect(decision.eligibility).toBe('ai_only');
  });

  it('restricted sensitivity is blocked_by_policy regardless of other fields', () => {
    const decision = classifyLearningSignalEligibility(baseEligibilityInput({ sensitivity: 'restricted' }));
    expect(decision.eligibility).toBe('blocked_by_policy');
  });

  it('no proposed memory layer is unsupported_scope', () => {
    const decision = classifyLearningSignalEligibility(baseEligibilityInput({ proposedMemoryLayer: null }));
    expect(decision.eligibility).toBe('unsupported_scope');
  });

  it('zero evidence refs is insufficient_evidence', () => {
    const decision = classifyLearningSignalEligibility(baseEligibilityInput({ evidenceRefCount: 0 }));
    expect(decision.eligibility).toBe('insufficient_evidence');
  });

  it('CORE RULE: a bare thumbs up/down with no note and no reason codes is insufficient_evidence — not every rating becomes memory', () => {
    const decision = classifyLearningSignalEligibility(
      baseEligibilityInput({ signalType: 'meri_feedback_positive', hasNote: false, reasonCount: 0 }),
    );
    expect(decision.eligibility).toBe('insufficient_evidence');
  });

  it('a bare rating WITH a note is eligible', () => {
    const decision = classifyLearningSignalEligibility(
      baseEligibilityInput({ signalType: 'meri_feedback_negative', hasNote: true, reasonCount: 0 }),
    );
    expect(decision.eligibility).toBe('eligible');
  });

  it('a bare rating WITH structured reason codes but no note is eligible', () => {
    const decision = classifyLearningSignalEligibility(
      baseEligibilityInput({ signalType: 'meri_feedback_negative', hasNote: false, reasonCount: 2 }),
    );
    expect(decision.eligibility).toBe('eligible');
  });

  it('an accepted CRM finding with evidence and a supported layer is eligible (no note/reason requirement — that gate is Meri-only)', () => {
    const decision = classifyLearningSignalEligibility(
      baseEligibilityInput({
        signalType: 'crm_finding_accepted',
        proposedMemoryLayer: 'client-people',
        hasNote: false,
        reasonCount: 0,
        evidenceRefCount: 2,
      }),
    );
    expect(decision.eligibility).toBe('eligible');
  });
});

describe('proposeLearningSignalCandidateAuthority (Phase 27B)', () => {
  it('never proposes firm_approved or client_approved — those require an actual approval decision, not a generation-time guess', () => {
    const outcomes = [
      proposeLearningSignalCandidateAuthority({
        signalType: 'meri_feedback_positive',
        hasNote: true,
        reasonCount: 1,
        evidenceRefCount: 2,
      }),
      proposeLearningSignalCandidateAuthority({
        signalType: 'crm_finding_accepted',
        hasNote: false,
        reasonCount: 0,
        evidenceRefCount: 2,
        crmSource: 'sam_gov',
      }),
      proposeLearningSignalCandidateAuthority({
        signalType: 'crm_finding_accepted',
        hasNote: false,
        reasonCount: 0,
        evidenceRefCount: 1,
        crmSource: 'public_web',
      }),
    ];
    for (const outcome of outcomes) {
      expect(outcome.memoryAuthority).not.toBe('firm_approved');
      expect(outcome.memoryAuthority).not.toBe('client_approved');
      expect(MEMORY_AUTHORITIES).toContain(outcome.memoryAuthority);
      expect(MEMORY_CLASSES).toContain(outcome.memoryClass);
    }
  });

  it('Meri feedback proposes user_preference / user_asserted', () => {
    const proposal = proposeLearningSignalCandidateAuthority({
      signalType: 'meri_feedback_negative',
      hasNote: true,
      reasonCount: 1,
      evidenceRefCount: 2,
    });
    expect(proposal.memoryClass).toBe('user_preference');
    expect(proposal.memoryAuthority).toBe('user_asserted');
    expect(proposal.confidenceReasons.length).toBeGreaterThan(0);
    expect(proposal.proposedConfidence).toBeGreaterThan(0);
    expect(proposal.proposedConfidence).toBeLessThanOrEqual(1);
  });

  it('a note raises confidence over a bare-reasons-only rating, all else equal', () => {
    const withNote = proposeLearningSignalCandidateAuthority({
      signalType: 'meri_feedback_negative',
      hasNote: true,
      reasonCount: 0,
      evidenceRefCount: 2,
    });
    const withoutNote = proposeLearningSignalCandidateAuthority({
      signalType: 'meri_feedback_negative',
      hasNote: false,
      reasonCount: 0,
      evidenceRefCount: 2,
    });
    expect(withNote.proposedConfidence).toBeGreaterThan(withoutNote.proposedConfidence);
  });

  it('CRM finding from an authoritative registry (sam_gov/lda) proposes external_authoritative', () => {
    const proposal = proposeLearningSignalCandidateAuthority({
      signalType: 'crm_finding_accepted',
      hasNote: false,
      reasonCount: 0,
      evidenceRefCount: 2,
      crmSource: 'sam_gov',
    });
    expect(proposal.memoryClass).toBe('client_steering');
    expect(proposal.memoryAuthority).toBe('external_authoritative');
  });

  it('CRM finding from a non-authoritative source proposes analyst_verified, not external_authoritative', () => {
    const proposal = proposeLearningSignalCandidateAuthority({
      signalType: 'crm_finding_accepted',
      hasNote: false,
      reasonCount: 0,
      evidenceRefCount: 2,
      crmSource: 'public_web',
    });
    expect(proposal.memoryAuthority).toBe('analyst_verified');
  });

  it('authoritative CRM source proposes higher confidence than a non-authoritative one, all else equal', () => {
    const authoritative = proposeLearningSignalCandidateAuthority({
      signalType: 'crm_finding_accepted',
      hasNote: false,
      reasonCount: 0,
      evidenceRefCount: 2,
      crmSource: 'lda',
    });
    const nonAuthoritative = proposeLearningSignalCandidateAuthority({
      signalType: 'crm_finding_accepted',
      hasNote: false,
      reasonCount: 0,
      evidenceRefCount: 2,
      crmSource: 'website',
    });
    expect(authoritative.proposedConfidence).toBeGreaterThan(nonAuthoritative.proposedConfidence);
  });

  it('does NOT use repetition/evidence count alone as confidence — extra evidence nudges but never dominates the source-quality signal', () => {
    // A non-authoritative source with 10 evidence refs must still not out-rank
    // an authoritative source with 2 — confidence is not "corroboration count".
    const manyWeakRefs = proposeLearningSignalCandidateAuthority({
      signalType: 'crm_finding_accepted',
      hasNote: false,
      reasonCount: 0,
      evidenceRefCount: 10,
      crmSource: 'public_web',
    });
    const fewStrongRefs = proposeLearningSignalCandidateAuthority({
      signalType: 'crm_finding_accepted',
      hasNote: false,
      reasonCount: 0,
      evidenceRefCount: 2,
      crmSource: 'sam_gov',
    });
    expect(fewStrongRefs.proposedConfidence).toBeGreaterThan(manyWeakRefs.proposedConfidence);
  });
});
