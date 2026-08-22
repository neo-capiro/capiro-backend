/**
 * Canonical hearing identity — Phase 3.
 *
 * ONE official event must resolve to ONE `committee_hearing` row no matter how
 * many official sources report it. Identity here is DETERMINISTIC and derived
 * from official identifiers only; fuzzy/AI matching is never the primary key
 * (plan §14 Phase 3 gate, and the explicit DO-NOT in the Phase 3/4 brief). The
 * one similarity check in this file (`normalizedTitleKey`) is a LAST-RESORT tie
 * breaker that still requires an exact chamber + committee + calendar-day match
 * alongside it.
 *
 * The id conventions are NOT new. `sync-hearings.ts` has been writing
 * `cm-{congress}-{eventId}` (Congress.gov committee-meeting + docs.house.gov,
 * which share the House `EventID`) and `{congress}-{jacket}-{date}` (historical
 * transcript records) into this table since before Phase 2. Phase 3 reuses the
 * first verbatim so discovery MERGES with the live corpus instead of forking a
 * parallel set of duplicate rows — the single most important compatibility
 * constraint in this phase.
 *
 * Pure module: no Prisma, no fetch, no clock reads except what callers pass in.
 */
import { createHash } from 'crypto';
import { etParts, isDateOnlySentinel } from './hearing-time.js';
import type { EventStatus, SourceEvent, Visibility } from './hearing-discovery.types.js';

/** Stable adapter keys, persisted in committee_source.adapter_key. */
export const CONGRESS_GOV_ADAPTER = 'congress-gov';
export const HOUSE_REPOSITORY_ADAPTER = 'house-repository';
export const SENATE_SCHEDULE_ADAPTER = 'senate-schedule';
export const COMMITTEE_SITE_ADAPTER = 'committee-site';

/**
 * Adapters whose `externalEventId` IS the official Congress.gov/House event id,
 * and which therefore must mint the legacy `cm-{congress}-{eventId}` id so their
 * rows merge with what `sync-hearings.ts` already wrote.
 */
const EVENT_ID_ADAPTERS = new Set<string>([CONGRESS_GOV_ADAPTER, HOUSE_REPOSITORY_ADAPTER]);

/** YYYYMMDD of a `@db.Date`-style UTC-midnight day. */
export function dayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** YYYY-MM-DD of a `@db.Date`-style UTC-midnight day. */
export function isoDay(d: Date): string {
  return `${dayKey(d).slice(0, 4)}-${dayKey(d).slice(4, 6)}-${dayKey(d).slice(6, 8)}`;
}

/**
 * HHMM of a start instant in EASTERN wall-clock, or `d` for a date-only record.
 * Eastern, not UTC: an 8:00 PM ET hearing is 00:00Z the next day, and keying on
 * UTC would file it under the wrong day (the 2026-07-29 defect class).
 */
export function clockKey(startsAt: Date | null | undefined): string {
  if (!startsAt || isDateOnlySentinel(startsAt)) return 'd';
  const { hour, minute } = etParts(startsAt);
  return `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}

/** sha256 hex of any payload — the observation + site-update change identity. */
export function contentHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * Key-sorted JSON so an identical payload always hashes identically regardless
 * of property insertion order. Without this, a parser that happens to emit keys
 * in a different order would look like a content change on every run and
 * re-emit duplicate committee_site_update rows forever.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Comparison form of a hearing title: lowercased, bracketed status prefixes
 * dropped (`sync-hearings.ts` prefixes `[Postponed] ` into the title), quotes and
 * punctuation folded, whitespace collapsed. Used ONLY as the last rung of the
 * match ladder, never on its own.
 */
export function normalizedTitleKey(title: string | null | undefined): string {
  const words = (title ?? '')
    .replace(/^\s*\[[^\]]{0,40}\]\s*/, '')
    .toLowerCase()
    .replace(/[‘’ʹ]/g, "'")
    .replace(/[“”ʺ]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);

  // Rejoin runs of single letters, so a dotted initialism and its undotted form
  // fold together: "H.R. 1" and "HR 1" both become "hr 1". Without this, two
  // official sources writing the same bill reference differently would miss on
  // the title rung of the match ladder. Safe to be this aggressive because that
  // rung ALSO requires an exact chamber + committee + calendar-day match.
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 1) out.push(run.join(''));
    else if (run.length === 1) out.push(run[0] as string);
    run = [];
  };
  for (const word of words) {
    if (word.length === 1 && /[a-z]/.test(word)) {
      run.push(word);
      continue;
    }
    flush();
    out.push(word);
  }
  flush();
  return out.join(' ');
}

/**
 * The canonical `committee_hearing.id` for an observed event.
 *
 * - Congress.gov / docs.house.gov: `cm-{congress}-{eventId}` — the EXISTING
 *   convention. Both sources key on the same House/Senate `EventID`, which is
 *   why they already merge today.
 * - Senate central schedule: no official event id exists, so a stable synthetic
 *   key from (system code, day, ET clock). Deterministic, so a re-run of the
 *   same schedule row lands on the same id rather than minting a duplicate.
 * - Committee site: same shape but hash-suffixed on the normalized title, since
 *   one committee can hold two events on the same day at the same hour.
 *
 * Never random, never time-of-run dependent.
 */
export function canonicalHearingId(event: SourceEvent, adapterKey: string): string {
  const congress = event.congress ?? 0;
  if (EVENT_ID_ADAPTERS.has(adapterKey) && /^\d+$/.test(event.externalEventId)) {
    return `cm-${congress}-${event.externalEventId}`;
  }
  const day = event.calendarDate ? dayKey(event.calendarDate) : 'nodate';
  const clock = clockKey(event.startsAt);
  const body = (event.committeeSystemCode ?? event.chamber).toLowerCase();
  if (adapterKey === SENATE_SCHEDULE_ADAPTER) {
    // The Senate feed publishes its own numeric <identifier>, which is stable
    // across a reschedule. Key on it. Deriving the id from (day, clock) instead
    // was a real defect: moving a hearing changed its id, so the reconciler saw
    // an unknown event and FORKED a duplicate canonical row (caught by the
    // disposable-Postgres verification, section H).
    if (/^\d+$/.test(event.externalEventId)) {
      return `sen-${congress}-${event.externalEventId}`;
    }
    return `sen-${congress}-${body}-${day}-${clock}`;
  }
  const titleFingerprint = contentHash(normalizedTitleKey(event.title)).slice(0, 10);
  return `cs-${congress}-${body}-${day}-${clock}-${titleFingerprint}`;
}

/**
 * The observation-level idempotency key. `hearing_source_observation` is
 * `@@unique([sourceId, externalEventId])`, so a source that lacks a real event id
 * needs a stable derived one — otherwise every run inserts a new observation row
 * for the same event and the provenance ledger grows without bound.
 */
export function observationExternalId(event: SourceEvent, adapterKey: string): string {
  if (event.externalEventId && event.externalEventId.trim().length > 0) {
    return event.externalEventId.trim();
  }
  return canonicalHearingId(event, adapterKey);
}

/**
 * One rung of the deterministic match ladder. `kind` is ordered by confidence:
 * an `id` hit is an official-identifier match and is always taken first; a
 * `title` hit is the weakest and still requires the same chamber, committee and
 * calendar day.
 */
export type MatchKeyKind = 'id' | 'natural' | 'day' | 'title';

export interface MatchKey {
  kind: MatchKeyKind;
  /** The exact `committee_hearing.id` to look up (only for `kind: 'id'`). */
  id?: string;
  /** Structural predicate for the non-id rungs. */
  predicate?: {
    chamber: string;
    committeeSystemCode?: string | null;
    committeeName?: string | null;
    calendarDate: Date;
    /** ET HHMM the row's startsAt must render as, when the source gave a time. */
    clock?: string;
    /** Normalized title the row must equal, for the weakest rung. */
    titleKey?: string;
  };
}

/**
 * Ordered candidate keys for resolving an observation to an existing canonical
 * hearing. The caller (CanonicalHearingRepository) walks these in order and
 * takes the first hit, so the strongest official-identifier evidence always
 * wins and the fuzzy-ish rung can only ever apply when nothing better matched.
 *
 * A Senate hearing that Congress.gov already published as `cm-119-{eventId}` is
 * exactly why the `natural` rung exists: the Senate schedule page carries no
 * event id, so without it the Senate adapter would mint a second `sen-...` row
 * for an event already in the table.
 */
export function matchKeys(event: SourceEvent, adapterKey: string): MatchKey[] {
  // NOTE: the STRONGEST rung is not in this list. Before consulting these keys,
  // the reconciler checks whether THIS source has already reported THIS
  // external event id and linked it to a hearing — see
  // HearingReconcilerService.reconcileEvent. That rung is what keeps a
  // rescheduled event on its original row even for an adapter whose synthetic
  // id is date-derived, and it cannot be expressed here because it is a lookup
  // against the observation ledger rather than a predicate over hearings.
  const keys: MatchKey[] = [{ kind: 'id', id: canonicalHearingId(event, adapterKey) }];
  const calendarDate = event.calendarDate;
  if (!calendarDate) return keys;

  const chamber = displayChamber(event.chamber);
  const clock = clockKey(event.startsAt);
  const base = {
    chamber,
    committeeSystemCode: event.committeeSystemCode ?? null,
    committeeName: event.committeeName ?? null,
    calendarDate,
  };

  // Only meaningful when the source actually published a time; a date-only
  // observation must not claim to match a timed row on the strength of 'd'.
  if (event.committeeSystemCode && clock !== 'd') {
    keys.push({ kind: 'natural', predicate: { ...base, clock } });
  }
  if (event.committeeSystemCode) {
    keys.push({ kind: 'day', predicate: { ...base } });
  }
  const titleKey = normalizedTitleKey(event.title);
  if (titleKey.length >= 12) {
    keys.push({ kind: 'title', predicate: { ...base, titleKey } });
  }
  return keys;
}

/**
 * `committee_hearing.chamber` is stored in Display Case ('House' | 'Senate' |
 * 'Joint') by the pre-existing sync, while `congress_committee.chamber` and this
 * module's `Chamber` type are lowercase. Convert at every boundary rather than
 * letting the two conventions leak into a comparison — a mismatch here silently
 * turns every structural match rung into a miss.
 */
export function displayChamber(chamber: string): string {
  const c = chamber.trim().toLowerCase();
  if (c === 'house') return 'House';
  if (c === 'senate') return 'Senate';
  if (c === 'joint') return 'Joint';
  return chamber;
}

/** Inverse of {@link displayChamber}. */
export function normalizeChamber(chamber: string | null | undefined): 'house' | 'senate' | 'joint' {
  const c = (chamber ?? '').trim().toLowerCase();
  if (c === 'house') return 'house';
  if (c === 'senate') return 'senate';
  return 'joint';
}

/**
 * Map a source's own status wording onto `committee_hearing.event_status`.
 * Unknown wording returns null rather than guessing 'scheduled' — a caller must
 * be able to tell "the source said nothing" from "the source said scheduled",
 * because only the latter should clear a previously-observed cancellation.
 */
export function normalizeEventStatus(raw: string | null | undefined): EventStatus | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/cancel/.test(s)) return 'canceled';
  if (/postpon|reschedul|delay/.test(s)) return 'postponed';
  if (/in\s*progress|underway|convened|live/.test(s)) return 'in_progress';
  if (/complete|adjourn|concluded|recessed\s*subject/.test(s)) return 'completed';
  if (/schedul|announc|confirmed|open|notice/.test(s)) return 'scheduled';
  return null;
}

/**
 * Closed-session detection. Most committee business is public; a markup or
 * business meeting explicitly noticed as closed/executive session is not, and
 * must never be queued for public capture.
 */
export function inferVisibility(
  title: string | null | undefined,
  eventType: string | null | undefined,
): Visibility {
  const t = `${title ?? ''} ${eventType ?? ''}`.toLowerCase();
  if (/\bclosed\b|\bexecutive session\b|\bclassified\b/.test(t)) return 'private';
  return 'public';
}

/**
 * Normalize a source's event-type wording to the small set the calendar filters
 * on, preserving the original in the observation. 'meeting' is the catch-all so
 * an unrecognized notice still lands somewhere sensible.
 */
export function normalizeEventType(raw: string | null | undefined): string {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t) return 'meeting';
  if (/mark\s*-?\s*up/.test(t)) return 'markup';
  if (/hearing/.test(t)) return 'hearing';
  if (/business meeting|organizational|executive session/.test(t)) return 'meeting';
  if (/field/.test(t)) return 'hearing';
  return 'meeting';
}
