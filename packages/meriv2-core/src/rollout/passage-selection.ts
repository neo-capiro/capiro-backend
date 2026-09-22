import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
  type CapabilityRolloutValidation,
} from './capability-rollout';

export const PASSAGE_SELECTION_CAPABILITY = 'PASSAGE_SELECTION' as const;

export function resolvePassageSelectionMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({ capability: PASSAGE_SELECTION_CAPABILITY, env, tenantId, surface }).mode;
}

export function validatePassageSelectionConfig(
  env: CapabilityRolloutEnvironment,
): CapabilityRolloutValidation {
  return validateCapabilityRolloutConfig({ capability: PASSAGE_SELECTION_CAPABILITY, env });
}