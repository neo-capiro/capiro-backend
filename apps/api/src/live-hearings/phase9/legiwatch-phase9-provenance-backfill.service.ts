/**
 * Provenance backfill — closes the CANONICAL_PROVENANCE gap the honest way.
 *
 * Some canonical hearings inside the READINESS window were created by the
 * legacy hearing sync and never re-observed through the Phase 3 canonical
 * discovery path, so they carry NO reconciled row in the provenance ledger
 * (`hearing_source_observation`). Readiness correctly refuses to pass
 * CANONICAL_PROVENANCE on that gap; weakening the gate is not an option.
 *
 * The fix is NOT a second write path. This job re-observes the REAL event
 * through the EXISTING pipeline and lets the existing invariants do their job:
 *
 *   select  bounded, deterministic window of legacy-only canonical hearings
 *   fetch   Congress.gov committee-meeting detail (real API, real payload)
 *   adapt   CongressGovAdapter.toSourceEvent — the same normalizer as discovery
 *   guard   resolveHearingId FIRST; a `new` answer means identity is ambiguous
 *           (the observation would mint a NEW canonical hearing) → skip+classify
 *   commit  HearingReconcilerService.reconcileEvent → recordObservation →
 *           linkToHearing → the Phase 9 disposition trigger stamps RECONCILED
 *
 * Safety contract (mirrors the operator brief):
 *  - manual-only: refuses to run unless the caller passed --manual
 *  - report-only mode: zero fetches, zero writes — the candidate list is
 *    reviewed before any production mutation
 *  - idempotent: the observation ledger is keyed (sourceId, externalEventId);
 *    a re-run refreshes `last_seen_at` and creates nothing new
 *  - append-only: linkToHearing never re-points a settled observation; the
 *    identity guard never forces a structural match that mints a hearing
 *  - bounded + restartable: LIMIT/OFFSET-style cursor over a deterministic
 *    order; the report carries the remaining gap so the next batch is a
 *    decision, not a guess
 *  - conflict-aware: fetch errors and identity conflicts are counted and
 *    surfaced per row, never swallowed, never fatal to the batch
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CongressGovAdapter,
  currentCongress,
} from '../../hearing-discovery/adapters/congress-gov.adapter.js';
import { HearingReconcilerService } from '../../hearing-discovery/hearing-reconciler.service.js';
import { normalizeChamber } from '../../hearing-discovery/hearing-identity.js';
import { GovInfoChrgAdapter } from '../../hearing-discovery/adapters/govinfo-chrg.adapter.js';
import { SenateCommitteeCalendarAdapter } from '../../hearing-discovery/adapters/senate-committee-calendar.adapter.js';
import { SourceRegistryService } from '../../hearing-discovery/source-registry.service.js';
import type {
  SourceDescriptor,
  SourceEvent,
} from '../../hearing-discovery/hearing-discovery.types.js';
import type { MatchOutcome } from '../../hearing-discovery/canonical-hearing.repository.js';
import { CanonicalHearingRepository } from '../../hearing-discovery/canonical-hearing.repository.js';

/** One candidate row exactly as the operator report presents it. */
export interface ProvenanceBackfillCandidate {
  hearingId: string;
  eventStatus: string | null;
  chamber: string | null;
  title: string | null;
  officialUrl: string | null;
  /** Effective start used by the READINESS window (starts_at, else date). */
  effectiveWhen: string | null;
  likelyAdapter: string;
  /** Official Congress.gov event id when derivable from the row itself. */
  externalEventId: string | null;
  /** How the event id was derived (audit trail for the operator report). */
  derive: 'id' | 'url' | 'none';
  classification:
    | 'PENDING'
    | 'OBSERVED'
    | 'ALREADY_LINKED'
    | 'UNFETCHABLE'
    | 'SKIPPED_IDENTITY_CONFLICT'
    | 'ERROR';
  error?: string;
}

export interface ProvenanceBackfillResult {
  mode: 'REPORT_ONLY' | 'APPLY';
  lookbackDays: number;
  limit: number;
  cursor: string | null;
  scanned: number;
  /** Rows for which a real source fetch + reconcile was attempted. */
  observablesFetched: number;
  observed: number;
  observationCreated: number;
  observationRefreshed: number;
  linkedExisting: number;
  newHearingsCreated: number;
  identityConflicts: number;
  skippedUnfetchable: number;
  errors: number;
  /** How many window hearings STILL lack reconciled provenance after this run. */
  remaining: number;
  nextCursor: string | null;
  candidates: ProvenanceBackfillCandidate[];
}

export interface ProvenanceBackfillOptions {
  manual: boolean;
  lookbackDays?: number;
  limit?: number;
  cursor?: string | null;
  /** REPORT_ONLY when true: no fetches, no writes, just the candidate report. */
  reportOnly?: boolean;
  /**
   * Test seam: produce the SourceEvent for one canonical hearing without the
   * network. Production wires CongressGovAdapter through the same shape.
   */
  observeEvent?: (hearingId: string) => Promise<SourceEvent>;
  /** Test seam: override the reconciler (unit tests assert the guard, not PG). */
  reconcilerFactory?: () => Pick<HearingReconcilerService, 'reconcileEvent'>;
  /** Test seam: the pre-commit identity probe (ladder outcome). */
  identityProbe?: (event: SourceEvent) => Promise<MatchOutcome['kind']>;
}

interface CandidateRow {
  id: string;
  event_status: string | null;
  chamber: string | null;
  congress: number | null;
  committee_system_code: string | null;
  committee_code: string | null;
  title: string | null;
  url: string | null;
  starts_at: Date | null;
  date: Date | null;
}

/** Internal working item: candidate row + its mutable run classification. */
interface WorkingItem extends ProvenanceBackfillCandidate {
  row: CandidateRow;
}

const DEFAULT_LOOKBACK_DAYS = 60;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

@Injectable()
export class LegiWatchPhase9ProvenanceBackfillService {
  constructor(private readonly prisma: PrismaService) {}

  /** Real canonical identity ladder (lazy: constructed with the prisma client). */
  private get identityResolver(): CanonicalHearingRepository | null {
    return this.prisma ? new CanonicalHearingRepository(this.prisma) : null;
  }

  async run(input: ProvenanceBackfillOptions): Promise<ProvenanceBackfillResult> {
    if (!input.manual) {
      throw new Error(
        'provenance-backfill is manual-only; pass --manual (scheduled attach is forbidden)',
      );
    }
    const lookbackDays = bounded(input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 1, 365);
    const limit = bounded(input.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const cursor = input.cursor?.trim() || null;

    const candidates = await this.selectCandidates({ lookbackDays, limit, cursor });
    const enriched: WorkingItem[] = candidates.map((row) => {
      const cls = classifyCandidate(row);
      return {
        row,
        hearingId: row.id,
        eventStatus: row.event_status,
        chamber: row.chamber,
        title: row.title,
        officialUrl: row.url,
        effectiveWhen: (row.starts_at ?? row.date)?.toISOString() ?? null,
        ...cls,
        classification:
          cls.likelyAdapter === 'UNFETCHABLE' ? ('UNFETCHABLE' as const) : ('PENDING' as const),
      };
    });

    const result: ProvenanceBackfillResult = {
      mode: input.reportOnly ? 'REPORT_ONLY' : 'APPLY',
      lookbackDays,
      limit,
      cursor,
      scanned: enriched.length,
      observablesFetched: 0,
      observed: 0,
      observationCreated: 0,
      observationRefreshed: 0,
      linkedExisting: 0,
      newHearingsCreated: 0,
      identityConflicts: 0,
      skippedUnfetchable: 0,
      errors: 0,
      remaining: 0,
      nextCursor: null,
      candidates: [],
    };

    // REPORT_ONLY stops here: the operator reviews the exact candidate list
    // (id, date, title, URL, adapter, external id) before any mutation.
    if (!input.reportOnly) {
      const source = await this.congressGovSource();
      const govInfoSource = await this.ensureGovInfoSource();
      const reconciler = input.reconcilerFactory
        ? input.reconcilerFactory()
        : new HearingReconcilerService(this.prisma);
      for (const item of enriched) {
        await this.applyCandidate(item, {
          result,
          source,
          govInfoSource,
          reconciler,
          options: input,
        });
      }
    }

    result.candidates = enriched.map(
      ({ row: _row, ...c }: WorkingItem): ProvenanceBackfillCandidate => ({
        hearingId: c.hearingId,
        eventStatus: c.eventStatus,
        chamber: c.chamber,
        title: c.title,
        officialUrl: c.officialUrl,
        effectiveWhen: c.effectiveWhen,
        likelyAdapter: c.likelyAdapter,
        externalEventId: c.externalEventId,
        derive: c.derive,
        classification: c.classification,
        ...(c.error ? { error: c.error } : {}),
      }),
    );

    result.skippedUnfetchable = enriched.filter(
      (c) => c.classification === 'UNFETCHABLE',
    ).length;
    result.observed = enriched.filter((c) => c.classification === 'OBSERVED').length;
    result.errors = enriched.filter((c) => c.classification === 'ERROR').length;
    result.identityConflicts = enriched.filter(
      (c) => c.classification === 'SKIPPED_IDENTITY_CONFLICT',
    ).length;
    result.remaining = await this.countRemaining(lookbackDays);
    const lastItem = result.scanned === limit ? enriched[enriched.length - 1] : undefined;
    result.nextCursor = lastItem
      ? `${lastItem.row.starts_at?.toISOString() ?? lastItem.row.date?.toISOString() ?? ''}|${lastItem.row.id}`
      : null;
    return result;
  }

  /**
   * Guard + commit for one candidate. Extracted so the ordering rule is
   * explicit: identity probe BEFORE any write, reconcile ONLY when the ladder
   * resolves to the hearing we already have.
   */
  private async applyCandidate(
    item: WorkingItem,
    ctx: {
      result: ProvenanceBackfillResult;
      source: SourceDescriptor | null;
      govInfoSource: SourceDescriptor | null;
      reconciler: Pick<HearingReconcilerService, 'reconcileEvent'>;
      options: ProvenanceBackfillOptions;
    },
  ): Promise<void> {
    const { row } = item;
    if (item.classification === 'UNFETCHABLE') return;
    try {
      // The observeEvent seam (unit tests) returns a bare SourceEvent; the
      // production path returns { event, adapterKey, source } so the guard and
      // reconciler always see the adapter that actually produced the event
      // (congress-gov OR the Senate committee-calendar fallback).
      const raw = ctx.options.observeEvent
        ? await ctx.options.observeEvent(row.id)
        : item.likelyAdapter === 'govinfo-chrg'
          ? await this.observeEvent(row, ctx.govInfoSource)
          : await this.observeEvent(row, ctx.source);
      const isWrapper = (
        v: unknown,
      ): v is { event: SourceEvent; adapterKey: string; source: SourceDescriptor | null } =>
        typeof v === 'object' && v !== null && 'event' in v;
      const { event, adapterKey: evtAdapterKey, source: evtSource } = isWrapper(raw)
        ? raw
        : {
            event: raw,
            adapterKey: item.likelyAdapter === 'govinfo-chrg' ? 'govinfo-chrg' : 'congress-gov',
            source: item.likelyAdapter === 'govinfo-chrg' ? ctx.govInfoSource : ctx.source,
          };
      ctx.result.observablesFetched += 1;
      // Pre-resolve identity BEFORE any write. Production uses the real
      // canonical ladder (same resolver the reconciler will consult); the
      // optional probe seam exists only for unit tests. A `new` answer means
      // reconciling would mint a NEW canonical hearing — the backfill creates
      // observations, never canonical identity.
      const probe = ctx.options.identityProbe
        ? ctx.options.identityProbe
        : async (evt: SourceEvent) =>
            (
              await (await this.identityResolver)?.resolveHearingId(
                evt,
                evtAdapterKey,
              )
            )?.kind ?? 'new';
      const kind = await probe(event);
      if (kind === 'new') {
        item.classification = 'SKIPPED_IDENTITY_CONFLICT';
        return;
      }
      const outcome = await ctx.reconciler.reconcileEvent(
        (evtSource ?? ctx.source) as SourceDescriptor,
        event,
        new Date(),
      );
      if (outcome.hearingId !== row.id) {
        // The ladder matched a DIFFERENT existing row: treat as a conflict
        // rather than silently linking provenance to the wrong identity.
        item.classification = 'SKIPPED_IDENTITY_CONFLICT';
        return;
      }
      item.classification = 'OBSERVED';
      if (outcome.observationCreated) ctx.result.observationCreated += 1;
      else ctx.result.observationRefreshed += 1;
      if (outcome.match === 'observation' || outcome.match === 'id') {
        ctx.result.linkedExisting += 1;
      }
      if (outcome.hearingCreated) {
        // Cannot happen after the guard, but if it ever does, surface it.
        ctx.result.newHearingsCreated += 1;
      }
    } catch (err) {
      item.classification = 'ERROR';
      item.error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    }
  }

  /**
   * Deterministic, bounded, restartable selection: window hearings with an
   * official URL and NO reconciled observation, oldest effective start first.
   */
  private async selectCandidates(input: {
    lookbackDays: number;
    limit: number;
    cursor: string | null;
  }): Promise<CandidateRow[]> {
    // Keyset cursor on the SORT KEY tuple (effectiveWhen, id) — an id-only cursor
    // silently skips rows when a later-start row has a smaller id (live 2026-09-01:
    // House cm-119-119xxx rows sort after Senate cm-119-338xxx by date but BEFORE it
    // by id, so 38 rows were skipped once the cursor passed a Senate id).
    let cursorEff: string | null = null;
    let cursorId: string | null = null;
    if (input.cursor) {
      const sep = input.cursor.indexOf('|');
      if (sep > 0) {
        cursorEff = input.cursor.slice(0, sep);
        cursorId = input.cursor.slice(sep + 1);
      } else {
        cursorId = input.cursor;
      }
    }
    return this.prisma.$queryRawUnsafe<CandidateRow[]>(
      `SELECT h.id, h.event_status, h.chamber, h.congress, h.committee_system_code,
              h.committee_code, h.title, h.url, h.starts_at, h.date
       FROM committee_hearing h
       WHERE COALESCE(h.starts_at, h.date::timestamp)
               BETWEEN now() - ($1 || ' days')::interval
                   AND now() + interval '30 days'
         AND h.url IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM hearing_source_observation o
           WHERE o.hearing_id = h.id AND o.reconciliation_status = 'RECONCILED'
         )
         AND (
           $3::timestamptz IS NULL
           OR (COALESCE(h.starts_at, h.date::timestamp), h.id) > ($3::timestamptz, $4::text)
         )
       ORDER BY COALESCE(h.starts_at, h.date::timestamp) ASC, h.id ASC
       LIMIT $2::int`,
      String(input.lookbackDays),
      input.limit,
      cursorEff,
      cursorId,
    );
  }

  private async countRemaining(lookbackDays: number): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n
       FROM committee_hearing h
       WHERE COALESCE(h.starts_at, h.date::timestamp)
               BETWEEN now() - ($1 || ' days')::interval
                   AND now() + interval '30 days'
         AND h.url IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM hearing_source_observation o
           WHERE o.hearing_id = h.id AND o.reconciliation_status = 'RECONCILED'
         )`,
      String(lookbackDays),
    );
    return rows[0]?.n ?? 0;
  }

  /** The central congress-gov source row (same one discovery reconciles under). */
  private async congressGovSource(): Promise<SourceDescriptor | null> {
    const rows = await this.prisma.$queryRawUnsafe<SourceDescriptor[]>(
      `SELECT id, committee_system_code AS "committeeSystemCode", chamber,
              source_type AS "sourceType", source_url AS "sourceUrl",
              adapter_key AS "adapterKey", priority, parser_version AS "parserVersion"
       FROM committee_source
       WHERE adapter_key = 'congress-gov' AND enabled = true
       ORDER BY priority ASC
       LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /**
   * Fetch the REAL event for one canonical hearing through the existing
   * Congress.gov adapter normalization. No payload is invented: the adapter's
   * `toSourceEvent` output for the official detail record is exactly what the
   * discovery path reconciles, so provenance written here is byte-compatible
   * with what scheduled discovery writes.
   */
  private async observeEvent(
    row: CandidateRow,
    source: SourceDescriptor | null,
  ): Promise<{ event: SourceEvent; adapterKey: string; source: SourceDescriptor | null }> {
    const adapterKey = classifyCandidate(row).likelyAdapter;
    if (adapterKey === 'govinfo-chrg') {
      const event = await this.observeGovInfoChrgEvent(row);
      return { event, adapterKey: 'govinfo-chrg', source };
    }
    if (adapterKey !== 'congress-gov' || !source) {
      throw new Error(`no fetchable official adapter for ${row.id}`);
    }
    const derived = deriveExternalEventId(row);
    const apiKey = process.env.CONGRESS_API_KEY ?? '';
    const adapter = new CongressGovAdapter({
      apiKey,
      congresses: [currentCongress()],
      maxPages: 1,
    });
    // Pace every detail fetch: the discovery context uses 200ms per request so
    // bursts never trip Congress.gov's per-IP throttle. Same contract here —
    // a 25-row batch fires 25 detail calls and un-paced bursts surface as
    // "no payload" failures (live 2026-09-01).
    await new Promise((resolve) => setTimeout(resolve, 250));
    const chamber = normalizeChamber(row.chamber);
    const detail = await adapter.fetchCommitteeMeetingDetail(derived, currentCongress(), chamber);
    if (detail) {
      const event = adapter.toSourceEventPublic(detail, source);
      if (!event) {
        throw new Error(`congress-gov payload not normalizable for event ${derived}`);
      }
      return { event, adapterKey: 'congress-gov', source };
    }
    // Congress.gov publishes no meeting record for this event. Some Senate
    // committees publish the SAME event on their own official calendar — a
    // legitimate first-party source. Fall through to it rather than failing:
    // the observation still flows through the same ledger + reconciler, and the
    // identity guard below still refuses anything that does not resolve to the
    // existing canonical row.
    if (chamber === 'senate') {
      const senate = await this.observeSenateCalendarEvent(row);
      if (senate) return senate;
    }
    throw new Error(`congress-gov returned no payload for event ${derived}`);
  }

  /**
   * Observe one Senate hearing through its own committee's official calendar
   * page (`senate-committee-calendar`). The committee's page is located via the
   * congress_committee registry URL (data, not code); the event is the page
   * entry whose calendar day matches the canonical row. Exactly-one-day-match
   * is unambiguous; multiple same-day entries require a title match, and
   * anything else throws so the row surfaces as an honest ERROR.
   */
  private async observeSenateCalendarEvent(
    row: CandidateRow,
  ): Promise<{ event: SourceEvent; adapterKey: string; source: SourceDescriptor } | null> {
    const systemCode = row.committee_system_code ?? row.committee_code;
    if (!systemCode) return null;
    const senateSource = await this.ensureSenateCalendarSource(systemCode);
    if (!senateSource?.sourceUrl) return null;
    const adapter = new SenateCommitteeCalendarAdapter({
      congress: row.congress ?? currentCongress(),
    });
    const events = await adapter.discoverEvents(senateSource, {
      since: null,
      daysAhead: 0,
      delayMs: 250,
      log: () => {},
    });
    const rowDay = (row.starts_at ?? row.date)?.toISOString().slice(0, 10);
    if (!rowDay) return null;
    const sameDay = events.filter(
      (e) => (e.calendarDate ? e.calendarDate.toISOString().slice(0, 10) : null) === rowDay,
    );
    if (sameDay.length === 0) return null;
    if (sameDay.length > 1) {
      // Committees wrap titles ("Hearings to examine …", "Business Meeting to
      // consider …"), so exact containment is too strict. Match on significant
      // token overlap in EITHER direction with a floor, and require it to be
      // unambiguous — anything else surfaces as an honest ERROR.
      const tokens = (s: string) =>
        new Set(
          (s ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .split(' ')
            .filter((t) => t.length > 2),
        );
      const rowTokens = tokens(row.title ?? '');
      const candidates = sameDay.filter((e) => {
        const pageTokens = tokens(e.title ?? '');
        let shared = 0;
        for (const t of pageTokens) if (rowTokens.has(t)) shared += 1;
        return shared >= 3;
      });
      if (candidates.length !== 1) {
        throw new Error(
          `senate-committee-calendar: ${sameDay.length} same-day entries for ${row.id}, ` +
            `${candidates.length} title candidates; ambiguous`,
        );
      }
      return candidates[0]
        ? { event: candidates[0], adapterKey: 'senate-committee-calendar', source: senateSource }
        : null;
    }
    return sameDay[0]
      ? { event: sameDay[0], adapterKey: 'senate-committee-calendar', source: senateSource }
      : null;
  }

  /**
   * The senate-committee-calendar source row for one committee (created on
   * demand; manual backfill only — never scheduled discovery). The page URL is
   * derived from the committee's registry URL (…/hearings), which is data the
   * registry already owns.
   */
  private async ensureSenateCalendarSource(
    systemCode: string,
  ): Promise<SourceDescriptor | null> {
    const existing = await this.prisma.$queryRawUnsafe<SourceDescriptor[]>(
      `SELECT id, committee_system_code AS "committeeSystemCode", chamber,
              source_type AS "sourceType", source_url AS "sourceUrl",
              adapter_key AS "adapterKey", priority, parser_version AS "parserVersion"
       FROM committee_source
       WHERE adapter_key = 'senate-committee-calendar' AND committee_system_code = $1 AND enabled = true
       ORDER BY priority ASC
       LIMIT 1`,
      systemCode,
    );
    if (existing[0]) return existing[0];
    const registry = await this.prisma.$queryRawUnsafe<Array<{ url: string | null }>>(
      `SELECT url FROM congress_committee WHERE system_code = $1`,
      systemCode,
    );
    const base = registry[0]?.url;
    if (!base) return null;
    const pageUrl = `${base.replace(/\/+$/, '')}/hearings`;
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO committee_source
         (id, committee_system_code, chamber, source_type, source_url, adapter_key,
          priority, parser_version, enabled, source_health, created_at, updated_at)
       SELECT gen_random_uuid()::text, $1, 'senate', 'COMMITTEE_SITE', $2,
              'senate-committee-calendar', 65, 'senate-committee-calendar/2026-09-01',
              true, 'unknown', now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM committee_source
         WHERE adapter_key = 'senate-committee-calendar' AND committee_system_code = $1
       )`,
      systemCode,
      pageUrl,
    );
    const created = await this.prisma.$queryRawUnsafe<SourceDescriptor[]>(
      `SELECT id, committee_system_code AS "committeeSystemCode", chamber,
              source_type AS "sourceType", source_url AS "sourceUrl",
              adapter_key AS "adapterKey", priority, parser_version AS "parserVersion"
       FROM committee_source
       WHERE adapter_key = 'senate-committee-calendar' AND committee_system_code = $1 AND enabled = true
       ORDER BY priority ASC LIMIT 1`,
      systemCode,
    );
    return created[0] ?? null;
  }

  /**
   * Observe one GovInfo CHRG package: summary + MODS -> the same SourceEvent
   * shape the reconciler consumes. calendarDate = package dateIssued (the
   * canonical row represents the PUBLISHED RECORD); actual heldDates are kept
   * verbatim in raw for audit — never silently rewritten to match identity.
   */
  private async observeGovInfoChrgEvent(row: CandidateRow): Promise<SourceEvent> {
    const pkgId = classifyCandidate(row).externalEventId;
    if (!pkgId) throw new Error(`cannot derive GovInfo package id for ${row.id}`);
    const adapter = new GovInfoChrgAdapter(process.env.GOVINFO_API_KEY ?? '');
    const summary = await adapter.fetchSummary(pkgId);
    if (!summary || !summary.dateIssued) {
      throw new Error(`govinfo returned no summary for ${pkgId}`);
    }
    const mods = await adapter.fetchMods(pkgId);
    const authorityId = mods?.committees[0]?.authorityId ?? row.committee_system_code ?? null;
    const chamber = normalizeChamber(
      (summary.chamber ?? row.chamber ?? 'house').toLowerCase().includes('sen') ? 'senate' : 'house',
    );
    const calendarDate = new Date(`${summary.dateIssued}T00:00:00.000Z`);
    return {
      externalEventId: pkgId,
      congress: Number(summary.congress ?? row.congress ?? 0) || (row.congress ?? null),
      chamber,
      committeeSystemCode: authorityId,
      title: summary.title ?? row.title,
      eventType: 'Congressional Hearing (published record)',
      eventStatus: (row.event_status as SourceEvent['eventStatus']) ?? 'completed',
      visibility: 'public',
      startsAt: null,
      calendarDate,
      location: null,
      officialPageUrl:
        summary.detailsLink ??
        `https://www.govinfo.gov/app/details/${pkgId}`,
      witnesses: [],
      agendaBillIds: [],
      sourceUpdatedAt: summary.lastModified ? new Date(summary.lastModified) : null,
      raw: {
        collectionCode: summary.documentType,
        heldDates: mods?.heldDates ?? [],
        pages: null,
        canonicalHearingRowId: row.id,
      },
    };
  }

  /** The govinfo-chrg source row (created on demand; manual backfill only). */
  private async ensureGovInfoSource(): Promise<SourceDescriptor | null> {
    const existing = await this.prisma.$queryRawUnsafe<SourceDescriptor[]>(
      `SELECT id, committee_system_code AS "committeeSystemCode", chamber,
              source_type AS "sourceType", source_url AS "sourceUrl",
              adapter_key AS "adapterKey", priority, parser_version AS "parserVersion"
       FROM committee_source
       WHERE adapter_key = 'govinfo-chrg' AND enabled = true
       ORDER BY priority ASC
       LIMIT 1`,
    );
    if (existing[0]) return existing[0];
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO committee_source
         (id, committee_system_code, chamber, source_type, source_url, adapter_key,
          priority, parser_version, enabled, source_health, created_at, updated_at)
       SELECT gen_random_uuid()::text, NULL, 'joint', 'COMMITTEE_STRUCTURED_DATA',
              'https://api.govinfo.gov', 'govinfo-chrg', 60, 'govinfo-chrg/2026-09-01',
              true, 'unknown', now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM committee_source WHERE adapter_key = 'govinfo-chrg'
       )`,
    );
    const created = await this.prisma.$queryRawUnsafe<SourceDescriptor[]>(
      `SELECT id, committee_system_code AS "committeeSystemCode", chamber,
              source_type AS "sourceType", source_url AS "sourceUrl",
              adapter_key AS "adapterKey", priority, parser_version AS "parserVersion"
       FROM committee_source
       WHERE adapter_key = 'govinfo-chrg' AND enabled = true
       ORDER BY priority ASC LIMIT 1`,
    );
    return created[0] ?? null;
  }
}

/**
 * Classification BEFORE any network I/O: which adapter can legitimately observe
 * this row, and what the official external event id is.
 *
 *  - `cm-{congress}-{eventId}` → congress-gov, event id verbatim
 *  - official congress.gov /event/ URL → parse the event id out of the URL
 *  - transcript-record ids (`{congress}-{jacket}-{date}`, CHRG URLs) are NOT
 *    committee-meeting events; the committee-meeting API cannot observe them
 *    and hand-crafting an observation is forbidden → UNFETCHABLE (excluded from
 *    the backfill; they are transcript-record corpus, not discovery events)
 */
export function classifyCandidate(row: CandidateRow): {
  likelyAdapter: string;
  externalEventId: string | null;
  derive: 'id' | 'url' | 'none';
} {
  const m = /^cm-(\d+)-(\d+)$/.exec(row.id);
  if (m) {
    return { likelyAdapter: 'congress-gov', externalEventId: m[2] ?? null, derive: 'id' };
  }
  const u = /\/event\/(\d+)th-Congress\/(?:house|senate|joint)-event\/(\d+)/.exec(
    row.url ?? '',
  );
  if (u) {
    return { likelyAdapter: 'congress-gov', externalEventId: u[2] ?? null, derive: 'url' };
  }
  // GovInfo Congressional Hearings (CHRG) transcript-record rows: the package id
  // is derivable from the official URL — CHRG-119hhrg64224 etc.
  const g = /(CHRG-\d+(?:hhrg|shrg|sjrg)\d+)/i.exec(row.url ?? '');
  if (g) {
    return { likelyAdapter: 'govinfo-chrg', externalEventId: g[1] ?? null, derive: 'url' };
  }
  return { likelyAdapter: 'UNFETCHABLE', externalEventId: null, derive: 'none' };
}

function deriveExternalEventId(row: CandidateRow): string {
  const c = classifyCandidate(row);
  if (!c.externalEventId) {
    throw new Error(`cannot derive official event id for ${row.id}`);
  }
  return c.externalEventId;
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
