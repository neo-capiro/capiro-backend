/**
 * Read-side aggregation for AI usage metering (ai_usage_events).
 *
 * Tenant methods run through prisma.withTenant so RLS scopes every read;
 * adminAllTenantsSummary is the ONLY cross-tenant read (withSystem) and must
 * stay behind the capiro_admin guard at the controller layer.
 *
 * Aggregation strategy: one narrow findMany per call, grouped in JS by the
 * pure aggregateUsageRows helper. Usage rows are one-per-generation (tens
 * per tenant per day), so fetching a clamped window and folding in memory is
 * cheaper than three groupBy round-trips plus a raw date_trunc query — and
 * the pure helper is unit-testable without a database.
 */
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export interface UsageDateRange {
  from?: Date;
  to?: Date;
}

export interface UsageBucket {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  count: number;
}

export interface TenantUsageSummary {
  from: Date;
  to: Date;
  eventCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  tenantKeyEventCount: number;
  byWorkflow: Array<UsageBucket & { workflow: string }>;
  byModel: Array<UsageBucket & { model: string }>;
  byDay: Array<UsageBucket & { day: string }>;
}

export interface AdminTenantUsageRow {
  tenantId: string;
  tenantName: string;
  totalCostUsd: number;
  totalTokens: number;
  eventCount: number;
  tenantKeyEventCount: number;
}

interface UsageRowLike {
  workflow: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: unknown; // Prisma.Decimal at runtime; Number() both ways
  usedTenantKey: boolean;
  createdAt: Date;
}

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Clamp to [from, to]: default trailing 30 days, never wider than a year. */
export function resolveUsageRange(range: UsageDateRange = {}): { from: Date; to: Date } {
  const to = range.to ?? new Date();
  let from = range.from ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (from > to) from = new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    from = new Date(to.getTime() - MAX_RANGE_DAYS * DAY_MS);
  }
  return { from, to };
}

export function aggregateUsageRows(rows: UsageRowLike[]): Omit<TenantUsageSummary, 'from' | 'to'> {
  const byWorkflow = new Map<string, UsageBucket>();
  const byModel = new Map<string, UsageBucket>();
  const byDay = new Map<string, UsageBucket>();
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let tenantKeyEventCount = 0;

  const fold = (map: Map<string, UsageBucket>, key: string, r: UsageRowLike, cost: number) => {
    const bucket = map.get(key) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, count: 0 };
    bucket.costUsd += cost;
    bucket.inputTokens += r.inputTokens;
    bucket.outputTokens += r.outputTokens;
    bucket.count += 1;
    map.set(key, bucket);
  };

  for (const r of rows) {
    const cost = Number(r.costUsd) || 0;
    totalCostUsd += cost;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    if (r.usedTenantKey) tenantKeyEventCount += 1;
    fold(byWorkflow, r.workflow, r, cost);
    fold(byModel, r.model, r, cost);
    fold(byDay, r.createdAt.toISOString().slice(0, 10), r, cost);
  }

  const spread = <K extends string>(map: Map<string, UsageBucket>, key: K) =>
    Array.from(map.entries()).map(
      ([k, b]) => ({ [key]: k, ...b }) as UsageBucket & Record<K, string>,
    );

  return {
    eventCount: rows.length,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    tenantKeyEventCount,
    byWorkflow: spread(byWorkflow, 'workflow').sort((a, b) => b.costUsd - a.costUsd),
    byModel: spread(byModel, 'model').sort((a, b) => b.costUsd - a.costUsd),
    byDay: spread(byDay, 'day').sort((a, b) => a.day.localeCompare(b.day)),
  };
}

@Injectable()
export class AiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async tenantSummary(ctx: TenantContext, range: UsageDateRange = {}): Promise<TenantUsageSummary> {
    return this.tenantSummaryByTenantId(ctx.tenantId, range);
  }

  /**
   * Same summary keyed by explicit tenantId — the capiro-admin drill-down.
   * Still runs through withTenant (RLS GUC = that tenant); only reachable
   * behind the capiro_admin guard.
   */
  async tenantSummaryByTenantId(
    tenantId: string,
    range: UsageDateRange = {},
  ): Promise<TenantUsageSummary> {
    const { from, to } = resolveUsageRange(range);
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.aiUsageEvent.findMany({
        where: { tenantId, createdAt: { gte: from, lte: to } },
      }),
    );
    return { from, to, ...aggregateUsageRows(rows) };
  }

  async tenantRecentEvents(ctx: TenantContext, opts: { limit?: number } = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.aiUsageEvent.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    );
  }

  /**
   * Cross-tenant spend table for the Capiro admin console. NOT tenant-scoped
   * (withSystem) — only reachable through the capiro_admin-guarded controller.
   */
  async adminAllTenantsSummary(range: UsageDateRange = {}): Promise<AdminTenantUsageRow[]> {
    const { from, to } = resolveUsageRange(range);
    return this.prisma.withSystem(async (tx) => {
      const [rows, tenants] = await Promise.all([
        tx.aiUsageEvent.findMany({ where: { createdAt: { gte: from, lte: to } } }),
        tx.tenant.findMany({ select: { id: true, name: true } }),
      ]);
      const names = new Map(tenants.map((t) => [t.id, t.name]));
      const byTenant = new Map<string, AdminTenantUsageRow>();
      for (const r of rows) {
        // M5.0: a tenant-agnostic (cached-L1) run metering row has
        // tenant_id = NULL — excluded from this PER-TENANT report by design
        // (it isn't billed to any one tenant). It still counts toward
        // platform spend; a dedicated platform-cost rollup is a documented
        // follow-up, not built here since nothing consumes it yet.
        if (r.tenantId == null) continue;
        const entry = byTenant.get(r.tenantId) ?? {
          tenantId: r.tenantId,
          tenantName: names.get(r.tenantId) ?? r.tenantId,
          totalCostUsd: 0,
          totalTokens: 0,
          eventCount: 0,
          tenantKeyEventCount: 0,
        };
        entry.totalCostUsd += Number(r.costUsd) || 0;
        entry.totalTokens += r.inputTokens + r.outputTokens;
        entry.eventCount += 1;
        if (r.usedTenantKey) entry.tenantKeyEventCount += 1;
        byTenant.set(r.tenantId, entry);
      }
      return Array.from(byTenant.values()).sort((a, b) => b.totalCostUsd - a.totalCostUsd);
    });
  }
}
