/**
 * funding-model — the PE detail page's per-FY funding lifecycle view-model.
 *
 * The canonical "which stage counts" precedence now lives in @capiro/shared
 * (currentFunding / congressionalPosition / FUNDING_*_PRECEDENCE) so the API's
 * server-side funding figures (finder list current, spark, capability current)
 * and this page share ONE implementation and cannot drift. This module keeps
 * the web-shaped `buildFundingSeries` (coerces the API's string|number|null
 * money fields, returns a per-FY series) and re-exports the shared primitives
 * under the historical names its importers already use.
 *
 * All dollar values are the canonical PE unit: MILLIONS (program_element_year is
 * stored in millions; this module never rescales).
 */
import type { ProgramElementYearPoint } from './types.js';
import {
  FUNDING_STAGE_LABEL,
  FUNDING_CURRENT_PRECEDENCE,
  FUNDING_CONGRESSIONAL_PRECEDENCE,
  currentFunding as sharedCurrentFunding,
  congressionalPosition as sharedCongressionalPosition,
  type FundingStage as SharedFundingStage,
  type FundingPick,
  type FundingStageValues,
} from '@capiro/shared';

// Re-export the shared canonical primitives under this module's historical
// names so existing importers (FyHistoryChart, ProgramElementWatchPage, tests)
// are unchanged while the ONE implementation lives in @capiro/shared.
export type FundingStage = SharedFundingStage;
export type StagePick = FundingPick;
export const STAGE_LABEL = FUNDING_STAGE_LABEL;
export const CURRENT_PRECEDENCE = FUNDING_CURRENT_PRECEDENCE;
export const CONGRESSIONAL_PRECEDENCE = FUNDING_CONGRESSIONAL_PRECEDENCE;
export const currentFunding = sharedCurrentFunding;
export const congressionalPosition = sharedCongressionalPosition;

export interface FundingPoint extends FundingStageValues {
  fy: number;
  /**
   * Furthest-along value INCLUDING the request fallback — what the trajectory
   * line and the bar chart plot. `stage` names where it came from. `value` is
   * null (stage 'none') only when the year carries no stage at all.
   */
  current: FundingPick;
  /**
   * Furthest-along CONGRESSIONAL value, excluding the request. `value` null
   * (stage 'none') for request-only or empty years.
   */
  congressional: FundingPick;
  /** congressional.value − request, when both exist; else null. + = Congress added. */
  deltaVsRequest: number | null;
}

/** Coerce the API's string | number | null money field to a finite number or null. */
function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the canonical per-FY funding series, sorted ascending by fiscal year.
 * Every funding chart consumes this — no chart re-derives stage precedence.
 */
export function buildFundingSeries(years: ProgramElementYearPoint[]): FundingPoint[] {
  return [...years]
    .map((year): FundingPoint => {
      const values: FundingStageValues = {
        request: toNum(year.request),
        hascMark: toNum(year.hascMark),
        sascMark: toNum(year.sascMark),
        hacDMark: toNum(year.hacDMark),
        sacDMark: toNum(year.sacDMark),
        conference: toNum(year.conference),
        enacted: toNum(year.enacted),
      };
      const current = currentFunding(values);
      const congressional = congressionalPosition(values);
      const deltaVsRequest =
        congressional.value != null && values.request != null
          ? congressional.value - values.request
          : null;
      return { fy: year.fy, ...values, current, congressional, deltaVsRequest };
    })
    .sort((a, b) => a.fy - b.fy);
}
