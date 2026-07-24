import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository, type SourcePeDelta } from '../sourcedata/source-data.repository.js';

/**
 * Program Element alert emitter (Release R4, §4.3).
 *
 * Puts PE funding movements into the SAME client feed as bill and hearing alerts, so
 * an analyst sees "the line my client cares about got cut" next to "the bill moved".
 *
 * Client association (§4.3): PE alerts stay client-associated through the CURRENT
 * relationship — a `program_element`-typed term on the client's unified watchlist.
 * No Policy Portfolio is required, and none is created. R6 generalizes this to scope
 * associations; until then the join is deliberately client-only.
 *
 * Deliberate design points:
 *  - the delta itself is NOT computed here. `program_element_delta` is apps/api-owned
 *    and populated by compute-budget-deltas; this service READS live rows only
 *    (superseded_at IS NULL), so a recompute never re-alerts;
 *  - matching is EXACT on the PE code, normalized for case/whitespace. A PE code is
 *    an identifier, not prose — fuzzy matching here would put another program's money
 *    on a client's feed;
 *  - severity is derived from the pipeline's own materiality score, never invented;
 *  - the alert text quotes the delta's stored explanation verbatim and never
 *    paraphrases a dollar movement.
 *
 * Architecture note: the plan lists this emitter under `apps/api`. It lives in
 * intel-api because `intel_alert` and the watchlist are intel-api-owned and apps/api
 * must never write them — the same split every other detector in this directory
 * follows (bill, state-bill, rule, hearing).
 */

/** Re-alert suppression window for one (client, PE, delta type, FY). */
const DEDUPE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_HOURS = 48;
/** Below this the movement is rounding noise, not intelligence. */
const DEFAULT_MATERIALITY_FLOOR = 0.3;

export interface PeDetectionSummary {
  scanned: number;
  matchedClients: number;
  alertsWritten: number;
  skippedDedup: number;
}

/** Normalize a PE code for exact comparison (case + surrounding whitespace only). */
export function normalizePeCode(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Materiality score → alert severity. Mirrors the bands the PE Watch pipeline
 * already scores with, so a "critical" here means the same thing it means there.
 */
export function severityForMateriality(score: number): 'critical' | 'notable' | 'info' {
  if (score >= 0.7) return 'critical';
  if (score >= 0.45) return 'notable';
  return 'info';
}

export function materialityBand(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.7) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

/** Human label for a delta type. Unknown types fall back to the raw token. */
const DELTA_TYPE_LABEL: Record<string, string> = {
  mark_vs_request: 'Committee mark vs request',
  mark_vs_mark: 'Chamber mark comparison',
  conference_vs_marks: 'Conference vs chamber marks',
  enacted_vs_request: 'Enacted vs request',
  pb_vs_prior_pb: 'Request vs prior-year request',
  new_start: 'New start',
  termination: 'Termination',
  zeroed: 'Zeroed',
  transfer_candidate: 'Possible transfer',
  quantity_change: 'Quantity change',
  unit_cost_change: 'Unit-cost change',
  outyear_shift: 'Outyear shift',
  project_level_change: 'Project-level change',
};

/** $X.XB / $XM, matching the dossier + web formatters. */
function fmtMillions(v: string | null): string | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}B`;
  return `$${n % 1 ? n.toFixed(1) : n.toFixed(0)}M`;
}

/**
 * The alert title. States the PE, what kind of change, and the movement — nothing
 * inferred. Exported so the wording is asserted by a test rather than by review.
 */
export function peAlertTitle(d: SourcePeDelta): string {
  const label = DELTA_TYPE_LABEL[d.deltaType] ?? d.deltaType;
  const from = fmtMillions(d.amountFrom);
  const to = fmtMillions(d.amountTo);
  const movement = from && to ? ` (${from} → ${to})` : '';
  const name = d.peTitle ? `${d.peCode} ${d.peTitle}` : d.peCode;
  const trimmed = name.length > 70 ? `${name.slice(0, 70)}…` : name;
  return `FY${d.assertedFy} ${label}: ${trimmed}${movement}`;
}

@Injectable()
export class PeChangeDetectorService {
  private readonly logger = new Logger(PeChangeDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sourceData: SourceDataRepository,
  ) {}

  /**
   * One detection cycle: read live PE deltas, resolve which clients watch each PE,
   * and write one `program_element` alert per (client, delta).
   */
  async runDetectionCycle(
    windowHours = DEFAULT_WINDOW_HOURS,
    materialityFloor = DEFAULT_MATERIALITY_FLOOR,
  ): Promise<PeDetectionSummary> {
    const summary: PeDetectionSummary = {
      scanned: 0,
      matchedClients: 0,
      alertsWritten: 0,
      skippedDedup: 0,
    };

    const deltas = await this.sourceData.getRecentPeDeltas(windowHours, materialityFloor);
    summary.scanned = deltas.length;
    if (!deltas.length) return summary;

    // ONE query for every program_element watchlist term across all tenants — the
    // index [tenantId, termType] backs it. A per-delta lookup would be an N+1.
    const watchers = await this.loadPeWatchers();
    if (!watchers.size) return summary;

    for (const d of deltas) {
      const targets = watchers.get(normalizePeCode(d.peCode));
      if (!targets?.length) continue;
      summary.matchedClients += targets.length;
      for (const t of targets) {
        const wrote = await this.writePeAlert(t.tenantId, t.clientId, t.topicLabel, d);
        if (wrote) summary.alertsWritten += 1;
        else summary.skippedDedup += 1;
      }
    }
    return summary;
  }

  /**
   * PE code → the (tenant, client) pairs whose watchlist names it. Built from
   * `program_element`-typed watchlist terms; the watchlist id encodes the client
   * (`wl:<clientId>`), the same convention every other detector uses.
   */
  private async loadPeWatchers(): Promise<
    Map<string, Array<{ tenantId: string; clientId: string; topicLabel: string | null }>>
  > {
    const out = new Map<
      string,
      Array<{ tenantId: string; clientId: string; topicLabel: string | null }>
    >();
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<
        Array<{ tenantId: string; watchlistId: string; value: string; topicLabel: string | null }>
      >(
        `SELECT t.tenant_id     AS "tenantId",
                t.watchlist_id  AS "watchlistId",
                t.value,
                tp.label        AS "topicLabel"
           FROM intel_watchlist_term t
           LEFT JOIN intel_watchlist_topic tp ON tp.id = t.topic_id
          WHERE t.term_type = 'program_element'`,
      ),
    );
    for (const r of rows) {
      // `wl:<clientId>` is the watchlist-id convention; anything else is not a
      // client watchlist and is skipped rather than guessed at.
      if (!r.watchlistId.startsWith('wl:')) continue;
      const clientId = r.watchlistId.slice(3);
      if (!clientId) continue;
      const key = normalizePeCode(r.value);
      if (!key) continue;
      const list = out.get(key) ?? [];
      // A client may name the same PE on two topics; alert once.
      if (!list.some((x) => x.clientId === clientId)) {
        list.push({ tenantId: r.tenantId, clientId, topicLabel: r.topicLabel });
      }
      out.set(key, list);
    }
    return out;
  }

  /**
   * Write one `program_element` alert. Returns false when an equivalent alert already
   * exists inside the dedupe window (idempotent re-runs) or the write failed.
   *
   * `sourceRef` is the PE CODE, not the delta id, so the feed's
   * @@index([tenantId, sourceType, sourceRef]) supports "every alert for this PE" and
   * the dossier/PE-360 surfaces can look alerts up by the identifier a user sees.
   */
  private async writePeAlert(
    tenantId: string,
    clientId: string,
    topicLabel: string | null,
    d: SourcePeDelta,
  ): Promise<boolean> {
    const dedupeSince = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlert.findFirst({
        where: {
          tenantId,
          clientId,
          sourceType: 'program_element',
          sourceRef: d.peCode,
          changeType: d.deltaType,
          createdAt: { gte: dedupeSince },
        },
        select: { id: true },
      }),
    );
    if (existing) return false;

    const severity = severityForMateriality(d.materialityScore);
    const why = topicLabel
      ? `${d.peCode} is on this client's watchlist under "${topicLabel}".`
      : `${d.peCode} is on this client's watchlist.`;

    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.create({
          data: {
            tenantId,
            clientId,
            sourceType: 'program_element',
            sourceRef: d.peCode,
            watchlistId: `wl:${clientId}`,
            kind: 'pe_funding_change',
            changeType: d.deltaType,
            severity,
            materiality: materialityBand(d.materialityScore),
            score: d.materialityScore,
            title: peAlertTitle(d),
            whyItMatters: why,
            // Recommended action is a deep link, not advice: open the line-level
            // source of truth. Program Element 360 stays authoritative (§4.2).
            recommendedAction: `Review Program Element ${d.peCode} for FY${d.assertedFy}.`,
            evidence: {
              programElement: {
                peCode: d.peCode,
                title: d.peTitle,
                fiscalYear: d.assertedFy,
                deltaType: d.deltaType,
                deltaTypeLabel: DELTA_TYPE_LABEL[d.deltaType] ?? d.deltaType,
                fromRef: d.fromRef,
                toRef: d.toRef,
                amountFromMillions: d.amountFrom == null ? null : Number(d.amountFrom),
                amountToMillions: d.amountTo == null ? null : Number(d.amountTo),
                deltaMillions: d.deltaAbs == null ? null : Number(d.deltaAbs),
                deltaPct: d.deltaPct,
                materialityScore: d.materialityScore,
                // Deep link to the line-level dossier (§4.3).
                href: `/program-elements/${encodeURIComponent(d.peCode)}`,
              },
              // Verbatim from the delta record — never a generated summary.
              actionText: d.explanation ?? DELTA_TYPE_LABEL[d.deltaType] ?? d.deltaType,
              actionDate: d.computedAt.toISOString().slice(0, 10),
              why,
              matchedTags: topicLabel ? [topicLabel] : [],
              tone: severity,
              band: materialityBand(d.materialityScore),
              triggerKey: 'peFundingChange',
              // Provenance: the delta row this alert was derived from (§4.3).
              sourceDeltaId: d.deltaId,
            },
            status: 'new',
          },
        }),
      );
      return true;
    } catch (err) {
      this.logger.error(
        `writePeAlert failed for ${d.peCode}/${clientId}: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
