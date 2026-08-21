const FALSE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'no']);

/** Must byte-match the tenant-scoped intel feature flag stored in intel-api. */
export const LEGIWATCH_LIVE_HEARINGS_V2_FEATURE = 'legiwatchLiveHearingsV2';

/**
 * Global emergency kill switch for the canonical Live Hearings surface.
 *
 * This variable never enables V2 by itself. Tenant activation still comes from
 * `/intel-api/feature-flags` and therefore fails closed. Operators may set
 * `VITE_LEGIWATCH_LIVE_HEARINGS_V2=false` to return every tenant to the
 * preserved surface without changing routes or data.
 */
export function legiwatchLiveHearingsV2KillSwitchAllows(
  raw = import.meta.env.VITE_LEGIWATCH_LIVE_HEARINGS_V2,
): boolean {
  if (raw === undefined || raw === null || raw.trim() === '') return true;
  return !FALSE_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Final rollout decision. Both the global kill switch and the tenant flag must
 * be true; an unresolved feature-flag request never activates the rebuild.
 */
export function legiwatchLiveHearingsV2Enabled(input: {
  tenantFlagEnabled: boolean;
  tenantFlagReady: boolean;
  killSwitchAllows?: boolean;
}): boolean {
  return Boolean(
    input.tenantFlagReady &&
      input.tenantFlagEnabled &&
      (input.killSwitchAllows ?? legiwatchLiveHearingsV2KillSwitchAllows()),
  );
}
