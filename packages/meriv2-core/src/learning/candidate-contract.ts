/**
 * LearningSignal → governed candidate — Phase 27B canonical contract.
 *
 * Pure, dependency-free (no I/O, no Prisma) — same discipline as
 * `./contract.ts`. This module answers two questions that
 * `LearningSignalCandidateService` (apps/api) needs answered the same way
 * every time, regardless of which 27A adapter produced the signal:
 *
 *   1. Is this signal even eligible to become a candidate at all
 *      ({@link classifyLearningSignalEligibility})? "duplicate" is
 *      deliberately NOT decided here — that requires a database lookup the
 *      service performs after this intrinsic check passes.
 *   2. If eligible, what memoryClass/memoryAuthority/confidence should the
 *      resulting candidate PROPOSE ({@link proposeLearningSignalCandidateAuthority})?
 *      A proposal, never a promotion: the candidate still lands in the
 *      existing `pending`/`suggested` governed-review queue
 *      (memory-candidate-rules.ts's `memory.learning_signal.requires_review`
 *      rule guarantees this regardless of scope) — a human reviewer can
 *      accept, downgrade, or reject the proposed authority.
 *
 * Never assigns `firm_approved`/`client_approved` (those require an actual
 * approval decision, not a generation-time guess) and never lets
 * `ai_generated_only` provenance reach `eligible` at all — see `ai_only`
 * below, the Phase 27 anti-self-corroboration invariant applied one layer
 * upstream of contract.ts's `assertNoAiSelfCorroboration`.
 */
import type { MemoryAuthority, MemoryClass } from '../memory/governance.js';
import type { SteeringLayer } from '../context/contract.js';
import type { LearningSignalProvenanceKind, LearningSignalType } from './contract.js';

/**
 * Why a signal did or did not produce a candidate. Recorded on every
 * processed signal (never silently dropped — Phase 27B handoff §4/§19),
 * closed list enforced by a DB CHECK on `learning_signal_candidate_outcome`.
 */
export const LEARNING_SIGNAL_CANDIDATE_ELIGIBILITIES = [
  'eligible',
  'insufficient_evidence',
  'negative_feedback_only',
  'duplicate',
  'unsupported_scope',
  'ai_only',
  'blocked_by_policy',
] as const;
export type LearningSignalCandidateEligibility =
  (typeof LEARNING_SIGNAL_CANDIDATE_ELIGIBILITIES)[number];

export interface LearningSignalEligibilityInput {
  readonly signalType: LearningSignalType;
  readonly provenanceKind: LearningSignalProvenanceKind;
  readonly proposedMemoryLayer: SteeringLayer | null;
  readonly evidenceRefCount: number;
  readonly sensitivity: 'normal' | 'confidential' | 'restricted';
  /** From `provenance.hasNote` — Meri feedback signals only; ignored otherwise. */
  readonly hasNote: boolean;
  /** From `provenance.reasons?.length` — Meri feedback signals only; ignored otherwise. */
  readonly reasonCount: number;
}

export interface LearningSignalEligibilityDecision {
  readonly eligibility: LearningSignalCandidateEligibility;
  readonly reason: string;
}

/**
 * Intrinsic (DB-free) eligibility. First-match-wins, same style as
 * `memory-candidate-rules.ts`. Does NOT decide `duplicate` — the caller
 * checks that separately (against active memory + pending candidates)
 * only once every check here has already passed, so a duplicate check is
 * never wasted on a signal that couldn't produce a candidate anyway.
 */
export function classifyLearningSignalEligibility(
  input: LearningSignalEligibilityInput,
): LearningSignalEligibilityDecision {
  if (input.signalType === 'crm_finding_rejected') {
    return {
      eligibility: 'negative_feedback_only',
      reason:
        'A rejected finding is suppression/negative-feedback evidence, never a new factual ' +
        'candidate — rejecting "Jane Doe is VP" does not establish "Jane Doe is NOT VP".',
    };
  }

  if (input.provenanceKind === 'ai_generated_only') {
    return {
      eligibility: 'ai_only',
      reason:
        'No human has confirmed this signal; AI-generated evidence cannot self-corroborate ' +
        'into a governed candidate.',
    };
  }

  if (input.sensitivity === 'restricted') {
    return {
      eligibility: 'blocked_by_policy',
      reason:
        'Restricted-sensitivity signals require an explicit review policy not yet implemented ' +
        'in Phase 27B; held back rather than routed into the general candidate queue.',
    };
  }

  if (!input.proposedMemoryLayer) {
    return {
      eligibility: 'unsupported_scope',
      reason: 'The signal does not map to any of the five frozen context layers.',
    };
  }

  if (input.evidenceRefCount === 0) {
    return {
      eligibility: 'insufficient_evidence',
      reason: 'No evidence references are attached to this signal.',
    };
  }

  const isMeriRating =
    input.signalType === 'meri_feedback_positive' || input.signalType === 'meri_feedback_negative';
  if (isMeriRating && !input.hasNote && input.reasonCount === 0) {
    return {
      eligibility: 'insufficient_evidence',
      reason:
        'A bare thumbs up/down with no note or reason codes is not explicit enough to justify ' +
        'a memory candidate — not every rating becomes memory.',
    };
  }

  return {
    eligibility: 'eligible',
    reason: 'Signal carries explicit human evidence and maps to a supported context layer.',
  };
}

export interface LearningSignalAuthorityProposalInput {
  readonly signalType: LearningSignalType;
  readonly hasNote: boolean;
  readonly reasonCount: number;
  readonly evidenceRefCount: number;
  /** `provenance.source` on a CRM Fill signal (e.g. 'sam_gov', 'public_web'); absent for Meri. */
  readonly crmSource?: string | null;
}

export interface LearningSignalCandidateAuthorityProposal {
  readonly memoryClass: MemoryClass;
  readonly memoryAuthority: MemoryAuthority;
  /** [0,1]. Never derived from repetition/corroboration count — see contract.ts. */
  readonly proposedConfidence: number;
  /** Always non-empty — "it is acceptable to emit proposedConfidence + confidenceReasons[]
   *  rather than pretending precision exists" (Phase 27B handoff §14). */
  readonly confidenceReasons: readonly string[];
}

/** External registries a human accepting a finding sourced from them can be treated as
 *  corroborated by, not merely verified by that one human. */
const AUTHORITATIVE_CRM_SOURCES: ReadonlySet<string> = new Set(['sam_gov', 'lda']);

/**
 * Only called for signals `classifyLearningSignalEligibility` already found
 * `eligible` — i.e. `signalType` is one of `meri_feedback_positive`,
 * `meri_feedback_negative`, or `crm_finding_accepted`. Never returns
 * `firm_approved`/`client_approved`: those require an actual human approval
 * decision on the candidate itself (memory-governance-lifecycle.helpers.ts),
 * not a generation-time guess.
 */
export function proposeLearningSignalCandidateAuthority(
  input: LearningSignalAuthorityProposalInput,
): LearningSignalCandidateAuthorityProposal {
  const reasons: string[] = [];

  if (
    input.signalType === 'meri_feedback_positive' ||
    input.signalType === 'meri_feedback_negative'
  ) {
    reasons.push(
      "A human explicitly rated Meri's own output about themselves (human_explicit provenance).",
    );
    let confidence = 0.45;
    if (input.hasNote) {
      confidence += 0.15;
      reasons.push('An explanatory note was left, not just a bare rating.');
    }
    if (input.reasonCount > 0) {
      confidence += 0.05;
      reasons.push(`${input.reasonCount} structured reason code(s) selected.`);
    }
    if (input.evidenceRefCount >= 2) {
      confidence += 0.05;
      reasons.push('Evidence points at both the message and its conversation.');
    }
    return {
      memoryClass: 'user_preference',
      memoryAuthority: 'user_asserted',
      proposedConfidence: Math.min(0.85, confidence),
      confidenceReasons: reasons,
    };
  }

  // Only remaining eligible signalType: 'crm_finding_accepted'.
  const authoritative = input.crmSource != null && AUTHORITATIVE_CRM_SOURCES.has(input.crmSource);
  reasons.push('A human admin explicitly accepted this finding (human_explicit provenance).');
  let confidence = 0.5;
  if (authoritative) {
    reasons.push(`Underlying source "${input.crmSource}" is an authoritative external registry.`);
    confidence = 0.75;
  } else {
    reasons.push(
      `Underlying source "${input.crmSource ?? 'unknown'}" is not an authoritative registry — ` +
        'treated as human-verified only, not independently corroborated.',
    );
  }
  if (input.evidenceRefCount >= 2) {
    confidence += 0.05;
    reasons.push('Evidence points at both the finding and its Fill-with-Meri run.');
  }
  return {
    memoryClass: 'client_steering',
    memoryAuthority: authoritative ? 'external_authoritative' : 'analyst_verified',
    proposedConfidence: Math.min(0.9, confidence),
    confidenceReasons: reasons,
  };
}
