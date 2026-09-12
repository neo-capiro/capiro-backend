/**
 * `hearing_source_observation` persistence — the provenance ledger.
 *
 * Every official report of an event is kept here verbatim. The canonical
 * `committee_hearing` row is a projection over these rows (see
 * `canonical-diff.ts`), which is what makes conflicting official data auditable
 * instead of silently overwritten.
 *
 * The table has four typed observed_* columns for the fields worth indexing and
 * a `source_metadata` JSON blob for the rest. The full normalized `SourceEvent`
 * is round-tripped through that blob under the `event` key so the projection can
 * be recomputed from the ledger alone — the property that makes the canonical
 * row reproducible. Dates are stored as ISO strings there and revived on read;
 * JSON has no Date type and a silently-stringified Date would break every
 * subsequent comparison.
 *
 * Idempotency: keyed on the schema's `@@unique([sourceId, externalEventId])`, so
 * a scraper that runs every 10 minutes updates one row per event instead of
 * appending a new one. `rawContentHash` makes "did this actually change" a
 * comparison rather than a guess.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { contentHash, normalizeChamber, observationExternalId } from './hearing-identity.js';
import type { ProjectableObservation } from './canonical-diff.js';
import type {
  EventStatus,
  ObservedStreamCandidate,
  SourceDescriptor,
  SourceEvent,
  Visibility,
} from './hearing-discovery.types.js';

/** Outcome of persisting one observation. */
export interface RecordObservationResult {
  observationId: string;
  externalEventId: string;
  /** True on the first sighting of this (source, event) pair. */
  created: boolean;
  /** True when the source's payload differs from the last time we saw it. */
  contentChanged: boolean;
  /**
   * The canonical hearing this (source, event) pair was ALREADY reconciled to on
   * a previous run, if any. This is the strongest identity evidence there is —
   * the same official source calling this the same event — and the reconciler
   * takes it ahead of the whole match ladder. Without it, an adapter whose
   * synthetic id is derived from the schedule (Senate, committee sites) forks a
   * duplicate row the moment a hearing moves.
   */
  existingHearingId: string | null;
}

export class HearingObservationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Persist one source's report of one event. Never destructive: an existing row
   * is refreshed (lastSeenAt + the current payload) rather than duplicated, and
   * `firstSeenAt` is left alone so "when did this event first appear on an
   * official source" stays answerable.
   */
  async recordObservation(
    source: SourceDescriptor,
    event: SourceEvent,
    now: Date,
  ): Promise<RecordObservationResult> {
    const externalEventId = observationExternalId(event, source.adapterKey);
    const payload = serializeEvent(event);
    const hash = contentHash(payload);
    // Prisma's InputJsonValue rejects `undefined`-bearing optional properties,
    // which SerializedEvent has by design (every field is optional). The value
    // is JSON-safe by construction — serializeEvent normalizes Dates to ISO
    // strings and never emits undefined — so the cast asserts what the shape
    // already guarantees rather than papering over an unknown payload.
    const metadata = {
      event: payload,
      adapterKey: source.adapterKey,
    } as unknown as Prisma.InputJsonObject;

    const existing = await this.prisma.hearingSourceObservation.findUnique({
      where: { sourceId_externalEventId: { sourceId: source.id, externalEventId } },
      select: { id: true, rawContentHash: true, hearingId: true },
    });

    if (!existing) {
      const created = await this.prisma.hearingSourceObservation.create({
        data: {
          sourceId: source.id,
          externalEventId,
          rawContentHash: hash,
          firstSeenAt: now,
          lastSeenAt: now,
          sourceUpdatedAt: event.sourceUpdatedAt ?? null,
          sourceMetadata: metadata,
          observedTitle: event.title ?? null,
          observedDate: event.calendarDate ?? null,
          observedStatus: event.eventStatus ?? null,
          observedLocation: event.location ?? null,
        },
        select: { id: true },
      });
      return {
        observationId: created.id,
        externalEventId,
        created: true,
        contentChanged: true,
        existingHearingId: null,
      };
    }

    const contentChanged = existing.rawContentHash !== hash;
    await this.prisma.hearingSourceObservation.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: now,
        // Only rewrite the payload when it actually changed, so `updatedAt`
        // means "the source changed" rather than "a scraper ran".
        ...(contentChanged
          ? {
              rawContentHash: hash,
              sourceMetadata: metadata,
              observedTitle: event.title ?? null,
              observedDate: event.calendarDate ?? null,
              observedStatus: event.eventStatus ?? null,
              observedLocation: event.location ?? null,
              sourceUpdatedAt: event.sourceUpdatedAt ?? null,
            }
          : {}),
      },
    });
    return {
      observationId: existing.id,
      externalEventId,
      created: false,
      contentChanged,
      existingHearingId: existing.hearingId,
    };
  }

  /**
   * Attach an observation to the canonical hearing it reconciled to. Idempotent
   * and only ever set for an observation that has none — re-pointing a settled
   * observation at a different hearing would rewrite history, which is the one
   * thing this ledger must not do. A genuine re-identification is a new
   * observation, not a mutated one.
   */
  async linkToHearing(observationId: string, hearingId: string): Promise<void> {
    await this.prisma.hearingSourceObservation.updateMany({
      where: { id: observationId, hearingId: null },
      data: { hearingId },
    });
  }

  /**
   * Load every observation for a canonical hearing, flattened for projection and
   * carrying its source's priority (lower = more authoritative).
   */
  async loadProjectable(hearingId: string): Promise<ProjectableObservation[]> {
    const rows = await this.prisma.hearingSourceObservation.findMany({
      where: { hearingId },
      include: {
        source: {
          select: { id: true, adapterKey: true, priority: true, chamber: true },
        },
      },
    });
    return rows.map((row) => {
      const meta = (row.sourceMetadata ?? {}) as { event?: SerializedEvent };
      const event = deserializeEvent(meta.event);
      return {
        sourceId: row.sourceId,
        adapterKey: row.source.adapterKey,
        sourcePriority: row.source.priority,
        lastSeenAt: row.lastSeenAt,
        sourceUpdatedAt: row.sourceUpdatedAt,
        congress: event.congress,
        chamber: event.chamber ?? row.source.chamber,
        committeeSystemCode: event.committeeSystemCode,
        subcommitteeSystemCode: event.subcommitteeSystemCode,
        committeeName: event.committeeName,
        title: event.title ?? row.observedTitle,
        eventType: event.eventType,
        eventStatus: (event.eventStatus ?? row.observedStatus) as EventStatus | null,
        visibility: event.visibility,
        startsAt: event.startsAt,
        calendarDate: event.calendarDate ?? row.observedDate,
        displayTime: event.displayTime,
        timeZone: event.timeZone ?? null,
        timeAuthority: event.timeAuthority ?? null,
        location: event.location ?? row.observedLocation,
        officialPageUrl: event.officialPageUrl,
        witnesses: event.witnesses,
        agendaBillIds: event.agendaBillIds,
        agendaComplete: event.agendaComplete,
        streamCandidates: event.streamCandidates,
      };
    });
  }

  /** Observations not yet reconciled to a canonical hearing (drives repair runs). */
  async countUnlinked(): Promise<number> {
    return this.prisma.hearingSourceObservation.count({ where: { hearingId: null } });
  }
}

/** JSON-safe form of a SourceEvent (Dates → ISO strings). */
interface SerializedEvent {
  externalEventId?: string;
  congress?: number | null;
  chamber?: string;
  committeeSystemCode?: string | null;
  subcommitteeSystemCode?: string | null;
  committeeName?: string | null;
  title?: string | null;
  eventType?: string | null;
  eventStatus?: string | null;
  visibility?: string | null;
  startsAt?: string | null;
  calendarDate?: string | null;
  displayTime?: string | null;
  /** IANA zone the source's time is stated in (field-hearing contract). */
  timeZone?: string | null;
  /** WHEN authority of the observation (explicit_local | instant | date_only). */
  timeAuthority?: string | null;
  location?: string | null;
  officialPageUrl?: string | null;
  witnesses?: string[];
  agendaBillIds?: string[];
  agendaComplete?: boolean;
  sourceUpdatedAt?: string | null;
  streamCandidates?: ObservedStreamCandidate[];
  raw?: Record<string, unknown>;
}

export function serializeEvent(event: SourceEvent): SerializedEvent {
  return {
    externalEventId: event.externalEventId,
    congress: event.congress ?? null,
    chamber: event.chamber,
    committeeSystemCode: event.committeeSystemCode ?? null,
    subcommitteeSystemCode: event.subcommitteeSystemCode ?? null,
    committeeName: event.committeeName ?? null,
    title: event.title ?? null,
    eventType: event.eventType ?? null,
    eventStatus: event.eventStatus ?? null,
    visibility: event.visibility ?? null,
    startsAt: event.startsAt ? event.startsAt.toISOString() : null,
    calendarDate: event.calendarDate ? event.calendarDate.toISOString() : null,
    displayTime: event.displayTime ?? null,
    timeZone: event.timeZone ?? null,
    timeAuthority: event.timeAuthority ?? null,
    location: event.location ?? null,
    officialPageUrl: event.officialPageUrl ?? null,
    witnesses: event.witnesses ?? [],
    agendaBillIds: event.agendaBillIds ?? [],
    agendaComplete: event.agendaComplete,
    sourceUpdatedAt: event.sourceUpdatedAt ? event.sourceUpdatedAt.toISOString() : null,
    streamCandidates: event.streamCandidates ?? [],
    raw: event.raw ?? {},
  };
}

function reviveDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function deserializeEvent(serialized: SerializedEvent | undefined): {
  congress: number | null;
  chamber: string | null;
  committeeSystemCode: string | null;
  subcommitteeSystemCode: string | null;
  committeeName: string | null;
  title: string | null;
  eventType: string | null;
  eventStatus: EventStatus | null;
  visibility: Visibility | null;
  startsAt: Date | null;
  calendarDate: Date | null;
  displayTime: string | null;
  timeZone: string | null;
  timeAuthority: string | null;
  location: string | null;
  officialPageUrl: string | null;
  witnesses: string[];
  agendaBillIds: string[];
  agendaComplete?: boolean;
  streamCandidates: ObservedStreamCandidate[];
} {
  const e = serialized ?? {};
  return {
    congress: e.congress ?? null,
    chamber: e.chamber ? normalizeChamber(e.chamber) : null,
    committeeSystemCode: e.committeeSystemCode ?? null,
    subcommitteeSystemCode: e.subcommitteeSystemCode ?? null,
    committeeName: e.committeeName ?? null,
    title: e.title ?? null,
    eventType: e.eventType ?? null,
    eventStatus: (e.eventStatus ?? null) as EventStatus | null,
    visibility: (e.visibility ?? null) as Visibility | null,
    startsAt: reviveDate(e.startsAt),
    calendarDate: reviveDate(e.calendarDate),
    displayTime: e.displayTime ?? null,
    timeZone: e.timeZone ?? null,
    timeAuthority: e.timeAuthority ?? null,
    location: e.location ?? null,
    officialPageUrl: e.officialPageUrl ?? null,
    witnesses: Array.isArray(e.witnesses) ? e.witnesses : [],
    agendaBillIds: Array.isArray(e.agendaBillIds) ? e.agendaBillIds : [],
    agendaComplete: e.agendaComplete === true,
    streamCandidates: Array.isArray(e.streamCandidates) ? e.streamCandidates : [],
  };
}
