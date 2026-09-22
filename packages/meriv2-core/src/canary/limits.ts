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
