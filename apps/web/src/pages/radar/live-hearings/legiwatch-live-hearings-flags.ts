const FALSE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'no']);

/**
 * Phase 0 rollout flag for the canonical Live Hearings surface.
 *
 * The rebuild is already the active product on its long-lived branch, so the
 * safe branch default is enabled. Operators can immediately fall back to the
 * preserved Phase 7/legacy surface by setting
 * `VITE_LEGIWATCH_LIVE_HEARINGS_V2=false` without changing routes or data.
 */
export function legiwatchLiveHearingsV2Enabled(
  raw = import.meta.env.VITE_LEGIWATCH_LIVE_HEARINGS_V2,
): boolean {
  if (raw === undefined || raw === null || raw.trim() === '') return true;
  return !FALSE_VALUES.has(raw.trim().toLowerCase());
}
