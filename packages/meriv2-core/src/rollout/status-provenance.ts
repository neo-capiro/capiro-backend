import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
  type CapabilityRolloutValidation,
} from './capability-rollout';

/**
 * Stage 4b status lookup rollout. The API schema builder resolves this before exposing
 * get_certification_status; off therefore preserves the prior schema list exactly.
 */
export const STATUS_PROVENANCE_CAPABILITY = 'STATUS_PROVENANCE' as const;

export function resolveStatusProvenanceMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({
    capability: STATUS_PROVENANCE_CAPABILITY,
    env,
    tenantId,
    surface,
  }).mode;
}

export function validateStatusProvenanceConfig(
  env: CapabilityRolloutEnvironment,
): CapabilityRolloutValidation {
  return validateCapabilityRolloutConfig({ capability: STATUS_PROVENANCE_CAPABILITY, env });
}
