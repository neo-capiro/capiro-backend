import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { HearingCryptoService } from '../hearing/hearing-crypto.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { ActionItemService } from './action-item.service.js';
import { recommendedActionsFor } from './recommended-actions.util.js';
import { normalizeEvidence } from './normalize-evidence.js';
import { AlertWorkStateService, type WorkState } from './alert-work-state.service.js';

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
  /**
   * Bill 360 event history (Release R1, §1.4): restrict to alerts whose
   * `source_ref` equals this bill id. Index-backed via
   * @@index([tenantId, sourceType, sourceRef]) — an INDEXED predicate, never an
   * in-memory filter. Pair with sourceTypes:['bill'] for a covering lookup.
   */
  sourceRef?: string;
  /**
   * P2-04 (Gate D e-4): the CURRENT USER, for per-user work-state decoration and
   * the dismissed/snoozed exclusion. Omitted → no work state is loaded and the
   * feed behaves exactly as before.
   */
  userId?: string;
  /**
   * Which work states to show. Omitted → the DEFAULT view, which EXCLUDES this
   * user's dismissed and still-snoozed alerts. `['all']` disables the exclusion.
   *
   * APPROACH (e-4 asks this to be stated explicitly): an EXCLUSION predicate,
   * `id: { notIn: <this user's hidden ids> }`, not a join and not a post-filter.
   *   - A join to intel_alert_work_state cannot be expressed alongside the
   *     keyset OR while staying index-backed, so it would silently drop the
   *     covering index the feed depends on.
   *   - A post-filter would break `hasMore`/`nextCursor`: `take: limit + 1`
   *     would count rows that are then discarded in JS, so a page whose items
   *     were all filtered out would report hasMore:false and end the infinite
   *     scroll early (edge case 11).
   *   The exclusion is a plain AND-ed primary-key predicate, so the ordering
   *   index still drives the scan, and the page is genuinely full.
   */
  workStates?: string[];
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

const b64encode = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
const b64decode = (cur: string): any => {
  try {
    return JSON.parse(Buffer.from(cur, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

export function encodeCursor(
  order: 'date' | 'score',
  row: { score: number; createdAt: Date; id: string },
): string {
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
    private readonly workState: AlertWorkStateService,
  ) {}

  /**
   * Decrypt-on-read (§9.7, fail-closed): fill `quote` for encrypted hearing
   * mentions by decrypting their transcript segment. Batches segment reads across
   * the page (no N+1). On any decrypt/read failure the quote stays null — NEVER
   * leak ciphertext. No-op when no key is configured (e.g. non-serve contexts).
   */
  private async decryptQuotes(
    tenantId: string,
    items: Array<{ evidence: unknown }>,
  ): Promise<void> {
    if (!this.crypto.configured) return;
    const segIds = new Set<string>();
    for (const it of items) {
      const ev = it.evidence as {
        hearing?: {
          mentions?: Array<{ quoteSource?: string; quote?: unknown; segmentId?: string | null }>;
        };
      } | null;
      for (const m of ev?.hearing?.mentions ?? []) {
        if (m?.quoteSource === 'encrypted' && !m.quote && m.segmentId) segIds.add(m.segmentId);
      }
    }
    if (!segIds.size) return;
    const segs = await this.prisma.withTenant(tenantId, (tx) =>
      tx.transcriptSegment.findMany({
        where: { id: { in: [...segIds] } },
        select: { id: true, textCiphertext: true, iv: true, authTag: true },
      }),
    );
    const cipherById = new Map(segs.map((s) => [s.id, s]));
    for (const it of items) {
      const ev = it.evidence as {
        hearing?: {
          mentions?: Array<{ quoteSource?: string; quote?: unknown; segmentId?: string | null }>;
        };
      } | null;
      for (const m of ev?.hearing?.mentions ?? []) {
        if (m?.quoteSource !== 'encrypted' || m.quote || !m.segmentId) continue;
        const c = cipherById.get(m.segmentId);
        if (!c?.textCiphertext || !c.iv || !c.authTag) continue;
        try {
          m.quote = this.crypto.decrypt({
            textCiphertext: c.textCiphertext,
            iv: c.iv,
            authTag: c.authTag,
          });
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

    // P2-04: exclude THIS user's dismissed / still-snoozed alerts. See FeedQuery
    // .workStates for why this is an exclusion rather than a join or a
    // post-filter. Never widens: `status` above still gates suppressed rows, so
    // work state can only narrow what a user sees (edge case 7).
    const wantsAll = q.workStates?.includes('all');
    if (q.userId && !wantsAll) {
      const hidden = await this.workState.hiddenAlertIds(tenantId, q.userId, clientId ?? null);
      if (hidden.length) where['id'] = { notIn: hidden };
    }
    // Bill 360 (§1.4): equality predicate on source_ref so a single-bill event
    // history hits @@index([tenantId, sourceType, sourceRef]) — never a JS filter.
    if (q.sourceRef) where['sourceRef'] = q.sourceRef;

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

    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlert.findMany({
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
      }),
    );

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(order, last) : null;

    // Per-sourceType counts for the SubNav badges + per-severity counts for the
    // Feed rail's "At a glance" panel (LegiWatch v2). Both over `baseWhere`, which
    // omits the sourceType facet and (in this UI) carries no severity filter — so
    // each reflects true tenant/client-scoped totals, not the loaded page.
    const [grouped, groupedSev] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.groupBy({ by: ['sourceType'], where: baseWhere, _count: true }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.groupBy({ by: ['severity'], where: baseWhere, _count: true }),
      ),
    ]);
    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.sourceType] = g._count;
    const severityCounts: Record<string, number> = {};
    for (const g of groupedSev) severityCounts[g.severity] = g._count;

    await this.decryptQuotes(tenantId, items); // fill encrypted hearing quotes (fail-closed)

    // Decorate each alert with its intelligent next-actions + current action state
    // (memo drafted? in weekly report? talking points?) — batch-loaded, no N+1.
    const actionState = await this.actions.summaryForAlerts(
      tenantId,
      items.map((i) => i.id),
    );

    // P2-04: per-user triage state for this page, batch-loaded in ONE query
    // beside actionState — same no-N+1 posture.
    const workStateByAlert: Map<string, WorkState> = q.userId
      ? await this.workState.forAlerts(
          tenantId,
          q.userId,
          items.map((i) => i.id),
        )
      : new Map();

    // Matched-tag resolution (LegiWatch v2 / L1): batch-resolve each alert's
    // termId → its WatchlistTerm → owning WatchlistTopic label ("tag"), in ONE
    // tenant-scoped read (no per-row join, mirrors decryptQuotes/getClientNames).
    // The calm feed card shows this as a chip instead of the "why it matters"
    // prose. Falls back (in deriveTag) to a denormalized hearing-mention term.
    const termIds = [...new Set(items.map((i) => i.termId).filter((x): x is string => Boolean(x)))];
    const termTagById = termIds.length
      ? new Map(
          (
            await this.prisma.withTenant(tenantId, (tx) =>
              tx.watchlistTerm.findMany({
                where: { id: { in: termIds }, tenantId },
                select: { id: true, value: true, topic: { select: { label: true } } },
              }),
            )
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
          .getClientNames(
            tenantId,
            items.map((i) => i.clientId),
          )
          .catch(() => new Map<string, string>());

    // P0-07: normalize evidence into ONE versioned contract, here and nowhere else.
    // Order matters and is asserted by test: decryptQuotes (above) → actionState →
    // termTagById → clientNames → normalize. Normalizing earlier would copy the
    // hearing mentions and the decrypted quote text would land on an orphaned object.
    const decorated = items.map((it) => {
      const evidence = normalizeEvidence({
        sourceType: it.sourceType,
        sourceRef: it.sourceRef,
        title: it.title,
        whyItMatters: it.whyItMatters,
        termId: it.termId,
        evidence: it.evidence,
        topicLabel: it.termId ? (termTagById.get(it.termId) ?? null) : null,
      });
      return {
        ...it,
        evidence,
        clientName: clientNames.get(it.clientId) ?? null,
        // deriveTag reads the RAW row on purpose — it runs independently of
        // normalization and reads the stored flat `matchedTags` key directly.
        tag: deriveTag(it, termTagById),
        recommendedActions: recommendedActionsFor({
          sourceType: it.sourceType,
          severity: it.severity,
          sourceRef: it.sourceRef,
          // The NORMALIZED evidence: a flat writer's top-level `sessionId` now lives
          // under `extra`, which is why sessionIdOf grew an `extra` fallback (b-4).
          evidence,
        }),
        actions: actionState.get(it.id) ?? { inReport: false, talkingPoints: 0 },
        // P2-04: this USER's triage state. Absent row = never triaged; 'new' is
        // the honest default rather than a missing field the UI has to guess at.
        workState: workStateByAlert.get(it.id) ?? {
          state: 'new' as const,
          assignedTo: null,
          snoozedUntil: null,
          note: null,
        },
      };
    });

    return { items: decorated, nextCursor, hasMore, counts, severityCounts };
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
  const ev = it.evidence as {
    hearing?: { mentions?: Array<{ term?: string | null; issueTags?: string[] | null }> };
  } | null;
  const mentions = ev?.hearing?.mentions ?? [];
  const byTerm = mentions.find((m) => m?.term)?.term;
  if (byTerm) return byTerm;
  const byIssue = mentions.flatMap((m) => m?.issueTags ?? [])[0];
  if (byIssue) return byIssue;
  // P1-09: the bill-change detector stores its relevance explanation as
  // evidence.matchedTags (bill-change-detector.service.ts:1041) and never sets termId,
  // so every bill alert used to render with no tag chip and an empty canonical issueId.
  // Ordering is deterministic — explainMatch returns
  // Array.from(new Set(matchedTags)).slice(0, 4) (relevance.util.ts:201), tags before
  // issue areas — so [0] is the strongest match. LAST fallback: existing precedence is
  // untouched.
  const flatTags = (it.evidence as { matchedTags?: unknown } | null)?.matchedTags;
  if (Array.isArray(flatTags)) {
    const first = flatTags.find((t): t is string => typeof t === 'string' && t.trim().length > 0);
    if (first) return first;
  }
  return null;
}
