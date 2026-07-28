import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { isoDate } from '../strategy/versioning.js';
import {
  ReferenceService,
  type ReferenceCalendars,
  type ReferenceRow,
} from '../reference/reference.service.js';
import { AGENTIC_FLAGS, StrategyFlagsService } from '../flags/strategy-flags.service.js';
import { RunsService } from './runs.service.js';
import { WatcherService } from './watcher.service.js';
import { classifyRisk } from './risk-router.js';
import { RUN_TERMINAL_STATES } from './run-state.js';
import type { Finding } from './watcher-checks.js';
import type { CreateRunDto, TransitionRunDto } from './dto/agents.dto.js';

/*
 * Stage F2 DB-polled Watcher scheduler. A plain setInterval in a Nest
 * lifecycle hook — @nestjs/schedule is deliberately NOT installed (no new
 * deps). Missions are the schedule: sp_agent_mission.nextRunAt is the claim
 * column, and the claim itself is an atomic UPDATE ... FROM (SELECT ... FOR
 * UPDATE SKIP LOCKED) that bumps nextRunAt forward by the cadence and RETURNS
 * the claimed rows — the same claim-on-read shape as intel-alert's
 * flushDigests — so two pods polling concurrently can never double-run a
 * mission (the loser's SELECT skips the locked row and the row is no longer
 * due once the winner commits).
 */

/** One claimed row from the atomic claim UPDATE (dueAt = the PRE-bump nextRunAt). */
interface ClaimedMission {
  id: string;
  tenantId: string;
  strategyId: string | null;
  cadence: string;
  dueAt: Date;
}

export interface TickResult {
  claimed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/** How many due missions one tick claims (bounded batch; the rest wait a tick). */
const CLAIM_BATCH = 100;
const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 15_000;

@Injectable()
export class WatcherSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatcherSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard: a slow tick must not overlap the next interval fire. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly watcher: WatcherService,
    private readonly runs: RunsService,
    private readonly flags: StrategyFlagsService,
    private readonly reference: ReferenceService,
  ) {}

  /**
   * DARK BY DEFAULT: the scheduler arms only when BOTH env switches are on —
   * STRATEGY_AGENTS_ENABLED (the agentic kill-switch every agentic flag is
   * ANDed with) AND STRATEGY_WATCHER_SCHEDULER (this loop's own switch). A
   * deploy with agents enabled but the scheduler flag unset runs NO timer.
   * Per-tenant gating happens per claimed mission below (and again inside
   * WatcherService.runCheckNow — defense-in-depth).
   */
  onModuleInit(): void {
    if (
      process.env.STRATEGY_AGENTS_ENABLED !== 'true' ||
      process.env.STRATEGY_WATCHER_SCHEDULER !== 'true'
    ) {
      return;
    }
    const raw = Number(process.env.STRATEGY_WATCHER_POLL_MS);
    const intervalMs = Math.max(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_MS, MIN_POLL_MS);
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Never keep the process alive just for the poll loop.
    this.timer.unref?.();
    this.logger.log(`watcher scheduler armed (poll every ${intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Interval callback: guarded so a still-in-flight tick is never overlapped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err) {
      // The loop itself must survive anything (next interval retries).
      this.logger.error(`watcher scheduler tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One claim+process pass (exposed for tests — no timer, no re-entrancy
   * guard). Claims due missions cross-tenant, then runs each check; a
   * poisoned mission is isolated by the per-mission try/catch below and can
   * never wedge the loop.
   */
  async tickOnce(): Promise<TickResult> {
    // ATOMIC CLAIM (cross-tenant => withSystem, mirrors intel-alert
    // flushDigests): the inner SELECT ... FOR UPDATE SKIP LOCKED picks due
    // active cadence missions without blocking on (or double-claiming against)
    // a concurrent pod; the UPDATE bumps nextRunAt forward IN THE SAME
    // STATEMENT, so by the time this tx commits the row is no longer due.
    // The new nextRunAt stays ON the mission's schedule: advance the PRE-bump
    // nextRunAt by whole cadence steps to the first occurrence strictly after
    // now(). Claiming requires next_run_at <= now(), so the step count is >= 1
    // and the result is never in the past; claim lag (poll interval, a slow
    // batch) therefore never drifts the fire time, and a mission that sat due
    // for a week (downtime) fires ONCE and resumes its ORIGINAL phase —
    // missed occurrences are skipped, never replayed as a catch-up storm.
    // KNOWN RE-ANCHOR (accepted Stage F tradeoff): the outbox consumer's
    // bring-forward overwrites next_run_at = now() — the mission's only
    // schedule column — so an edit-triggered check re-phases the cadence to
    // the edit time. Preserving the original phase across bring-forwards
    // needs a dedicated anchor column (deliberately out of scope here).
    // dueAt (the PRE-bump nextRunAt, via the FROM alias) keys the idempotency
    // bucket AT DAY GRANULARITY (see the bucket comment below): if this tick
    // crashes after commit but before the run insert, the occurrence is simply
    // skipped (claim already moved nextRunAt); if a duplicate trigger for the
    // same occurrence ever races through, RunsService dedupes on
    // (tenantId, idempotencyKey).
    const claimed = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<ClaimedMission[]>`
        UPDATE sp_agent_mission m
           SET next_run_at = due.next_run_at +
                 (CASE due.cadence WHEN 'weekly' THEN interval '7 days' ELSE interval '1 day' END) *
                 (FLOOR(EXTRACT(EPOCH FROM (now() - due.next_run_at)) /
                        (CASE due.cadence WHEN 'weekly' THEN 604800 ELSE 86400 END)) + 1),
               updated_at = now()
          FROM (
            SELECT id, tenant_id, next_run_at, cadence
              FROM sp_agent_mission
             WHERE state = 'active' AND cadence IS NOT NULL AND next_run_at <= now()
             ORDER BY next_run_at ASC
             LIMIT ${CLAIM_BATCH}
             FOR UPDATE SKIP LOCKED
          ) due
         WHERE m.id = due.id
        RETURNING m.id, m.tenant_id AS "tenantId", m.strategy_id AS "strategyId",
                  due.cadence AS "cadence", due.next_run_at AS "dueAt"`,
    );

    if (claimed.length > 0) {
      this.logger.log(`watcher scheduler tick claimed ${claimed.length} due mission(s)`);
    }
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    for (const mission of claimed) {
      // Occurrence bucket = the UTC DAY of the pre-bump nextRunAt this claim
      // consumed — NOT the full timestamp. The outbox consumer brings a
      // mission forward (nextRunAt = now()) on every plan edit, so during an
      // active editing session each poll would otherwise consume a brand-new
      // timestamp bucket and mint a fresh ready_for_review run per poll.
      // Day granularity coalesces them: the same-day key makes runCheckNow
      // (and the firm placeholder below) REFRESH the day's existing run in
      // place — one run per mission per day, mirroring the manual path's
      // watch:<missionId>:<today> key.
      const bucket = isoDate(new Date(mission.dueAt))!;
      const idempotencyKey = `sched:${mission.id}:${bucket}`;
      try {
        // Per-tenant gate, checked BEFORE minting anything: a tenant whose
        // strategyWatcher flag is off skips QUIETLY (no run, no error spam) —
        // nextRunAt was already bumped, so it re-checks next occurrence.
        // Fail-closed (flag read failure => false). runCheckNow re-checks the
        // same flag as defense-in-depth.
        const enabled = await this.flags.isAgenticFlagEnabled(
          mission.tenantId,
          AGENTIC_FLAGS.strategyWatcher,
        );
        if (!enabled) {
          skipped++;
          continue;
        }
        this.logger.log(
          `[mission:${mission.id} tenant:${mission.tenantId}] scheduled ` +
            `${mission.strategyId === null ? 'firm-calendar' : 'strategy'} check (key ${idempotencyKey})`,
        );
        if (mission.strategyId === null) {
          // FIRM-LEVEL SEAM: WatcherService.runCheckNow is strategy-scoped by
          // contract (it 400s on strategyId null) — firm calendar missions run
          // this minimal placeholder pass instead (see method docs).
          await this.runFirmCalendarPlaceholder(mission, idempotencyKey);
        } else {
          // userId null => system-triggered (runs under withTenant, authorKind
          // meri); trigger passed EXPLICITLY so the run ledger never labels an
          // automated check 'manual'.
          await this.watcher.runCheckNow(mission.tenantId, null, mission.id, {
            idempotencyKey,
            trigger: 'scheduled',
          });
        }
        succeeded++;
      } catch (err) {
        // Isolate the poisoned mission: log, best-effort fail its run, and
        // KEEP DRAINING the batch. nextRunAt was already bumped by the claim,
        // so the mission simply retries at its next cadence occurrence.
        failed++;
        this.logger.error(
          `scheduled watcher check failed (mission ${mission.id}, tenant ${mission.tenantId}): ${(err as Error).message}`,
        );
        await this.failRunBestEffort(mission.tenantId, idempotencyKey, err);
      }
    }
    return { claimed: claimed.length, succeeded, failed, skipped };
  }

  /**
   * FIRM-LEVEL PLACEHOLDER (documented seam, plan §F2): a firm-scoped calendar
   * mission (strategyId null) does not yet diff reference calendars ACROSS
   * STRATEGIES — that cross-strategy impact diff is Stage F follow-up work.
   * What IS real is the change detection ('a no-change run creates no noise'):
   * each occurrence fingerprints the tenant's merged reference calendars
   * (ReferenceService.getCalendars — congress + PPBE, baseline or fork) and
   * compares it to the fingerprint the mission's previous run recorded.
   *   - unchanged  => the run lands ready_for_review with findings: [] (the
   *     run row is the record, same convention as runCheckNow's zero-finding
   *     path) — NO finding, NO riskClassification, nothing for a reviewer;
   *   - changed, or no baseline yet (first occurrence / pre-fingerprint rows)
   *     => ONE CRITICAL 'firm-calendar-review' finding, classified by the
   *     RiskRouter with firmLevel=true (=> always critical,
   *     requiresImpactSummary, NEVER auto-apply).
   * Every occurrence records `calendarFingerprint` in the run's findings JSON
   * so the next occurrence has a baseline. No change-set is proposed (there
   * are no ops to propose yet) — the run itself is the review obligation, and
   * its viewer is the review queue's firm-level section (GET
   * /agents/runs/firm-review → RunsService.listFirmReview, which lists
   * finding-carrying firm runs in ready_for_review and excludes the
   * zero-finding ledger rows); a reviewer drains it via the ready_for_review
   * -> completed transition. Replace the changed-path body with the real
   * cross-strategy calendar diff when it lands.
   */
  private async runFirmCalendarPlaceholder(
    mission: ClaimedMission,
    idempotencyKey: string,
  ): Promise<void> {
    const run = await this.runs.createRun(mission.tenantId, null, mission.id, {
      trigger: 'scheduled',
      idempotencyKey,
    } as CreateRunDto);
    this.logger.log(`[run:${run.id} mission:${mission.id}] firm-calendar placeholder (${run.state})`);
    // Idempotent replay of the same occurrence: if the run already advanced
    // past planning, this occurrence was already handled — leave it alone.
    if (run.state !== 'queued' && run.state !== 'planning') return;
    if (run.state === 'queued') {
      await this.runs.transition(mission.tenantId, null, run.id, {
        to: 'planning',
      } as TransitionRunDto);
    }

    // CHANGE DETECTION (see method docs): only a calendar that actually
    // changed since the last recorded fingerprint — or one we have never
    // fingerprinted — is worth a reviewer's attention.
    const calendars = await this.reference.getCalendars(mission.tenantId);
    const calendarFingerprint = fingerprintCalendars(calendars);
    const previous = await this.lastRecordedFingerprint(mission.tenantId, mission.id, run.id);

    if (previous === calendarFingerprint) {
      // No change: findings [] + the fingerprint (kept current so a later
      // pre-fingerprint gap can never resurface). Zero noise.
      await this.runs.transition(mission.tenantId, null, run.id, {
        to: 'ready_for_review',
        findings: { findings: [], calendarFingerprint },
      } as TransitionRunDto);
      return;
    }

    const message =
      previous === null
        ? 'Firm-level calendar review due: first scheduled check for this mission — verify current reference calendars against every active strategy (automated cross-strategy diff is a Stage F follow-up)'
        : 'Firm-level calendar review due: reference calendars changed since the last scheduled check — verify the changes against every active strategy (automated cross-strategy diff is a Stage F follow-up)';
    // Phase 3 presentation fields: this finding is firm-level (never
    // strategy-scoped), so it never reaches WatchReviewService's per-strategy
    // card UI — only the firm review queue (RunsService.listFirmReview) reads
    // this run, which does not sort on sortRank. Values are still populated
    // (never left to a type-assertion) so this stays a real Finding, not a
    // shape that happens to typecheck.
    const finding: Finding = {
      code: 'firm-calendar-review',
      severity: 'critical',
      nodeIds: [],
      message,
      category: 'calendar',
      title: 'Firm calendar changed',
      impact: message,
      whyCompared: ['calendar fingerprint'],
      sortRank: 1,
    };
    const classification = classifyRisk({
      findings: [{ code: finding.code, severity: finding.severity, message: finding.message }],
      firmLevel: true,
      opCount: 0,
    });
    // Check-run shape (run-state.ts): planning -> ready_for_review directly.
    await this.runs.transition(mission.tenantId, null, run.id, {
      to: 'ready_for_review',
      findings: { findings: [finding], riskClassification: classification, calendarFingerprint },
    } as TransitionRunDto);
  }

  /**
   * The most recent `calendarFingerprint` any prior run of this mission
   * recorded (null = no baseline yet). Scans a bounded window of recent runs
   * rather than only the latest: failed/canceled occurrences never wrote a
   * fingerprint, and a transient failure must not erase the last real
   * observation (which would re-emit the critical finding on an unchanged
   * calendar).
   */
  private async lastRecordedFingerprint(
    tenantId: string,
    missionId: string,
    excludeRunId: string,
  ): Promise<string | null> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spAgentRun.findMany({
        where: { missionId, id: { not: excludeRunId } },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { findings: true },
      }),
    );
    for (const row of rows) {
      const f = row.findings;
      if (f && typeof f === 'object' && !Array.isArray(f)) {
        const fp = (f as Record<string, unknown>).calendarFingerprint;
        if (typeof fp === 'string') return fp;
      }
    }
    return null;
  }

  /**
   * After a check throws, the run it created (if it got that far — the
   * idempotency key finds it) may be stranded in a non-terminal state.
   * Transition it to failed (or canceled from 'queued', the only pre-start
   * state, which cannot legally move to failed) so it never reads as live.
   * ready_for_review is left ALONE: with day-bucketed keys the lookup can
   * resolve to the day's already-reviewable run (a later same-day refresh
   * that threw), and failing it would destroy the review surface — mirrors
   * runCheckNow, whose refresh errors deliberately leave the run untouched.
   * Best-effort: this cleanup failing must not wedge the batch either.
   */
  private async failRunBestEffort(
    tenantId: string,
    idempotencyKey: string,
    err: unknown,
  ): Promise<void> {
    try {
      const run = await this.prisma.withTenant(tenantId, (tx) =>
        tx.spAgentRun.findFirst({ where: { idempotencyKey } }),
      );
      if (!run || RUN_TERMINAL_STATES.has(run.state) || run.state === 'ready_for_review') return;
      const to = run.state === 'queued' ? 'canceled' : 'failed';
      await this.runs.transition(tenantId, null, run.id, {
        to,
        error: ((err as Error)?.message ?? 'scheduled watcher check failed').slice(0, 4000),
      } as TransitionRunDto);
    } catch (cleanupErr) {
      this.logger.error(
        `could not mark scheduled run failed (tenant ${tenantId}, key ${idempotencyKey}): ${(cleanupErr as Error).message}`,
      );
    }
  }
}

/**
 * Stable content fingerprint of the tenant's merged reference calendars —
 * SUBSTANTIVE schedule content only (kind, label, fy, dates), each kind's rows
 * sorted canonically. Deliberately EXCLUDED: row ids (a fork re-mints them for
 * identical content), tone and position (presentation), and the
 * baseline/override source flag (a fork whose rows match the baseline is not a
 * calendar change). Pure and exported for tests.
 */
export function fingerprintCalendars(cal: ReferenceCalendars): string {
  const canon = (rows: ReferenceRow[]): string[] =>
    rows
      .map(
        (r) =>
          `${r.kind}|${r.label}|${r.fy ?? ''}|${isoDate(r.startsOn) ?? ''}|${isoDate(r.endsOn) ?? ''}`,
      )
      .sort();
  return createHash('sha256')
    .update(
      JSON.stringify([canon(cal.congress), canon(cal.ppbeLanes), canon(cal.ppbeCurrentPhases)]),
    )
    .digest('hex');
}
