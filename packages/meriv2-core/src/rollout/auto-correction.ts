import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
  type CapabilityRolloutValidation,
} from './capability-rollout';

export const AUTO_CORRECTION_CAPABILITY = 'AUTO_CORRECTION' as const;

export function resolveAutoCorrectionMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({
    capability: AUTO_CORRECTION_CAPABILITY,
    env,
    tenantId,
    surface,
  }).mode;
}

export function validateAutoCorrectionConfig(
  env: CapabilityRolloutEnvironment,
): CapabilityRolloutValidation {
  return validateCapabilityRolloutConfig({ capability: AUTO_CORRECTION_CAPABILITY, env });
}
