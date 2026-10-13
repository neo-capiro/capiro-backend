import type { ExpectedMilestoneType, ExpectedConfidenceLevel } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { mapCombinedAlertsToHearings } from '../linking/bill-hearings.service.js';
import type {
  BillContext,
  ExpectedMilestone,
  MatchedTopic,
  BillHearingView,
  DossierOverview,
  ContextAlertView,
  RecommendedActionView,
  DossierSeverity,
} from './bill-dossier.types.js';
import { MAX_HEARINGS, toIso } from './bill-dossier-presentation.js';
export const MAX_ALERTS = 50;
export const MAX_MENTIONS_PER_HEARING = 10;
export const MAX_RECOMMENDED_ACTIONS = 10;
export interface ClientAlertRow {
  id: string;
  severity: string | null;
  createdAt: Date;
  title: string;
  whyItMatters: string | null;
  recommendedAction: string | null;
}
export class BillDossierClientContext {
  constructor(private readonly prisma: PrismaService) {}
  async loadTracking(tenantId: string, clientId: string, billId: string): Promise<BillContext> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findFirst({ where: { tenantId, clientId, billId } }),
    );
    if (!row) {
      return {
        tracked: false,
        position: null,
        priority: null,
        analystNote: null,
        stage: null,
        trackedAt: null,
        expected: null,
      };
    }
    const hasExpected = Boolean(
      row.expectedMilestoneType ||
      row.expectedWindowStart ||
      row.expectedWindowEnd ||
      row.expectedRationale,
    );
    const expected: ExpectedMilestone | null = hasExpected
      ? {
          milestoneType: (row.expectedMilestoneType as ExpectedMilestoneType | null) ?? null,
          windowStart: toIso(row.expectedWindowStart),
          windowEnd: toIso(row.expectedWindowEnd),
          confidence: (row.expectedConfidence as ExpectedConfidenceLevel | null) ?? null,
          rationale: row.expectedRationale ?? null,
          updatedBy: row.expectedUpdatedBy ?? null,
          updatedAt: toIso(row.expectedUpdatedAt),
          stale: row.expectedWindowEnd ? row.expectedWindowEnd.getTime() < Date.now() : false,
        }
      : null;
    return {
      tracked: true,
      position: normalizePosition(row.position),
      priority: normalizePriority(row.priority),
      // Preserve legacy `note` when no explicit analyst note was set (plan §1.3).
      analystNote: row.analystNote ?? row.note ?? null,
      stage: row.stage ?? null,
      trackedAt: toIso(row.trackedAt),
      expected,
    };
  }

  async loadClientAlerts(
    tenantId: string,
    clientId: string,
    billId: string,
  ): Promise<ClientAlertRow[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlert.findMany({
        // Index-backed: @@index([tenantId, sourceType, sourceRef]); clientId is a
        // cheap residual equality (still applied by Postgres, not in JS).
        where: { tenantId, clientId, sourceType: 'bill', sourceRef: billId },
        orderBy: { createdAt: 'desc' },
        take: MAX_ALERTS,
        select: {
          id: true,
          severity: true,
          createdAt: true,
          title: true,
          whyItMatters: true,
          recommendedAction: true,
        },
      }),
    );
  }

  async loadMatchedTopics(
    tenantId: string,
    clientId: string,
    billId: string,
  ): Promise<MatchedTopic[]> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.billMatch.findFirst({
        where: { tenantId, clientId, billId },
        select: {
          matchedTags: true,
          fit: true,
          jurisdiction: true,
          lastFitAt: true,
        },
      }),
    );
    if (!row) return [];
    return (row.matchedTags ?? [])
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => ({
        label: t,
        fit: typeof row.fit === 'number' ? row.fit : null,
        jurisdiction: row.jurisdiction ?? null,
        matchedAt: toIso(row.lastFitAt),
      }));
  }

  async loadClientHearings(
    tenantId: string,
    clientId: string,
    billId: string,
  ): Promise<BillHearingView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlert.findMany({
        where: {
          tenantId,
          clientId,
          sourceType: 'combined',
          sourceRef: billId,
          status: { notIn: ['dismissed', 'snoozed', 'suppressed'] },
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_HEARINGS,
        select: { sourceRef: true, evidence: true, createdAt: true },
      }),
    );
    return mapCombinedAlertsToHearings(rows)
      .hearings.slice(0, MAX_HEARINGS)
      .map((h) => ({
        id: h.sessionId,
        title: h.title,
        committee: h.committeeId,
        date: h.occurredAt,
        mentions: h.mentions.slice(0, MAX_MENTIONS_PER_HEARING).map((m) => ({
          ts: m.timestampMs === null ? null : msToClock(m.timestampMs),
          speaker: m.speakerName,
          quote: m.quote,
        })),
      }));
  }

  mergeAnalystOverview(
    base: DossierOverview,
    tracking: BillContext | null,
    alertRows: ClientAlertRow[],
  ): DossierOverview {
    const out: DossierOverview = { ...base };
    // Derived (Capiro analysis) fallback: the newest alert that recorded a
    // why-it-matters. An analyst note, when present, wins below.
    const derived = alertRows.find((r) => (r.whyItMatters ?? '').trim().length > 0);
    if (derived) {
      out.whyItMatters = {
        origin: 'derived',
        text: derived.whyItMatters as string,
        asOf: toIso(derived.createdAt),
        source: 'Capiro alert analysis',
      };
    }
    if (!tracking || !tracking.tracked) return out;
    if (tracking.analystNote) {
      out.whyItMatters = {
        origin: 'analyst',
        text: tracking.analystNote,
        asOf: tracking.trackedAt,
        source: 'Analyst note',
      };
    }
    if (tracking.expected?.rationale) {
      out.analystOutlook = {
        origin: 'analyst',
        text: tracking.expected.rationale,
        asOf: tracking.expected.updatedAt,
        expires: tracking.expected.windowEnd,
      };
    }
    return out;
  }
}
export function toContextAlertView(r: ClientAlertRow): ContextAlertView {
  return {
    id: r.id,
    sev: sevForAlert(r.severity),
    date: toIso(r.createdAt),
    title: r.title,
  };
}

export function buildRecommendedActions(rows: ClientAlertRow[]): RecommendedActionView[] {
  const out: RecommendedActionView[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const text = (r.recommendedAction ?? '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text,
      origin: 'derived',
      sev: sevForAlert(r.severity),
      date: toIso(r.createdAt),
      alertId: r.id,
    });
    if (out.length >= MAX_RECOMMENDED_ACTIONS) break;
  }
  return out;
}

export function msToClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function sevForAlert(severity: string | null): DossierSeverity {
  if (severity === 'critical') return 'critical';
  if (severity === 'notable') return 'notable';
  return 'info';
}

export function normalizePosition(v: string | null): 'support' | 'oppose' | 'monitor' | null {
  return v === 'support' || v === 'oppose' || v === 'monitor' ? v : null;
}

export function normalizePriority(v: string | null): 'low' | 'med' | 'high' | null {
  return v === 'low' || v === 'med' || v === 'high' ? v : null;
}
