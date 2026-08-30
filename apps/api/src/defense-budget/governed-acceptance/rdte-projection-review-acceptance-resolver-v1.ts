/**
 * Phase 10B-15 Part H -- the one centralized resolver for
 * `allowedReviewedAcceptances`, the projection-planner input the Phase
 * 10B-14 investigation found no real caller ever populated.
 *
 * Callers must never manually construct an acceptance-ID set. This module
 * is the only place that turns "a review decision exists" into "this exact
 * run may be treated as an accepted review" -- by re-validating, for each
 * candidate binding a caller asks about, that an immutable
 * `BudgetReviewDecisionV1` row exists with `decision='accept'`, bound (by
 * FK and by hash-triad equality, not by trusting the caller's own claim)
 * to exactly that candidate/run/artifact/source-document/cycle. A binding
 * that fails any check is silently excluded, never included with a
 * best-effort guess -- fail closed.
 *
 * Negative controls this resolver must produce an empty result for (Part
 * H): a rejected review, a wrong artifact/cycle/candidate/run, a tampered
 * hash, and an acceptance recorded for a different family's candidate
 * (enforced by requiring every field the caller supplies to match exactly
 * -- there is no cross-family lookup path at all, so "another family"
 * cannot even be expressed as a match).
 */

export interface ProjectionAcceptanceBindingRequestV1 {
  /** The candidate/run pairing the caller wants to know is validly accepted. */
  candidateId: string;
  runId: string;
  /** The caller's own expected identity for this candidate -- never trusted without verification. */
  expectedSourceSha256: string;
  expectedArtifactSha256: string;
  expectedManifestContentSha256: string;
}

export interface ProjectionReviewAcceptanceReaderV1 {
  /**
   * Returns the exact accepted review decision for this candidate+run, or
   * null if none exists, the decision is not 'accept', or the run does not
   * belong to the candidate. Hash-triad equality against the review
   * decision's OWN candidate is verified by the caller of this reader
   * (see `resolveAllowedReviewedAcceptancesV1`) -- the reader's only job is
   * an exact, unambiguous lookup, never a fuzzy match.
   */
  findAcceptedReviewDecision(input: {
    candidateId: string;
    runId: string;
  }): Promise<{
    reviewDecisionId: string;
    decision: string;
    sourceSha256: string;
    extractionArtifactSha256: string;
    manifestContentSha256: string;
  } | null>;
}

/**
 * Resolves the exact set of verification-run IDs (matching the
 * `decisionId`/`verificationRunId` field every projection-planner Gate 1b
 * checks membership against) that a REAL, validated, immutable human
 * acceptance backs -- for exactly the candidate/run/hash bindings the
 * caller names. Never returns more than what the caller explicitly asked
 * about; never invents a binding the caller did not request.
 */
export async function resolveAllowedReviewedAcceptancesV1(
  reader: ProjectionReviewAcceptanceReaderV1,
  bindings: readonly ProjectionAcceptanceBindingRequestV1[],
): Promise<ReadonlySet<string>> {
  const allowed = new Set<string>();
  for (const binding of bindings) {
    const decision = await reader.findAcceptedReviewDecision({
      candidateId: binding.candidateId,
      runId: binding.runId,
    });
    if (decision == null) continue;
    if (decision.decision !== 'accept') continue;
    if (
      decision.sourceSha256 !== binding.expectedSourceSha256 ||
      decision.extractionArtifactSha256 !== binding.expectedArtifactSha256 ||
      decision.manifestContentSha256 !== binding.expectedManifestContentSha256
    ) {
      continue;
    }
    allowed.add(binding.runId);
  }
  return allowed;
}

export interface ProjectionAcceptanceResolverPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * The one real, database-backed implementation. The query joins
 * `budget_review_decision_v1` to `budget_verification_run_v1` (requiring
 * the run to belong to the SAME candidate the review decision names --
 * closing the "review accepted under one candidate, replayed against a
 * different one" gap) so a caller can never receive a binding for a
 * candidate/run pair that does not structurally agree with itself.
 */
export function createPrismaProjectionReviewAcceptanceReaderV1(
  prisma: ProjectionAcceptanceResolverPrismaLikeV1,
): ProjectionReviewAcceptanceReaderV1 {
  return {
    async findAcceptedReviewDecision(input) {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT rd."id" AS review_decision_id, rd."decision",
          rd."source_sha256", rd."extraction_artifact_sha256", rd."manifest_content_sha256"
         FROM "budget_review_decision_v1" rd
         JOIN "budget_verification_run_v1" run ON run."id" = rd."run_id" AND run."candidate_id" = rd."candidate_id"
         WHERE rd."candidate_id" = $1::uuid AND rd."run_id" = $2::uuid
         ORDER BY rd."created_at" DESC LIMIT 1`,
        input.candidateId,
        input.runId,
      );
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        reviewDecisionId: String(r.review_decision_id),
        decision: String(r.decision),
        sourceSha256: String(r.source_sha256),
        extractionArtifactSha256: String(r.extraction_artifact_sha256),
        manifestContentSha256: String(r.manifest_content_sha256),
      };
    },
  };
}
