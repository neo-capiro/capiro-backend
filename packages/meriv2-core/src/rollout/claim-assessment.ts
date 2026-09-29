import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
} from './capability-rollout';

export const CLAIM_ASSESSMENT_CAPABILITY = 'CLAIM_ASSESSMENT' as const;

/** Stage 1 treats both shadow and enforce as non-blocking post-release assessment. */
export function resolveClaimAssessmentMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({
    capability: CLAIM_ASSESSMENT_CAPABILITY,
    env,
    tenantId,
    surface,
  }).mode;
}
