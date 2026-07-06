import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * WatchlistMatch → hearing `intel_alert` promotion (Phase 6 §9.5). Closes the
 * "hearing matches sit unused" gap: groups `intel_watchlist_match` rows into ONE
 * `hearing` alert per (client, session) — never one-per-term (avoids alert
 * storms) — and upserts it idempotently on `dedupe_key`.
 *
 * SHADOW-safe: writes `intel_alert` with status='new' and delivers nothing (no
 * SES/SNS, single-sender invariant intact). intel_* tables carry no RLS, so
 * reads/writes filter by the caller-supplied tenantId (app-code isolation). Does
 * NOT decrypt transcript text (§9.3): encrypted segments store a pointer
 * (segmentId + timestamp + quoteSource='encrypted'); the feed decrypts on read.
 */
export const PROMOTE_TOP_K = 5;

export interface PromoteSessionResult {
  alerts: number;
  skipped: boolean;
}
export interface PromoteSweepResult {
  sessions: number;
  alerts: number;
  skipped: number;
}

interface MatchRow {
  clientId: string;
  segmentId: string;
  termId: string;
  termType: string;
  termValue: string;
  score: number;
  startMs: number;
}

@Injectable()
export class WatchlistMatchPromoterService {
  constructor(private readonly prisma: PrismaService) {}

  /** Sweep every session with watchlist matches (optionally since an ISO time). */
  async promoteAll(sinceIso?: string): Promise<PromoteSweepResult> {
    const since = sinceIso ? new Date(sinceIso) : undefined;
    // Cross-tenant sweep: groups matches across ALL tenants to fan out, then
    // promotes each under its own tenant scope. Under RLS this MUST bypass.
    const groups = await this.prisma.withSystem((tx) =>
      tx.watchlistMatch.groupBy({
        by: ['tenantId', 'sessionId'],
        where: since ? { createdAt: { gte: since } } : {},
      }),
    );
    let alerts = 0;
    let skipped = 0;
    for (const g of groups) {
      const r = await this.promoteMatches(g.tenantId, g.sessionId);
      alerts += r.alerts;
      if (r.skipped) skipped += 1;
    }
    return { sessions: groups.length, alerts, skipped };
  }

  /**
   * Promote all watchlist matches for one session into per-client hearing alerts.
   * The whole operation runs in ONE transaction holding a per-session advisory
   * xact-lock (efficiency backstop against a concurrent sweep + hearing-end hook);
   * the `dedupe_key` unique constraint is the correctness backstop.
   */
  async promoteMatches(tenantId: string, sessionId: string): Promise<PromoteSessionResult> {
    // withTenant IS a $transaction (same advisory-lock + dedupe-upsert
    // semantics) that additionally sets app.current_tenant so the intel_*
    // reads/writes below respect RLS.
    return this.prisma.withTenant(tenantId, async (tx) => {
      const lock = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
        `promote:${sessionId}`,
      );
      if (!lock[0]?.locked) return { alerts: 0, skipped: true };

      const matches = (await tx.watchlistMatch.findMany({
        where: { tenantId, sessionId },
        select: {
          clientId: true,
          segmentId: true,
          termId: true,
          termType: true,
          termValue: true,
          score: true,
          startMs: true,
        },
      })) as MatchRow[];
      if (!matches.length) return { alerts: 0, skipped: false };

      const session = await tx.liveHearingSession.findUnique({
        where: { id: sessionId },
        select: { title: true, committeeId: true, startedAt: true, endedAt: true },
      });

      // Resolve segments once for the whole session (for speaker/quote/tags).
      const segIds = Array.from(new Set(matches.map((m) => m.segmentId)));
      const segs = await tx.transcriptSegment.findMany({
        where: { id: { in: segIds } },
        select: { id: true, resolvedSpeakerName: true, textPlain: true, issueTags: true },
      });
      const segById = new Map(segs.map((s) => [s.id, s]));

      // One alert per client.
      const byClient = new Map<string, MatchRow[]>();
      for (const m of matches) {
        const arr = byClient.get(m.clientId) ?? [];
        arr.push(m);
        byClient.set(m.clientId, arr);
      }

      let alerts = 0;
      for (const [clientId, rows] of byClient) {
        const hasRisk = rows.some((r) => r.termType === 'risk');
        const ranked = [...rows].sort((a, b) => b.score - a.score);
        const kept = ranked.slice(0, PROMOTE_TOP_K);
        const maxScore = ranked[0]?.score ?? 0;
        const score = Math.max(0, Math.min(1, maxScore + (hasRisk ? 0.1 : 0)));
        const distinctTerms = Array.from(new Set(ranked.map((r) => r.termValue)));

        const occurredAt = session?.endedAt ?? session?.startedAt ?? null;
        const evidence = {
          hearing: {
            sessionId,
            title: session?.title ?? null,
            committeeId: session?.committeeId ?? null,
            occurredAt: occurredAt ? occurredAt.toISOString() : null,
            mentions: kept.map((m) => {
              const seg = segById.get(m.segmentId);
              const hasPlain = Boolean(seg?.textPlain);
              return {
                segmentId: m.segmentId,
                timestampMs: m.startMs,
                speakerName: seg?.resolvedSpeakerName ?? null,
                quote: hasPlain ? (seg?.textPlain ?? null) : null,
                quoteSource: hasPlain ? 'textPlain' : 'encrypted',
                issueTags: seg?.issueTags ?? [],
                term: m.termValue,
                termType: m.termType,
                score: m.score,
              };
            }),
          },
          link: { via: 'watchlist_match', matchCount: rows.length },
        };

        const dedupeKey = `hearing:${clientId}:${sessionId}`;
        const title = `${session?.title ?? 'Hearing'} — ${rows.length} watchlist mention${rows.length === 1 ? '' : 's'}`;
        const whyItMatters = `Your watchlist term${distinctTerms.length === 1 ? '' : 's'} (${distinctTerms
          .slice(0, 4)
          .join(', ')}) ${distinctTerms.length === 1 ? 'was' : 'were'} referenced in this hearing.`;
        const recommendedAction = `Review the ${kept.length} mention${kept.length === 1 ? '' : 's'} in "${session?.title ?? 'this hearing'}" and brief the client.`;

        const data = {
          sourceType: 'hearing',
          sourceRef: sessionId,
          kind: hasRisk ? 'risk_phrase' : 'hearing_mention',
          severity: hasRisk ? 'notable' : 'info',
          materiality: hasRisk ? 'medium' : 'low',
          score,
          clientImpact: 'monitor',
          urgency: hasRisk ? 'med' : 'low',
          title,
          whyItMatters,
          recommendedAction,
          evidence,
        };

        // Idempotent upsert on dedupe_key. Under the advisory lock the key is
        // processed once, so findUnique→create cannot race a concurrent create
        // (dedupeKey embeds sessionId → other sessions never collide).
        const existing = await tx.intelAlert.findUnique({
          where: { dedupeKey },
          select: { id: true, status: true },
        });
        if (existing) {
          if (existing.status === 'new') {
            await tx.intelAlert.update({ where: { id: existing.id }, data });
            alerts += 1;
          }
          // never resurrect a reviewed/sent/dismissed alert
        } else {
          await tx.intelAlert.create({ data: { tenantId, clientId, dedupeKey, ...data } });
          alerts += 1;
        }
      }
      return { alerts, skipped: false };
    });
  }
}
