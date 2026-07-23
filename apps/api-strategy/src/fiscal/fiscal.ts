/**
 * US federal fiscal-calendar helpers. Ported verbatim from the Strategy Planner
 * prototype (`sp-data.jsx`) so the real build derives node/reference dates the
 * same way the UX prototype does. Plan D2: nodes/reference store TRUE dates;
 * quarter-units (`q`) are DERIVED render coordinates from this calendar.
 *
 * Axis convention: q=0 is Oct 1 of the first shown FY; 1 q-unit = 1 quarter =
 * 3 months. The board shows a rolling 3-FY window [CUR_FY, +1, +2].
 */

/** Federal fiscal year for a date (FY starts Oct 1). */
export function fyOf(d: Date): number {
  return d.getMonth() >= 9 ? d.getFullYear() + 1 : d.getFullYear();
}

/** The rolling 3-FY window shown on the board. */
export function currentFyWindow(now: Date = new Date()): [number, number, number] {
  const cur = fyOf(now);
  return [cur, cur + 1, cur + 2];
}

/**
 * The axis origin (q=0): Oct 1 of the first shown FY. Since FY-N Q1 (Oct–Dec)
 * sits in calendar year N-1, this is Oct 1 of calendar year (CUR_FY - 1).
 */
export function axisStart(now: Date = new Date()): Date {
  const [first] = currentFyWindow(now);
  return new Date(first - 1, 9, 1);
}

/**
 * Map a quarter-unit position on the axis to a real calendar date.
 * Mirrors the prototype's `qToDate`.
 */
export function qToDate(q: number, now: Date = new Date()): Date {
  const start = axisStart(now);
  const tot = q * 3; // months from the axis origin
  const mi = Math.floor(tot);
  const frac = tot - mi;
  const base = new Date(start.getFullYear(), start.getMonth() + mi, 1);
  const dim = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const day = Math.min(dim, Math.max(1, Math.round(frac * dim) + 1));
  return new Date(base.getFullYear(), base.getMonth(), day);
}
