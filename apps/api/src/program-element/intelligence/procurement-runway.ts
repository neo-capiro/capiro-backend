/**
 * Procurement-runway classifier (product plan F6) — classifies a budget line's
 * multi-year funding series (FY25–FY31 where loaded) into an investment shape.
 *
 * Pure module: no DB, no I/O. Input is the per-FY funding series in MILLIONS
 * (request for the budget year, actual/enacted for priors, FYDP for outyears —
 * the caller supplies whatever the line has; the classifier is honest about
 * sparse series via 'insufficient_data').
 *
 * Vocabulary (fixed — surfaces and specs depend on these literals):
 *   'new_start'         no funding before the budget year, funded from it on
 *   'zeroed'            was funded, goes to zero and stays zero
 *   'cliff'             funded through the FYDP then falls off a cliff (>70% drop
 *                       to a sustained lower level, or to zero, after a peak)
 *   'one_year_plus_up'  a single-year spike >60% above both neighbors
 *   'ramping'           sustained growth (CAGR >= +15% across the series)
 *   'declining'         sustained decline (CAGR <= -15%)
 *   'flat'              none of the above; funding continues near-level
 *   'insufficient_data' fewer than 2 funded years
 */

export interface FyFunding {
  fy: number;
  /** Millions. null = year not stated in any source (distinct from zero). */
  amount: number | null;
}

export type RunwayClass =
  | 'new_start'
  | 'zeroed'
  | 'cliff'
  | 'one_year_plus_up'
  | 'ramping'
  | 'declining'
  | 'flat'
  | 'insufficient_data';

export interface RunwayResult {
  runway: RunwayClass;
  /** Compound annual growth rate across first->last funded year; null if N/A. */
  cagr: number | null;
  peakFy: number | null;
  firstFundedFy: number | null;
  lastFundedFy: number | null;
  /** Sentence safe to render verbatim, with the numbers that drove the call. */
  rationale: string;
}

const GROWTH_CAGR = 0.15;
const DECLINE_CAGR = -0.15;
const SPIKE_RATIO = 1.6;
const CLIFF_DROP = 0.7;
/** Amounts under this (millions) are treated as “not really funded” for shape calls. */
const FUNDED_FLOOR_M = 0.05;

function fmtM(v: number): string {
  return `$${Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + 'B' : v.toFixed(1) + 'M'}`;
}

/**
 * Classify a funding series. `budgetYearFy` anchors new-start detection (the FY
 * whose request the books were built for — 2027 for the current corpus).
 */
export function classifyRunway(series: FyFunding[], budgetYearFy: number): RunwayResult {
  const sorted = [...series]
    .filter((s) => s.amount !== null)
    .sort((a, b) => a.fy - b.fy) as Array<{ fy: number; amount: number }>;

  const funded = sorted.filter((s) => s.amount > FUNDED_FLOOR_M);
  const result = (
    runway: RunwayClass,
    rationale: string,
    extras?: Partial<Omit<RunwayResult, 'runway' | 'rationale'>>,
  ): RunwayResult => ({
    runway,
    cagr: extras?.cagr ?? null,
    peakFy: extras?.peakFy ?? (funded.length ? funded.reduce((m, s) => (s.amount > m.amount ? s : m)).fy : null),
    firstFundedFy: funded[0]?.fy ?? null,
    lastFundedFy: funded[funded.length - 1]?.fy ?? null,
    rationale,
  });

  const firstFunded = funded[0];
  const lastFunded = funded[funded.length - 1];
  if (firstFunded === undefined || lastFunded === undefined) {
    return result('insufficient_data', 'No funded years stated for this line.');
  }
  if (funded.length === 1) {
    // A single funded year IS meaningful when it's the budget year on a line
    // with stated-zero priors: that's a new start.
    const only = firstFunded;
    const priorsStatedZero = sorted.some((s) => s.fy < only.fy && s.amount <= FUNDED_FLOOR_M);
    if (only.fy >= budgetYearFy && (priorsStatedZero || sorted.length === 1)) {
      return result('new_start', `First funding appears in FY${only.fy} (${fmtM(only.amount)}) with no prior-year funding.`);
    }
    return result('insufficient_data', `Only FY${only.fy} is stated — not enough to classify a runway.`);
  }

  const first = firstFunded;
  const last = lastFunded;
  const years = last.fy - first.fy;
  const cagr = years > 0 ? Math.pow(last.amount / first.amount, 1 / years) - 1 : 0;
  const cagrRounded = Math.round(cagr * 1000) / 1000;
  const peak = funded.reduce((m, s) => (s.amount > m.amount ? s : m));

  // 1. new start: nothing funded before the budget year; funded from it forward.
  if (first.fy >= budgetYearFy && sorted.some((s) => s.fy < budgetYearFy && s.amount <= FUNDED_FLOOR_M)) {
    return result('new_start', `First funding appears in FY${first.fy} (${fmtM(first.amount)}); prior years are zero.`, { cagr: cagrRounded });
  }

  // 2. zeroed: had funding, then the remaining stated years are all ~zero.
  const afterPeak = sorted.filter((s) => s.fy > peak.fy);
  const tailZeroFrom = sorted.findIndex(
    (s, i) => s.amount <= FUNDED_FLOOR_M && sorted.slice(i).every((t) => t.amount <= FUNDED_FLOOR_M),
  );
  const zeroTailStart = tailZeroFrom > 0 ? sorted[tailZeroFrom] : undefined;
  if (zeroTailStart !== undefined && zeroTailStart.fy <= budgetYearFy + 1) {
    const z = zeroTailStart;
    return result('zeroed', `Funding ends at FY${z.fy}: ${fmtM(peak.amount)} peak in FY${peak.fy}, zero from FY${z.fy} on.`, { cagr: cagrRounded, peakFy: peak.fy });
  }

  // 3. one-year plus-up: an interior spike >60% above both neighbors.
  for (let i = 1; i < funded.length - 1; i += 1) {
    const a = funded[i - 1];
    const b = funded[i];
    const c = funded[i + 1];
    if (a === undefined || b === undefined || c === undefined) continue;
    if (b.amount >= a.amount * SPIKE_RATIO && b.amount >= c.amount * SPIKE_RATIO) {
      return result('one_year_plus_up', `FY${b.fy} spikes to ${fmtM(b.amount)} — ${Math.round((b.amount / Math.max(a.amount, c.amount) - 1) * 100)}% above adjacent years.`, { cagr: cagrRounded, peakFy: b.fy });
    }
  }

  // 4. cliff: post-peak funding falls >70% (but not to sustained zero — that's 'zeroed').
  if (afterPeak.length >= 1) {
    const tailMax = Math.max(...afterPeak.map((s) => s.amount));
    if (peak.fy >= budgetYearFy - 1 && tailMax <= peak.amount * (1 - CLIFF_DROP) && tailMax > FUNDED_FLOOR_M) {
      return result('cliff', `Falls ${Math.round((1 - tailMax / peak.amount) * 100)}% after the FY${peak.fy} peak (${fmtM(peak.amount)} → ${fmtM(tailMax)}).`, { cagr: cagrRounded, peakFy: peak.fy });
    }
  }

  // 5/6. sustained growth / decline by CAGR.
  if (cagr >= GROWTH_CAGR) {
    return result('ramping', `Grows ${fmtM(first.amount)} (FY${first.fy}) → ${fmtM(last.amount)} (FY${last.fy}), ${Math.round(cagr * 100)}%/yr.`, { cagr: cagrRounded, peakFy: peak.fy });
  }
  if (cagr <= DECLINE_CAGR) {
    return result('declining', `Declines ${fmtM(first.amount)} (FY${first.fy}) → ${fmtM(last.amount)} (FY${last.fy}), ${Math.round(cagr * 100)}%/yr.`, { cagr: cagrRounded, peakFy: peak.fy });
  }

  return result('flat', `Funding holds near ${fmtM(last.amount)} through FY${last.fy}.`, { cagr: cagrRounded, peakFy: peak.fy });
}
