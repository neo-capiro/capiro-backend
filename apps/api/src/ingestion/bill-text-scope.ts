/** FY26 is a parent admission window, never an ingestion timestamp filter. */
export const FY26_START = '2025-10-01';
export const FY26_END = '2026-10-01';
export function inFY26(value: string | Date | null | undefined): boolean {
  if (!value) return false;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) && time >= Date.parse(FY26_START) && time < Date.parse(FY26_END);
}
export function eligibleFY26(introduced: string | null, actions: readonly string[]): boolean {
  return inFY26(introduced) || actions.some(inFY26);
}
// Fixed SQL, not interpolated user input. Published state action dates are ISO date strings.
export const FEDERAL_FY26_SQL = `(b.introduced_date >= DATE '${FY26_START}' AND b.introduced_date < DATE '${FY26_END}'
 OR EXISTS (SELECT 1 FROM congress_bill_action a WHERE a.bill_id=b.id AND a.date >= DATE '${FY26_START}' AND a.date < DATE '${FY26_END}'))`;
export const STATE_FY26_SQL = `(b.latest_action_date >= DATE '${FY26_START}' AND b.latest_action_date < DATE '${FY26_END}'
 OR EXISTS (SELECT 1 FROM state_bill_action a WHERE a.bill_key=b.id AND a.date >= DATE '${FY26_START}' AND a.date < DATE '${FY26_END}')
 OR EXISTS (SELECT 1 FROM state_bill_published_record a WHERE a.bill_key=b.id AND a.kind='action'
 AND a.event_date ~ '^\\d{4}-\\d{2}-\\d{2}$' AND a.event_date >= '${FY26_START}' AND a.event_date < '${FY26_END}'))`;
