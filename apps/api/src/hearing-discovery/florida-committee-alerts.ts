import { contentHash } from './hearing-identity.js';
import type {
  CalendarFacts,
  CalendarField,
  CalendarDocument,
  AgendaItem,
} from './legislative-calendar.js';
import type { CommitteeUpdateObservation, SiteUpdateType } from './hearing-discovery.types.js';

const STATE_KEY = /^state:([A-Z]{2}):(.+)$/i;

export type StateCommitteeFollowRef = {
  jurisdiction: string;
  stateCommitteeId: string;
};

/**
 * Existing committee follows deliberately use a soft-reference string. State
 * committees therefore get a collision-proof namespace without a table rewrite
 * or a second notification pipeline.
 */
export function stateCommitteeFollowKey(jurisdiction: string, stateCommitteeId: string): string {
  const state = jurisdiction.trim().toUpperCase();
  const id = stateCommitteeId.trim();
  if (!/^[A-Z]{2}$/.test(state) || state === 'US' || !id)
    throw new Error('State committee follow requires a two-letter jurisdiction and committee id');
  return `state:${state}:${id}`;
}

export function parseStateCommitteeFollowKey(value: string): StateCommitteeFollowRef | null {
  const match = STATE_KEY.exec(value.trim());
  if (!match || match[1]!.toUpperCase() === 'US' || !match[2]!.trim()) return null;
  return {
    jurisdiction: match[1]!.toUpperCase(),
    stateCommitteeId: match[2]!.trim(),
  };
}

/** Alias ids are accepted only from the official directory evidence contract.
 * Callers still verify that every returned id resolves to a Florida committee
 * row before using it as an alert stream. */
export function verifiedStateCommitteeAliasIds(sourceEvidence: unknown): string[] {
  if (!sourceEvidence || typeof sourceEvidence !== 'object' || Array.isArray(sourceEvidence))
    return [];
  const aliases = (sourceEvidence as { directory?: { aliasIds?: unknown } }).directory?.aliasIds;
  if (!Array.isArray(aliases)) return [];
  return [
    ...new Set(
      aliases
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

/** Encode one router segment. WHATWG URL parsing normalizes even percent-encoded
 * standalone dot segments, so reject those two impossible canonical ids. */
function committeePathSegment(value: string): string {
  if (value === '.' || value === '..') throw new Error('Unsafe committee route segment');
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Canonical state/federal destination used by inbox and email alert links. */
export function committeeUpdatesDeepLink(committeeSystemCode: string): string {
  const state = parseStateCommitteeFollowKey(committeeSystemCode);
  return state
    ? `/legiwatch/committees/${committeePathSegment(state.jurisdiction)}/${committeePathSegment(state.stateCommitteeId)}?tab=updates`
    : `/legiwatch/committees/${committeePathSegment(committeeSystemCode)}?tab=updates`;
}

type StateCalendarAlertInput = {
  jurisdiction: string;
  stateCommitteeId: string;
  hearingId: string;
  revision: number;
  existed: boolean;
  /** Existing unresolved hearing became attributable to this state committee. */
  firstCommitteeAttribution?: boolean;
  before: Partial<CalendarFacts>;
  after: Partial<CalendarFacts>;
  changedFields: readonly CalendarField[];
  sourceUrl: string;
  publishedAt: string | null;
  parserVersion: string | null;
};

function valueText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function documentType(document: CalendarDocument): SiteUpdateType {
  const kind = document.kind.toLowerCase();
  if (kind.includes('transcript')) return 'official_transcript_posted';
  if (kind.includes('testimony') || kind.includes('witness')) return 'witness_testimony_published';
  if (kind.includes('amendment')) return 'amendment_added';
  if (kind.includes('archive') || kind.includes('video')) return 'archive_posted';
  return 'committee_memo_published';
}

function eventSummary(after: Partial<CalendarFacts>): string {
  const parts = [after.time?.date, after.time?.rawTime, after.location].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'See the official meeting notice for details.';
}

/**
 * Translate one committed state calendar transition into the same durable
 * committee publication feed used by federal follows. The returned hashes are
 * derived only from canonical state, so replaying an unchanged observation is
 * idempotent even across worker restarts.
 */
export function stateCalendarCommitteeUpdates(
  input: StateCalendarAlertInput,
): CommitteeUpdateObservation[] {
  const committeeSystemCode = stateCommitteeFollowKey(input.jurisdiction, input.stateCommitteeId);
  const officialPublishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
  const rows: CommitteeUpdateObservation[] = [];
  const push = (
    updateType: SiteUpdateType,
    normalizedTitle: string,
    normalizedSummary: string | null,
    token: unknown,
    previousValue: unknown = null,
    newValue: unknown = null,
    sourceUrl = input.sourceUrl,
  ) => {
    rows.push({
      committeeSystemCode,
      hearingId: input.hearingId,
      updateType,
      normalizedTitle,
      normalizedSummary,
      sourceUrl,
      officialPublishedAt,
      previousValue: valueText(previousValue),
      newValue: valueText(newValue),
      contentHash: contentHash({
        contract: 'state-committee-alert-v1',
        committeeSystemCode,
        hearingId: input.hearingId,
        revision: input.revision,
        updateType,
        token,
      }),
      parserVersion: input.parserVersion,
    });
  };

  if (!input.existed || input.firstCommitteeAttribution) {
    push(
      'hearing_announced',
      `Hearing announced: ${input.after.title ?? 'Committee meeting'}`,
      eventSummary(input.after),
      {
        reason: input.existed ? 'committee_attributed' : 'hearing_created',
        hearing: input.after,
      },
      null,
      input.after,
    );
  }

  const changed = new Set(input.changedFields);
  if (input.existed && changed.has('time')) {
    const before = input.before.time;
    const after = input.after.time;
    if (before?.date !== after?.date)
      push(
        'date_changed',
        `Date changed: ${input.after.title ?? 'Committee meeting'}`,
        eventSummary(input.after),
        { from: before?.date ?? null, to: after?.date ?? null },
        before?.date,
        after?.date,
      );
    if (
      before?.rawTime !== after?.rawTime ||
      before?.startsAt !== after?.startsAt ||
      before?.precision !== after?.precision
    )
      push(
        'time_changed',
        `Time changed: ${input.after.title ?? 'Committee meeting'}`,
        eventSummary(input.after),
        { from: before ?? null, to: after ?? null },
        before,
        after,
      );
  }
  if (input.existed && changed.has('location'))
    push(
      'room_changed',
      `Room changed: ${input.after.title ?? 'Committee meeting'}`,
      eventSummary(input.after),
      { from: input.before.location ?? null, to: input.after.location ?? null },
      input.before.location,
      input.after.location,
    );
  if (input.existed && changed.has('status')) {
    const status = input.after.status;
    if (status === 'postponed' || status === 'canceled')
      push(
        status,
        `${status === 'canceled' ? 'Canceled' : 'Postponed'}: ${input.after.title ?? 'Committee meeting'}`,
        eventSummary(input.after),
        { from: input.before.status ?? null, to: status },
        input.before.status,
        status,
      );
  }
  if (changed.has('watchUrl') && input.after.watchUrl)
    push(
      input.before.watchUrl ? 'livestream_changed' : 'livestream_posted',
      `${input.before.watchUrl ? 'Official watch link changed' : 'Official watch link posted'}: ${input.after.title ?? 'Committee meeting'}`,
      'Open the official publisher page to watch this proceeding.',
      input.after.watchUrl,
      input.before.watchUrl,
      input.after.watchUrl,
      input.after.watchUrl,
    );

  if (changed.has('agenda')) {
    const beforeKeys = new Set((input.before.agenda ?? []).map((item: AgendaItem) => item.key));
    for (const item of input.after.agenda ?? []) {
      if (beforeKeys.has(item.key)) continue;
      push(
        item.kind === 'bill' || item.kind === 'unresolved_bill'
          ? 'bill_added'
          : 'committee_memo_published',
        `Agenda item added: ${item.title}`,
        input.after.title ?? null,
        item,
        null,
        item,
        item.sourceUrl,
      );
    }
  }

  if (changed.has('documents')) {
    const beforeByKey = new Map(
      (input.before.documents ?? []).map((document: CalendarDocument) => [
        document.key,
        contentHash(document),
      ]),
    );
    for (const document of input.after.documents ?? []) {
      if (beforeByKey.get(document.key) === contentHash(document)) continue;
      push(
        documentType(document),
        `Published: ${document.title}`,
        input.after.title ?? null,
        document,
        null,
        document,
        document.url,
      );
    }
  }

  return rows;
}
