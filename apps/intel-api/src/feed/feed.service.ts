import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { HearingCryptoService } from '../hearing/hearing-crypto.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { ActionItemService } from './action-item.service.js';
import { recommendedActionsFor } from './recommended-actions.util.js';

/**
 * Combined intel feed (Phase 6 §9.7). Reads `intel_alert` only — evidence is
 * denormalized at write time (§9.3) so there is NO hot-path join to
 * congress_bill/hearing. Keyset pagination (no OFFSET), index-backed:
 *   per-client, order=date  → [tenant_id, client_id, created_at] (Phase-4 index)
 *   per-client, order=score → [tenant_id, client_id, score, created_at] (Phase-6 index)
 *   tenant-wide, order=date  → [tenant_id, created_at]         (P11 index)
 *   tenant-wide, order=score → [tenant_id, score, created_at]  (P11 index)
 *
 * clientId is OPTIONAL: when omitted the feed is a TENANT-WIDE roll-up across
 * every client (Radar's global altitude, P11), and each returned alert carries
 * its own clientId + resolved clientName so cards can label the client. When
 * present the feed is the per-client view (unchanged).
 *
 * intel_alert has no RLS → every query filters by tenantId (app-code isolation),
 * plus clientId when scoped to one client. Encrypted mention quotes are returned
 * as pointers (quoteSource='encrypted', quote=null) as stored; decrypt-on-read is
 * a fast follow (the serve task-def carries HEARING_ENCRYPTION_KEY).
 */

export const DEFAULT_STATUSES = ['new', 'reviewed', 'sent'];
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 25;

export interface FeedQuery {
  sourceTypes?: string[];
  severities?: string[];
  statuses?: string[];
  since?: Date;
  until?: Date;
  order?: 'date' | 'score';
  cursor?: string;
  limit?: number;
}

interface DateCursor {
  t: string;
  id: string;
}
interface ScoreCursor {
  s: number;
  t: string;
  id: string;
}

const b64encode = (obj: unknown): string => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
const b64decode = (cur: string): any => {
  try {
    return JSON.parse(Buffer.from(cur, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

export function encodeCursor(order: 'date' | 'score', row: { score: number; createdAt: Date; id: string }): string {
  return order === 'score'
    ? b64encode({ s: row.score, t: row.createdAt.toISOString(), id: row.id } satisfies ScoreCursor)
    : b64encode({ t: row.createdAt.toISOString(), id: row.id } satisfies DateCursor);
}

@Injectable()
export class FeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: HearingCryptoService,
    private readonly actions: ActionItemService,
    private readonly sourceData: SourceDataRepository,
  ) {}

  /**
   * Decrypt-on-read (§9.7, fail-closed): fill `quote` for encrypted hearing
   * mentions by decrypting their transcript segment. Batches segment reads across
   * the page (no N+1). On any decrypt/read failure the quote stays null — NEVER
   * leak ciphertext. No-op when no key is configured (e.g. non-serve contexts).
   */
  private async decryptQuotes(items: Array<{ evidence: unknown }>): Promise<void> {
    if (!this.crypto.configured) return;
    const segIds = new Set<string>();
    for (const it of items) {
      const ev = it.evidence as { hearing?: { mentions?: Array<{ quoteSource?: string; quote?: unknown; segmentId?: string | null }> } } | null;
      for (const m of ev?.hearing?.mentions ?? []) {
        if (m?.quoteSource === 'encrypted' && !m.quote && m.segmentId) segIds.add(m.segmentId);
      }
    }
    if (!segIds.size) return;
    const segs = await this.prisma.transcriptSegment.findMany({
      where: { id: { in: [...segIds] } },
      select: { id: true, textCiphertext: true, iv: true, authTag: true },
    });
    const cipherById = new Map(segs.map((s) => [s.id, s]));
    for (const it of items) {
      const ev = it.evidence as { hearing?: { mentions?: Array<{ quoteSource?: string; quote?: unknown; segmentId?: string | null }> } } | null;
      for (const m of ev?.hearing?.mentions ?? []) {
        if (m?.quoteSource !== 'encrypted' || m.quote || !m.segmentId) continue;
        const c = cipherById.get(m.segmentId);
        if (!c?.textCiphertext || !c.iv || !c.authTag) continue;
        try {
          m.quote = this.crypto.decrypt({ textCiphertext: c.textCiphertext, iv: c.iv, authTag: c.authTag });
        } catch {
          /* fail closed: leave quote null, never leak ciphertext */
        }
      }
    }
  }

  /**
   * @param clientId one client to scope to, or `null`/omitted for the TENANT-WIDE
   *   roll-up across every client (P11). Both paths are tenant-scoped in app code.
   */
  async getFeed(tenantId: string, clientId: string | null | undefined, q: FeedQuery) {
    const order: 'date' | 'score' = q.order === 'score' ? 'score' : 'date';
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const statuses = q.statuses?.length ? q.statuses : DEFAULT_STATUSES;

    // Shared filters (also used for counts, minus the sourceType facet). clientId
    // is added ONLY for the per-client view; omitted → tenant-wide roll-up.
    const baseWhere: Record<string, unknown> = {
      tenantId,
      status: { in: statuses },
    };
    if (clientId) baseWhere['clientId'] = clientId;
    if (q.severities?.length) baseWhere['severity'] = { in: q.severities };
    if (q.since || q.until) {
      baseWhere['createdAt'] = {
        ...(q.since ? { gte: q.since } : {}),
        ...(q.until ? { lt: q.until } : {}),
      };
    }

    const where: Record<string, unknown> = { ...baseWhere };
    if (q.sourceTypes?.length) where['sourceType'] = { in: q.sourceTypes };

    // Keyset predicate from the cursor (AND-ed with the filters above).
    const cur = q.cursor ? b64decode(q.cursor) : null;
    if (cur) {
      if (order === 'score' && typeof cur.s === 'number' && cur.t && cur.id) {
        const t = new Date(cur.t);
        where['OR'] = [
          { score: { lt: cur.s } },
          { score: cur.s, createdAt: { lt: t } },
          { score: cur.s, createdAt: t, id: { lt: cur.id } },
        ];
      } else if (order === 'date' && cur.t && cur.id) {
        const t = new Date(cur.t);
        where['OR'] = [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: cur.id } }];
      }
    }

    const orderBy =
      order === 'score'
        ? [{ score: 'desc' as const }, { createdAt: 'desc' as const }, { id: 'desc' as const }]
        : [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

    const rows = await this.prisma.intelAlert.findMany({
      where,
      orderBy,
      take: limit + 1, // one extra to compute hasMore
      select: {
        id: true,
        clientId: true,
        sourceType: true,
        sourceRef: true,
        kind: true,
        severity: true,
        materiality: true,
        score: true,
        clientImpact: true,
        urgency: true,
        title: true,
        whyItMatters: true,
        recommendedAction: true,
        evidence: true,
        status: true,
        createdAt: true,
        // termId → the matched WatchlistTerm → its WatchlistTopic ("tag"). Used to
        // surface a clean tag CHIP on the calm feed card (LegiWatch v2 / L1),
        // resolved in a single batched read below (no hot-path per-row join).
        termId: true,
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(order, last) : null;

    // Per-sourceType counts for the SubNav badges — same filters MINUS sourceType.
    const grouped = await this.prisma.intelAlert.groupBy({
      by: ['sourceType'],
      where: baseWhere,
      _count: true,
    });
    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.sourceType] = g._count;

    await this.decryptQuotes(items); // fill encrypted hearing quotes (fail-closed)

    // Decorate each alert with its intelligent next-actions + current action state
    // (memo drafted? in weekly report? talking points?) — batch-loaded, no N+1.
    const actionState = await this.actions.summaryForAlerts(
      tenantId,
      items.map((i) => i.id),
    );

    // Matched-tag resolution (LegiWatch v2 / L1): batch-resolve each alert's
    // termId → its WatchlistTerm → owning WatchlistTopic label ("tag"), in ONE
    // tenant-scoped read (no per-row join, mirrors decryptQuotes/getClientNames).
    // The calm feed card shows this as a chip instead of the "why it matters"
    // prose. Falls back (in deriveTag) to a denormalized hearing-mention term.
    const termIds = [
      ...new Set(items.map((i) => i.termId).filter((x): x is string => Boolean(x))),
    ];
    const termTagById = termIds.length
      ? new Map(
          (
            await this.prisma.watchlistTerm.findMany({
              where: { id: { in: termIds }, tenantId },
              select: { id: true, value: true, topic: { select: { label: true } } },
            })
          ).map((t) => [t.id, t.topic?.label ?? t.value]),
        )
      : new Map<string, string>();

    // Global roll-up: resolve display names for the page's client ids in one
    // tenant-scoped read so each card can label its client (no-op/skip for the
    // per-client view — it already knows the name from the URL). Never blocks the
    // feed: a name that can't be resolved just renders as its id upstream.
    const clientNames = clientId
      ? new Map<string, string>()
      : await this.sourceData
          .getClientNames(tenantId, items.map((i) => i.clientId))
          .catch(() => new Map<string, string>());

    const decorated = items.map((it) => ({
      ...it,
      clientName: clientNames.get(it.clientId) ?? null,
      tag: deriveTag(it, termTagById),
      recommendedActions: recommendedActionsFor({
        sourceType: it.sourceType,
        severity: it.severity,
        sourceRef: it.sourceRef,
        evidence: it.evidence,
      }),
      actions: actionState.get(it.id) ?? { inReport: false, talkingPoints: 0 },
    }));

    return { items: decorated, nextCursor, hasMore, counts };
  }
}

/**
 * The single matched watchlist "tag" to chip on a feed card (LegiWatch v2 / L1).
 * Prefers the alert's matched term's owning topic label (a real bill-tracker tag);
 * falls back to a denormalized hearing-mention term, then a hearing issue tag.
 * Returns null when no structured tag is available (the card then shows no chip —
 * never the old "matches tag …" prose).
 */
function deriveTag(
  it: { termId: string | null; evidence: unknown },
  termTagById: Map<string, string>,
): string | null {
  if (it.termId && termTagById.has(it.termId)) return termTagById.get(it.termId) ?? null;
  const ev = it.evidence as
    | { hearing?: { mentions?: Array<{ term?: string | null; issueTags?: string[] | null }> } }
    | null;
  const mentions = ev?.hearing?.mentions ?? [];
  const byTerm = mentions.find((m) => m?.term)?.term;
  if (byTerm) return byTerm;
  const byIssue = mentions.flatMap((m) => m?.issueTags ?? [])[0];
  return byIssue ?? null;
}
