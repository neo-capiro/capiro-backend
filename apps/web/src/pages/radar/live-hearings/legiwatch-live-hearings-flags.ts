const FALSE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'no']);

/** Must byte-match the tenant-scoped intel feature flag stored in intel-api. */
export const LEGIWATCH_LIVE_HEARINGS_V2_FEATURE = 'legiwatchLiveHearingsV2';

/**
 * Build-time emergency kill switch for the canonical Live Hearings surface.
 * It can only disable; it can never activate V2 by itself.
 */
export function legiwatchLiveHearingsV2KillSwitchAllows(
  raw = import.meta.env.VITE_LEGIWATCH_LIVE_HEARINGS_V2,
): boolean {
  if (raw === undefined || raw === null || raw.trim() === '') return true;
  return !FALSE_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Final Phase 9 rollout decision.
 *
 * - SHADOW/CANARY/READY: only an explicitly enabled tenant sees V2.
 * - CUTOVER: the guarded server default may enable V2 for every tenant.
 * - ROLLBACK or an unresolved rollout request: fail closed to the preserved UI.
 * - The build-time emergency switch can always disable either route.
 */
export function legiwatchLiveHearingsV2Enabled(input: {
  tenantFlagEnabled: boolean;
  tenantFlagReady: boolean;
  rolloutReady?: boolean;
  productionDefaultEnabled?: boolean;
  forceLegacy?: boolean;
  killSwitchAllows?: boolean;
}): boolean {
  const killSwitchAllows =
    input.killSwitchAllows ?? legiwatchLiveHearingsV2KillSwitchAllows();
  if (!killSwitchAllows || !input.rolloutReady || input.forceLegacy) return false;
  const tenantCanary = input.tenantFlagReady && input.tenantFlagEnabled;
  return Boolean(tenantCanary || input.productionDefaultEnabled);
}
