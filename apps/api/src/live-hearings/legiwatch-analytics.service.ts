/**
 * LegiWatch V2 Wave 3 — Analytics (LEGIWATCH-V2-HANDOFF §5.8, §7 "analytics
 * aggregates and time series" BACKEND REQUIRED item).
 *
 * Every panel is a real, tenant-scoped, date-range-scoped server aggregate —
 * never the frontend summing a paginated Feed page (§28/§41 forbid exactly
 * that). `intel_alert` (intel-api's unified signal) is read via cross-schema
 * raw SQL, the same established pattern `hearing-intelligence.worker.ts`
 * already uses in the opposite direction, since apps/api and intel-api share
 * one physical Postgres database.
 *
 * A monitored client with zero matching signals renders `0`; a client with no
 * monitoring model renders `null` (the client never had a `topicId` on any
 * alert JOIN target) — the two are never conflated (§28/§32: missing data is
 * never zero).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

const SOURCE_FAMILY_LABEL: Record<string, string> = {
  bill: 'Congress.gov',
  hearing: 'Committee pages',
  combined: 'Congress.gov + Committee pages',
};

const MATERIALITY_WEIGHT: Record<string, number> = { low: 1, medium: 2, high: 3 };

function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  const to_ = to ? new Date(to) : new Date();
  const from_ = from ? new Date(from) : new Date(to_.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from_, to: to_ };
}

@Injectable()
export class LegiWatchAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(ctx: TenantContext, clientId: string | null, fromQ?: string, toQ?: string) {
    const { from, to } = parseRange(fromQ, toQ);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const alerts = await this.alertRows(tx, ctx.tenantId, clientId, from, to);
      const decisions = alerts.filter((a) => a.status === 'reviewed' || a.status === 'sent').length;
      const sourceFamilies = new Set(alerts.map((a) => a.sourceType));

      const billsChanged = await tx.congressBill.count({ where: { statusAt: { gte: from, lte: to } } });
      const billsTrackedTotal = await tx.congressBill.count();

      const [committeeSourceHealthy, committeeSourceTotal] = await Promise.all([
        tx.committeeSource.count({ where: { sourceHealth: 'healthy' } }),
        tx.committeeSource.count(),
      ]);

      return {
        signalsTotal: alerts.length,
        sourceFamiliesInvolved: sourceFamilies.size,
        clientDecisions: decisions,
        billsMoved: billsChanged,
        billsTrackedTotal,
        sourceCoveragePct: committeeSourceTotal > 0 ? Math.round((committeeSourceHealthy / committeeSourceTotal) * 100) : null,
        sourceFamiliesCurrent: committeeSourceHealthy,
        sourceFamiliesTotal: committeeSourceTotal,
        from: from.toISOString(),
        to: to.toISOString(),
        freshnessAt: new Date().toISOString(),
      };
    });
  }

  async signalVolume(ctx: TenantContext, clientId: string | null, fromQ?: string, toQ?: string) {
    const { from, to } = parseRange(fromQ, toQ);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = clientId
        ? await tx.$queryRaw<Array<{ day: Date; count: bigint }>>`
            SELECT date_trunc('day', created_at) AS day, COUNT(*) AS count
            FROM intel_alert
            WHERE tenant_id = ${ctx.tenantId} AND created_at BETWEEN ${from} AND ${to} AND client_id = ${clientId}
            GROUP BY 1 ORDER BY 1`
        : await tx.$queryRaw<Array<{ day: Date; count: bigint }>>`
            SELECT date_trunc('day', created_at) AS day, COUNT(*) AS count
            FROM intel_alert
            WHERE tenant_id = ${ctx.tenantId} AND created_at BETWEEN ${from} AND ${to}
            GROUP BY 1 ORDER BY 1`;
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        total: rows.reduce((sum, r) => sum + Number(r.count), 0),
        days: rows.map((r) => ({ date: r.day.toISOString().slice(0, 10), count: Number(r.count) })),
      };
    });
  }

  /** Velocity indexed against each topic's OWN 30-day mean of 100 — a topic
   *  with no alerts in the trailing 30 days is excluded, never divided by
   *  zero into a fabricated spike. */
  async issueMomentum(ctx: TenantContext, clientId: string | null, fromQ?: string, toQ?: string) {
    const { to } = parseRange(fromQ, toQ);
    const thirtyStart = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenStart = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = clientId
        ? await tx.$queryRaw<Array<{ topicId: string; label: string; window: string; weighted: number }>>`
            SELECT ia.topic_id AS "topicId", wt.label,
                   CASE WHEN ia.created_at >= ${sevenStart} THEN 'recent7' ELSE 'trail30' END AS window,
                   SUM(CASE ia.materiality WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)::float AS weighted
            FROM intel_alert ia
            JOIN intel_watchlist_topic wt ON wt.id = ia.topic_id
            WHERE ia.tenant_id = ${ctx.tenantId} AND ia.client_id = ${clientId}
              AND ia.topic_id IS NOT NULL AND ia.created_at BETWEEN ${thirtyStart} AND ${to}
            GROUP BY 1, 2, 3`
        : await tx.$queryRaw<Array<{ topicId: string; label: string; window: string; weighted: number }>>`
            SELECT ia.topic_id AS "topicId", wt.label,
                   CASE WHEN ia.created_at >= ${sevenStart} THEN 'recent7' ELSE 'trail30' END AS window,
                   SUM(CASE ia.materiality WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)::float AS weighted
            FROM intel_alert ia
            JOIN intel_watchlist_topic wt ON wt.id = ia.topic_id
            WHERE ia.tenant_id = ${ctx.tenantId}
              AND ia.topic_id IS NOT NULL AND ia.created_at BETWEEN ${thirtyStart} AND ${to}
            GROUP BY 1, 2, 3`;

      const byTopic = new Map<string, { label: string; recent7: number; trail30: number }>();
      for (const r of rows) {
        const cur = byTopic.get(r.topicId) ?? { label: r.label, recent7: 0, trail30: 0 };
        if (r.window === 'recent7') cur.recent7 += Number(r.weighted);
        else cur.trail30 += Number(r.weighted);
        byTopic.set(r.topicId, cur);
      }

      const topics = [...byTopic.entries()]
        .map(([topicId, v]) => {
          // trail30 covers the full 30 days including the last 7, so the
          // "prior 23 days" baseline is trail30 minus the recent7 slice,
          // scaled to a comparable 7-day rate.
          const priorBaselinePerWeek = ((v.trail30 - v.recent7) / 23) * 7;
          if (priorBaselinePerWeek <= 0) return null;
          const index = Math.round((v.recent7 / priorBaselinePerWeek) * 100);
          return { topicId, label: v.label, index };
        })
        .filter((t): t is { topicId: string; label: string; index: number } => t !== null)
        .sort((a, b) => b.index - a.index)
        .slice(0, 10);

      return { from: thirtyStart.toISOString(), to: to.toISOString(), topics };
    });
  }

  /** Per-client × source-family matrix. `count` is a real number (including
   *  0) only for a client with an actual monitoring model (a watchlist
   *  exists); `null` means "not monitored" — never coerced to 0. */
  async clientExposure(ctx: TenantContext, fromQ?: string, toQ?: string) {
    const { from, to } = parseRange(fromQ, toQ);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [clients, monitoredIds, counts] = await Promise.all([
        tx.client.findMany({ where: { status: { not: 'archived' } }, select: { id: true, name: true } }),
        // "Monitored" means an approved model exists — a Watchlist row with
        // NO topics is the cold-start state (§7.12), not a monitoring model.
        tx.$queryRaw<Array<{ clientId: string }>>`
          SELECT DISTINCT w.client_id AS "clientId"
          FROM intel_watchlist w
          WHERE w.tenant_id = ${ctx.tenantId}
            AND EXISTS (SELECT 1 FROM intel_watchlist_topic t WHERE t.watchlist_id = w.id)`,
        tx.$queryRaw<Array<{ clientId: string; sourceType: string; count: bigint }>>`
          SELECT client_id AS "clientId", source_type AS "sourceType", COUNT(*) AS count
          FROM intel_alert
          WHERE tenant_id = ${ctx.tenantId} AND created_at BETWEEN ${from} AND ${to}
          GROUP BY 1, 2`,
      ]);
      const monitored = new Set(monitoredIds.map((r) => r.clientId));
      const countsByClient = new Map<string, Record<string, number>>();
      for (const r of counts) {
        const bucket = countsByClient.get(r.clientId) ?? {};
        bucket[r.sourceType] = Number(r.count);
        countsByClient.set(r.clientId, bucket);
      }

      const rows = clients
        .map((c) => {
          const isMonitored = monitored.has(c.id);
          const bucket = countsByClient.get(c.id) ?? {};
          return {
            clientId: c.id,
            clientName: c.name,
            monitored: isMonitored,
            bySourceFamily: isMonitored
              ? Object.fromEntries(
                  Object.entries(SOURCE_FAMILY_LABEL).map(([type, label]) => [label, bucket[type] ?? 0]),
                )
              : null,
          };
        })
        .sort((a, b) => a.clientName.localeCompare(b.clientName));

      return { from: from.toISOString(), to: to.toISOString(), rows };
    });
  }

  /** Committee attribution is restricted to `sourceType='hearing'` — for
   *  `'combined'` alerts, `sourceRef` is a bill id, not a session id (see
   *  bill-hearings.service.ts), so joining those against the session table
   *  would silently miss/misattribute rather than undercount honestly. */
  async committeeActivity(ctx: TenantContext, clientId: string | null, fromQ?: string, toQ?: string) {
    const { from, to } = parseRange(fromQ, toQ);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = clientId
        ? await tx.$queryRaw<Array<{ systemCode: string | null; committeeName: string | null; count: bigint }>>`
            SELECT lhs.committee_id AS "systemCode", cc.name AS "committeeName", COUNT(DISTINCT ia.id) AS count
            FROM intel_alert ia
            JOIN intel_live_hearing_session lhs ON lhs.id = ia.source_ref
            LEFT JOIN congress_committee cc ON cc.system_code = lhs.committee_id
            WHERE ia.tenant_id = ${ctx.tenantId} AND ia.client_id = ${clientId}
              AND ia.source_type = 'hearing' AND ia.created_at BETWEEN ${from} AND ${to}
              AND lhs.committee_id IS NOT NULL
            GROUP BY 1, 2 ORDER BY count DESC LIMIT 10`
        : await tx.$queryRaw<Array<{ systemCode: string | null; committeeName: string | null; count: bigint }>>`
            SELECT lhs.committee_id AS "systemCode", cc.name AS "committeeName", COUNT(DISTINCT ia.id) AS count
            FROM intel_alert ia
            JOIN intel_live_hearing_session lhs ON lhs.id = ia.source_ref
            LEFT JOIN congress_committee cc ON cc.system_code = lhs.committee_id
            WHERE ia.tenant_id = ${ctx.tenantId}
              AND ia.source_type = 'hearing' AND ia.created_at BETWEEN ${from} AND ${to}
              AND lhs.committee_id IS NOT NULL
            GROUP BY 1, 2 ORDER BY count DESC LIMIT 10`;
      const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        total,
        rows: rows.map((r) => ({
          systemCode: r.systemCode,
          committeeName: r.committeeName ?? r.systemCode,
          count: Number(r.count),
        })),
      };
    });
  }

  /** Real freshness per named source family, never a fabricated percentage.
   *  Committee pages already has a genuine health enum (`CommitteeSource`);
   *  the other four are read from each family's own row-level sync
   *  timestamp — the same field their own ingestion pipeline already writes. */
  async sourceCoverage() {
    const now = Date.now();
    const freshWindowMs = 48 * 60 * 60 * 1000;
    const freshSince = new Date(now - freshWindowMs);

    const [
      billTotal, billFresh, billLatest,
      committeeHealthy, committeeTotal,
      frTotal, frFresh, frLatest,
      peTotal, peFresh, peLatest,
      stateTotal, stateFresh, stateLatest,
    ] = await Promise.all([
      this.prisma.congressBill.count(),
      this.prisma.congressBill.count({ where: { lastSyncedAt: { gte: freshSince } } }),
      this.prisma.congressBill.aggregate({ _max: { lastSyncedAt: true } }),
      this.prisma.committeeSource.count({ where: { sourceHealth: 'healthy' } }),
      this.prisma.committeeSource.count(),
      this.prisma.federalRegisterDocument.count(),
      this.prisma.federalRegisterDocument.count({ where: { syncedAt: { gte: freshSince } } }),
      this.prisma.federalRegisterDocument.aggregate({ _max: { syncedAt: true } }),
      this.prisma.programElement.count(),
      this.prisma.programElement.count({ where: { lastSyncedAt: { gte: freshSince } } }),
      this.prisma.programElement.aggregate({ _max: { lastSyncedAt: true } }),
      this.prisma.stateBill.count(),
      this.prisma.stateBill.count({ where: { syncedAt: { gte: freshSince } } }),
      this.prisma.stateBill.aggregate({ _max: { syncedAt: true } }),
    ]);

    const pct = (fresh: number, total: number): number | null => (total > 0 ? Math.round((fresh / total) * 100) : null);

    return {
      freshnessAt: new Date().toISOString(),
      sources: [
        { family: 'Congress.gov', coveragePct: pct(billFresh, billTotal), total: billTotal, lastSyncedAt: billLatest._max.lastSyncedAt?.toISOString() ?? null },
        { family: 'Committee pages', coveragePct: pct(committeeHealthy, committeeTotal), total: committeeTotal, lastSyncedAt: null },
        { family: 'Federal Register', coveragePct: pct(frFresh, frTotal), total: frTotal, lastSyncedAt: frLatest._max.syncedAt?.toISOString() ?? null },
        { family: 'Program element service', coveragePct: pct(peFresh, peTotal), total: peTotal, lastSyncedAt: peLatest._max.lastSyncedAt?.toISOString() ?? null },
        { family: 'State legislatures', coveragePct: pct(stateFresh, stateTotal), total: stateTotal, lastSyncedAt: stateLatest._max.syncedAt?.toISOString() ?? null },
      ],
    };
  }

  private async alertRows(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string | null,
    from: Date,
    to: Date,
  ) {
    type Row = { id: string; sourceType: string; status: string };
    return clientId
      ? tx.$queryRaw<Row[]>`
          SELECT id, source_type AS "sourceType", status
          FROM intel_alert
          WHERE tenant_id = ${tenantId} AND created_at BETWEEN ${from} AND ${to} AND client_id = ${clientId}`
      : tx.$queryRaw<Row[]>`
          SELECT id, source_type AS "sourceType", status
          FROM intel_alert
          WHERE tenant_id = ${tenantId} AND created_at BETWEEN ${from} AND ${to}`;
  }
}
