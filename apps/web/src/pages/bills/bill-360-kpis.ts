/**
 * Bill 360 KPI strip rendering rules (LW-QA-021) — shared by every surface that
 * paints the strip: the vNext full page, the legacy full page, the LegiWatch
 * drawer, and the text/PDF export.
 *
 * Two defects live here permanently:
 *  1. The strip used to be an unkeyed positional array. A cell is now found by
 *     its semantic `id`, so an API reorder or insertion can never slide a value
 *     under the wrong label.
 *  2. A `date` value is a full ISO instant on the wire. Formatting it in ONE
 *     place is why a drawer can no longer paint `2026-07-22T00:00:00.000Z`
 *     where the full page shows `2026-07-22`.
 */
import { fmtDate } from '../../components/dossier/dossier-format.js';
import type { BillKpi, BillKpiId } from './bill-360.types.js';

/** Canonical render order of the six cells. */
export const BILL_KPI_ORDER: readonly BillKpiId[] = [
  'current_status',
  'latest_vote',
  'funding_position',
  'delta_from_request',
  'last_official_action',
  'next_milestone',
];

/** What an unavailable cell paints — never blank, never '0', never a bare dash. */
export const KPI_UNAVAILABLE = 'Not available';

/**
 * The strip in canonical order. Ids the API did not send are simply absent;
 * any id it sent that is not in the order list is appended rather than dropped,
 * so a new cell shipped by the API is visible instead of silently lost.
 */
export function orderedKpis(kpis: BillKpi[]): BillKpi[] {
  const byId = new Map(kpis.map((k) => [k.id, k]));
  const known = BILL_KPI_ORDER.map((id) => byId.get(id)).filter((k): k is BillKpi => Boolean(k));
  const extra = kpis.filter((k) => !BILL_KPI_ORDER.includes(k.id));
  return [...known, ...extra];
}

/** True when the cell has no figure to show and is carrying a reason instead. */
export function kpiUnavailable(k: BillKpi): boolean {
  return k.value == null;
}

/** The string the cell's value line paints. */
export function kpiValueText(k: BillKpi): string {
  if (k.value == null) return k.unavailableLabel?.trim() || KPI_UNAVAILABLE;
  return k.valueType === 'date' ? fmtDate(k.value) : k.value;
}

/**
 * The caption under the value: the cell's own `sub`, or — when it has none —
 * its as-of date. An unavailable cell says WHY instead, in the bill's own terms.
 * A `date` cell already shows its date as the value, so it never repeats it here.
 */
export function kpiSubText(k: BillKpi): string | null {
  if (k.value == null) return k.unavailableReason ?? k.sub;
  if (k.sub) return k.sub;
  return k.valueType === 'date' ? null : fmtDate(k.asOf) || null;
}
