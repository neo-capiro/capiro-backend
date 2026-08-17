/**
 * Step 1.3 — Budget-position (PB-cycle / FYDP outyear) pure helpers.
 *
 * The PB-vs-prior-PB comparison math lives here as a PURE, exported, unit-tested
 * function so the read service stays a thin DB shim and the delta engine (Step 1.4)
 * can reuse the same logic. No Prisma / Nest imports.
 *
 * Cycle naming convention: a "PB cycle" is `pb_fy<YYYY>` (the President's Budget for
 * that submission year). `pbCycleSubmissionYear('pb_fy2027') === 2027`. Non-PB cycles
 * (hasc_*, enacted_*, ...) are ignored by the PB comparison.
 *
 * Money convention: amounts are $ MILLIONS for value_kind='total' (project-wide
 * convention, see program-element-writer buildYearTitle). The comparison operates on
 * value_kind='total' only.
 */

/** A budget-position row as the comparison helper needs it (DB-agnostic). */
export interface BudgetPositionLike {
  positionCycle: string;
  assertedFy: number;
  /** $ millions for value_kind='total'. Decimal columns arrive as string|number; both ok. */
  amount: number | string | null;
  valueKind: string;
}

export interface PbComparisonRow {
  assertedFy: number;
  /** Amount the *current* (latest submission) PB asserts for assertedFy, or null. */
  pbCurrent: number | null;
  /** Amount the *prior* (one submission earlier) PB asserts for assertedFy, or null. */
  pbPrior: number | null;
  /** pbCurrent - pbPrior; null when either side is missing. */
  deltaAbs: number | null;
  /** (pbCurrent - pbPrior) / |pbPrior| as a fraction; null when prior is missing/zero. */
  deltaPct: number | null;
  /** Present in current PB but absent from prior PB. */
  newInPb: boolean;
  /** Present in prior PB but absent from current PB. */
  droppedFromPb: boolean;
}

const PB_CYCLE_RE = /^pb_fy(\d{4})$/i;

/** Submission year of a `pb_fy<YYYY>` cycle, or null for any non-PB cycle. */
export function pbCycleSubmissionYear(positionCycle: string): number | null {
  const m = PB_CYCLE_RE.exec(positionCycle.trim());
  if (!m) return null;
  const yr = Number(m[1]);
  return Number.isFinite(yr) ? yr : null;
}

/** Coerce a Decimal-ish value to a finite number, or null. */
function toAmount(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the PB-vs-prior-PB comparison for a single PE from its budget positions.
 *
 * "Current PB"  = the PB cycle with the HIGHEST submission year present.
 * "Prior PB"    = the PB cycle with the SECOND-highest submission year present.
 * (Both are derived from the data, so a PE with only one PB book yields []
 *  unless that single book asserts an FY also covered by another PB book — but a
 *  single book is a single submission year, so the "≥2 PB cycles" rule below filters
 *  it out cleanly.)
 *
 * For each assertedFy present in EITHER the current or prior PB (i.e. present in ≥2
 * PB cycles' coverage when both sides have it; the per-FY row is emitted whenever it
 * appears in current OR prior so new_in_pb / dropped_from_pb are representable):
 *   - deltaAbs = pbCurrent - pbPrior            (null if either side missing)
 *   - deltaPct = deltaAbs / |pbPrior|           (null if pbPrior missing or 0)
 *   - newInPb        = in current, not in prior
 *   - droppedFromPb  = in prior, not in current
 *
 * Only value_kind='total' rows participate. Zero is a real value (not "missing"):
 * a prior of 0 yields deltaPct=null (no meaningful ratio) but still a deltaAbs.
 *
 * Returns [] when fewer than 2 distinct PB submission years are present (nothing to
 * compare against), so the endpoint degrades to an honest empty result.
 */
export function computePbComparison(positions: BudgetPositionLike[]): PbComparisonRow[] {
  // Distinct PB submission years present, descending.
  const cyclesByYear = new Map<number, string>();
  for (const p of positions) {
    if (p.valueKind !== 'total') continue;
    const yr = pbCycleSubmissionYear(p.positionCycle);
    if (yr === null) continue;
    cyclesByYear.set(yr, p.positionCycle);
  }
  const years = [...cyclesByYear.keys()].sort((a, b) => b - a);
  if (years.length < 2) return [];

  const currentCycle = cyclesByYear.get(years[0]!)!;
  const priorCycle = cyclesByYear.get(years[1]!)!;

  // assertedFy -> amount, for each side. Last write wins, but the natural key makes
  // (cycle, assertedFy, 'total') unique upstream so there is at most one per FY.
  const current = new Map<number, number | null>();
  const prior = new Map<number, number | null>();
  for (const p of positions) {
    if (p.valueKind !== 'total') continue;
    if (p.positionCycle === currentCycle) current.set(p.assertedFy, toAmount(p.amount));
    else if (p.positionCycle === priorCycle) prior.set(p.assertedFy, toAmount(p.amount));
  }

  const allFys = new Set<number>([...current.keys(), ...prior.keys()]);
  const rows: PbComparisonRow[] = [];
  for (const fy of [...allFys].sort((a, b) => a - b)) {
    const inCurrent = current.has(fy);
    const inPrior = prior.has(fy);
    const pbCurrent = inCurrent ? current.get(fy)! : null;
    const pbPrior = inPrior ? prior.get(fy)! : null;

    const deltaAbs = pbCurrent !== null && pbPrior !== null ? round2(pbCurrent - pbPrior) : null;
    const deltaPct =
      pbCurrent !== null && pbPrior !== null && pbPrior !== 0
        ? Math.round(((pbCurrent - pbPrior) / Math.abs(pbPrior)) * 1e4) / 1e4
        : null;

    rows.push({
      assertedFy: fy,
      pbCurrent,
      pbPrior,
      deltaAbs,
      deltaPct,
      // "new_in_pb": the FY shows up in the current PB but the prior PB had no value
      // for it (either the FY row is absent OR present-but-null).
      newInPb: inCurrent && pbCurrent !== null && (!inPrior || pbPrior === null),
      // "dropped_from_pb": the prior PB asserted a value for this FY but the current
      // PB no longer does.
      droppedFromPb: inPrior && pbPrior !== null && (!inCurrent || pbCurrent === null),
    });
  }
  return rows;
}
