import { contentHash } from './hearing-identity.js';
import { calendarDayParts } from '../live-hearings/legiwatch-calendar-export.js';
import type { Visibility } from './hearing-discovery.types.js';

export type CalendarStatus =
  'scheduled' | 'postponed' | 'canceled' | 'in_progress' | 'completed' | 'unknown';
export type CalendarTime = {
  date: string;
  rawTime: string | null;
  timezone: string;
  precision: 'instant' | 'date' | 'relative' | 'unknown';
  startsAt: string | null;
  endsAt: string | null;
};
export type AgendaItem = {
  key: string;
  position: number;
  kind: 'bill' | 'presentation' | 'other' | 'unresolved_bill';
  title: string;
  bill?: { scope: 'state' | 'federal'; id: string; jurisdiction: string; session: string };
  sourceUrl: string;
  evidence: Record<string, unknown>;
};
export type CalendarDocument = {
  key: string;
  title: string;
  url: string;
  kind: string;
  publishedAt: string | null;
  contentHash?: string;
  publishedText?: string;
  deadlines?: string[];
};
export type CalendarFacts = {
  title: string;
  status: CalendarStatus;
  /** Only source-qualified visibility may change recording eligibility. */
  visibility?: Visibility;
  time: CalendarTime;
  location: string | null;
  agenda: AgendaItem[];
  documents: CalendarDocument[];
  watchUrl: string | null;
};
export type CalendarField = keyof CalendarFacts;
export type LegislativeObservation = {
  jurisdiction: string;
  session: string | null;
  chamber: 'house' | 'senate' | 'joint';
  // Stable, verified official notice identity, shared across providers only
  // when both actually cite that same notice. A title/date is never identity.
  officialIdentity: string;
  bodySourceKey: string;
  bodyName: string;
  stateCommitteeId: string | null;
  eventType: 'committee' | 'floor' | 'joint';
  sourceUrl: string;
  publishedAt: string | null;
  fields: Partial<CalendarFacts>;
  completeFields: CalendarField[];
  completeness: 'complete' | 'partial';
  issues: string[];
};
export type CalendarProvenance = Partial<
  Record<
    CalendarField,
    {
      sourceId: string;
      priority: number;
      publishedAt: string | null;
      changedAt: string;
    }
  >
>;

export function legislativeEventId(observation: LegislativeObservation): string {
  if (!/^[A-Z]{2}$/.test(observation.jurisdiction) || observation.jurisdiction === 'US')
    throw new Error('State event requires an explicit geographic jurisdiction');
  if (!observation.officialIdentity.trim() || !observation.bodySourceKey.trim())
    throw new Error('Event and body need source identity');
  return `state-${observation.jurisdiction.toLowerCase()}-${contentHash([
    observation.jurisdiction,
    observation.session,
    observation.chamber,
    observation.bodySourceKey,
    observation.officialIdentity,
  ]).slice(0, 32)}`;
}

export function validateCalendarObservation(o: LegislativeObservation): void {
  legislativeEventId(o);
  if (
    o.fields.visibility !== undefined &&
    !['public', 'private'].includes(o.fields.visibility)
  )
    throw new Error('Invalid calendar visibility');
  if (!publicSourceUrl(o.sourceUrl)) throw new Error('Invalid public source URL');
  if (o.publishedAt && !Number.isFinite(Date.parse(o.publishedAt)))
    throw new Error('Invalid publication time');
  const t = o.fields.time;
  if (t) {
    if (!calendarDayParts(t.date) || !/^\d{4}-\d{2}-\d{2}$/.test(t.date))
      throw new Error('Invalid calendar day');
    try {
      new Intl.DateTimeFormat('en', { timeZone: t.timezone });
    } catch {
      throw new Error('Invalid calendar timezone');
    }
    if (t.precision !== 'instant' && t.startsAt !== null)
      throw new Error('Uncertain time cannot carry an instant');
    if (t.precision === 'instant' && (!t.startsAt || !Number.isFinite(Date.parse(t.startsAt))))
      throw new Error('Invalid start instant');
    if (
      t.endsAt &&
      (!Number.isFinite(Date.parse(t.endsAt)) ||
        !t.startsAt ||
        Date.parse(t.endsAt) <= Date.parse(t.startsAt))
    )
      throw new Error('Invalid end instant');
  }
  const keys = new Set<string>();
  for (const item of o.fields.agenda ?? []) {
    if (!item.key || keys.has(item.key) || !Number.isInteger(item.position) || item.position < 0)
      throw new Error('Invalid agenda ordering/identity');
    keys.add(item.key);
    if (!publicSourceUrl(item.sourceUrl)) throw new Error('Agenda requires source evidence');
    if (
      item.bill &&
      (item.kind !== 'bill' ||
        item.bill.scope !== 'state' ||
        item.bill.jurisdiction !== o.jurisdiction ||
        !o.session ||
        item.bill.session !== o.session)
    )
      throw new Error('Agenda bill crosses geographic/session scope');
    if (item.kind === 'bill' && !item.bill)
      throw new Error('Resolved agenda item requires a canonical bill');
  }
  for (const doc of o.fields.documents ?? [])
    if (!publicSourceUrl(doc.url)) throw new Error('Invalid document URL');
  if (o.fields.watchUrl && !publicSourceUrl(o.fields.watchUrl))
    throw new Error('Invalid watch URL');
}

export function publicSourceUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname)
    );
  } catch {
    return false;
  }
}

// Polling timestamps never compete as source revisions. Each field can be
// withdrawn by a complete observation; a partial or omitted field preserves it.
export function projectLegislativeObservation(
  previous: Partial<CalendarFacts>,
  provenance: CalendarProvenance,
  observation: LegislativeObservation,
  source: { id: string; priority: number },
  now: Date,
): {
  facts: Partial<CalendarFacts>;
  provenance: CalendarProvenance;
  changedFields: CalendarField[];
} {
  validateCalendarObservation(observation);
  const facts = { ...previous };
  const nextProvenance = { ...provenance };
  const changedFields: CalendarField[] = [];
  for (const field of observation.completeFields) {
    if (!Object.prototype.hasOwnProperty.call(observation.fields, field)) continue;
    const value = observation.fields[field];
    if (value === undefined) continue;
    const prior = provenance[field];
    const incomingDate = observation.publishedAt ? Date.parse(observation.publishedAt) : null;
    const priorDate = prior?.publishedAt ? Date.parse(prior.publishedAt) : null;
    // A dated stale revision never regresses a confirmed newer value. Without
    // comparable source timestamps, field authority wins; polling recency does not.
    if (prior && incomingDate !== null && priorDate !== null && incomingDate < priorDate) continue;
    if (
      prior &&
      prior.sourceId !== source.id &&
      source.priority > prior.priority &&
      !(incomingDate !== null && priorDate !== null && incomingDate > priorDate)
    )
      continue;
    // Equal-authority sources without a comparable newer publication keep the
    // incumbent. Their arrival order must not oscillate the public calendar.
    if (
      prior &&
      prior.sourceId !== source.id &&
      source.priority === prior.priority &&
      !(incomingDate !== null && priorDate !== null && incomingDate > priorDate)
    )
      continue;
    if (contentHash(previous[field]) !== contentHash(value)) {
      Object.assign(facts, { [field]: value });
      changedFields.push(field);
    }
    nextProvenance[field] = {
      sourceId: source.id,
      priority: source.priority,
      publishedAt: observation.publishedAt,
      changedAt: changedFields.includes(field)
        ? now.toISOString()
        : (prior?.changedAt ?? now.toISOString()),
    };
  }
  return { facts, provenance: nextProvenance, changedFields };
}

export function affectedAgendaBills(
  before: Partial<CalendarFacts>,
  after: Partial<CalendarFacts>,
): string[] {
  return [
    ...new Set(
      [...(before.agenda ?? []), ...(after.agenda ?? [])].flatMap((i) =>
        i.bill ? [i.bill.id] : [],
      ),
    ),
  ];
}
