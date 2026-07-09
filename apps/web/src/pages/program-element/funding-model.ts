/**
 * funding-model — the SINGLE source of truth for a Program Element's per-FY
 * funding lifecycle. Every funding visualization on the PE page (Overview
 * "Funding trajectory", the Funding-tab bar chart, the Congress-vs-request
 * delta bars) must derive from `buildFundingSeries` so they cannot disagree.
 *
 * Before this module each chart re-invented its own "which stage counts" rule:
 * the Overview plotted enacted+request, the Funding bar blended
 * enacted→conference→request (ignoring committee marks — so a line Congress
 * marked at $1.5B but hasn't enacted showed a $0 bar), and the delta bars used
 * a third ladder. Same data, three answers. This model fixes the precedence in
 * one place.
 *
 * Pure + deterministic (no React, no I/O) so it is golden-fixture spec'd. All
 * dollar values are the canonical PE unit: MILLIONS (program_element_year is
 * stored in millions; this module never rescales).
 */
import type { ProgramElementYearPoint } from './types.js';

/** A point in the appropriations lifecycle a funding value can come from. */
export type FundingStage =
  | 'enacted'
  | 'conference'
  | 'sacd'
  | 'hacd'
  | 'sasc'
  | 'hasc'
  | 'request'
  | 'none';

/** Human-facing label for each stage (legends, tooltips, "Latest: …"). */
export const STAGE_LABEL: Record<FundingStage, string> = {
  enacted: 'Enacted',
  conference: 'Conference',
  sacd: 'SAC-D',
  hacd: 'HAC-D',
  sasc: 'SASC',
  hasc: 'HASC',
  request: 'Request',
  none: 'No data',
};

/**
 * Congressional-position precedence: the furthest-along point in the process,
 * EXCLUDING the President's request. Order = latest stage first. Used for the
 * delta-vs-request bars, which must stay null for years Congress hasn't touched
 * (a request-only year has no "position").
 */
export const CONGRESSIONAL_PRECEDENCE = [
  'enacted',
  'conference',
  'sacd',
  'hacd',
  'sasc',
  'hasc',
] as const satisfies readonly FundingStage[];

/**
 * "Current authoritative number" precedence: the congressional ladder, then the
 * request as the baseline fallback. Used for the trajectory line + the bar
 * chart, which should always plot *something* when a request exists.
 */
export const CURRENT_PRECEDENCE = [
  ...CONGRESSIONAL_PRECEDENCE,
  'request',
] as const satisfies readonly FundingStage[];

/** Per-FY stage values after numeric coercion. */
interface StageValues {
  request: number | null;
  hascMark: number | null;
  sascMark: number | null;
  hacDMark: number | null;
  sacDMark: number | null;
  conference: number | null;
  enacted: number | null;
}

export interface StagePick {
  value: number | null;
  stage: FundingStage;
}

export interface FundingPoint extends StageValues {
  fy: number;
  /**
   * Furthest-along value INCLUDING the request fallback — what the trajectory
   * line and the bar chart plot. `stage` names where it came from. `value` is
   * null (stage 'none') only when the year carries no stage at all.
   */
  current: StagePick;
  /**
   * Furthest-along CONGRESSIONAL value, excluding the request. `value` null
   * (stage 'none') for request-only or empty years.
   */
  congressional: StagePick;
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

/** Map a stage key to its value in a StageValues record. */
function valueForStage(values: StageValues, stage: FundingStage): number | null {
  switch (stage) {
    case 'enacted':
      return values.enacted;
    case 'conference':
      return values.conference;
    case 'sacd':
      return values.sacDMark;
    case 'hacd':
      return values.hacDMark;
    case 'sasc':
      return values.sascMark;
    case 'hasc':
      return values.hascMark;
    case 'request':
      return values.request;
    case 'none':
      return null;
  }
}

/** Walk a precedence list and return the first stage that has a value. */
function pick(values: StageValues, precedence: readonly FundingStage[]): StagePick {
  for (const stage of precedence) {
    const value = valueForStage(values, stage);
    if (value != null) return { value, stage };
  }
  return { value: null, stage: 'none' };
}

/** The furthest-along authoritative number for a year (request as fallback). */
export function currentFunding(values: StageValues): StagePick {
  return pick(values, CURRENT_PRECEDENCE);
}

/** Congress's furthest-along position for a year, or {null,'none'} if none. */
export function congressionalPosition(values: StageValues): StagePick {
  return pick(values, CONGRESSIONAL_PRECEDENCE);
}

/**
 * Build the canonical per-FY funding series, sorted ascending by fiscal year.
 * Every funding chart consumes this — no chart re-derives stage precedence.
 */
export function buildFundingSeries(years: ProgramElementYearPoint[]): FundingPoint[] {
  return [...years]
    .map((year): FundingPoint => {
      const values: StageValues = {
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
