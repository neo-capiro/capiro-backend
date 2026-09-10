/**
 * candidate-correction-policy-v1 -- Phase 10B-35c.
 *
 * Pure eligibility evaluation for "record candidate NEW as the correction of
 * candidate OLD". No I/O, no Prisma, no supersession side effects -- exactly
 * the same shape as `scoped-fact-review-policy-v1.ts`'s
 * `evaluateScopedFactReviewEligibilityV1`, so both mechanisms are reviewed
 * the same way.
 *
 * What "eligible" means here, and why:
 *   - The OLD candidate must exist and be in a status this mechanism is
 *     allowed to correct. `NEEDS_REVIEW` is the exact status of the real
 *     production candidate this mechanism was built for (a pre-fix parser
 *     result awaiting whole-candidate review) and `REJECTED` is included
 *     because a genuinely broken extraction can also need a corrected
 *     re-verification. `REVIEW_ACCEPTED` is deliberately EXCLUDED: an
 *     already-accepted whole-candidate decision is a distinct, heavier
 *     correction problem (it may already be feeding canonical/legacy
 *     tables) that this bounded mechanism does not attempt to solve -- an
 *     accepted candidate is corrected, if ever, through the existing
 *     whole-candidate review/promotion machinery, not this one.
 *   - The NEW candidate must exist, must differ from the OLD candidate, and
 *     must be bound to the SAME source document and source bytes (a
 *     correction is a corrected RE-READING of the same evidence, never a
 *     link between two unrelated documents -- enforced again, redundantly,
 *     by the DB trigger `check_budget_candidate_correction_v1_binding`).
 *   - The NEW candidate must not itself be REJECTED (correcting a tainted
 *     candidate with a still-broken one would defeat the purpose).
 *
 * What this policy does NOT decide:
 *   - Whether the OLD candidate already has a correction on file (that is a
 *     storage-layer fact, resolved by the unique index +
 *     `CandidateCorrectionV1Service`'s idempotency/refusal logic, not a
 *     policy question -- the DB state can change between a dry-run preview
 *     and a commit, and the unique index is the authority of record).
 *   - Whether to call `supersedeAllForCandidate()` (always attempted by the
 *     service on commit, harmless/no-op when there is nothing active).
 */

export const CANDIDATE_CORRECTION_POLICY_ID_V1 = 'phase10b35c-candidate-correction-v1';
export const CANDIDATE_CORRECTION_POLICY_VERSION_V1 = '1.0.0';

/** Whole-candidate statuses this mechanism may correct FROM. */
export const CORRECTABLE_OLD_CANDIDATE_STATUSES_V1 = ['NEEDS_REVIEW', 'REJECTED'] as const;
export type CorrectableOldCandidateStatusV1 = (typeof CORRECTABLE_OLD_CANDIDATE_STATUSES_V1)[number];

/** Whole-candidate statuses a NEW (corrected) candidate must NOT be in. */
const INELIGIBLE_NEW_CANDIDATE_STATUSES_V1 = ['REJECTED'] as const;

export interface CandidateCorrectionCandidateSnapshotV1 {
  id: string;
  status: string;
  sourceDocumentId: string;
  sourceSha256: string;
}

export type CandidateCorrectionRefusalCodeV1 =
  | 'old_candidate_status_not_correctable'
  | 'new_candidate_status_ineligible'
  | 'old_equals_new'
  | 'source_identity_mismatch';

export interface CandidateCorrectionRefusalV1 {
  code: CandidateCorrectionRefusalCodeV1;
  detail: string;
}

export interface CandidateCorrectionEligibilityResultV1 {
  eligible: boolean;
  refusalReasons: CandidateCorrectionRefusalV1[];
  policy: { id: string; version: string };
}

export function evaluateCandidateCorrectionEligibilityV1(input: {
  oldCandidate: CandidateCorrectionCandidateSnapshotV1;
  newCandidate: CandidateCorrectionCandidateSnapshotV1;
}): CandidateCorrectionEligibilityResultV1 {
  const refusalReasons: CandidateCorrectionRefusalV1[] = [];
  const { oldCandidate, newCandidate } = input;

  if (oldCandidate.id === newCandidate.id) {
    refusalReasons.push({
      code: 'old_equals_new',
      detail: `candidate ${oldCandidate.id} cannot correct itself`,
    });
  }

  if (!(CORRECTABLE_OLD_CANDIDATE_STATUSES_V1 as readonly string[]).includes(oldCandidate.status)) {
    refusalReasons.push({
      code: 'old_candidate_status_not_correctable',
      detail: `old candidate ${oldCandidate.id} is ${oldCandidate.status}; only ${CORRECTABLE_OLD_CANDIDATE_STATUSES_V1.join(' or ')} may be corrected`,
    });
  }

  if ((INELIGIBLE_NEW_CANDIDATE_STATUSES_V1 as readonly string[]).includes(newCandidate.status)) {
    refusalReasons.push({
      code: 'new_candidate_status_ineligible',
      detail: `new candidate ${newCandidate.id} is ${newCandidate.status}; a correction cannot itself be a rejected extraction`,
    });
  }

  if (
    oldCandidate.sourceDocumentId !== newCandidate.sourceDocumentId ||
    oldCandidate.sourceSha256 !== newCandidate.sourceSha256
  ) {
    refusalReasons.push({
      code: 'source_identity_mismatch',
      detail:
        `old candidate ${oldCandidate.id} (source ${oldCandidate.sourceDocumentId}/${oldCandidate.sourceSha256}) and ` +
        `new candidate ${newCandidate.id} (source ${newCandidate.sourceDocumentId}/${newCandidate.sourceSha256}) ` +
        'do not share the same source document and bytes',
    });
  }

  return {
    eligible: refusalReasons.length === 0,
    refusalReasons,
    policy: { id: CANDIDATE_CORRECTION_POLICY_ID_V1, version: CANDIDATE_CORRECTION_POLICY_VERSION_V1 },
  };
}
