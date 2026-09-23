import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
  type CapabilityRolloutValidation,
} from './capability-rollout';

/**
 * Stage 4a (docs/meri/grounding/stage-4/4a-match-labels.md), design only. Not imported by any
 * caller yet — `off` is the only mode any environment can reach, which is the current legacy
 * (free-prose "Direct match/Conditional niche/Adjacency") behavior regardless of this wrapper's
 * existence, since nothing resolves it. Follows the identical MODE/TENANTS/SURFACES pattern as
 * every Stage 0-2 capability so the eventual call site is a drop-in, not a new pattern to review.
 */
export const MATCH_LABEL_CAPABILITY = 'MATCH_LABEL' as const;

export function resolveMatchLabelMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({ capability: MATCH_LABEL_CAPABILITY, env, tenantId, surface }).mode;
}

export function validateMatchLabelConfig(env: CapabilityRolloutEnvironment): CapabilityRolloutValidation {
  return validateCapabilityRolloutConfig({ capability: MATCH_LABEL_CAPABILITY, env });
}
