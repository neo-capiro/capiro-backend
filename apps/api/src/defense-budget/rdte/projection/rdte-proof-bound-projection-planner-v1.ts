/** Production Phase 4 projection entry point with exact Phase 2 proof binding. */
import type { RdteCycleBundleV1 } from '../rdte-cycle-bundle-v1.js';
import {
  computeProjectionPlanContentSha256,
  proofBoundRdteCanonicalProjectionPlanV1Schema,
  type ProofBoundRdteCanonicalProjectionPlanV1,
} from './rdte-canonical-projection-plan-v1.js';
import {
  planRdteCanonicalProjection,
  type RdteCanonicalRowSnapshotV1,
} from './rdte-projection-planner-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

/**
 * The legacy pure mapper predates the final Phase 2 result contract and emits
 * compatibility IDs only. This wrapper is the required production boundary:
 * it joins every candidate to the exact certified verification reference and
 * fails closed if any proof field or accepted-assertion binding is absent.
 */
export function planProofBoundRdteCanonicalProjection(input: {
  bundle: RdteCycleBundleV1;
  artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  canonicalRows?: RdteCanonicalRowSnapshotV1;
}): { plan: ProofBoundRdteCanonicalProjectionPlanV1 } {
  const mapped = planRdteCanonicalProjection({
    bundle: input.bundle,
    artifacts: input.artifacts,
    ...(input.canonicalRows ? { canonicalRows: input.canonicalRows } : {}),
  });
  const verificationByKey = new Map(
    input.bundle.verifications.map((verification) => [
      verification.manifestDocumentKey,
      verification,
    ]),
  );
  // ProgramElement merge can attach R-2 narrative assertion IDs onto an R-1-owned
  // identity candidate. Acceptance must therefore be checked against the full set of
  // trusted terminal Phase 2 results for this certified cycle, not only the owning
  // document's ledger. Provenance/identity binding below still pins the candidate to
  // its owning document verification.
  const cycleAcceptedAssertionIds = new Set<string>();
  for (const verification of input.bundle.verifications) {
    const trustedTerminal =
      (verification.phase2Decision === 'PASS' && verification.status === 'VERIFICATION_PASSED') ||
      (verification.phase2Decision === 'REVIEW' && verification.status === 'REVIEW_ACCEPTED');
    if (!trustedTerminal) continue;
    for (const assertionId of verification.acceptedAssertionIds) {
      cycleAcceptedAssertionIds.add(assertionId);
    }
  }

  const candidates = mapped.plan.candidates.map((candidate) => {
    const verification = verificationByKey.get(candidate.sourceDocumentKey);
    if (!verification) {
      throw new Error(
        `projection candidate ${candidate.candidateId} has no certified verification reference`,
      );
    }
    const trustedTerminal =
      (verification.phase2Decision === 'PASS' && verification.status === 'VERIFICATION_PASSED') ||
      (verification.phase2Decision === 'REVIEW' && verification.status === 'REVIEW_ACCEPTED');
    if (!trustedTerminal) {
      throw new Error(
        `projection candidate ${candidate.candidateId} is governed by non-terminal verification ` +
          `${verification.phase2Decision}/${verification.status}`,
      );
    }
    if (
      candidate.verificationCandidateId !== verification.candidateId ||
      candidate.verificationRunId !== verification.verificationRunId ||
      candidate.verificationDecisionId !== verification.verificationRunId ||
      candidate.artifactId !== verification.artifactId ||
      candidate.artifactContentSha256 !== verification.artifactContentSha256 ||
      candidate.sourcePdfSha256 !== verification.sourcePdfSha256
    ) {
      throw new Error(
        `projection candidate ${candidate.candidateId} is not bound to the certified Phase 2 result`,
      );
    }

    if (candidate.assertionIds.length === 0) {
      if (cycleAcceptedAssertionIds.size === 0) {
        throw new Error(
          `projection candidate ${candidate.candidateId} has no accepted Phase 2 assertion basis`,
        );
      }
    } else {
      const unaccepted = candidate.assertionIds.filter(
        (assertionId) => !cycleAcceptedAssertionIds.has(assertionId),
      );
      if (unaccepted.length > 0) {
        throw new Error(
          `projection candidate ${candidate.candidateId} contains assertions not accepted by Phase 2: ` +
            unaccepted.join(', '),
        );
      }
    }

    return {
      ...candidate,
      verificationDecision: verification.phase2Decision,
      verificationStatus: verification.status,
      verificationPolicySha256: verification.policySha256,
      sourceDocumentId: verification.sourceDocumentId,
    };
  });
  const { contentSha256: _oldHash, ...mappedWithoutHash } = mapped.plan;
  const hashInput = {
    ...mappedWithoutHash,
    candidates,
  };
  const plan = proofBoundRdteCanonicalProjectionPlanV1Schema.parse({
    ...hashInput,
    contentSha256: computeProjectionPlanContentSha256(hashInput),
  });
  return { plan };
}
