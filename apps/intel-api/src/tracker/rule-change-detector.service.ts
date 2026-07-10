import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SourceRuleRepository,
  type SourceRule,
} from '../sourcedata/rule-source-data.repository.js';
import { explainMatch, type WatchlistLike } from './relevance.util.js';

const DEDUPE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface RuleDetectionSummary {
  scanned: number;
  matched: number;
  alertsWritten: number;
  skippedDedup: number;
}

/**
 * Unified rule-emitter (Phase 1 M3.3, PD4) — the FIRST time a federal
 * `federal_register_document` OR a state `state_rule` reaches the LegiWatch
 * feed at all (federal regs were apps/api-dashboard-only before this;
 * `check-comment-periods.ts`/M3.4 stays the DEADLINE-COUNTDOWN chip, this is
 * the NEW-MATCH alert — two different surfaces on the same underlying
 * document, not a double-notify, per PD4).
 *
 * v1 scope, stated plainly: only `rule_new_match` (a newly-synced rule
 * matching a client's watchlist). `rule_comment_open`/`rule_finalized`
 * (parent §4 M3.3) are deferred — `rule_finalized` in particular needs
 * cross-notice linking (a FINAL notice matched back to the PROPOSED notice
 * for the same underlying rule via its docket/rule number), which FL's own
 * adapter doesn't yet build (the same chained-fetch gap documented in
 * fl-far.client.ts).
 *
 * Broadcast-per-tenant, not tracked-item-based (rules aren't "tracked" the
 * way bills are) — mirrors check-comment-periods.ts's client×document scan,
 * reusing `explainMatch`'s keyword machinery (a rule's title/abstract slots
 * into the SAME `RelevanceBill` shape a bill's title/latestActionText does).
 */
@Injectable()
export class RuleChangeDetectorService {
  private readonly logger = new Logger(RuleChangeDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ruleSource: SourceRuleRepository,
  ) {}

  async runDetectionCycle(windowHours = 48): Promise<RuleDetectionSummary> {
    const zero: RuleDetectionSummary = {
      scanned: 0,
      matched: 0,
      alertsWritten: 0,
      skippedDedup: 0,
    };
    const rules = await this.ruleSource.getRecentlySyncedRules(windowHours);
    if (!rules.length) return zero;

    const tenants = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM tenants WHERE status = 'active'`),
    );

    let matched = 0;
    let alertsWritten = 0;
    let skippedDedup = 0;
    const watchlistCache = new Map<string, WatchlistLike>();

    for (const tenant of tenants) {
      watchlistCache.clear();
      // `clients` is apps/api-owned + tenant-scoped (RLS) — cross-realm raw
      // SQL under withSystem with an explicit tenant_id bound param, the SAME
      // pattern source-data.repository.ts's getClientProfile/clientTenantMap
      // use (never a bare cross-tenant scan, even under withSystem).
      const clients = await this.prisma.withSystem((tx) =>
        tx.$queryRawUnsafe<Array<{ id: string; name: string }>>(
          `SELECT id::text AS id, name
             FROM clients
            WHERE tenant_id = $1::uuid AND status != 'archived' AND profile_status = 'ACTIVE'`,
          tenant.id,
        ),
      );
      if (!clients.length) continue;

      for (const client of clients) {
        const wl = await this.watchlistFor(tenant.id, client.id, watchlistCache);
        if (!wl.issueAreas.length && !wl.tags.length) continue;

        for (const rule of rules) {
          const ex = explainMatch(
            { title: rule.title, policyArea: null, subjects: [], latestActionText: rule.abstract },
            wl,
          );
          if (!ex.matchedTags.length) continue;
          matched++;

          const wrote = await this.writeRuleAlert(
            tenant.id,
            client.id,
            rule,
            ex.why,
            ex.matchedTags,
          );
          if (wrote) alertsWritten++;
          else skippedDedup++;
        }
      }
    }

    return { scanned: rules.length, matched, alertsWritten, skippedDedup };
  }

  private async writeRuleAlert(
    tenantId: string,
    clientId: string,
    rule: SourceRule,
    why: string | null,
    matchedTags: string[],
  ): Promise<boolean> {
    const dedupeSince = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlert.findFirst({
        where: {
          tenantId,
          clientId,
          sourceType: 'regulation',
          changeType: 'rule_new_match',
          sourceRef: rule.id,
          createdAt: { gte: dedupeSince },
        },
        select: { id: true },
      }),
    );
    if (existing) return false;

    const jurisdictionLabel = rule.jurisdiction === 'state' ? (rule.state ?? 'state') : 'US';
    const displayTitle = rule.title.length > 80 ? `${rule.title.slice(0, 80)}…` : rule.title;
    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.create({
          data: {
            tenantId,
            clientId,
            sourceType: 'regulation',
            sourceRef: rule.id,
            watchlistId: `wl:${clientId}`,
            kind: 'rule_new_match',
            changeType: 'rule_new_match',
            severity: 'info',
            materiality: 'low',
            score: 0.3,
            title: `New matched rule: ${displayTitle}`,
            whyItMatters: why,
            evidence: {
              stage: 'New rule',
              // Verbatim from the record (Workstream C discipline) — never a summary.
              actionText: rule.abstract ?? rule.title,
              actionDate: rule.publicationDate.toISOString().slice(0, 10),
              url: rule.sourceUrl,
              sourceUrl: rule.sourceUrl,
              why,
              matchedTags,
              tone: 'info',
              band: 'low',
              triggerKey: 'newMatch',
              ruleTitle: rule.title,
              agency: rule.agency,
              ruleType: rule.ruleType,
              commentEndDate: rule.commentEndDate?.toISOString().slice(0, 10) ?? null,
              jurisdiction: jurisdictionLabel,
            },
            status: 'new',
          },
        }),
      );
      return true;
    } catch (err) {
      this.logger.error(
        `writeRuleAlert failed for ${rule.id}/${clientId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** Build the keyword-match watchlist (WatchlistLike) — same shape/query BillChangeDetectorService.watchlistFor builds, duplicated per this codebase's per-detector convention (see that method's own history for why). */
  private async watchlistFor(
    tenantId: string,
    clientId: string,
    cache: Map<string, WatchlistLike>,
  ): Promise<WatchlistLike> {
    const cached = cache.get(clientId);
    if (cached) return cached;
    let wl: WatchlistLike = { issueAreas: [], tags: [] };
    try {
      const wlId = `wl:${clientId}`;
      const built = await this.prisma.withTenant(tenantId, async (tx) => {
        const head = await tx.watchlist.findFirst({
          where: { id: wlId },
          select: { issueAreas: true },
        });
        if (!head) return null;
        const topics = await tx.watchlistTopic.findMany({
          where: { watchlistId: wlId },
          select: { id: true, label: true },
        });
        const terms = topics.length
          ? await tx.watchlistTerm.findMany({
              where: { topicId: { in: topics.map((t) => t.id) } },
              select: { topicId: true, termType: true, value: true },
            })
          : [];
        return { head, topics, terms };
      });
      if (built) {
        const { head, topics, terms } = built;
        wl = {
          issueAreas: head.issueAreas,
          tags: topics.map((t) => ({
            tag: t.label,
            synonyms: terms
              .filter((x) => x.topicId === t.id && x.termType === 'synonym')
              .map((x) => x.value),
            relatedEntities: terms
              .filter((x) => x.topicId === t.id && x.termType === 'entity')
              .map((x) => x.value),
            riskTerms: terms
              .filter((x) => x.topicId === t.id && x.termType === 'risk')
              .map((x) => x.value),
          })),
        };
      }
    } catch (e) {
      this.logger.warn(`watchlistFor ${clientId} failed: ${(e as Error).message}`);
    }
    cache.set(clientId, wl);
    return wl;
  }
}
