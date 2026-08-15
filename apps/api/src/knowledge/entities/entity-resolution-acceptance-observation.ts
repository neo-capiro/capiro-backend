import type { EntityResolutionGoldenObservation } from './entity-resolution-evaluator.js';
import type { MeriCompatibleEntityResolutionObservation } from './entity-resolution-meri-compat-evaluator.js';
import type { UniversalEntityResolutionOrchestrationResult } from './universal-entity-resolution-orchestrator.types.js';

/**
 * Convert real Universal Entity Resolution output into the two Phase 5 release
 * evaluator observation shapes. Acceptance harnesses should use these helpers
 * rather than constructing "perfect" observations by hand.
 */
export function toEntityResolutionGoldenObservation(
  caseId: string,
  result: UniversalEntityResolutionOrchestrationResult,
): EntityResolutionGoldenObservation {
  return {
    caseId,
    status: result.status,
    selectedCanonicalName: result.entity?.canonicalName ?? null,
    candidateCanonicalNames: uniqueCandidateNames(result),
  };
}

export function toMeriCompatibleEntityResolutionObservation(
  caseId: string,
  result: UniversalEntityResolutionOrchestrationResult,
  safety: {
    duplicateEntityCreated?: boolean;
    privateIdentityLeaked?: boolean;
  } = {},
): MeriCompatibleEntityResolutionObservation {
  return {
    caseId,
    status: result.status,
    selectedCanonicalName: result.entity?.canonicalName ?? null,
    candidateCanonicalNames: uniqueCandidateNames(result),
    attemptedStages: result.attemptedStages.map((trace) => trace.stage),
    duplicateEntityCreated: safety.duplicateEntityCreated ?? false,
    privateIdentityLeaked: safety.privateIdentityLeaked ?? false,
  };
}

function uniqueCandidateNames(
  result: UniversalEntityResolutionOrchestrationResult,
): string[] {
  const names = new Set<string>();
  for (const candidate of result.candidates) {
    const name = candidate.canonicalName.trim();
    if (name) names.add(name);
  }
  if (result.entity?.canonicalName.trim()) names.add(result.entity.canonicalName.trim());
  return [...names];
}
