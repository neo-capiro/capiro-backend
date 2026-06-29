import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import { issueAreaForSector, normalizeIssueArea } from '@capiro/shared';
import { EMBEDDING_MODEL, embedText, normalize, vectorLiteral } from '../embeddings/embedder.js';
import { normalizeE164 } from './sms/sms.service.js';
import {
  BILL_STAGES,
  billStage,
  congressFromBillId,
  currentCongress,
  humanizeBillId,
  passageProbability,
} from './bill-stage.util.js';
import { MIN_TERM_LEN, wholeWordHit } from './tracker-relevance.util.js';
import {
  DEFAULT_TRIGGERS,
  ISSUE_AREAS,
  type AlertPrefsPayload,
  type BoardBill,
  type BoardColumn,
  type BoardResponse,
  type BillSearchResult,
  type ChangeTone,
  type MatchReason,
  type MatchReasonKind,
  type RecommendationBill,
  type RecommendationsResponse,
  type WatchlistPayload,
  type WatchlistTag,
} from './tracker.types.js';

/** Accepts the controller DTO shape (optional fields may be undefined). */
type AlertPrefsInput = Omit<
  AlertPrefsPayload,
  'emailAddress' | 'smsPhone' | 'quietHoursStart' | 'quietHoursEnd'
> & {
  emailAddress?: string | null;
  smsPhone?: string | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
};

const RECOMMENDATION_FLOOR = 0.45;
const EMBED_CANDIDATE_FLOOR = 0.3; // broad — composite fit + RECOMMENDATION_FLOOR gate the feed

interface BillRow {
  id: string;
  title: string;
  latest_action_text: string | null;
  latest_action_date: Date | null;
  subjects: string[];
  policy_area: string | null;
  sponsor_name: string | null;
  sponsor_party: string | null;
  cosponsors_count: number;
}

/** A normalized lower-cased haystack for whole-word term matching. */
function haystack(bill: BillRow): string {
  return [bill.title, bill.policy_area ?? '', ...(bill.subjects ?? [])].join('  ').toLowerCase();
}

const TONE_FOR_CHANGE: Record<string, ChangeTone> = {
  bill_enacted: 'success',
  bill_to_president: 'success',
  bill_failed: 'critical',
  bill_passed_chamber: 'success',
  bill_floor_scheduled: 'info',
  bill_reported: 'success',
  bill_markup: 'info',
  bill_hearing: 'info',
  bill_amendment: 'notable',
};

@Injectable()
export class TrackerService {
  private readonly logger = new Logger(TrackerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intelligence: IntelligenceService,
  ) {}

  issueAreas(): readonly string[] {
    return ISSUE_AREAS;
  }

  // ── Watchlist ──────────────────────────────────────────────────────────────

  private normalizeTag(raw: Partial<WatchlistTag> & { tag?: string }): WatchlistTag | null {
    const tag = (raw.tag ?? '').trim();
    if (!tag) return null;
    const clean = (arr: unknown): string[] =>
      Array.isArray(arr)
        ? Array.from(
            new Set(
              arr
                .filter((x): x is string => typeof x === 'string')
                .map((x) => x.trim())
                .filter(Boolean),
            ),
          )
        : [];
    const priority = (['low', 'med', 'high'] as const).includes(raw.priority as never)
      ? (raw.priority as WatchlistTag['priority'])
      : 'med';
    const position = (['support', 'oppose', 'monitor'] as const).includes(raw.position as never)
      ? (raw.position as WatchlistTag['position'])
      : 'monitor';
    return {
      tag,
      issueArea: typeof raw.issueArea === 'string' ? raw.issueArea : null,
      synonyms: clean(raw.synonyms),
      relatedEntities: clean(raw.relatedEntities),
      riskTerms: clean(raw.riskTerms),
      position,
      priority,
    };
  }

  async getWatchlist(clientId: string, tenantId: string): Promise<WatchlistPayload> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientWatchlist.findFirst({ where: { clientId } }),
    );
    // Never configured → default-select the issue area derived from the client's
    // sector (auto-carryover), so a DEFENSE client starts with "Defense" selected
    // for both display and recommendation matching. Once the user saves, their
    // explicit selection governs (no row → defaults; row exists → exact).
    if (!row) {
      const client = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({ where: { id: clientId }, select: { sectorTag: true } }),
      );
      const sectorArea = issueAreaForSector(client?.sectorTag);
      return { issueAreas: sectorArea ? [sectorArea] : [], tags: [] };
    }
    const tagsRaw = Array.isArray(row.tags) ? (row.tags as unknown[]) : [];
    const tags = tagsRaw
      .map((t) => this.normalizeTag((t ?? {}) as Partial<WatchlistTag>))
      .filter((t): t is WatchlistTag => t != null);
    // Remap any legacy issue-area labels to canonical ones (dedup) so renamed
    // taxonomy entries aren't dropped by the canonical-only filter on save.
    const issueAreas = Array.isArray(row.issueAreas)
      ? Array.from(
          new Set(row.issueAreas.map(normalizeIssueArea).filter((a): a is string => a != null)),
        )
      : [];
    return { issueAreas, tags };
  }

  async putWatchlist(
    clientId: string,
    tenantId: string,
    userId: string,
    payload: WatchlistPayload,
  ): Promise<WatchlistPayload> {
    await this.assertClient(clientId, tenantId);
    const issueAreas = Array.isArray(payload.issueAreas)
      ? Array.from(
          new Set(payload.issueAreas.map(normalizeIssueArea).filter((a): a is string => a != null)),
        )
      : [];
    const tags = (Array.isArray(payload.tags) ? payload.tags : [])
      .map((t) => this.normalizeTag(t))
      .filter((t): t is WatchlistTag => t != null);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientWatchlist.upsert({
        where: { clientId },
        update: { issueAreas, tags: tags as unknown as object, updatedBy: userId },
        create: {
          tenantId,
          clientId,
          issueAreas,
          tags: tags as unknown as object,
          updatedBy: userId,
        },
      }),
    );
    return { issueAreas, tags };
  }

  /**
   * Suggestions to seed an empty (or partial) watchlist FROM the client profile:
   * the client's capability tags become watchlist tag rows (Med / Monitor), and
   * the client's sector (+ each capability's sector) maps to issue areas. Already-
   * present tags / issue areas are excluded so re-importing is a no-op. The
   * caller (Configure "Import from profile") merges these into the form and saves.
   */
  async getSeedSuggestions(
    clientId: string,
    tenantId: string,
  ): Promise<{ tags: WatchlistTag[]; issueAreas: string[] }> {
    const existing = await this.getWatchlist(clientId, tenantId);
    const existingTagNames = new Set(existing.tags.map((t) => t.tag.toLowerCase()));
    const existingAreas = new Set(existing.issueAreas);

    const [client, caps] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.client.findFirst({ where: { id: clientId }, select: { sectorTag: true } }),
        tx.clientCapability.findMany({ where: { clientId }, select: { tags: true, sector: true } }),
      ]),
    );

    // Capability tags → watchlist tag rows (distinct, not already tracked).
    const seen = new Set<string>();
    const tags: WatchlistTag[] = [];
    for (const cap of caps) {
      const capTags = Array.isArray(cap.tags)
        ? (cap.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      for (const raw of capTags) {
        const tag = raw.trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key) || existingTagNames.has(key)) continue;
        seen.add(key);
        tags.push({
          tag,
          issueArea: null,
          synonyms: [],
          relatedEntities: [],
          riskTerms: [],
          position: 'monitor',
          priority: 'med',
        });
      }
    }

    // Client sector + capability sectors → issue areas (not already selected).
    const areaSet = new Set<string>();
    const clientArea = issueAreaForSector(client?.sectorTag);
    if (clientArea && !existingAreas.has(clientArea)) areaSet.add(clientArea);
    for (const cap of caps) {
      const a = issueAreaForSector(cap.sector);
      if (a && !existingAreas.has(a)) areaSet.add(a);
    }

    return { tags, issueAreas: [...areaSet] };
  }

  // ── Alert preferences ────────────────────────────────────────────────────

  async getAlertPrefs(
    clientId: string,
    tenantId: string,
    userId: string,
  ): Promise<AlertPrefsPayload> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.alertPreference.findFirst({ where: { userId, clientId } }),
    );
    if (!row) {
      return {
        triggers: [...DEFAULT_TRIGGERS],
        materiality: 'medium',
        emailEnabled: false,
        emailAddress: null,
        emailCadence: 'realtime',
        smsEnabled: false,
        smsPhone: null,
        smsPhoneVerified: false,
        smsCadence: 'realtime',
        quietHoursStart: null,
        quietHoursEnd: null,
      };
    }
    return {
      triggers: row.triggers,
      materiality: row.materiality as AlertPrefsPayload['materiality'],
      emailEnabled: row.emailEnabled,
      emailAddress: row.emailAddress,
      emailCadence: row.emailCadence as AlertPrefsPayload['emailCadence'],
      smsEnabled: row.smsEnabled,
      smsPhone: row.smsPhone,
      smsPhoneVerified: row.smsPhoneVerified,
      smsCadence: row.smsCadence as AlertPrefsPayload['smsCadence'],
      quietHoursStart: row.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd,
    };
  }

  async putAlertPrefs(
    clientId: string,
    tenantId: string,
    userId: string,
    payload: AlertPrefsInput,
  ): Promise<AlertPrefsPayload> {
    await this.assertClient(clientId, tenantId);
    // Always store the phone as canonical E.164 — the client may PUT the raw
    // typed value (e.g. "+1 (415) 555-1234") via autosave after verification,
    // which must not clobber the normalized number the delivery path sends to.
    const normalizedPhone = normalizeE164(payload.smsPhone ?? null);
    // SMS can only be enabled with a verified phone AND a valid E.164 number
    // (consent + deliverability gate). A bad number can never be delivery-enabled.
    const smsEnabled = !!payload.smsEnabled && !!payload.smsPhoneVerified && !!normalizedPhone;
    const data = {
      triggers: Array.isArray(payload.triggers) ? payload.triggers : [],
      materiality: payload.materiality ?? 'medium',
      emailEnabled: !!payload.emailEnabled,
      emailAddress: payload.emailAddress?.trim() || null,
      emailCadence: payload.emailCadence ?? 'realtime',
      smsEnabled,
      smsPhone: normalizedPhone,
      smsPhoneVerified: !!payload.smsPhoneVerified && !!normalizedPhone,
      smsCadence: payload.smsCadence ?? 'realtime',
      quietHoursStart: payload.quietHoursStart?.trim() || null,
      quietHoursEnd: payload.quietHoursEnd?.trim() || null,
    };
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.alertPreference.upsert({
        where: { userId_clientId: { userId, clientId } },
        update: data,
        create: { tenantId, clientId, userId, ...data },
      }),
    );
    return this.getAlertPrefs(clientId, tenantId, userId);
  }

  /** Mark a verified phone on the user's pref (called after OTP confirm). */
  async markPhoneVerified(
    clientId: string,
    tenantId: string,
    userId: string,
    phone: string,
  ): Promise<void> {
    await this.assertClient(clientId, tenantId);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.alertPreference.upsert({
        where: { userId_clientId: { userId, clientId } },
        update: { smsPhone: phone, smsPhoneVerified: true, smsEnabled: true },
        create: {
          tenantId,
          clientId,
          userId,
          triggers: [...DEFAULT_TRIGGERS],
          smsPhone: phone,
          smsPhoneVerified: true,
          smsEnabled: true,
        },
      }),
    );
  }

  // ── Board membership (track / untrack) ───────────────────────────────────

  async trackBill(
    clientId: string,
    tenantId: string,
    userId: string,
    billId: string,
    source: 'recommended' | 'manual_search' | 'imported' = 'recommended',
  ): Promise<{ tracked: true }> {
    const trimmed = (billId ?? '').trim();
    if (!trimmed) throw new BadRequestException('billId is required');
    const [exists] = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM congress_bill WHERE id = ${trimmed} LIMIT 1
    `;
    if (!exists) throw new NotFoundException(`Bill ${trimmed} not found`);
    await this.assertClient(clientId, tenantId);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.upsert({
        where: { clientId_billId: { clientId, billId: trimmed } },
        update: { source },
        create: { tenantId, clientId, billId: trimmed, source, createdBy: userId },
      }),
    );
    await this.recordFeedback(clientId, tenantId, userId, trimmed, 'tracked');
    return { tracked: true };
  }

  async untrackBill(
    clientId: string,
    tenantId: string,
    billId: string,
  ): Promise<{ untracked: true }> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.deleteMany({ where: { clientId, billId: (billId ?? '').trim() } }),
    );
    return { untracked: true };
  }

  async recordFeedback(
    clientId: string,
    tenantId: string,
    userId: string | null,
    billId: string,
    signal: string,
  ): Promise<{ ok: true }> {
    const trimmed = (billId ?? '').trim();
    if (!trimmed) throw new BadRequestException('billId is required');
    const allowed = ['tracked', 'dismissed', 'marked_irrelevant', 'opened'];
    if (!allowed.includes(signal)) throw new BadRequestException(`Unknown signal "${signal}"`);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackerFeedback.create({
        data: { tenantId, clientId, userId, billId: trimmed, signal },
      }),
    );
    return { ok: true };
  }

  // ── Board read ───────────────────────────────────────────────────────────

  async getBoard(clientId: string, tenantId: string, userId: string): Promise<BoardResponse> {
    const tracked = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' } }),
    );
    const empty = (): BoardResponse => ({
      columns: BILL_STAGES.map((s) => ({ id: s.id, label: s.label, count: 0, bills: [] })),
      total: 0,
    });
    if (!tracked.length) return empty();

    const billIds = tracked.map((t) => t.billId);
    const bills = await this.fetchBillRows(billIds);
    const billById = new Map(bills.map((b) => [b.id, b]));
    const watchlist = await this.getWatchlist(clientId, tenantId);

    // Latest material change per bill (for the change chip + unread dot).
    const sinceChange = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    const changes = await this.prisma.intelligenceChange.findMany({
      where: {
        source: 'congress_bill',
        detectedAt: { gte: sinceChange },
        relatedClientIds: { has: clientId },
      },
      orderBy: { detectedAt: 'desc' },
      select: { changeType: true, detectedAt: true, data: true },
    });
    const changeByBill = new Map<string, { changeType: string; detectedAt: Date }>();
    for (const c of changes) {
      const bid = (c.data as { bill_id?: string } | null)?.bill_id;
      if (bid && !changeByBill.has(bid)) {
        changeByBill.set(bid, { changeType: c.changeType, detectedAt: c.detectedAt });
      }
    }

    // The user's "opened" feedback marks a bill read.
    const opened = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackerFeedback.findMany({
        where: { clientId, userId, signal: 'opened', billId: { in: billIds } },
        orderBy: { createdAt: 'desc' },
        select: { billId: true, createdAt: true },
      }),
    );
    const openedByBill = new Map<string, Date>();
    for (const o of opened)
      if (!openedByBill.has(o.billId)) openedByBill.set(o.billId, o.createdAt);

    const columns: Record<string, BoardColumn> = {};
    for (const s of BILL_STAGES) columns[s.id] = { id: s.id, label: s.label, count: 0, bills: [] };

    for (const t of tracked) {
      const bill = billById.get(t.billId);
      if (!bill) continue;
      const stage = billStage(bill.latest_action_text);
      const prob = passageProbability({
        latestActionText: bill.latest_action_text,
        title: bill.title,
        latestActionDate: bill.latest_action_date,
      });
      const change = changeByBill.get(t.billId) ?? null;
      const openedAt = openedByBill.get(t.billId);
      const unread = !!change && (!openedAt || openedAt.getTime() < change.detectedAt.getTime());
      const card: BoardBill = {
        billId: t.billId,
        displayNum: humanizeBillId(t.billId),
        title: bill.title,
        stage,
        probability: prob,
        tags: this.matchedTagLabels(bill, watchlist).slice(0, 3),
        isManual: true,
        trackedAt: t.createdAt.toISOString(),
        unread,
        change: change
          ? {
              tone: TONE_FOR_CHANGE[change.changeType] ?? 'info',
              label: this.changeChipLabel(change.changeType, change.detectedAt),
              dot: unread,
            }
          : null,
      };
      const col = columns[stage];
      if (!col) continue;
      col.bills.push(card);
      col.count += 1;
    }
    for (const s of BILL_STAGES) {
      const col = columns[s.id];
      if (col) col.bills.sort((a, b) => b.probability - a.probability);
    }
    return {
      columns: BILL_STAGES.map((s) => columns[s.id]).filter((c): c is BoardColumn => !!c),
      total: tracked.length,
    };
  }

  async getSummary(
    clientId: string,
    tenantId: string,
    userId: string,
  ): Promise<{ boardCount: number; unread: number }> {
    const board = await this.getBoard(clientId, tenantId, userId);
    const unread = board.columns.reduce((n, c) => n + c.bills.filter((b) => b.unread).length, 0);
    return { boardCount: board.total, unread };
  }

  // ── Recommendations ──────────────────────────────────────────────────────

  async getRecommendations(clientId: string, tenantId: string): Promise<RecommendationsResponse> {
    const watchlist = await this.getWatchlist(clientId, tenantId);
    const terms = await this.intelligence.getClientRelevanceTerms(clientId, tenantId);

    // Watchlist-derived terms tune the matcher on top of LDA/capability signal.
    const tagTermSets = watchlist.tags.map((t) => ({
      tag: t,
      terms: Array.from(
        new Set(
          [t.tag, ...t.synonyms, ...t.relatedEntities, ...t.riskTerms]
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ),
    }));
    const watchlistKeywordTerms = tagTermSets.flatMap((x) => x.terms);
    const embeddingParts = Array.from(
      new Set([...terms.embeddingPartsClean, ...watchlistKeywordTerms, ...watchlist.issueAreas]),
    );
    const keywordTerms = Array.from(
      new Set([...terms.keywordTermsExpanded, ...watchlistKeywordTerms, ...watchlist.issueAreas]),
    );

    if (!embeddingParts.length && !keywordTerms.length) {
      return { recommendations: [], aboveFloorCount: 0, total: 0, floor: RECOMMENDATION_FLOOR };
    }

    // Exclusions: already on the board, or dismissed.
    const [trackedRows, dismissedRows] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.trackedBill.findMany({ where: { clientId }, select: { billId: true } }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.trackerFeedback.findMany({
          where: { clientId, signal: { in: ['dismissed', 'marked_irrelevant'] } },
          select: { billId: true },
        }),
      ),
    ]);
    const excluded = new Set<string>([
      ...trackedRows.map((r) => r.billId),
      ...dismissedRows.map((r) => r.billId),
    ]);

    // Candidate universe: scored semantic matches ∪ keyword matches, scoped to
    // the current Congress (prior-Congress bills are dead → never recommend them).
    const congress = currentCongress();
    const semanticScores = await this.semanticScores(embeddingParts, congress);
    const keywordIds = await this.keywordCandidateIds(keywordTerms, congress);
    const candidateIds = Array.from(new Set([...semanticScores.keys(), ...keywordIds])).filter(
      (id) => !excluded.has(id),
    );
    if (!candidateIds.length) {
      return { recommendations: [], aboveFloorCount: 0, total: 0, floor: RECOMMENDATION_FLOOR };
    }
    const bills = await this.fetchBillRows(candidateIds);

    // Bills the broad keyword matcher hit (LDA issue names + capabilities +
    // watchlist + issue areas) — a real relevance signal even with no watchlist.
    const keywordIdSet = new Set(keywordIds);
    const recs: RecommendationBill[] = bills.map((bill) => {
      const hay = haystack(bill);
      const semantic = semanticScores.get(bill.id) ?? 0;

      // Which watchlist tags / issue areas hit, and how.
      const matchedTags: string[] = [];
      const reasons: MatchReason[] = [];
      let exactEntity = false;
      let textMatch = false;
      let subjectMatch = false;
      let priorityBoost = 0;
      let topTagLabel: string | null = null;

      for (const { tag, terms: tagTerms } of tagTermSets) {
        const hit = tagTerms.find((tt) => wholeWordHit(hay, tt));
        if (hit) {
          matchedTags.push(tag.tag);
          textMatch = true;
          // Compute entity-ness PER tag — using the accumulated flag would
          // mislabel a later synonym-only match as 'entity'.
          const isEntity = [tag.tag, ...tag.relatedEntities].some((tt) => wholeWordHit(hay, tt));
          if (isEntity) exactEntity = true;
          if (tag.priority === 'high') priorityBoost = 1;
          if (!topTagLabel) topTagLabel = tag.tag;
          reasons.push({
            kind: isEntity ? 'entity' : 'keyword',
            detail: `Matches your watchlist term “${hit}”.`,
          });
        }
      }
      for (const area of watchlist.issueAreas) {
        const areaTokens = area
          .toLowerCase()
          .split(/[^a-z]+/)
          .filter((w) => w.length >= MIN_TERM_LEN && w !== 'and');
        if (areaTokens.some((tok) => wholeWordHit(hay, tok))) {
          matchedTags.push(area);
          subjectMatch = true;
          if (!topTagLabel) topTagLabel = area;
          reasons.push({ kind: 'issue_code', detail: `In your issue area “${area}”.` });
        }
      }
      // Credit a broad keyword/subject match (the client's LDA issue codes or
      // capability terms) even when no watchlist tag was authored.
      if (keywordIdSet.has(bill.id)) {
        if (!textMatch) {
          textMatch = true;
          reasons.push({
            kind: 'keyword',
            detail: 'Matches this client’s tracked issue areas or capabilities.',
          });
        }
      }
      if (semantic > 0) {
        reasons.push({
          kind: 'semantic',
          detail: topTagLabel
            ? `Semantic match to your watchlist (≈ “${topTagLabel}”).`
            : 'Semantically similar to this client’s tracked topics.',
        });
      }

      // Composite relevance. Weighted so the POPULATED signal (semantic +
      // LDA/capability keyword + sector issue area) can clear the floor on its
      // own — a watchlist sharpens to high scores but isn't required. (The
      // original watchlist-centric weighting left every non-watchlist client
      // below the floor, i.e. zero recommendations.)
      const fit = Math.max(
        0,
        Math.min(
          1,
          0.4 * semantic +
            0.3 * (textMatch ? 1 : 0) +
            0.15 * (exactEntity ? 1 : 0) +
            0.1 * (subjectMatch ? 1 : 0) +
            0.05 * priorityBoost,
        ),
      );

      // Primary "why" = highest-signal reason.
      const order: MatchReasonKind[] = ['entity', 'keyword', 'issue_code', 'semantic'];
      const primary =
        reasons.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0] ??
        ({
          kind: 'semantic',
          detail: 'Semantically related to this client’s topics.',
        } as MatchReason);

      return {
        billId: bill.id,
        displayNum: humanizeBillId(bill.id),
        title: bill.title,
        stage: billStage(bill.latest_action_text),
        probability: passageProbability({
          latestActionText: bill.latest_action_text,
          title: bill.title,
          latestActionDate: bill.latest_action_date,
        }),
        fit,
        belowFloor: fit < RECOMMENDATION_FLOOR,
        matchedTags: Array.from(new Set(matchedTags)).slice(0, 4),
        matchReasons: reasons.slice(0, 3),
        whyKind: primary.kind,
        why: primary.detail,
        latestAction: bill.latest_action_text,
        latestActionDate: bill.latest_action_date
          ? bill.latest_action_date.toISOString().slice(0, 10)
          : null,
        sponsorName: bill.sponsor_name,
        sponsorParty: bill.sponsor_party,
        cosponsorsCount: bill.cosponsors_count ?? 0,
      };
    });

    // Drop pure-noise (no signal at all) then sort by fit desc, prob desc.
    const filtered = recs.filter((r) => r.fit > 0);
    filtered.sort((a, b) => b.fit - a.fit || b.probability - a.probability);
    const aboveFloorCount = filtered.filter((r) => !r.belowFloor).length;
    return {
      recommendations: filtered,
      aboveFloorCount,
      total: filtered.length,
      floor: RECOMMENDATION_FLOOR,
    };
  }

  // ── Bill search (Add-bill modal) ─────────────────────────────────────────

  async searchBills(q: string): Promise<BillSearchResult[]> {
    const query = (q ?? '').trim();
    if (query.length < 2) return [];
    const like = `%${query.toLowerCase()}%`;
    // Bill-number tokens: "H.R. 4455" → "hr-4455" so we can match the id form.
    const idToken = `%${query
      .toLowerCase()
      .replace(/[.\s]+/g, '')
      .replace(/^([a-z]+)(\d)/, '$1-$2')}%`;
    const rows = await this.fetchBillRowsRaw(
      `WHERE cb.congress = $3 AND (LOWER(cb.title) LIKE $1 OR LOWER(cb.id) LIKE $2)
       ORDER BY cb.latest_action_date DESC NULLS LAST
       LIMIT 20`,
      [like, idToken, currentCongress()],
    );
    return rows.map((b) => ({
      billId: b.id,
      displayNum: humanizeBillId(b.id),
      title: b.title,
      stage: billStage(b.latest_action_text),
      probability: passageProbability({
        latestActionText: b.latest_action_text,
        title: b.title,
        latestActionDate: b.latest_action_date,
      }),
    }));
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async assertClient(clientId: string, tenantId: string): Promise<void> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);
  }

  private changeChipLabel(changeType: string, detectedAt: Date): string {
    const days = Math.max(0, Math.round((Date.now() - detectedAt.getTime()) / 86_400_000));
    const base: Record<string, string> = {
      bill_enacted: 'Became law',
      bill_to_president: 'Sent to President',
      bill_failed: 'Failed',
      bill_passed_chamber: 'Passed chamber',
      bill_floor_scheduled: 'Floor scheduled',
      bill_reported: 'Passed committee',
      bill_markup: 'Markup',
      bill_hearing: 'Hearing',
      bill_amendment: 'Amended',
    };
    const label = base[changeType] ?? 'Updated';
    if (changeType === 'bill_amendment')
      return days <= 1 ? `${label} ${days === 0 ? 'today' : '1d ago'}` : `${label} ${days}d ago`;
    return label;
  }

  /** Watchlist tags + issue areas that match a bill (for board card chips). */
  private matchedTagLabels(bill: BillRow, watchlist: WatchlistPayload): string[] {
    const hay = haystack(bill);
    const out: string[] = [];
    for (const tag of watchlist.tags) {
      const terms = [tag.tag, ...tag.synonyms, ...tag.relatedEntities];
      if (terms.some((t) => wholeWordHit(hay, t))) out.push(tag.tag);
    }
    for (const area of watchlist.issueAreas) {
      const toks = area
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length >= MIN_TERM_LEN && w !== 'and');
      if (toks.some((t) => wholeWordHit(hay, t))) out.push(area);
    }
    return Array.from(new Set(out));
  }

  /** Scored semantic candidates (current Congress only): billId → cosine similarity (0..1). */
  private async semanticScores(parts: string[], congress: number): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const query = normalize(parts.join('. '));
    if (query.length < 10) return out;
    try {
      const vector = await embedText(query);
      const vec = vectorLiteral(vector);
      // Over-fetch (the global bill embeddings span every synced Congress) so the
      // current-Congress post-filter still leaves a full candidate set.
      const rows = await this.prisma.$queryRawUnsafe<Array<{ source_id: string; score: number }>>(
        `SELECT ce.source_id, (1 - (ce.embedding <=> $1::vector))::float8 AS score
           FROM context_embeddings ce
          WHERE ce.source_type = 'bill'
            AND ce.model = $2
            AND ce.embedding IS NOT NULL
            AND (1 - (ce.embedding <=> $1::vector)) >= $3
          ORDER BY ce.embedding <=> $1::vector
          LIMIT 400`,
        vec,
        EMBEDDING_MODEL,
        EMBED_CANDIDATE_FLOOR,
      );
      for (const r of rows) {
        const id = (r.source_id ?? '').trim();
        // Prior-Congress bills are dead — drop them from recommendations.
        if (id && congressFromBillId(id) === congress && !out.has(id)) {
          out.set(id, Math.max(0, Math.min(1, r.score)));
        }
      }
    } catch (e) {
      this.logger.warn(`Recommendations embeddings lookup failed: ${(e as Error).message}`);
    }
    return out;
  }

  /** Keyword/subject candidate bill ids, scoped to the current Congress. */
  private async keywordCandidateIds(terms: string[], congress: number): Promise<string[]> {
    const lower = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= MIN_TERM_LEN);
    if (!lower.length) return [];
    const patterns = lower.map((n) => `\\m${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT cb.id
      FROM congress_bill cb
      LEFT JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id
      WHERE cb.congress = ${congress}
        AND (
             LOWER(cbs.name) = ANY(${lower}::text[])
          OR LOWER(cbs.name) ~ ANY(${patterns}::text[])
          OR LOWER(cb.policy_area) = ANY(${lower}::text[])
          OR LOWER(cb.title) ~ ANY(${patterns}::text[])
        )
      LIMIT 300
    `;
    return rows.map((r) => r.id);
  }

  private async fetchBillRows(ids: string[]): Promise<BillRow[]> {
    if (!ids.length) return [];
    return this.prisma.$queryRaw<BillRow[]>`
      SELECT cb.id, cb.title, cb.latest_action_text, cb.latest_action_date,
             cb.subjects, cb.policy_area, cb.sponsor_name, cb.sponsor_party,
             cb.cosponsors_count
      FROM congress_bill cb
      WHERE cb.id = ANY(${ids}::text[])
    `;
  }

  private async fetchBillRowsRaw(whereOrderLimit: string, params: unknown[]): Promise<BillRow[]> {
    return this.prisma.$queryRawUnsafe<BillRow[]>(
      `SELECT cb.id, cb.title, cb.latest_action_text, cb.latest_action_date,
              cb.subjects, cb.policy_area, cb.sponsor_name, cb.sponsor_party,
              cb.cosponsors_count
       FROM congress_bill cb
       ${whereOrderLimit}`,
      ...params,
    );
  }
}
