/**
 * LegiWatch Live Hearings — Phase 3 canonical hearing discovery core: contracts.
 *
 * Phase 2 (5ff26d38) added the tables; this module adds the discovery layer that
 * fills them. The shape below is the plan's §8.1 adapter contract, narrowed to
 * what Phase 3 actually implements (event discovery, enrichment, committee-site
 * updates, health) — `discoverStream` deliberately yields only PAGE-level
 * candidates observed on an official source. Actually RESOLVING media (probing,
 * SSRF checks, Senate ISVP extraction, the YouTube/C-SPAN legal gates) stays in
 * intel-api's existing StreamResolverService and is wired in Phase 4; Phase 3
 * must not duplicate or weaken it.
 *
 * Every type here is pure data — no Prisma, no fetch — so the reconciler and the
 * parsers stay unit-testable without a database or a network.
 */

/** Chamber of an official congressional body. Matches congress_committee.chamber. */
export type Chamber = 'house' | 'senate' | 'joint';

/** committee_source.source_type. */
export type SourceType =
  | 'CONGRESS_GOV'
  | 'HOUSE_REPOSITORY'
  | 'SENATE_SCHEDULE'
  | 'COMMITTEE_SITE'
  | 'COMMITTEE_RSS'
  | 'COMMITTEE_API'
  | 'COMMITTEE_STRUCTURED_DATA'
  | 'COMMITTEE_HEADLESS';

/** committee_source.source_health. */
export type SourceHealthState = 'healthy' | 'degraded' | 'failing' | 'unknown';

/** committee_hearing.event_status — the committee-event lifecycle. */
export type EventStatus = 'scheduled' | 'postponed' | 'canceled' | 'in_progress' | 'completed';

/** committee_hearing.visibility. */
export type Visibility = 'public' | 'private';

/** hearing_stream_candidate.resolution_state. */
export type StreamResolutionState =
  | 'NOT_CHECKED'
  | 'WAITING_FOR_STREAM'
  | 'READY'
  | 'LIVE'
  | 'ENDED'
  | 'NO_PUBLIC_STREAM'
  | 'POLICY_BLOCKED'
  | 'SOURCE_ERROR';

/**
 * hearing_stream_candidate.capture_policy. Defaults to REVIEW_REQUIRED
 * everywhere — a candidate is never assumed server-capturable, and Phase 3
 * discovery never promotes one to SERVER_CAPTURE_ALLOWED on its own.
 */
export type CapturePolicy =
  | 'SERVER_CAPTURE_ALLOWED'
  | 'BROWSER_CAPTURE_ONLY'
  | 'LICENSE_REQUIRED'
  | 'BLOCKED'
  | 'REVIEW_REQUIRED';

/** committee_site_update.update_type — the enumerated set from the Phase 2 doc comment. */
export type SiteUpdateType =
  | 'committee_news_published'
  | 'hearing_announced'
  | 'date_changed'
  | 'time_changed'
  | 'room_changed'
  | 'postponed'
  | 'canceled'
  | 'witness_added'
  | 'witness_removed'
  | 'witness_testimony_published'
  | 'committee_memo_published'
  | 'bill_added'
  | 'amendment_added'
  | 'livestream_posted'
  | 'livestream_changed'
  | 'archive_posted'
  | 'official_transcript_posted';

/**
 * One hearing/meeting exactly as one official source reported it, before any
 * reconciliation. This is what gets persisted verbatim into
 * hearing_source_observation, so conflicting official data stays auditable
 * instead of being flattened into the canonical row and lost.
 */
export interface SourceEvent {
  /** Qualified state source contract; federal agendaBillIds retain their semantics. */
  legislative?: import('./legislative-calendar.js').LegislativeObservation;
  /**
   * The source's own stable event id (Congress.gov/House `eventId`, a Senate
   * schedule row key, ...). Half of the observation's idempotency key.
   */
  externalEventId: string;
  /** Congress number the event belongs to, when the source states it. */
  congress?: number | null;
  chamber: Chamber;
  /** congress_committee.system_code of the owning full committee, when known. */
  committeeSystemCode?: string | null;
  /** system_code of the subcommittee, when the source distinguishes one. */
  subcommitteeSystemCode?: string | null;
  /** Display committee name as the source words it (fallback when no system code). */
  committeeName?: string | null;
  title?: string | null;
  /** Event type as the source words it (Hearing, Markup, Business Meeting, ...). */
  eventType?: string | null;
  /** Normalized lifecycle status derived from the source's own status wording. */
  eventStatus?: EventStatus | null;
  visibility?: Visibility | null;
  /** True instant of the start when the source gives a time. Null for date-only. */
  startsAt?: Date | null;
  /** Eastern calendar day of the event (never a fabricated midnight instant). */
  calendarDate?: Date | null;
  /** Eastern wall-clock display time as published, e.g. 10:00 AM. */
  displayTime?: string | null;
  /**
   * IANA zone the source's time is stated in. Eastern for normal Washington
   * business; a field hearing's official announcement can state its own local
   * zone (e.g. America/Los_Angeles), and that explicit statement outranks an
   * ambiguous central-calendar instant (hearing-time.resolveSourceTime).
   * Serialized with the observation so the projection stays reproducible from
   * the ledger alone.
   */
  timeZone?: string | null;
  /**
   * How `startsAt`/`displayTime` were derived (hearing-time.resolveSourceTime).
   * `explicit_local` — the source published an explicit local clock + zone and
   * the instant was derived from them: the highest WHEN authority, able to
   * correct a mis-zoned central-calendar instant. `instant` — the source's UTC
   * instant was taken verbatim (Eastern assumption). `date_only` — no time.
   * Serialized with the observation.
   */
  timeAuthority?: string | null;
  location?: string | null;
  /** Public, key-free official event page. Never an api.congress.gov URL. */
  officialPageUrl?: string | null;
  /** Name, Position, Organization strings; source order preserved. */
  witnesses?: string[];
  /** Canonical congress_bill ids on the agenda, e.g. 119-hr-8800. */
  agendaBillIds?: string[];
  agendaComplete?: boolean;
  /** The source's own last-updated timestamp, when it publishes one. */
  sourceUpdatedAt?: Date | null;
  /** Page/media candidates the source itself advertises (no probing here). */
  streamCandidates?: ObservedStreamCandidate[];
  /** Raw provenance blob stored on the observation for later forensics. */
  raw?: Record<string, unknown>;
  /**
   * STRONG-PROOF canonical attachment (state legislative path only): the
   * canonical `committee_hearing.id` this observation was proven to belong to
   * by an exact publisher page or a shared publisher media entry — never by a
   * title/date guess. When set, the legislative reconciler attaches the new
   * source's observation to THIS row instead of deriving a fresh id from the
   * observation's own identity, so two official sources citing the same
   * proceeding converge on one canonical row.
   */
  canonicalHearingId?: string | null;
}

/**
 * A stream candidate as ADVERTISED by an official source — not a resolved one.
 * `mediaUrl` is only set when the source itself publishes a direct media URL; an
 * embedded third-party player yields a page URL plus a provider hint, and Phase
 * 4's resolver decides what (if anything) is capturable.
 */
export interface ObservedStreamCandidate {
  provider: string;
  officialPageUrl: string;
  mediaUrl?: string | null;
  mediaType?: string | null;
  /** Lower sorts first. Official first-party media should always outrank embeds. */
  priority?: number;
  /** Phase 3 only ever asserts REVIEW_REQUIRED / BROWSER_CAPTURE_ONLY / BLOCKED. */
  capturePolicy?: CapturePolicy;
}

/** Additional facts a per-committee source can add to an already-known event. */
export interface EventEnrichment {
  witnesses?: string[];
  documents?: Array<{ title: string; url: string; publishedAt?: Date | null }>;
  location?: string | null;
  eventStatus?: EventStatus | null;
  subcommitteeSystemCode?: string | null;
  officialPageUrl?: string | null;
  streamCandidates?: ObservedStreamCandidate[];
  /** Free-form provenance merged into the observation's source_metadata. */
  raw?: Record<string, unknown>;
}

/**
 * A normalized committee-site change. `contentHash` is the dedupe identity —
 * repeated runs over an unchanged page must produce the same hash and therefore
 * no new row. Full page bodies are never carried here (plan §9).
 */
export interface CommitteeUpdateObservation {
  committeeSystemCode: string;
  updateType: SiteUpdateType;
  normalizedTitle: string;
  normalizedSummary?: string | null;
  sourceUrl: string;
  officialPublishedAt?: Date | null;
  /** Soft ref to the canonical hearing, when the update is about one. */
  hearingId?: string | null;
  previousValue?: string | null;
  newValue?: string | null;
  contentHash: string;
  parserVersion?: string | null;
}

/** Result of one source probe. */
export interface SourceHealth {
  ok: boolean;
  /** HTTP status when the probe was an HTTP fetch. */
  status?: number | null;
  /** Wall-clock duration of the probe. */
  durationMs?: number;
  /** Populated when `ok` is false — never swallowed silently. */
  error?: string | null;
  /** Rows the probe could see, when the adapter can cheaply say. */
  observedEvents?: number | null;
}

/** A committee_source row as the adapters see it (no Prisma types leak here). */
export interface SourceDescriptor {
  id: string;
  committeeSystemCode: string | null;
  chamber: Chamber;
  sourceType: SourceType;
  sourceUrl: string;
  adapterKey: string;
  priority: number;
  parserVersion: string | null;
}

/**
 * Phase 3's adapter contract. `discoverEvents` is the only method every adapter
 * must implement; the rest are optional so a plain central-calendar source is
 * not forced to fake per-committee enrichment.
 */
export interface CommitteeSourceAdapter {
  /** Failures in a bounded discovery pass. Valid returned events may still be
   * reconciled, but callers must not advance a complete-discovery watermark. */
  readonly discoveryErrors?: readonly string[];
  /** Stable key persisted in committee_source.adapter_key. */
  readonly adapterKey: string;
  /** Bumped when a parser's output shape changes, so stale rows are detectable. */
  readonly parserVersion: string;
  discoverEvents(source: SourceDescriptor, ctx: DiscoveryContext): Promise<SourceEvent[]>;
  enrichEvent?(
    source: SourceDescriptor,
    hearing: CanonicalHearingRef,
    ctx: DiscoveryContext,
  ): Promise<EventEnrichment | null>;
  discoverUpdates?(
    source: SourceDescriptor,
    ctx: DiscoveryContext,
  ): Promise<CommitteeUpdateObservation[]>;
  healthCheck?(source: SourceDescriptor, ctx: DiscoveryContext): Promise<SourceHealth>;
}

/** The minimum a canonical hearing exposes to an enrichment adapter. */
export interface CanonicalHearingRef {
  id: string;
  congress: number | null;
  chamber: string;
  committeeSystemCode: string | null;
  committeeName: string;
  title: string;
  calendarDate: Date;
  startsAt: Date | null;
  /** IANA zone the canonical row records for this event's time. */
  timeZone: string | null;
  officialPageUrl: string | null;
}

/** Ambient knobs handed to every adapter call. */
export interface DiscoveryContext {
  /** Incremental watermark from SyncRun; adapters may narrow their window with it. */
  since: Date | null;
  /** Forward window, in days, a schedule adapter should scan. */
  daysAhead: number;
  /** Structured log sink — adapters must not write to the console directly. */
  log: (msg: string) => void;
  /** Per-request pacing so a burst of detail fetches stays under rate limits. */
  delayMs: number;
}
