import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
  type CapabilityRolloutValidation,
} from './capability-rollout';

/**
 * Stage 4a rollout. Dark by default; MeriV3 resolves this against the real turn tenant/surface.
 */
export const MATCH_LABEL_CAPABILITY = 'MATCH_LABEL' as const;

export function resolveMatchLabelMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({ capability: MATCH_LABEL_CAPABILITY, env, tenantId, surface })
    .mode;
}

export function validateMatchLabelConfig(
  env: CapabilityRolloutEnvironment,
): CapabilityRolloutValidation {
  return validateCapabilityRolloutConfig({ capability: MATCH_LABEL_CAPABILITY, env });
}
