/**
 * Maps a budget line's stored rows onto the four intelligence classifiers and
 * returns their combined verdict (product plan F1 chips / F3 / F5 / F6 / F9).
 *
 * Pure module — the read service coerces Prisma Decimals to numbers and hands
 * plain rows in (same "rows -> *Like -> pure helper" idiom as delta-compute).
 * All money in MILLIONS. Link flags are tri-state: undefined = link graph not
 * yet consulted, so link-dependent anomaly rules stay silent (never false-flag).
 */
import { classifyPosture, type PostureResult } from './committee-posture.js';
import { classifyRunway, type FyFunding, type RunwayResult } from './procurement-runway.js';
import { classifyMaturity, type MaturityResult } from './acquisition-maturity.js';
import { detectAnomalies, type Anomaly } from './budget-anomaly.js';

export interface YearRowLike {
  fy: number;
  request: number | null;
  hascMark: number | null;
  sascMark: number | null;
  hacDMark: number | null;
  sacDMark: number | null;
  conference: number | null;
  enacted: number | null;
}

export interface IntelligenceInput {
  appropriationType: string | null;
  budgetActivity: string | null;
  years: YearRowLike[];
  /** Stated FYDP outyear totals (fy > budget year), millions. */
  outyears?: Array<{ fy: number; amount: number | null }>;
  /** Budget-year procurement quantity when known. */
  quantity?: number | null;
}

export interface IntelligenceResult {
  budgetYearFy: number | null;
  posture: PostureResult | null;
  runway: RunwayResult | null;
  maturity: MaturityResult;
  anomalies: Anomaly[];
}

/**
 * Budget year = the latest FY with a stated request (matches the markup-monitor
 * "current cycle = max fy" convention); null when no year carries a request.
 */
export function pickBudgetYear(years: YearRowLike[]): number | null {
  let by: number | null = null;
  for (const y of years) {
    if (y.request !== null && (by === null || y.fy > by)) by = y.fy;
  }
  if (by !== null) return by;
  // Mark-only lines (e.g. congressional adds with no request) still have a cycle.
  for (const y of years) {
    if (by === null || y.fy > by) by = y.fy;
  }
  return by;
}

export function buildIntelligence(input: IntelligenceInput): IntelligenceResult {
  const years = [...input.years].sort((a, b) => a.fy - b.fy);
  const by = pickBudgetYear(years);
  const byRow = by === null ? undefined : years.find((y) => y.fy === by);

  const posture = byRow
    ? classifyPosture({
        request: byRow.request,
        hascMark: byRow.hascMark,
        sascMark: byRow.sascMark,
        hacDMark: byRow.hacDMark,
        sacDMark: byRow.sacDMark,
        conference: byRow.conference,
        enacted: byRow.enacted,
      })
    : null;

  // Funding series: priors use the most-final stated number, the budget year
  // uses the request, stated outyears extend the FYDP tail.
  const series: FyFunding[] = years.map((y) => ({
    fy: y.fy,
    amount:
      by !== null && y.fy < by ? y.enacted ?? y.conference ?? y.request : y.request ?? y.enacted,
  }));
  for (const o of input.outyears ?? []) {
    if (!series.some((s) => s.fy === o.fy)) series.push({ fy: o.fy, amount: o.amount });
  }
  series.sort((a, b) => a.fy - b.fy);
  const runway = by !== null && series.length > 0 ? classifyRunway(series, by) : null;

  const maturity = classifyMaturity({
    appropriationType: input.appropriationType,
    budgetActivity: input.budgetActivity,
  });

  const priorRow = by === null ? undefined : years.find((y) => y.fy === by - 1);
  const statedOutyears = (input.outyears ?? []).filter(
    (o) => by !== null && o.fy > by && o.amount !== null,
  );
  const anomalies = byRow
    ? detectAnomalies({
        appropriationType: input.appropriationType,
        request: byRow.request,
        priorYearRequest: priorRow?.request ?? null,
        hascMark: byRow.hascMark,
        sascMark: byRow.sascMark,
        hacDMark: byRow.hacDMark,
        sacDMark: byRow.sacDMark,
        quantity: input.quantity ?? null,
        outyearTotal: statedOutyears.length
          ? statedOutyears.reduce((s, o) => s + (o.amount ?? 0), 0)
          : null,
      })
    : [];

  return { budgetYearFy: by, posture, runway, maturity, anomalies };
}
