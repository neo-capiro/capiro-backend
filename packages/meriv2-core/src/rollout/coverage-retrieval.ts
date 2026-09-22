import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
  type CapabilityRolloutValidation,
} from './capability-rollout';

export const COVERAGE_RETRIEVAL_CAPABILITY = 'COVERAGE_RETRIEVAL' as const;

export function resolveCoverageRetrievalMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({
    capability: COVERAGE_RETRIEVAL_CAPABILITY,
    env,
    tenantId,
    surface,
  }).mode;
}

export function validateCoverageRetrievalConfig(
  env: CapabilityRolloutEnvironment,
): CapabilityRolloutValidation {
  return validateCapabilityRolloutConfig({ capability: COVERAGE_RETRIEVAL_CAPABILITY, env });
}
