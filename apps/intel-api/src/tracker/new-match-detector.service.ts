import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TrackerBoardService, type RecommendationItem } from './tracker-board.service.js';
import { NEW_MATCH_CLASS, severityToMateriality } from './change-detector.util.js';
import { scoreShadowAlert } from '../intel-alert/alert-scorer.js';

/** Bills scored per client per cycle (matches the recommendations surface default). */
const NEW_MATCH_LIMIT = 25;

export interface NewMatchSummary {
  clients: number;
  candidates: number;
  newMatches: number;
  alertsWritten: number;
  refreshed: number;
}

/**
 * LegiWatch B1 — the "new matched bill" emitter. Recommendations were
 * compute-on-read only (`TrackerBoardService.getRecommendations`): a fresh
 * client↔bill fit ranking every page load, with no memory of what a client had
 * already been shown. This pass PERSISTS that ranking to `intel_bill_match` and
 * fires a `bill_new_match` `intel_alert` the first time a bill crosses a client's
 * fit floor — then never again (dedup = the `[clientId, billId]` unique key, not
 * the 14-day window; §3 B1).
 *
 * It reuses the exact candidate-union + `scoreBillFit` logic behind
 * `getRecommendations` (which already excludes tracked + dismissed bills — the
 * correct universe for "a bill you haven't added yet but should know about").
 *
 * RLS (G3): the watchlist universe scan is cross-tenant → `withSystem`; every
 * match/alert write is re-scoped to the row's tenant → `withTenant` (which wraps
 * the two creates in ONE transaction, so a match row never exists without its
 * alert). Shadow-safe: the alert is written `status='new'` and delivered only by
 * the (guarded) emit sweep.
 */
@Injectable()
export class NewMatchDetectorService {
  private readonly logger = new Logger(NewMatchDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly board: TrackerBoardService,
  ) {}

  async runNewMatchCycle(limit = NEW_MATCH_LIMIT): Promise<NewMatchSummary> {
    // Universe: every active watchlist (one per client) across all tenants.
    const wls = await this.prisma.withSystem((tx) =>
      tx.watchlist.findMany({
        where: { active: true },
        select: { tenantId: true, clientId: true },
      }),
    );

    let clients = 0;
    let candidates = 0;
    let newMatches = 0;
    let alertsWritten = 0;
    let refreshed = 0;

    for (const wl of wls) {
      clients += 1;
      let recs: RecommendationItem[] = [];
      try {
        recs = await this.board.getRecommendations(wl.tenantId, wl.clientId, limit);
      } catch (e) {
        this.logger.warn(
          `recommendations failed for ${wl.clientId} (tenant ${wl.tenantId}): ${(e as Error).message}`,
        );
        continue;
      }
      candidates += recs.length;
      if (!recs.length) continue;

      // Which of these candidates has the client already been matched on?
      const billIds = recs.map((r) => r.billId);
      const existing = await this.prisma.withTenant(wl.tenantId, (tx) =>
        tx.billMatch.findMany({
          where: { clientId: wl.clientId, billId: { in: billIds } },
          select: { billId: true },
        }),
      );
      const known = new Set(existing.map((e) => e.billId));

      for (const rec of recs) {
        try {
          if (known.has(rec.billId)) {
            // Already matched → refresh the snapshot's fit/tags, never re-alert.
            await this.prisma.withTenant(wl.tenantId, (tx) =>
              tx.billMatch.update({
                where: { clientId_billId: { clientId: wl.clientId, billId: rec.billId } },
                data: { fit: rec.fit, matchedTags: rec.matchedTags, lastFitAt: new Date() },
              }),
            );
            refreshed += 1;
            continue;
          }
          const wrote = await this.persistAndAlert(wl.tenantId, wl.clientId, rec);
          newMatches += 1;
          if (wrote) alertsWritten += 1;
        } catch (e) {
          this.logger.error(
            `new-match write failed for ${rec.billId} (client ${wl.clientId}): ${(e as Error).message}`,
          );
        }
      }
    }

    return { clients, candidates, newMatches, alertsWritten, refreshed };
  }

  /**
   * Persist the match snapshot AND write its `bill_new_match` alert in one
   * transaction. A concurrent cycle racing the same (client,bill) hits the
   * `[clientId, billId]` unique → P2002 → we skip (the other run owns it), so
   * exactly one alert is ever written per newly-matching bill.
   */
  private async persistAndAlert(
    tenantId: string,
    clientId: string,
    rec: RecommendationItem,
  ): Promise<boolean> {
    const cls = NEW_MATCH_CLASS;
    const materiality = severityToMateriality(cls.severity);
    const { score, band } = scoreShadowAlert({
      severity: cls.severity,
      materiality,
      changeType: cls.changeType,
      actionDate: rec.latestActionDate,
      matchedTags: rec.matchedTags,
    });
    const url = this.billUrl(rec.billId);
    try {
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.billMatch.create({
          data: {
            tenantId,
            clientId,
            billId: rec.billId,
            fit: rec.fit,
            matchedTags: rec.matchedTags,
            congress: this.congressOf(rec.billId),
          },
        });
        await tx.intelAlert.create({
          data: {
            tenantId,
            clientId,
            sourceType: 'bill',
            sourceRef: rec.billId,
            watchlistId: `wl:${clientId}`,
            kind: cls.changeType,
            changeType: cls.changeType,
            severity: cls.severity,
            materiality,
            score,
            title: `${rec.displayNum}: ${cls.label}`,
            whyItMatters: rec.why || null,
            evidence: {
              fit: rec.fit,
              whyKind: rec.whyKind,
              stage: cls.label,
              actionText:
                `Now matches your watchlist (fit ${rec.fit.toFixed(2)})` +
                `${rec.title ? ` — ${rec.title}` : ''}`,
              actionDate: rec.latestActionDate
                ? rec.latestActionDate.toISOString().slice(0, 10)
                : null,
              url,
              sourceUrl: url,
              why: rec.why || null,
              matchedTags: rec.matchedTags,
              tone: cls.tone,
              band,
              triggerKey: cls.triggerKey,
              billTitle: rec.title,
              displayNum: rec.displayNum,
            },
            status: 'new',
          },
        });
      });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false; // raced — the other cycle wrote it
      throw e;
    }
  }

  /** Congress number from a canonical bill id ("119-hr-1234" → 119); 0 if unparseable. */
  private congressOf(billId: string): number {
    const n = Number((billId.split('-')[0] ?? '').trim());
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** Canonical congress.gov bill URL from "119-hr-1234"; null for unknown bill types. */
  private billUrl(billId: string): string | null {
    const [c, type, num] = billId.split('-');
    if (!c || !type || !num) return null;
    const slug: Record<string, string> = {
      hr: 'house-bill',
      s: 'senate-bill',
      hres: 'house-resolution',
      sres: 'senate-resolution',
      hjres: 'house-joint-resolution',
      sjres: 'senate-joint-resolution',
      hconres: 'house-concurrent-resolution',
      sconres: 'senate-concurrent-resolution',
    };
    const kind = slug[type.toLowerCase()];
    return kind ? `https://www.congress.gov/bill/${c}th-congress/${kind}/${num}` : null;
  }
}
