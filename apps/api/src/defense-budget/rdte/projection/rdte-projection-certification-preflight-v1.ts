/** Guarded projection pass used only to complete final cycle certification. */
import {
  computeRdteCycleBundleContentSha256,
  type RdteCycleBundleV1,
} from '../rdte-cycle-bundle-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import type { RdteCanonicalRowSnapshotV1 } from './rdte-projection-planner-v1.js';
import { planProofBoundRdteCanonicalProjection } from './rdte-proof-bound-projection-planner-v1.js';

export function planRdteProjectionForCertification(input: {
  preflightBundle: RdteCycleBundleV1;
  artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  canonicalRows?: RdteCanonicalRowSnapshotV1;
}) {
  const blockerCodes = input.preflightBundle.blockingFindings.map((finding) => finding.code);
  if (blockerCodes.length !== 1 || blockerCodes[0] !== 'projection_planning_not_complete') {
    throw new Error(
      `projection preflight refused: expected sole projection blocker, got ${blockerCodes.join(', ') || 'none'}`,
    );
  }

  // Omit optional projectionPlanContentSha256 entirely — canonical JSON rejects
  // explicit undefined values, and the authorized bundle must not yet bind a plan SHA.
  const {
    contentSha256: _ignoredContentSha,
    projectionPlanContentSha256: _ignoredPlanSha,
    ...rest
  } = input.preflightBundle;
  const withoutHash = {
    ...rest,
    certification: 'CERTIFIED_RDTE_READY_FOR_PROJECTION' as const,
    blockingFindings: [],
  };
  const authorizedBundle: RdteCycleBundleV1 = {
    ...withoutHash,
    contentSha256: computeRdteCycleBundleContentSha256(withoutHash),
  };
  return planProofBoundRdteCanonicalProjection({
    bundle: authorizedBundle,
    artifacts: input.artifacts,
    ...(input.canonicalRows ? { canonicalRows: input.canonicalRows } : {}),
  });
}
