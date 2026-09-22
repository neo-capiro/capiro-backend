import {
  EVIDENCE_ACCURACY_CAPABILITY,
  resolveEvidenceAccuracyMode,
  validateCapabilityRolloutConfig,
  type AssuranceSurface,
  type CapabilityRolloutMode,
} from '@capiro/meriv2-core';

interface EvidenceAccuracyConfigLogger {
  warn(message: string, context?: Record<string, unknown>): unknown;
}

export function resolveEvidenceAccuracyModeForTenant(
  tenantId: string | null | undefined,
  surface: AssuranceSurface = 'chat',
  env: NodeJS.ProcessEnv = process.env,
): CapabilityRolloutMode {
  return resolveEvidenceAccuracyMode(env, tenantId, surface);
}

export function logEvidenceAccuracyConfigIssues(
  logger: EvidenceAccuracyConfigLogger,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const validation = validateCapabilityRolloutConfig({
    capability: EVIDENCE_ACCURACY_CAPABILITY,
    env,
  });
  if (!validation.ok) {
    logger.warn('meri.evidence_accuracy.invalid_config', { issues: validation.issues });
  }
}
