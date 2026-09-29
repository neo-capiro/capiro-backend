import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
  type CapabilityRolloutValidation,
} from './capability-rollout';

export const JEV_CACHE_CAPABILITY = 'JEV_CACHE' as const;

export function resolveJevCacheMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({ capability: JEV_CACHE_CAPABILITY, env, tenantId, surface })
    .mode;
}

export function validateJevCacheConfig(
  env: CapabilityRolloutEnvironment,
): CapabilityRolloutValidation {
  return validateCapabilityRolloutConfig({ capability: JEV_CACHE_CAPABILITY, env });
}
