import type {
  DefenseBudgetVerificationResultV1,
  VerificationRequestV1,
} from '../../verification/verification-contract-v1.js';
import type { BudgetVerificationV1Service } from '../../verification/services/budget-verification-v1.service.js';

export interface RdtePhase2VerificationCaptureV1 {
  latest: DefenseBudgetVerificationResultV1 | null;
  results: DefenseBudgetVerificationResultV1[];
}

/**
 * Wrap the final Phase 2 service without changing its trust implementation.
 * The wrapper only injects already-built independent reference descriptors and
 * captures exact results for the cycle bundle.
 */
export function createRdtePhase2VerificationAdapter(input: {
  delegate: BudgetVerificationV1Service;
  referenceArtifacts?: VerificationRequestV1['referenceArtifacts'];
}): {
  service: BudgetVerificationV1Service;
  capture: RdtePhase2VerificationCaptureV1;
} {
  const capture: RdtePhase2VerificationCaptureV1 = { latest: null, results: [] };
  const service = {
    async verify(request: VerificationRequestV1) {
      const result = await input.delegate.verify({
        ...request,
        ...(input.referenceArtifacts && input.referenceArtifacts.length > 0
          ? { referenceArtifacts: input.referenceArtifacts }
          : {}),
      });
      capture.latest = result;
      capture.results.push(result);
      return result;
    },
  } as unknown as BudgetVerificationV1Service;
  return { service, capture };
}
