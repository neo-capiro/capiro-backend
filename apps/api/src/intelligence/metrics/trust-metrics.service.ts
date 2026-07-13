import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * P3 — Trust/eval metrics rollup (blueprint §12.6). Aggregates the telemetry
 * the trust spine already collects — the grounding auditor's verdicts
 * (`meri_audit_ledger`), the Context Compiler's packet traces
 * (`context_packet`), advocacy outcomes (`outcome_event`), and the memory
 * promotion queue (`memory_candidate`) — into a per-tenant summary. Until now
 * these were write-only rows with no aggregation surface.
 *
 * Mirrors the house convention (product-metrics / ai-usage): ONE `withTenant`
 * read per table, fold in memory via exported pure functions (DB-free +
 * unit-testable), and echo a `definitions` block so a consumer renders the
 * caveats rather than guessing. RLS is the visibility source of truth — the
 * caller's `tenantId` is never an input beyond the GUC.
 *
 * v1 scope: the metrics DIRECTLY aggregatable from existing rows. Deliberately
 * OUT of v1 (need new instrumentation / are noisy): reviewer-judged recall
 * relevance, time-saved baseline, context-adherence grading, and the
 * outreach-edit-distance / citation-coverage rollups (JSONB-extraction + sparse
 * sources). Those are follow-ups; this endpoint states exactly what it covers.
 */

const AUDIT_DECISIONS = ['deliver', 'deliver_with_flags', 'repair', 'hold'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const CANDIDATE_STATUSES = ['auto_committed', 'approved', 'rejected', 'pending'] as const;

export interface AuditorSurfaceMetric {
  surface: string;
  total: number;
  /** Fraction with a clean `deliver` decision (no held/repaired/flagged output). */
  passRate: number;
  decisions: Record<(typeof AUDIT_DECISIONS)[number], number>;
  /** Top-severity histogram; `clean` = no finding (topSeverity null). */
  severity: Record<(typeof SEVERITIES)[number] | 'clean', number>;
}

export interface TrustMetricsSummary {
  range: { from: string; to: string };
  auditor: {
    total: number;
    bySurface: AuditorSurfaceMetric[];
    /** Enforcement posture: how many verdicts ran under each mode. */
    byMode: Array<{ mode: string; total: number }>;
  };
  contextParity: {
    /** Distinct surfaces that emitted a context packet in-range (§6 "N of 7"). */
    surfacesEmitting: string[];
    surfaceCount: number;
    totalPackets: number;
    /** Why context was withheld, across all packets. */
    exclusionReasons: Array<{ reason: string; count: number }>;
  };
  outcomes: { total: number; byKind: Array<{ kind: string; count: number }> };
  memoryPromotion: {
    total: number;
    byStatus: Record<(typeof CANDIDATE_STATUSES)[number], number>;
    bySourceKind: Array<{ sourceKind: string; count: number }>;
    /** Median minutes from candidate creation to a human decision (approve/reject). */
    medianDecisionMinutes: number | null;
    decisionSampleSize: number;
  };
  definitions: {
    passRate: string;
    contextParity: string;
    promotionQuality: string;
    scope: string;
  };
}

interface AuditRow {
  surface: string;
  mode: string;
  decision: string;
  topSeverity: string | null;
}
interface PacketRow {
  surface: string;
  exclusions: unknown;
}
interface OutcomeRow {
  kind: string;
}
interface CandidateRow {
  status: string;
  sourceKind: string;
  createdAt: Date;
  decidedAt: Date | null;
}

const DEFAULT_RANGE_DAYS = 90;
const MAX_RANGE_DAYS = 366;

@Injectable()
export class TrustMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getTrustMetrics(
    ctx: TenantContext,
    opts?: { from?: string; to?: string },
  ): Promise<TrustMetricsSummary> {
    const { from, to } = resolveRange(opts);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [audits, packets, outcomes, candidates] = await Promise.all([
        tx.meriAuditLedger.findMany({
          where: { tenantId: ctx.tenantId, createdAt: { gte: from, lte: to } },
          select: { surface: true, mode: true, decision: true, topSeverity: true },
        }) as Promise<AuditRow[]>,
        tx.contextPacket.findMany({
          where: { tenantId: ctx.tenantId, createdAt: { gte: from, lte: to } },
          select: { surface: true, exclusions: true },
        }) as Promise<PacketRow[]>,
        tx.outcomeEvent.findMany({
          where: { tenantId: ctx.tenantId, observedAt: { gte: from, lte: to } },
          select: { kind: true },
        }) as Promise<OutcomeRow[]>,
        tx.memoryCandidate.findMany({
          where: { tenantId: ctx.tenantId, createdAt: { gte: from, lte: to } },
          select: { status: true, sourceKind: true, createdAt: true, decidedAt: true },
        }) as Promise<CandidateRow[]>,
      ]);

      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        auditor: foldAuditor(audits),
        contextParity: foldContextParity(packets),
        outcomes: foldOutcomes(outcomes),
        memoryPromotion: foldMemoryPromotion(candidates),
        definitions: {
          passRate:
            "fraction of audited outputs with a clean 'deliver' decision (no finding held, repaired, or flagged), per surface",
          contextParity:
            'distinct Meri surfaces that emitted a Context Compiler packet in-range — the §12.6 surface-context-parity signal',
          promotionQuality:
            'memory candidates by terminal state (auto_committed/approved/rejected/pending) + median human-decision latency',
          scope: 'per-tenant, RLS-scoped; time range by created/observed timestamp',
        },
      };
    });
  }
}

// ── Pure folders (DB-free; exported for unit tests) ─────────────────────────

export function foldAuditor(rows: readonly AuditRow[]): TrustMetricsSummary['auditor'] {
  const bySurface = new Map<string, AuditorSurfaceMetric>();
  const byMode = new Map<string, number>();
  for (const r of rows) {
    byMode.set(r.mode, (byMode.get(r.mode) ?? 0) + 1);
    const m =
      bySurface.get(r.surface) ??
      ({
        surface: r.surface,
        total: 0,
        passRate: 0,
        decisions: { deliver: 0, deliver_with_flags: 0, repair: 0, hold: 0 },
        severity: { critical: 0, high: 0, medium: 0, low: 0, clean: 0 },
      } satisfies AuditorSurfaceMetric);
    m.total++;
    if ((AUDIT_DECISIONS as readonly string[]).includes(r.decision)) {
      m.decisions[r.decision as (typeof AUDIT_DECISIONS)[number]]++;
    }
    if (r.topSeverity && (SEVERITIES as readonly string[]).includes(r.topSeverity)) {
      m.severity[r.topSeverity as (typeof SEVERITIES)[number]]++;
    } else {
      m.severity.clean++;
    }
    bySurface.set(r.surface, m);
  }
  for (const m of bySurface.values()) {
    m.passRate = m.total ? round4(m.decisions.deliver / m.total) : 0;
  }
  return {
    total: rows.length,
    bySurface: [...bySurface.values()].sort((a, b) => (a.surface < b.surface ? -1 : 1)),
    byMode: [...byMode.entries()]
      .map(([mode, total]) => ({ mode, total }))
      .sort((a, b) => (a.mode < b.mode ? -1 : 1)),
  };
}

export function foldContextParity(
  rows: readonly PacketRow[],
): TrustMetricsSummary['contextParity'] {
  const surfaces = new Set<string>();
  const reasons = new Map<string, number>();
  for (const r of rows) {
    surfaces.add(r.surface);
    if (Array.isArray(r.exclusions)) {
      for (const ex of r.exclusions) {
        const reason = (ex as { reason?: string } | null)?.reason;
        if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
  }
  return {
    surfacesEmitting: [...surfaces].sort(),
    surfaceCount: surfaces.size,
    totalPackets: rows.length,
    exclusionReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

export function foldOutcomes(rows: readonly OutcomeRow[]): TrustMetricsSummary['outcomes'] {
  const byKind = new Map<string, number>();
  for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  return {
    total: rows.length,
    byKind: [...byKind.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
  };
}

export function foldMemoryPromotion(
  rows: readonly CandidateRow[],
): TrustMetricsSummary['memoryPromotion'] {
  const byStatus: Record<(typeof CANDIDATE_STATUSES)[number], number> = {
    auto_committed: 0,
    approved: 0,
    rejected: 0,
    pending: 0,
  };
  const bySourceKind = new Map<string, number>();
  const latencies: number[] = [];
  for (const r of rows) {
    if ((CANDIDATE_STATUSES as readonly string[]).includes(r.status)) {
      byStatus[r.status as (typeof CANDIDATE_STATUSES)[number]]++;
    }
    bySourceKind.set(r.sourceKind, (bySourceKind.get(r.sourceKind) ?? 0) + 1);
    // Human-decision latency only for candidates a person acted on (approved/
    // rejected) — auto_committed has no meaningful review delay.
    if (r.decidedAt && (r.status === 'approved' || r.status === 'rejected')) {
      const mins = (r.decidedAt.getTime() - r.createdAt.getTime()) / 60_000;
      if (mins >= 0) latencies.push(mins);
    }
  }
  return {
    total: rows.length,
    byStatus,
    bySourceKind: [...bySourceKind.entries()]
      .map(([sourceKind, count]) => ({ sourceKind, count }))
      .sort((a, b) => b.count - a.count || a.sourceKind.localeCompare(b.sourceKind)),
    medianDecisionMinutes: median(latencies),
    decisionSampleSize: latencies.length,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Trailing DEFAULT_RANGE_DAYS by default; clamp span to MAX_RANGE_DAYS. */
export function resolveRange(opts?: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = opts?.to ? new Date(opts.to) : new Date();
  const from = opts?.from
    ? new Date(opts.from)
    : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 86_400_000);
  const clampedFrom =
    to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000
      ? new Date(to.getTime() - MAX_RANGE_DAYS * 86_400_000)
      : from;
  return { from: clampedFrom, to };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : round4((s[mid - 1]! + s[mid]!) / 2);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
