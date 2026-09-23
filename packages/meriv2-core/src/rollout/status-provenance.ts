import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
  type CapabilityRolloutValidation,
} from './capability-rollout';

/**
 * Stage 4b (docs/meri/grounding/stage-4/4b-status-provenance.md), design only. Not imported by
 * any caller yet — there is no certification/controlled-status tool surface to gate. Follows the
 * identical MODE/TENANTS/SURFACES pattern as every Stage 0-2 capability.
 */
export const STATUS_PROVENANCE_CAPABILITY = 'STATUS_PROVENANCE' as const;

export function resolveStatusProvenanceMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({ capability: STATUS_PROVENANCE_CAPABILITY, env, tenantId, surface }).mode;
}

export function validateStatusProvenanceConfig(env: CapabilityRolloutEnvironment): CapabilityRolloutValidation {
  return validateCapabilityRolloutConfig({ capability: STATUS_PROVENANCE_CAPABILITY, env });
}
