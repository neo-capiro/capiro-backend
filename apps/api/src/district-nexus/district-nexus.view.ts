/**
 * District Nexus map/detail query contracts (Rev 2 plan, WS-E1/E2).
 *
 * ── Why `view=future` is rejected rather than implemented ───────────────────
 *
 * The plan's E1 DTO offers `view=current|future`, and the prototype has an
 * "Enacted future" toggle. The toggle ships DISABLED, titled "No enacted-future
 * boundary artifact has been built yet", and that is the honest state for three
 * independent reasons:
 *
 *   1. The 'F' boundary rail reads each district's re-hosted `kmlS3Key`, which
 *      only `sync-legistorm-districts --commit --with-kml` populates.
 *   2. More fundamentally, award geography is reported against CURRENT
 *      districts. USAspending's congressional_code is the as-reported (original)
 *      vintage. There is no re-attribution from a current-district award to a
 *      future boundary that would not be invention.
 *   3. Nothing in the aggregation layer has any notion of status —
 *      `foldDistricts` emits `status: 'C'` as a literal.
 *
 * So a future-view request cannot be answered, and the dangerous failure is not
 * an error: it is returning the CURRENT map under a "future" label, which looks
 * entirely plausible and is wrong. Rejecting loudly is the only safe behaviour
 * until a future rail genuinely exists. When it does, the fix is here and in
 * foldDistricts — not in the callers.
 */

/** Boundary vintage a request is asking about. */
export type DistrictNexusView = 'current' | 'future';

/** Views the backend can actually answer today. */
export const SUPPORTED_VIEWS: readonly DistrictNexusView[] = ['current'];

export const DEFAULT_VIEW: DistrictNexusView = 'current';

export class UnsupportedViewError extends Error {
  constructor(readonly requested: string) {
    super(
      `The "${requested}" district view is not available: no enacted-future boundary artifact has been built, and award geography is reported against current districts, so it cannot be re-attributed to future boundaries.`,
    );
    this.name = 'UnsupportedViewError';
  }
}

/**
 * Normalize and validate a `view` query parameter.
 *
 * Absent/empty means `current` — the default is the answerable one. Anything
 * we cannot answer throws rather than silently degrading, because a silently
 * degraded answer here is indistinguishable from a correct one.
 */
export function parseView(raw: string | null | undefined): DistrictNexusView {
  if (raw == null || raw === '') return DEFAULT_VIEW;
  const value = raw.trim().toLowerCase();
  if ((SUPPORTED_VIEWS as readonly string[]).includes(value)) {
    return value as DistrictNexusView;
  }
  // 'future' is a real, spelled-out view that we deliberately cannot serve;
  // anything else is simply not a view. Both are rejected, and the message
  // distinguishes them so an operator can tell a gap from a typo.
  if (value === 'future') throw new UnsupportedViewError('future');
  throw new UnsupportedViewError(value);
}
