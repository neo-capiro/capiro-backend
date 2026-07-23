/*
 * Live US-federal fiscal calendar — ported from the prototype's sp-data.jsx.
 * Everything derives from `now` so the board is correct to the day. The board
 * shows a rolling 3-FY window [CUR_FY, +1, +2]. Axis unit `q` = quarters from
 * the axis origin (q=0 = Oct 1 of the first shown FY); 1 q-unit = 1 quarter =
 * 3 months.
 *
 * Production note: the prototype stored `q`/`dur` on nodes; the real API stores
 * TRUE dates (startsOn/endsOn) — so `qOfDate` converts a date to a q-position,
 * and `fyQuarterToQ` converts a firm-phase FY+quarter to a q-position.
 */

const pad2 = (y: number) => String(y).slice(2);

/** US federal FY (Oct 1 start). */
export function fyOf(d: Date): number {
  return d.getMonth() >= 9 ? d.getFullYear() + 1 : d.getFullYear();
}

export interface FiscalCalendar {
  now: Date;
  fys: [number, number, number];
  fyLabels: [string, string, string];
  focalFy: string;
  axisStart: Date;
  todayQ: number;
  todayLabel: string;
  quarters: QuarterCol[];
  months: MonthCol[];
}

export interface QuarterCol {
  fy: string; // 'FY27'
  q: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  months: string; // 'Oct–Dec'
  cal: string; // calendar year, e.g. '2026'
}

export interface MonthCol {
  m: string; // 'Oct'
  cal: string; // '2026'
  fy: string; // 'FY27'
  fyStart: boolean; // first month (Oct) of an FY
  idx: number;
}

const Q_RANGE: Record<string, string> = {
  Q1: 'Oct–Dec',
  Q2: 'Jan–Mar',
  Q3: 'Apr–Jun',
  Q4: 'Jul–Sep',
};
const MONTHS_BY_Q: Record<string, string[]> = {
  Q1: ['Oct', 'Nov', 'Dec'],
  Q2: ['Jan', 'Feb', 'Mar'],
  Q3: ['Apr', 'May', 'Jun'],
  Q4: ['Jul', 'Aug', 'Sep'],
};

export function buildCalendar(now: Date = new Date()): FiscalCalendar {
  const curFy = fyOf(now);
  const fys: [number, number, number] = [curFy, curFy + 1, curFy + 2];
  const fyLabels: [string, string, string] = [
    'FY' + pad2(fys[0]),
    'FY' + pad2(fys[1]),
    'FY' + pad2(fys[2]),
  ];
  const axisStart = new Date(fys[0] - 1, 9, 1); // Oct 1 of the first shown FY

  const quarters: QuarterCol[] = [];
  fys.forEach((fy) => {
    (['Q1', 'Q2', 'Q3', 'Q4'] as const).forEach((q) => {
      const calYear = q === 'Q1' ? fy - 1 : fy;
      quarters.push({ fy: 'FY' + pad2(fy), q, months: Q_RANGE[q]!, cal: String(calYear) });
    });
  });

  const months: MonthCol[] = [];
  quarters.forEach((qc) => {
    MONTHS_BY_Q[qc.q]!.forEach((m, mi) => {
      months.push({
        m,
        cal: qc.cal,
        fy: qc.fy,
        fyStart: qc.q === 'Q1' && mi === 0,
        idx: months.length,
      });
    });
  });

  const todayMUnits = dateToMonthUnits(now, axisStart);
  return {
    now,
    fys,
    fyLabels,
    focalFy: fyLabels[1],
    axisStart,
    todayQ: todayMUnits / 3,
    todayLabel: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    quarters,
    months,
  };
}

/** Months from the axis origin (float), from the prototype's dateToMonthUnits. */
export function dateToMonthUnits(d: Date, axisStart: Date): number {
  const mi = d.getFullYear() * 12 + d.getMonth() - (axisStart.getFullYear() * 12 + 9);
  const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return mi + (d.getDate() - 1) / dim;
}

/** A true date → q-position on the axis. */
export function qOfDate(d: Date, cal: FiscalCalendar): number {
  return dateToMonthUnits(d, cal.axisStart) / 3;
}

/** quarter-units → a real calendar date (prototype qToDate). */
export function qToDate(q: number, axisStart: Date): Date {
  const tot = q * 3;
  const mi = Math.floor(tot);
  const frac = tot - mi;
  const base = new Date(axisStart.getFullYear(), axisStart.getMonth() + mi, 1);
  const dim = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    Math.min(dim, Math.max(1, Math.round(frac * dim) + 1)),
  );
}

export function qToDateLabel(q: number, cal: FiscalCalendar): string {
  return qToDate(q, cal.axisStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Firm-phase FY+quarter → q-position (quarter index into the shown window). */
export function fyQuarterToQ(fy: number, quarter: number, cal: FiscalCalendar): number {
  return (fy - cal.fys[0]) * 4 + (quarter - 1);
}

/** month-index label 'Oct \'26' for a q-position (prototype monthLabel). */
export function monthLabel(q: number, cal: FiscalCalendar): string {
  const seq = cal.months;
  const i = Math.max(0, Math.min(seq.length - 1, Math.round(q * 3)));
  const x = seq[i]!;
  return x.m + " '" + x.cal.slice(2);
}

/** A node's display date-range label (prototype nodeRange), from true dates. */
export function nodeRangeLabel(startQ: number, endQ: number, cal: FiscalCalendar): string {
  const a = monthLabel(startQ, cal);
  const b = monthLabel(endQ, cal);
  return a === b ? a : a + ' – ' + b;
}
