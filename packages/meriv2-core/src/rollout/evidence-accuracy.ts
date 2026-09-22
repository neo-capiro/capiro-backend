import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
} from './capability-rollout';

export const EVIDENCE_ACCURACY_CAPABILITY = 'EVIDENCE_ACCURACY' as const;

export function resolveEvidenceAccuracyMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({
    capability: EVIDENCE_ACCURACY_CAPABILITY,
    env,
    tenantId,
    surface,
  }).mode;
}

export function evidenceAccuracyEnabled(mode: CapabilityRolloutMode): boolean {
  return mode === 'shadow' || mode === 'enforce';
}

export function evidenceAccuracyEnforced(mode: CapabilityRolloutMode): boolean {
  return mode === 'enforce';
}