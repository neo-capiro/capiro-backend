import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
  type CapabilityRolloutValidation,
} from './capability-rollout';

export const EVIDENCE_PROFILES_CAPABILITY = 'EVIDENCE_PROFILES' as const;

export function resolveEvidenceProfilesMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({ capability: EVIDENCE_PROFILES_CAPABILITY, env, tenantId, surface }).mode;
}

export function validateEvidenceProfilesConfig(env: CapabilityRolloutEnvironment): CapabilityRolloutValidation {
  return validateCapabilityRolloutConfig({ capability: EVIDENCE_PROFILES_CAPABILITY, env });
}