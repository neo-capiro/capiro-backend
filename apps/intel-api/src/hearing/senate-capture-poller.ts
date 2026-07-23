import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { constructSenateIsvpUrl, senateIsvpFallbackUrls } from './stream-extractors.js';
import { SenateScheduleService } from './senate-schedule.service.js';
import type { DiscoveredSenateHearing } from './senate-schedule.js';

/**
 * SenateCapturePollerService — the poll cycle behind the `poll-hearings` verb.
 *
 *   discover (senate.gov feed) → upsert capture claim rows (capture-once via
 *   hearingKey @unique) → cross-check the daily committee_hearing snapshot for
 *   cancels + the committee_hearing.id crosswalk → probe the constructed ISVP
 *   master.m3u8 for go-live → transition status → (Increment B) launch a capture
 *   worker.
 *
 * Increment A ships this with NO launcher (deps.launchCapture undefined) and, in
 * dry-run, records a detected-live hearing as status='live' WITHOUT starting any
 * ffmpeg/Deepgram — proving discovery + liveness end to end while dark.
 *
 * The decision helpers below are PURE + exported so they unit-test without a DB
 * or network; the service does the I/O.
 */

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/** Normalize a committee display name for fuzzy crosswalk matching. */
export function normalizeCommitteeName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Detect the `[Postponed]/[Cancelled]/[Rescheduled]` status prefix that
 * apps/api `sync-hearings` bakes into committee_hearing.title (there is no
 * dedicated status column). Used to skip proceedings that won't air.
 */
export function titleIndicatesCanceled(title: string | null | undefined): boolean {
  return /^\s*\[(postponed|cancell?ed|rescheduled)\]/i.test(title ?? '');
}

/** Ordered ISVP probe URLs for a committee stream (primary streamId + fallbacks). */
export function candidateProbeUrls(comm: string, filename: string): string[] {
  const params = { comm, filename };
  const urls: string[] = [];
  const primary = constructSenateIsvpUrl(params);
  if (primary) urls.push(primary);
  urls.push(...senateIsvpFallbackUrls(params));
  // De-dupe while preserving order.
  return Array.from(new Set(urls));
}

export interface CaptureRowLike {
  status: string;
  scheduledAt: Date | null;
  pollCount: number;
}

export interface ProbeWindow {
  /** How long BEFORE scheduledAt we begin probing (ms). */
  leadMs: number;
  /** How long AFTER scheduledAt we keep probing before giving up (ms). */
  pendingWindowMs: number;
  /** Hard cap on probe attempts before a no-show is skipped. */
  maxPollCount: number;
}

export type ProbeDecision = 'probe' | 'skip-stale' | 'wait' | 'terminal';

/**
 * Decide what to do with a capture row this cycle:
 *  - 'terminal'   : already live/capturing/ended/failed/skipped → leave it.
 *  - 'wait'       : scheduled but the lead window hasn't opened yet.
 *  - 'skip-stale' : past the pending window or over the poll cap → mark skipped.
 *  - 'probe'      : in-window → probe the m3u8 for go-live.
 * A null scheduledAt is treated as "probe now" (unknown start; the feed listed
 * it today) until the poll cap is hit.
 */
export function decideProbeAction(
  row: CaptureRowLike,
  now: Date,
  w: ProbeWindow,
): ProbeDecision {
  if (row.status !== 'discovered' && row.status !== 'pending') return 'terminal';
  if (row.pollCount >= w.maxPollCount) return 'skip-stale';
  const t = now.getTime();
  if (!row.scheduledAt) return 'probe';
  const start = row.scheduledAt.getTime();
  if (t < start - w.leadMs) return 'wait';
  if (t > start + w.pendingWindowMs) return 'skip-stale';
  return 'probe';
}

// ── service ───────────────────────────────────────────────────────────────────

export interface ConcurrencyPolicy {
  /** Max simultaneous 'capturing' rows before further go-lives are deferred. */
  maxConcurrent: number;
  /** A 'capturing' row whose heartbeat is older than this is reaped → pending. */
  staleHeartbeatMs: number;
}

export const DEFAULT_CONCURRENCY: ConcurrencyPolicy = {
  maxConcurrent: 8, // conservative until the Deepgram plan ceiling is confirmed
  staleHeartbeatMs: 3 * 60_000,
};

export interface PollRunOptions {
  dryRun: boolean;
  /** When false, discover + upsert only (no network probing). Default true. */
  probe: boolean;
  window: ProbeWindow;
  concurrency: ConcurrencyPolicy;
}

export interface PollerDeps {
  /** SSRF-guarded liveness probe (net-guard guardedProbe in the wired verb). */
  probe: (url: string) => Promise<{ ok: boolean; status: number; url: string }>;
  /** Launch a capture worker for a live hearing; returns a taskArn. Absent in
   *  Increment A (dark) → a detected-live hearing is recorded, not captured. */
  launchCapture?: (captureId: string) => Promise<string | null>;
  now: () => Date;
}

export interface PollResult {
  discovered: number;
  upserted: number;
  probed: number;
  live: number;
  pending: number;
  skipped: number;
  reaped: number;
  deferred: number;
  launched: number;
  log: string[];
}

export const DEFAULT_PROBE_WINDOW: ProbeWindow = {
  leadMs: 10 * 60_000, // start probing 10 min before the listed start
  pendingWindowMs: 3 * 60 * 60_000, // keep trying for 3h after (long hearings start late)
  maxPollCount: 240, // ~a full day of 1-min polls before giving up on a no-show
};

@Injectable()
export class SenateCapturePollerService {
  private readonly logger = new Logger(SenateCapturePollerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: SenateScheduleService,
    private readonly repo: SourceDataRepository,
  ) {}

  async runOnce(opts: PollRunOptions, deps: PollerDeps): Promise<PollResult> {
    const now = deps.now();
    const res: PollResult = {
      discovered: 0,
      upserted: 0,
      probed: 0,
      live: 0,
      pending: 0,
      skipped: 0,
      reaped: 0,
      deferred: 0,
      launched: 0,
      log: [],
    };

    // 1) Discover from the live schedule feed.
    const hearings = await this.schedule.discover();
    res.discovered = hearings.length;

    // 2) Enrichment/cancel cross-check from the daily committee_hearing snapshot.
    const ymd = toUtcYmd(now);
    const dayIndex = await this.buildDayIndex(ymd);

    // 3) Upsert claim rows (capture-once) + apply cancel skips.
    for (const h of hearings) {
      const committeeName = h.entry.subCommittee
        ? `${h.entry.committee ?? ''} — ${h.entry.subCommittee}`.trim()
        : (h.entry.committee ?? null);
      const match = dayIndex.get(normalizeCommitteeName(h.entry.committee));
      const canceled = match ? titleIndicatesCanceled(match.title) : false;

      await this.prisma.senateHearingCapture.upsert({
        where: { hearingKey: h.entry.identifier },
        create: {
          hearingKey: h.entry.identifier,
          comm: h.comm,
          filename: h.filename,
          committeeCode: h.entry.committeeCode,
          committeeName,
          title: h.entry.matter,
          hearingType: h.entry.type,
          mediaUrl: h.isvpUrl ?? null,
          committeeHearingId: match?.id ?? null,
          scheduledAt: h.scheduledAt,
          status: canceled ? 'skipped' : 'discovered',
        },
        // Preserve lifecycle status on update (never clobber capturing/ended);
        // refresh mutable metadata only.
        update: {
          comm: h.comm,
          filename: h.filename,
          committeeCode: h.entry.committeeCode,
          committeeName,
          title: h.entry.matter,
          hearingType: h.entry.type,
          committeeHearingId: match?.id ?? null,
          scheduledAt: h.scheduledAt,
        },
      });
      res.upserted++;

      if (canceled) {
        // Skip a canceled/postponed proceeding unless we're already on it.
        const marked = await this.prisma.senateHearingCapture.updateMany({
          where: { hearingKey: h.entry.identifier, status: { in: ['discovered', 'pending'] } },
          data: { status: 'skipped', lastError: 'canceled/postponed per committee_hearing title' },
        });
        if (marked.count) {
          res.skipped++;
          res.log.push(`SKIP canceled ${h.entry.identifier} ${committeeName ?? h.comm}`);
        }
      }
    }

    // 4) Probe active rows for go-live.
    if (opts.probe) {
      // Reap stale captures first (worker died / redeploy): a 'capturing' row
      // whose heartbeat has gone stale returns to 'pending' so it re-probes and,
      // if still live, relaunches. This is the durable answer to "which hearings
      // am I capturing" — it survives replica/worker loss (T12).
      const staleBefore = new Date(now.getTime() - opts.concurrency.staleHeartbeatMs);
      const reaped = await this.prisma.senateHearingCapture.updateMany({
        where: { status: 'capturing', heartbeatAt: { lt: staleBefore } },
        data: { status: 'pending', taskArn: null, lastError: 'reaped: stale heartbeat' },
      });
      res.reaped = reaped.count;
      if (reaped.count) res.log.push(`REAP ${reaped.count} stale capture(s)`);

      // Concurrency ceiling: count live captures AFTER reaping; each launch this
      // cycle increments the running tally so we never exceed maxConcurrent.
      let activeCaptures = await this.prisma.senateHearingCapture.count({
        where: { status: 'capturing' },
      });

      const active = await this.prisma.senateHearingCapture.findMany({
        where: { status: { in: ['discovered', 'pending'] } },
      });
      for (const row of active) {
        const action = decideProbeAction(row, now, opts.window);
        if (action === 'terminal' || action === 'wait') continue;
        if (action === 'skip-stale') {
          await this.prisma.senateHearingCapture.update({
            where: { id: row.id },
            data: { status: 'skipped', lastError: 'no-show: past pending window / poll cap' },
          });
          res.skipped++;
          res.log.push(`SKIP no-show ${row.hearingKey} ${row.committeeName ?? row.comm}`);
          continue;
        }

        // action === 'probe'
        res.probed++;
        const urls = candidateProbeUrls(row.comm, row.filename);
        let liveUrl: string | null = null;
        let lastStatus = 0;
        for (const url of urls) {
          try {
            const p = await deps.probe(url);
            lastStatus = p.status;
            if (p.ok) {
              liveUrl = p.url;
              break;
            }
          } catch (err) {
            this.logger.warn(`probe error ${url}: ${(err as Error).message}`);
          }
        }

        if (liveUrl) {
          await this.prisma.senateHearingCapture.update({
            where: { id: row.id },
            data: { status: 'live', mediaUrl: liveUrl, lastProbeStatus: 200 },
          });
          res.live++;
          res.log.push(
            `${opts.dryRun ? 'WOULD_CAPTURE' : 'LIVE'} ${row.hearingKey} ` +
              `${row.committeeName ?? row.comm} -> ${liveUrl}`,
          );
          // Launch a capture worker unless dry-run (Increment A leaves
          // launchCapture undefined → row stays 'live', captured later).
          if (!opts.dryRun && deps.launchCapture) {
            if (activeCaptures >= opts.concurrency.maxConcurrent) {
              // Over the ceiling: leave status='live' and retry next cycle when
              // capacity frees. NEVER silently drop — surface the deferral.
              res.deferred++;
              res.log.push(
                `OVER_CAPACITY defer ${row.hearingKey} ` +
                  `(${activeCaptures}/${opts.concurrency.maxConcurrent} capturing)`,
              );
            } else {
              const arn = await deps.launchCapture(row.id);
              if (arn) {
                await this.prisma.senateHearingCapture.update({
                  where: { id: row.id },
                  data: { status: 'capturing', taskArn: arn, startedAt: now, heartbeatAt: now },
                });
                activeCaptures++;
                res.launched++;
                res.log.push(`LAUNCH ${row.hearingKey} task=${arn}`);
              }
            }
          }
        } else {
          await this.prisma.senateHearingCapture.update({
            where: { id: row.id },
            data: {
              status: 'pending',
              pollCount: { increment: 1 },
              lastProbeStatus: lastStatus || null,
            },
          });
          res.pending++;
        }
      }
    }

    return res;
  }

  /** Build a normalized-committee-name → {id,title} index for one day. */
  private async buildDayIndex(ymd: string): Promise<Map<string, { id: string; title: string | null }>> {
    const index = new Map<string, { id: string; title: string | null }>();
    try {
      const rows = await this.repo.getSenateHearingsForDate(ymd);
      for (const r of rows) {
        const key = normalizeCommitteeName(r.committeeName);
        // First writer wins; the crosswalk is best-effort (multiple hearings per
        // committee/day collapse to one — committeeHearingId is a reference only).
        if (key && !index.has(key)) index.set(key, { id: r.id, title: r.title });
      }
    } catch (err) {
      this.logger.warn(`committee_hearing enrichment skipped: ${(err as Error).message}`);
    }
    return index;
  }
}

/** UTC 'YYYY-MM-DD' for the committee_hearing @db.Date comparison. */
function toUtcYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
