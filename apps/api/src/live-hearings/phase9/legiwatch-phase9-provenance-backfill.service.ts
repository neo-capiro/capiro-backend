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
      const reconciler = input.reconcilerFactory
        ? input.reconcilerFactory()
        : new HearingReconcilerService(this.prisma);
      for (const item of enriched) {
        await this.applyCandidate(item, { result, source, reconciler, options: input });
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
    result.nextCursor =
      result.scanned === limit ? (enriched[enriched.length - 1]?.row.id ?? null) : null;
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
      reconciler: Pick<HearingReconcilerService, 'reconcileEvent'>;
      options: ProvenanceBackfillOptions;
    },
  ): Promise<void> {
    const { row } = item;
    if (item.classification === 'UNFETCHABLE') return;
    try {
      const event = ctx.options.observeEvent
        ? await ctx.options.observeEvent(row.id)
        : await this.observeEvent(row, ctx.source);
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
                'congress-gov',
              )
            )?.kind ?? 'new';
      const kind = await probe(event);
      if (kind === 'new') {
        item.classification = 'SKIPPED_IDENTITY_CONFLICT';
        return;
      }
      const outcome = await ctx.reconciler.reconcileEvent(
        ctx.source as SourceDescriptor,
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
    return this.prisma.$queryRawUnsafe<CandidateRow[]>(
      `SELECT h.id, h.event_status, h.chamber, h.congress, h.committee_system_code,
              h.title, h.url, h.starts_at, h.date
       FROM committee_hearing h
       WHERE COALESCE(h.starts_at, h.date::timestamp)
               BETWEEN now() - ($1 || ' days')::interval
                   AND now() + interval '30 days'
         AND h.url IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM hearing_source_observation o
           WHERE o.hearing_id = h.id AND o.reconciliation_status = 'RECONCILED'
         )
         AND ($3::text IS NULL OR h.id > $3::text)
       ORDER BY COALESCE(h.starts_at, h.date::timestamp) ASC, h.id ASC
       LIMIT $2::int`,
      String(input.lookbackDays),
      input.limit,
      input.cursor,
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
  ): Promise<SourceEvent> {
    const adapterKey = classifyCandidate(row).likelyAdapter;
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
    if (!detail) {
      throw new Error(`congress-gov returned no payload for event ${derived}`);
    }
    const event = adapter.toSourceEventPublic(detail, source);
    if (!event) {
      throw new Error(`congress-gov payload not normalizable for event ${derived}`);
    }
    return event;
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
