/**
 * The non-central Phase 3 discovery jobs, as service methods so the thin
 * `scripts/*.ts` wrappers stay wrappers and the logic stays testable.
 *
 * Four jobs live here:
 *   enrichCommitteeHearings  — per-hearing committee-site enrichment
 *   detectCommitteeUpdates   — per-committee change feed
 *   probeSources             — source health / reachability
 *   reconcileArchives        — post-event archive + official transcript linkage
 *
 * They are separate jobs, not one cron, because they fail independently and on
 * different cadences: enrichment is hot near an event, update detection is
 * steady, probes are cheap, archive reconciliation only matters after an event
 * ends. Each returns `RunCounts` so the shared SyncRun wrapper records it.
 */
import type { PrismaClient } from '@prisma/client';
import type { RunCounts } from '../ingestion/sync-run.helper.js';
import { contentHash } from './hearing-identity.js';
import { CommitteeSourceRepository } from './committee-source.repository.js';
import { CanonicalHearingRepository, insertSiteUpdates } from './canonical-hearing.repository.js';
import { StreamCandidateRepository } from './stream-candidate.repository.js';
import { CommitteeSiteAdapter } from './adapters/committee-site.adapter.js';
import { sleep } from './adapters/source-http.js';
import type {
  CanonicalHearingRef,
  DiscoveryContext,
  SourceDescriptor,
  SourceHealth,
} from './hearing-discovery.types.js';

/**
 * Anything a probe can call. Kept structural rather than requiring the full
 * `CommitteeSourceAdapter` so a caller can pass the three central adapters
 * (which need API keys and congress numbers to construct) without this module
 * having to know how to build them.
 */
export interface ProbeableAdapter {
  parserVersion?: string;
  healthCheck?: (source: SourceDescriptor, ctx: DiscoveryContext) => Promise<SourceHealth>;
}

export type ProbeAdapterMap = Map<string, ProbeableAdapter>;

export interface JobOptions {
  now?: Date;
  delayMs?: number;
  /** Cap on bodies/hearings touched in one run, so a run is always finite. */
  limit?: number;
  log?: (msg: string) => void;
  dryRun?: boolean;
}

export class DiscoveryJobsService {
  private readonly sources: CommitteeSourceRepository;
  private readonly hearings: CanonicalHearingRepository;
  private readonly candidates: StreamCandidateRepository;

  constructor(
    private readonly prisma: PrismaClient,
    deps?: {
      sources?: CommitteeSourceRepository;
      hearings?: CanonicalHearingRepository;
      candidates?: StreamCandidateRepository;
    },
  ) {
    this.sources = deps?.sources ?? new CommitteeSourceRepository(prisma);
    this.hearings = deps?.hearings ?? new CanonicalHearingRepository(prisma);
    this.candidates = deps?.candidates ?? new StreamCandidateRepository(prisma);
  }

  /**
   * Committee-site enrichment. Prioritizes hearings closest to their start: a
   * committee posts witnesses and testimony in the last 24-48 hours, and that is
   * exactly when enrichment is worth an HTTP request. Past events are skipped
   * here — they belong to archive reconciliation.
   */
  async enrichCommitteeHearings(
    opts: JobOptions & { withinHours?: number } = {},
  ): Promise<RunCounts> {
    const now = opts.now ?? new Date();
    const log = opts.log ?? (() => {});
    const withinHours = opts.withinHours ?? 24 * 7;
    const limit = opts.limit ?? 200;
    const horizon = new Date(now.getTime() + withinHours * 3_600_000);

    const upcoming = await this.prisma.committeeHearing.findMany({
      where: {
        date: { gte: startOfDay(now), lte: horizon },
        eventStatus: { in: ['scheduled', 'postponed', 'in_progress'] },
      },
      select: {
        id: true,
        congress: true,
        chamber: true,
        committeeSystemCode: true,
        committeeCode: true,
        committeeName: true,
        title: true,
        date: true,
        startsAt: true,
        url: true,
      },
      orderBy: [{ startsAt: 'asc' }, { date: 'asc' }],
      take: limit,
    });

    const adapter = new CommitteeSiteAdapter();
    const ctx: DiscoveryContext = {
      since: null,
      daysAhead: 0,
      delayMs: opts.delayMs ?? 250,
      log,
    };
    const counts: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };

    for (const row of upcoming) {
      const systemCode = row.committeeSystemCode ?? row.committeeCode;
      if (!systemCode || !row.url) {
        counts.skipped += 1;
        continue;
      }
      const [source] = await this.sources.listEnabled({
        adapterKey: 'committee-site',
        committeeSystemCode: systemCode,
      });
      if (!source) {
        counts.skipped += 1;
        continue;
      }
      const ref: CanonicalHearingRef = {
        id: row.id,
        congress: row.congress,
        chamber: row.chamber,
        committeeSystemCode: systemCode,
        committeeName: row.committeeName,
        title: row.title,
        calendarDate: row.date,
        startsAt: row.startsAt,
        timeZone: null,
        officialPageUrl: row.url,
      };
      await sleep(ctx.delayMs);
      try {
        const enrichment = await adapter.enrichEvent(source, ref, ctx);
        await this.sources.recordOutcome(source.id, { ok: true }, now, adapter.parserVersion);
        if (!enrichment) {
          counts.skipped += 1;
          continue;
        }
        if (opts.dryRun) {
          counts.skipped += 1;
          continue;
        }
        // Witnesses are only FILLED, never overwritten: Congress.gov's witness
        // list is higher authority than a scraped page, and clobbering it with a
        // partial scrape would lose names rather than add them.
        if (enrichment.witnesses?.length) {
          const existing = await this.prisma.committeeHearing.findUnique({
            where: { id: row.id },
            select: { witnesses: true },
          });
          if (!existing?.witnesses?.length) {
            await this.prisma.committeeHearing.update({
              where: { id: row.id },
              data: { witnesses: enrichment.witnesses },
            });
            counts.updated += 1;
          }
        }
        if (enrichment.streamCandidates?.length) {
          const res = await this.candidates.recordCandidates(row.id, enrichment.streamCandidates, {
            now,
            sourceId: source.id,
          });
          if (res.created > 0) {
            counts.inserted += res.created;
            await this.hearings.refreshStreamAvailability(row.id);
          }
        }
        if (enrichment.documents?.length) {
          const inserted = await this.prisma.$transaction((tx) =>
            insertSiteUpdates(
              tx,
              enrichment.documents!.slice(0, 25).map((doc) => ({
                committeeSystemCode: systemCode,
                hearingId: row.id,
                updateType: 'committee_memo_published' as const,
                normalizedTitle: doc.title.slice(0, 500),
                normalizedSummary: null,
                sourceUrl: doc.url,
                officialPublishedAt: doc.publishedAt ?? null,
                previousValue: null,
                newValue: null,
                contentHash: hashDoc(systemCode, row.id, doc.url),
                parserVersion: adapter.parserVersion,
              })),
              now,
              source.id,
            ),
          );
          counts.inserted += inserted;
        }
      } catch (err) {
        counts.errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        await this.sources.recordOutcome(source.id, { ok: false, error: message }, now);
        log(`[enrich] ${row.id} via ${source.sourceUrl} failed: ${message}`);
      }
    }
    log(
      `[enrich] ${upcoming.length} candidate hearings | inserted=${counts.inserted} ` +
        `updated=${counts.updated} skipped=${counts.skipped} errors=${counts.errors}`,
    );
    return counts;
  }

  /**
   * Committee-site update detection. Walks the registered COMMITTEE_SITE sources
   * with conditional GETs, so an unchanged page costs a 304 and produces no
   * change-feed rows.
   */
  async detectCommitteeUpdates(opts: JobOptions = {}): Promise<RunCounts> {
    const now = opts.now ?? new Date();
    const log = opts.log ?? (() => {});
    const sources = await this.sources.listEnabled({ adapterKey: 'committee-site' });
    const slice = opts.limit ? sources.slice(0, opts.limit) : sources;
    const counts: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };

    // Conditional state is held for the run. It is intentionally NOT persisted:
    // `committee_site_update.content_hash` already makes repeat emission
    // idempotent, and adding a second cache would be a second source of truth
    // for "have we seen this" that could disagree with the first.
    const state = new Map<
      string,
      { etag?: string | null; lastModified?: string | null; contentHash?: string | null }
    >();
    const adapter = new CommitteeSiteAdapter({
      priorState: (url) => state.get(url),
      saveState: (url, s) => state.set(url, s),
    });
    const ctx: DiscoveryContext = { since: null, daysAhead: 0, delayMs: opts.delayMs ?? 400, log };

    for (const source of slice) {
      await sleep(ctx.delayMs);
      await this.sources.markChecked(source.id, now);
      try {
        const updates = (await adapter.discoverUpdates?.(source, ctx)) ?? [];
        await this.sources.recordOutcome(
          source.id,
          { ok: true, observedEvents: updates.length },
          now,
          adapter.parserVersion,
        );
        if (!updates.length || opts.dryRun) {
          counts.skipped += 1;
          continue;
        }
        const inserted = await this.prisma.$transaction((tx) =>
          insertSiteUpdates(tx, updates, now, source.id),
        );
        counts.inserted += inserted;
      } catch (err) {
        counts.errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        await this.sources.recordOutcome(source.id, { ok: false, error: message }, now);
        log(`[site-updates] ${source.sourceUrl} failed: ${message}`);
      }
    }
    log(
      `[site-updates] ${slice.length} sources | inserted=${counts.inserted} ` +
        `skipped=${counts.skipped} errors=${counts.errors}`,
    );
    return counts;
  }

  /**
   * Source health probe. Cheap, and the only job whose entire purpose is to make
   * a broken official source visible before a user notices a missing hearing.
   * Probe failures are recorded, never thrown past the loop.
   */
  async probeSources(opts: JobOptions & { adapters?: ProbeAdapterMap } = {}): Promise<RunCounts> {
    const now = opts.now ?? new Date();
    const log = opts.log ?? (() => {});
    const sources = await this.sources.listEnabled();
    const slice = opts.limit ? sources.slice(0, opts.limit) : sources;
    const counts: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
    const ctx: DiscoveryContext = { since: null, daysAhead: 0, delayMs: opts.delayMs ?? 200, log };
    const registry: ProbeAdapterMap =
      opts.adapters ?? new Map([['committee-site', new CommitteeSiteAdapter()]]);

    for (const source of slice) {
      const adapter = registry.get(source.adapterKey);
      if (!adapter?.healthCheck) {
        counts.skipped += 1;
        continue;
      }
      await sleep(ctx.delayMs);
      try {
        const health = await adapter.healthCheck(source, ctx);
        const state = await this.sources.recordOutcome(
          source.id,
          health,
          now,
          adapter.parserVersion ?? null,
        );
        counts.updated += 1;
        if (!health.ok) counts.errors += 1;
        log(
          `[probe] ${source.adapterKey} ${source.sourceUrl} → ${state} ` +
            `(status=${health.status ?? '-'} ${health.durationMs ?? '-'}ms)`,
        );
      } catch (err) {
        counts.errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        await this.sources.recordOutcome(source.id, { ok: false, error: message }, now);
        log(`[probe] ${source.sourceUrl} threw: ${message}`);
      }
    }
    log(
      `[probe] ${slice.length} sources probed | updated=${counts.updated} ` +
        `skipped=${counts.skipped} failures=${counts.errors}`,
    );
    return counts;
  }

  /**
   * Post-event archive reconciliation. Moves finished events out of the
   * 'scheduled' lifecycle and links whatever official record now exists.
   *
   * The completion rule is deliberately conservative: an event is only marked
   * `completed` once its calendar day is fully past. Using "start time + N
   * hours" would mark a hearing complete while it is still gavelled in, and the
   * whole point of `event_status` is that a consumer can trust it.
   */
  async reconcileArchives(opts: JobOptions & { lookbackDays?: number } = {}): Promise<RunCounts> {
    const now = opts.now ?? new Date();
    const log = opts.log ?? (() => {});
    const lookbackDays = opts.lookbackDays ?? 30;
    const from = new Date(startOfDay(now).getTime() - lookbackDays * 86_400_000);
    const counts: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };

    const past = await this.prisma.committeeHearing.findMany({
      where: {
        date: { gte: from, lt: startOfDay(now) },
        eventStatus: { in: ['scheduled', 'in_progress'] },
      },
      select: { id: true, committeeSystemCode: true, committeeCode: true, date: true, title: true },
      take: opts.limit ?? 1000,
    });

    for (const row of past) {
      try {
        if (opts.dryRun) {
          counts.skipped += 1;
          continue;
        }
        // official_hearing_transcript.hearing_id is a nullable soft ref; only an
        // exact match counts. No catch-and-null here: a failing query must
        // surface as an error for this row, not look like "no transcript".
        const transcript = await this.prisma.officialHearingTranscript.findFirst({
          where: { hearingId: row.id },
          select: { id: true, sourceUrl: true },
          orderBy: { fetchedAt: 'desc' },
        });
        await this.prisma.committeeHearing.update({
          where: { id: row.id },
          data: {
            eventStatus: 'completed',
            // coverage_status only advances to 'captured' when a capture
            // actually produced a transcript — Phase 4's job. Here the honest
            // value is unchanged unless an OFFICIAL transcript exists.
            ...(transcript ? { coverageStatus: 'captured' } : {}),
          },
        });
        counts.updated += 1;
        const systemCode = row.committeeSystemCode ?? row.committeeCode;
        if (transcript?.sourceUrl && systemCode) {
          const inserted = await this.prisma.$transaction((tx) =>
            insertSiteUpdates(
              tx,
              [
                {
                  committeeSystemCode: systemCode,
                  hearingId: row.id,
                  updateType: 'official_transcript_posted' as const,
                  normalizedTitle: row.title.slice(0, 500),
                  normalizedSummary: 'An official transcript is now published for this hearing.',
                  sourceUrl: transcript.sourceUrl,
                  officialPublishedAt: null,
                  previousValue: null,
                  newValue: transcript.sourceUrl,
                  contentHash: hashDoc(systemCode, row.id, transcript.sourceUrl),
                  parserVersion: 'archive-reconcile/2026-08-20',
                },
              ],
              now,
              null,
            ),
          );
          counts.inserted += inserted;
        }
      } catch (err) {
        counts.errors += 1;
        log(`[archives] ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log(
      `[archives] ${past.length} past events | completed=${counts.updated} ` +
        `transcriptSignals=${counts.inserted} errors=${counts.errors}`,
    );
    return counts;
  }
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Stable change identity for a document link, computed with the same hash as
 * every other dedupe key in this phase so "have we already filed this" is one
 * rule rather than several.
 */
function hashDoc(systemCode: string, hearingId: string, url: string): string {
  return contentHash({ systemCode, hearingId, url });
}
