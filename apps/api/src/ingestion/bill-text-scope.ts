/** FY26 is a parent admission window, never an ingestion timestamp filter. */
export const FY26_START = '2025-10-01';
export const FY26_END = '2026-10-01';
export function inFY26(value: string | Date | null | undefined): boolean {
  if (!value) return false;
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value);
    if (!match) return false;
    const day = new Date(`${match[1]}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1])
      return false;
  }
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
 OR EXISTS (SELECT 1 FROM jsonb_array_elements(
   CASE WHEN jsonb_typeof(b.legiscan_progress)='array' THEN b.legiscan_progress ELSE '[]'::jsonb END
 ) AS p(event) WHERE CASE
   WHEN p.event->>'date' ~ '^(2025|2026)-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
   THEN to_char((left(p.event->>'date',7)||'-01')::date + (right(p.event->>'date',2)::int-1),'YYYY-MM-DD')=p.event->>'date'
     AND p.event->>'date' >= '${FY26_START}' AND p.event->>'date' < '${FY26_END}'
   ELSE false END)
 OR EXISTS (SELECT 1 FROM state_bill_action a WHERE a.bill_key=b.id AND a.date >= DATE '${FY26_START}' AND a.date < DATE '${FY26_END}')
 OR EXISTS (SELECT 1 FROM state_bill_published_record a WHERE a.bill_key=b.id AND a.kind='action'
 AND a.event_date ~ '^\\d{4}-\\d{2}-\\d{2}$' AND a.event_date >= '${FY26_START}' AND a.event_date < '${FY26_END}'))`;
