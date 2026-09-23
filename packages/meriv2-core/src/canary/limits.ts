export const CANARY_LIMITS_VERSION = 'stage2-canary-limits-v1' as const;

/**
 * Capture a capability-off baseline window first. These limits are predeclared
 * and must not be tuned after observing canary results.
 */
export const CANARY_LIMITS_V1 = {
  holds: 0,
  clarificationRateDeltaPp: 2,
  repairLatencyP50Ms: 3_000,
  repairLatencyP95Ms: 8_000,
  passageRequiredRetention: 1,
  timeToTextP95DeltaMs: 4_000,
  costPerCompletedTurnDeltaPct: 40,
} as const;

export const CANARY_LIMITS_V2_VERSION = 'stage2-canary-limits-v2' as const;

/**
 * Additive limits predeclared before intervention and incomplete-outcome canary
 * data exists. V1 remains unchanged for reproducible historical reports.
 */
export const CANARY_LIMITS_V2 = {
  ...CANARY_LIMITS_V1,
  passageSafetyInterventionRate: 0.05,
  completionRateDropPp: 2,
  errorRateDeltaPp: 1,
  abortRateDeltaPp: 1,
  incompleteRateDeltaPp: 1,
} as const;
