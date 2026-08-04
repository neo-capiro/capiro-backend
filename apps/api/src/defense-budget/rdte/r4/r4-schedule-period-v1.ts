/**
 * r4-schedule-period-v1 — strict schedule period representation for R-4/R-4A
 * milestone extraction.
 *
 * Workstream K (Phase 4 plan §16). Supports the full fidelity ladder of
 * schedule date expressions found in RDT&E Schedule Profile exhibits:
 *
 *   - exact_date:      fully specified calendar date (e.g. "Jan 15, 2027",
 *                      "2027-01-15", "1/15/2027")
 *   - calendar_month:  year + month only (e.g. "Jan 2027", "January 2027")
 *   - calendar_quarter: year + calendar quarter (e.g. "Q3 2027", "3Q CY2027")
 *   - fiscal_quarter:  fiscal year + fiscal quarter (e.g. "3Q FY2028",
 *                      "Q3 FY28", "FY2028 Q3")
 *   - fiscal_year:     fiscal year only (e.g. "FY 2028", "FY28")
 *   - text_only:       free-text schedule note with no parseable date
 *                      (e.g. "TBD", "Ongoing", "N/A")
 *   - range:           explicit start–end range (e.g. "Jan 2027 – Jun 2028",
 *                      "FY2027-FY2028")
 *   - unknown:         empty or unrecognised input
 *
 * Rules (Phase 4 plan §16):
 *   - raw printed text is always retained;
 *   - normalized year/quarter/month fields are populated ONLY when explicit
 *     in the source;
 *   - start/end values are populated ONLY when the source provides sufficient
 *     precision (exact_date, or range with exact_date endpoints);
 *   - NO synthetic first/last day is ever fabricated from a quarter, month,
 *     or year label;
 *   - normalization confidence is recorded for every parse.
 *
 * Pure module. No NestJS, Prisma, AWS, parser, or writer dependencies.
 */

/* ------------------------------------------------------------------ */
/* Period kind vocabulary                                              */
/* ------------------------------------------------------------------ */

export const R4_SCHEDULE_PERIOD_KIND_V1_VALUES = [
  'exact_date',
  'calendar_month',
  'calendar_quarter',
  'fiscal_quarter',
  'fiscal_year',
  'text_only',
  'range',
  'unknown',
] as const;
export type R4SchedulePeriodKindV1 = (typeof R4_SCHEDULE_PERIOD_KIND_V1_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface R4SchedulePeriodV1 {
  kind: R4SchedulePeriodKindV1;
  /** Raw printed text exactly as it appeared in the source cell. */
  rawText: string;
  /** ISO-8601 calendar date (YYYY-MM-DD). Present ONLY for exact_date. */
  exactDate?: string;
  /** Four-digit year when explicitly stated. */
  year?: number;
  /** Calendar quarter 1-4 when explicitly stated. */
  calendarQuarter?: number;
  /** Fiscal quarter 1-4 when explicitly stated. */
  fiscalQuarter?: number;
  /** Fiscal year when explicitly stated. */
  fiscalYear?: number;
  /** Calendar month 1-12 when explicitly stated. */
  month?: number;
  /** Start of an explicit range. Present only for range kind. */
  start?: R4SchedulePeriodV1;
  /** End of an explicit range. Present only for range kind. */
  end?: R4SchedulePeriodV1;
  /** Free-text label for text_only kind. */
  textLabel?: string;
  /** Parser confidence in the normalization (0-1). */
  confidence: number;
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function makeExactDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

/* ------------------------------------------------------------------ */
/* Individual parsers (ordered by specificity)                         */
/* ------------------------------------------------------------------ */

/** ISO-8601: 2027-01-15 */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** US numeric: 1/15/2027 or 01/15/2027 */
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Month-name date: Jan 15, 2027 / January 15, 2027 / 15 Jan 2027 */
const MONTH_NAME_DATE_RE = /^(?:(\w+)\s+(\d{1,2}),?\s+(\d{4})|(\d{1,2})\s+(\w+)\s+(\d{4}))$/i;

/** Month-year: Jan 2027 / January 2027 */
const MONTH_YEAR_RE = /^(\w+)\s+(\d{4})$/i;

/** Calendar quarter: Q3 2027 / 3Q 2027 / 3Q CY2027 / Q3 CY27 */
const CALENDAR_QUARTER_RE = /^(?:Q([1-4])\s+(?:CY\s*)?(\d{4})|([1-4])Q\s+(?:CY\s*)?(\d{4}))$/i;

/** Fiscal quarter: 3Q FY2028 / Q3 FY28 / FY2028 Q3 / FY28 3Q */
const FISCAL_QUARTER_RE =
  /^(?:Q([1-4])\s+FY\s*(\d{2,4})|([1-4])Q\s+FY\s*(\d{2,4})|FY\s*(\d{2,4})\s+Q([1-4])|FY\s*(\d{2,4})\s+([1-4])Q)$/i;

/** Fiscal year only: FY 2028 / FY2028 / FY28 */
const FISCAL_YEAR_RE = /^FY\s*(\d{2,4})$/i;

/** Calendar year only: 2027 (treated as fiscal_year for R-4 context) */
const BARE_YEAR_RE = /^(\d{4})$/;

/** Explicit range separator: en-dash, em-dash, hyphen, or "to" */
const RANGE_SEP_RE = /\s*(?:–|—|-|\bto\b)\s*/i;

function normalizeYear(twoOrFour: string): number {
  const n = parseInt(twoOrFour, 10);
  if (twoOrFour.length === 2) {
    /* 00-68 -> 2000-2068, 69-99 -> 1969-1999 (POSIX pivot) */
    return n <= 68 ? 2000 + n : 1900 + n;
  }
  return n;
}

function parseExactDateText(text: string): R4SchedulePeriodV1 | null {
  const trimmed = text.trim();

  /* ISO-8601 */
  const iso = ISO_DATE_RE.exec(trimmed);
  if (iso) {
    const y = parseInt(iso[1]!, 10);
    const m = parseInt(iso[2]!, 10);
    const d = parseInt(iso[3]!, 10);
    if (isValidDate(y, m, d)) {
      return {
        kind: 'exact_date',
        rawText: text,
        exactDate: makeExactDate(y, m, d),
        year: y,
        month: m,
        confidence: 1.0,
      };
    }
    return null;
  }

  /* US numeric */
  const us = US_DATE_RE.exec(trimmed);
  if (us) {
    const m = parseInt(us[1]!, 10);
    const d = parseInt(us[2]!, 10);
    const y = parseInt(us[3]!, 10);
    if (isValidDate(y, m, d)) {
      return {
        kind: 'exact_date',
        rawText: text,
        exactDate: makeExactDate(y, m, d),
        year: y,
        month: m,
        confidence: 0.95,
      };
    }
    return null;
  }

  /* Month-name date */
  const mn = MONTH_NAME_DATE_RE.exec(trimmed);
  if (mn) {
    let monthStr: string;
    let dayStr: string;
    let yearStr: string;
    if (mn[1] != null) {
      /* "Jan 15, 2027" */
      monthStr = mn[1];
      dayStr = mn[2]!;
      yearStr = mn[3]!;
    } else {
      /* "15 Jan 2027" */
      dayStr = mn[4]!;
      monthStr = mn[5]!;
      yearStr = mn[6]!;
    }
    const m = MONTH_NAMES[monthStr.toLowerCase()];
    const d = parseInt(dayStr, 10);
    const y = parseInt(yearStr, 10);
    if (m != null && isValidDate(y, m, d)) {
      return {
        kind: 'exact_date',
        rawText: text,
        exactDate: makeExactDate(y, m, d),
        year: y,
        month: m,
        confidence: 0.95,
      };
    }
    return null;
  }

  return null;
}

function parseSinglePeriod(text: string): R4SchedulePeriodV1 {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { kind: 'unknown', rawText: text, confidence: 0 };
  }

  /* exact_date */
  const exact = parseExactDateText(trimmed);
  if (exact != null) return exact;

  /* calendar_month: Jan 2027 */
  const my = MONTH_YEAR_RE.exec(trimmed);
  if (my) {
    const m = MONTH_NAMES[my[1]!.toLowerCase()];
    if (m != null) {
      const y = parseInt(my[2]!, 10);
      return {
        kind: 'calendar_month',
        rawText: text,
        year: y,
        month: m,
        confidence: 0.9,
      };
    }
  }

  /* calendar_quarter: Q3 2027 / 3Q 2027 / 3Q CY2027 */
  const cq = CALENDAR_QUARTER_RE.exec(trimmed);
  if (cq) {
    const q = parseInt(cq[1] ?? cq[3]!, 10);
    const y = parseInt(cq[2] ?? cq[4]!, 10);
    return {
      kind: 'calendar_quarter',
      rawText: text,
      year: y,
      calendarQuarter: q,
      confidence: 0.9,
    };
  }

  /* fiscal_quarter: 3Q FY2028 / Q3 FY28 / FY2028 Q3 */
  const fq = FISCAL_QUARTER_RE.exec(trimmed);
  if (fq) {
    let q: number;
    let fy: number;
    if (fq[1] != null) {
      q = parseInt(fq[1], 10);
      fy = normalizeYear(fq[2]!);
    } else if (fq[3] != null) {
      q = parseInt(fq[3], 10);
      fy = normalizeYear(fq[4]!);
    } else if (fq[5] != null) {
      fy = normalizeYear(fq[5]);
      q = parseInt(fq[6]!, 10);
    } else {
      fy = normalizeYear(fq[7]!);
      q = parseInt(fq[8]!, 10);
    }
    return {
      kind: 'fiscal_quarter',
      rawText: text,
      fiscalYear: fy,
      fiscalQuarter: q,
      confidence: 0.9,
    };
  }

  /* fiscal_year: FY 2028 / FY28 */
  const fy = FISCAL_YEAR_RE.exec(trimmed);
  if (fy) {
    return {
      kind: 'fiscal_year',
      rawText: text,
      fiscalYear: normalizeYear(fy[1]!),
      confidence: 0.9,
    };
  }

  /* bare year: 2027 -> treat as fiscal_year in R-4 context */
  const by = BARE_YEAR_RE.exec(trimmed);
  if (by) {
    return {
      kind: 'fiscal_year',
      rawText: text,
      fiscalYear: parseInt(by[1]!, 10),
      confidence: 0.7,
    };
  }

  /* text_only fallback */
  return {
    kind: 'text_only',
    rawText: text,
    textLabel: trimmed,
    confidence: 0.5,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Parse a raw schedule-period string into a strict R4SchedulePeriodV1.
 *
 * Never fabricates a day, month, or quarter from a coarser label.
 * Never invents start/end values for non-exact periods.
 */
export function parseR4SchedulePeriod(rawText: string): R4SchedulePeriodV1 {
  const trimmed = rawText.trim();
  if (trimmed === '') {
    return { kind: 'unknown', rawText, confidence: 0 };
  }

  /* Try range split first.  Only treat as range when BOTH sides parse
   * to something more specific than text_only/unknown. */
  const parts = trimmed.split(RANGE_SEP_RE);
  if (parts.length === 2) {
    const left = parseSinglePeriod(parts[0]!);
    const right = parseSinglePeriod(parts[1]!);
    const leftOk = left.kind !== 'text_only' && left.kind !== 'unknown';
    const rightOk = right.kind !== 'text_only' && right.kind !== 'unknown';
    if (leftOk && rightOk) {
      return {
        kind: 'range',
        rawText,
        start: left,
        end: right,
        confidence: Math.min(left.confidence, right.confidence) * 0.95,
      };
    }
  }

  return parseSinglePeriod(trimmed);
}

/**
 * Returns true when the period carries enough precision to populate
 * plannedDate/actualDate on a milestone assertion (exact_date only).
 */
export function hasExactDate(period: R4SchedulePeriodV1): boolean {
  return period.kind === 'exact_date' && period.exactDate != null;
}

/**
 * Returns the exact ISO date string when present, otherwise undefined.
 * Used to populate milestoneAssertionV1Schema.plannedDate / actualDate.
 */
export function exactDateString(period: R4SchedulePeriodV1): string | undefined {
  return hasExactDate(period) ? period.exactDate : undefined;
}
