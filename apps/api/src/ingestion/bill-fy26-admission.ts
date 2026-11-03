/**
 * SCRUM-247 FY26 bill-admission helpers.
 *
 * FY26 admission is opt-in through BILL_FISCAL_YEAR=2026. When the variable
 * is absent every caller keeps its existing behaviour; a non-empty value
 * other than 2026 is rejected instead of being silently ignored.
 *
 * LegiScan admission is decided from the raw bill's OWN history/progress
 * dates only — those are the official legislative events. Sync timestamps,
 * session years and text-version dates are never admission evidence, and a
 * bill's session overlapping FY26 does not by itself admit the bill.
 *
 * Admission is a PARENT-bill decision: once a parent is admitted, every one
 * of its text versions is preserved.
 */
import { eligibleFY26 } from './bill-text-scope.js';

export const FY26_YEAR = 2026;
export const FY26_SCOPE_SUFFIX = ':fy26';

export type FiscalYearMode = typeof FY26_YEAR | null;

/**
 * Reads BILL_FISCAL_YEAR. Absent/blank => null (no behaviour change).
 * "2026" => 2026. Any other non-empty value throws.
 */
export function fiscalYearMode(
  value: string | undefined = process.env.BILL_FISCAL_YEAR,
): FiscalYearMode {
  const raw = value?.trim();
  if (!raw) return null;
  if (raw !== String(FY26_YEAR))
    throw new Error(`BILL_FISCAL_YEAR must be ${FY26_YEAR} when set; got ${raw}`);
  return FY26_YEAR;
}

/** Scope suffix appended to durable cursor/checkpoint keys in FY26 mode. */
export function fy26ScopedSuffix(mode: FiscalYearMode): string {
  return mode === FY26_YEAR ? FY26_SCOPE_SUFFIX : '';
}

type DatedEntry =
  { date?: unknown; action_date?: unknown; event_date?: unknown } | null | undefined;

export interface RawLegiscanBillLike {
  history?: DatedEntry[] | null;
  progress?: DatedEntry[] | null;
  texts?: unknown[] | null;
  /** These fields never establish fiscal-year eligibility. */
  session?: unknown;
  synced_at?: unknown;
  status_date?: unknown;
}

function officialDate(entry: DatedEntry): string | null {
  if (!entry) return null;
  for (const candidate of [entry.date, entry.action_date, entry.event_date]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * Official legislative event dates from the raw bill: history dates plus
 * progress dates. Session years, sync times and text-version dates are
 * deliberately excluded.
 */
export function rawBillEventDates(raw: RawLegiscanBillLike | null | undefined): string[] {
  const dates: string[] = [];
  for (const entry of raw?.history ?? []) {
    const date = officialDate(entry);
    if (date) dates.push(date);
  }
  for (const entry of raw?.progress ?? []) {
    const date = officialDate(entry);
    if (date) dates.push(date);
  }
  return dates;
}

/**
 * Parent-bill FY26 admission. Admitted when introduced in FY26 or when any
 * history/progress event falls inside the half-open FY26 window.
 */
export function rawBillEligibleFy26(raw: RawLegiscanBillLike | null | undefined): boolean {
  if (!raw) return false;
  // A first history entry is not necessarily an introduction. Introduction is
  // already a legislative event when present; admit from the actual event dates.
  return eligibleFY26(null, rawBillEventDates(raw));
}

/**
 * Admission decision for a raw bill in the given mode. With no FY26 mode the
 * caller's existing behaviour is preserved (everything is admitted).
 */
export function admitsRawBill(
  raw: RawLegiscanBillLike | null | undefined,
  mode: FiscalYearMode,
): boolean {
  if (mode === null) return true;
  return rawBillEligibleFy26(raw);
}

/**
 * Text versions to ingest for an admitted parent. All versions of an
 * eligible parent are preserved; an ineligible parent contributes none.
 */
export function textVersionsForAdmission<T>(
  raw: { texts?: T[] | null } | null | undefined,
  admitted: boolean,
): T[] {
  if (!admitted) return [];
  return raw?.texts ?? [];
}
