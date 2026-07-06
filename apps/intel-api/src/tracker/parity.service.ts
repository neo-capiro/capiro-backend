import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { WatchlistSyncService } from '../watchlist/watchlist-sync.service.js';
import {
  computeParity,
  gateVerdict,
  KNOWN_CHANGE_TYPES,
  type ParityDecision,
  type ParityMetrics,
} from './parity.util.js';

/**
 * Phase 5 parity report (§8). Read-only diff of the legacy tracker's decisions
 * (`intelligence_change`) vs the shadow `intel_alert` set over a rolling window;
 * appends one `intel_parity_run` audit row (advisory-lock guarded → idempotent
 * per scope+window). Writes NO apps/api table and delivers nothing (single-sender
 * invariant preserved — legacy remains the sole sender through Phase 8).
 */
const DAY_MS = 86_400_000;

export interface ParityRunResult {
  tenantScope: string;
  tenantId: string | null;
  windowDays: number;
  clientCount: number;
  metrics: ParityMetrics;
  passed: boolean;
  reason: string | null;
  wrote: boolean; // false when the advisory lock was already held (concurrent run)
}

@Injectable()
export class ParityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SourceDataRepository,
  ) {}

  /**
   * @param tenants 'all' (every tracker decision, cross-tenant) or a single
   *                tenant slug/id (scopes both sides to that tenant's clients).
   */
  async run(opts: {
    windowDays: number;
    tenants: string;
    gitSha?: string | null;
  }): Promise<ParityRunResult> {
    const windowDays = opts.windowDays > 0 ? opts.windowDays : 7;
    const all = opts.tenants === 'all' || opts.tenants === '';

    let tenantId: string | null = null;
    let tenantScope = 'all';
    let clientIds: string[] | null = null;

    if (!all) {
      tenantId = await new WatchlistSyncService(this.prisma).resolveTenantId(opts.tenants);
      if (!tenantId) throw new Error(`NO_TENANT_FOR ${opts.tenants}`);
      tenantScope = tenantId;
      const map = await this.repo.clientTenantMap([tenantId]);
      clientIds = map.map((m) => m.clientId);
    }

    // Legacy (ground truth) — durable intelligence_change decisions.
    const legacy: ParityDecision[] = await this.repo.legacyTrackerDecisions(clientIds, windowDays, [
      ...KNOWN_CHANGE_TYPES,
    ]);

    // Shadow — intel_alert (bill path). Audit job: 'all' mode reads across every
    // tenant, scoped mode filters by clientId. Either way this is a cross-tenant
    // audit read → withSystem (bypass RLS).
    const since = new Date(Date.now() - windowDays * DAY_MS);
    const intelRows = await this.prisma.withSystem((tx) =>
      tx.intelAlert.findMany({
        where: {
          sourceType: 'bill',
          createdAt: { gte: since },
          ...(clientIds ? { clientId: { in: clientIds } } : {}),
        },
        select: { clientId: true, sourceRef: true, changeType: true, severity: true },
      }),
    );
    const intel: ParityDecision[] = intelRows.map((r) => ({
      clientId: r.clientId,
      billId: r.sourceRef,
      changeType: r.changeType ?? '',
      severity: r.severity,
    }));

    const metrics = computeParity(legacy, intel);
    const gate = gateVerdict(metrics);
    const clientCount = clientIds
      ? clientIds.length
      : new Set([...legacy, ...intel].map((d) => d.clientId)).size;

    // Append the audit row under an advisory lock (idempotent per scope+window).
    const lockKey = `intel:parity:${tenantScope}:${windowDays}`;
    // Audit write to intel_parity_run (bypass-only RLS policy — tenant_id is
    // nullable in 'all' mode). withSystem IS a $transaction, so the advisory
    // lock + create keep their atomicity.
    const wrote = await this.prisma.withSystem(async (tx) => {
      const lockRows = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
        lockKey,
      );
      if (!lockRows[0]?.locked) return false;
      await tx.intelParityRun.create({
        data: {
          windowDays,
          tenantScope,
          tenantId,
          clientCount,
          legacyCount: metrics.legacyCount,
          intelCount: metrics.intelCount,
          intersection: metrics.intersection,
          overlap: metrics.overlap,
          recall: metrics.recall,
          precision: metrics.precision,
          missedCriticals: metrics.missedCriticals.length,
          severityCriticalMismatches: metrics.severityCriticalMismatches.length,
          maxScoreDelta: null, // legacy stores no comparable fit — recompute pass deferred (§8.3)
          p95ScoreDelta: null,
          passed: gate.passed,
          reason: gate.reason,
          gitSha: opts.gitSha ?? null,
        },
      });
      return true;
    });

    return {
      tenantScope,
      tenantId,
      windowDays,
      clientCount,
      metrics,
      passed: gate.passed,
      reason: gate.reason,
      wrote,
    };
  }

  /**
   * Contiguous green-day streak for a scope ending today (§8.6 corrected query),
   * plus the distinct-day count so a scheduling gap can't masquerade as a streak.
   */
  async greenStreak(tenantScope: string): Promise<{ greenStreak: number; distinctDays: number }> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ green_streak: bigint; distinct_days: bigint }>>(
        `WITH daily AS (
         SELECT run_at::date AS d, bool_and(passed) AS ok
           FROM intel_parity_run
          WHERE tenant_scope = $1 AND run_at >= now() - interval '30 days'
          GROUP BY run_at::date
       )
       SELECT
         (SELECT count(*) FROM daily
           WHERE ok AND d > COALESCE((SELECT max(d) FROM daily WHERE NOT ok), '-infinity'::date)
         ) AS green_streak,
         (SELECT count(*) FROM daily
           WHERE d > COALESCE((SELECT max(d) FROM daily WHERE NOT ok), '-infinity'::date)
         ) AS distinct_days`,
        tenantScope,
      ),
    );
    const r = rows[0];
    return {
      greenStreak: Number(r?.green_streak ?? 0),
      distinctDays: Number(r?.distinct_days ?? 0),
    };
  }
}
