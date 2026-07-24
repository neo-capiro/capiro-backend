import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { StateSourceDataRepository } from '../sourcedata/state-source-data.repository.js';
import { TrackerWatchlistService } from './tracker-watchlist.service.js';
import { isStateBillKey, humanizeStateBillKey, stateBillStatusRank } from '@capiro/shared';
import { embedText, normalize, vectorLiteral, EMBEDDING_MODEL } from '../embeddings/embedder.js';
import {
  scoreBillFit,
  type CompiledTopicForFit,
  type MatchReason,
  type MatchReasonKind,
} from './bill-fit.util.js';
import {
  BILL_STAGES,
  billStage,
  congressFromBillId,
  currentCongress,
  passageProbability,
  type BillStage,
} from './bill-stage.util.js';
import { humanizeBillId } from './relevance.util.js';

/**
 * Recommendation feed + tracked-bill curation for the UNIFIED tracker (Phase 3
 * §6.2), ported from apps/api tracker.service.getRecommendations/getBoard/
 * trackBill/untrackBill. The relevance input is the compiled UNIFIED watchlist
 * (Phase 2 WatchlistCompiler) rather than the apps/api IntelligenceService.
 *
 * intel-api has no RLS, so every read/write filters by the TenantGuard-resolved
 * `tenantId` (app-code isolation). Gated by `tracker_owner_intel` at the
 * controller (404 when off) → during shadow only the internal tenant reaches
 * this, and apps/api stays source of truth (D6). Reads GLOBAL bill data
 * read-only via SourceDataRepository; writes only `intel_*`.
 */

/** Candidate floor for the semantic pre-filter (cosine ≥ this to be a candidate). */
export const EMBED_CANDIDATE_FLOOR = 0.3;
/**
 * State-candidate fit floor (DD6, S5.1) — LOWER than the federal
 * RECOMMENDATION_FLOOR (0.45) on purpose: state candidates never carry a
 * semantic component (embed-state-bills ships dark in P0), so scoreBillFit's
 * achievable max for a state bill is 0.60 (textMatch+exactEntity+
 * subjectMatch+priorityBoost), not 1.0 — the federal floor would starve
 * genuine matches. `fit.belowFloor` (computed against the federal floor) is
 * NOT used for state candidates; compare `fit.fit` against this constant
 * directly.
 */
export const LEGIWATCH_STATE_FIT_FLOOR = Number(process.env.LEGIWATCH_STATE_FIT_FLOOR ?? '0.40');
/** Change-chip lookback for the board (a tracked bill "changed recently"). */
const RECENT_CHANGE_DAYS = 21;
const DAY_MS = 86_400_000;

/** Editable Bill 360 client-bill context fields (Release R1, §1.3). All optional. */
export interface UpdateBillContextInput {
  position?: string;
  priority?: string;
  analystNote?: string;
  expectedMilestoneType?: string;
  expectedWindowStart?: string;
  expectedWindowEnd?: string;
  expectedConfidence?: string;
  expectedRationale?: string;
}
/** Feedback signals the API accepts (mirrors the `intel_feedback.signal` doc set). */
const ALLOWED_FEEDBACK_SIGNALS = new Set([
  'useful',
  'not_useful',
  'wrong_impact',
  'wrong_urgency',
  'false_positive',
  'missed',
  'tracked',
  'dismissed',
  'marked_irrelevant',
  'opened',
]);

export interface RecommendationItem {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  stageLabel: string;
  passageProbability: number;
  latestActionText: string | null;
  latestActionDate: Date | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  cosponsorsCount: number | null;
  fit: number;
  matchedTags: string[];
  why: string;
  whyKind: MatchReasonKind;
  matchReasons: MatchReason[];
  /** 'US' | <state code> (State Legislation Platform, S5/S7.2). Absent = 'US' — every pre-Phase-0 caller stays unaffected. */
  jurisdiction?: string;
  /** Official state deep link (a state candidate only) — new-match-detector's billUrl() prefers this over any congress.gov synthesis. */
  stateUrl?: string | null;
  /** LegiScan/OpenStates source link (a state candidate only) — the billUrl() fallback below stateUrl. */
  url?: string | null;
}

/** One Add-bill-modal search hit (P1.1 — exact legacy BillSearchResult shape). */
export interface BillSearchResult {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  probability: number;
}

/**
 * Build the two bound LIKE patterns for bill search (P1.1, ported from
 * apps/api tracker.service.searchBills): a lowercase title substring, plus a
 * bill-id token — "H.R. 4455" → "%hr-4455%" (strip dots/spaces, hyphen between
 * the alpha type and the first digit) so the query matches the id form.
 * Exported for the pure-unit spec.
 */
export function billSearchPatterns(query: string): { titleLike: string; idLike: string } {
  const titleLike = `%${query.toLowerCase()}%`;
  const idLike = `%${query
    .toLowerCase()
    .replace(/[.\s]+/g, '')
    .replace(/^([a-z]+)(\d)/, '$1-$2')}%`;
  return { titleLike, idLike };
}

/**
 * Pure reducer for the client-profile tab-badge summary — legacy-identical
 * `{ boardCount, unread }` (apps/api tracker.service.getSummary). The legacy
 * service derives `unread` per card from change events vs 'opened' feedback;
 * here `intel_tracked_bill.unread` already stores that bit (getBoard's cards
 * read it verbatim), so counting rows matches the board without paying for fit
 * scoring or alert lookups. Exported for the unit spec.
 */
export function summarizeTrackedRows(rows: Array<{ unread: boolean }>): {
  boardCount: number;
  unread: number;
} {
  let unread = 0;
  for (const r of rows) if (r.unread) unread += 1;
  return { boardCount: rows.length, unread };
}

export interface BoardCard {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  passageProbability: number;
  latestActionText: string | null;
  latestActionDate: Date | null;
  note: string | null;
  isManual: boolean;
  unread: boolean;
  trackedAt: Date;
  matchedTags: string[];
  changeChip: { label: string; changeType: string | null; at: Date } | null;
  // Phase 9 (Bill→Hearing interlink): "discussed in N hearings" chip. Presence
  // comes from the trackedBill hearing badge (set by the linker); the count is
  // the number of distinct `combined` alerts for this bill.
  lastHearingSessionId: string | null;
  lastHearingAt: Date | null;
  hearingCount: number;
  /** 'US' | <state code> (State Legislation Platform, S7.2). Absent = 'US'. */
  jurisdiction?: string;
}
export interface BoardColumn {
  id: BillStage;
  label: string;
  cards: BoardCard[];
}

const stageLabelOf = (s: BillStage): string => BILL_STAGES.find((x) => x.id === s)?.label ?? s;

const toRelevanceBill = (b: {
  title: string | null;
  policyArea: string | null;
  subjects: string[] | null;
  latestActionText: string | null;
}) => ({
  title: b.title ?? '',
  policyArea: b.policyArea,
  subjects: b.subjects,
  latestActionText: b.latestActionText,
});

@Injectable()
export class TrackerBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SourceDataRepository,
    private readonly watchlists: TrackerWatchlistService,
    private readonly stateRepo: StateSourceDataRepository,
  ) {}

  /** Bucket a state_bill status rank (0-9) into the board's 4 congress-shaped columns (S4.5 — no status ladder in P0; the drawer shows the real status). */
  private stateStatusToBoardStage(status: string | null): BillStage {
    const rank = stateBillStatusRank(status);
    if (rank >= 9) return 'enacted';
    if (rank >= 3) return 'passed';
    if (rank >= 1) return 'committee';
    return 'introduced';
  }

  /**
   * Batch-fetch bills for a jurisdiction-mixed set of ids, keyed by id — a DD1
   * key routes to StateSourceDataRepository, everything else to the congress
   * SourceDataRepository (S4.4/S7.6: board/recs are jurisdiction-mixed, no
   * separate state tab). ID shape alone disambiguates (congress ids start
   * with 2-3 digits; DD1 keys start with a 2-letter state code) — no need to
   * thread `source` through the caller.
   */
  private async fetchMergedBills(billIds: string[]): Promise<
    Map<
      string,
      {
        title: string | null;
        latestActionText: string | null;
        latestActionDate: Date | null;
        policyArea: string | null;
        subjects: string[] | null;
      }
    >
  > {
    const congressIds = billIds.filter((id) => !isStateBillKey(id));
    const stateIds = billIds.filter((id) => isStateBillKey(id));
    const [congressBills, stateBills] = await Promise.all([
      congressIds.length ? this.repo.fetchRecommendationBills(congressIds) : Promise.resolve([]),
      stateIds.length ? this.stateRepo.getStateBillsByIds(stateIds) : Promise.resolve([]),
    ]);
    const out = new Map<
      string,
      {
        title: string | null;
        latestActionText: string | null;
        latestActionDate: Date | null;
        policyArea: string | null;
        subjects: string[] | null;
      }
    >();
    for (const b of congressBills) out.set(b.id, b);
    for (const b of stateBills) {
      out.set(b.id, {
        title: b.title,
        latestActionText: b.latestActionText,
        latestActionDate: b.latestActionDate,
        policyArea: null,
        subjects: b.subjects,
      });
    }
    return out;
  }

  private displayNumFor(billId: string): string {
    return isStateBillKey(billId) ? humanizeStateBillKey(billId) : humanizeBillId(billId);
  }

  /** 'US' | <state code>, derived from the id shape alone (the DD1 key's leading 2-letter segment). */
  private jurisdictionFor(billId: string): string {
    return isStateBillKey(billId) ? (billId.split('-')[0]?.toUpperCase() ?? 'US') : 'US';
  }

  private async compiledTopics(
    tenantId: string,
    clientId: string,
  ): Promise<{
    topics: CompiledTopicForFit[];
    issueAreas: string[];
    terms: string[];
    jurisdictions: string[];
  }> {
    const compiled = await this.watchlists.getCompiled(tenantId, clientId);
    const topics: CompiledTopicForFit[] = compiled.billMatchSet.map((t) => ({
      label: t.label,
      issueArea: t.issueArea,
      priority: t.priority,
      keywords: t.keywords,
      synonyms: t.synonyms,
      entities: t.entities,
      riskPhrases: t.riskPhrases,
    }));
    const termSet = new Set<string>();
    for (const t of topics) {
      for (const v of [...t.keywords, ...t.synonyms, ...t.entities, ...t.riskPhrases])
        termSet.add(v);
    }
    for (const a of compiled.issueAreas) termSet.add(a);
    return {
      topics,
      issueAreas: compiled.issueAreas,
      terms: Array.from(termSet),
      jurisdictions: compiled.jurisdictions,
    };
  }

  /**
   * Ranked bill recommendations for a client. Union of semantic (Bedrock cosine)
   * + keyword/subject candidates in the current Congress, minus already-tracked
   * and dismissed bills, scored by the composite fit and floored at
   * RECOMMENDATION_FLOOR. Embeddings failure degrades to keyword-only.
   */
  async getRecommendations(
    tenantId: string,
    clientId: string,
    limit = 25,
  ): Promise<RecommendationItem[]> {
    const { topics, issueAreas, terms, jurisdictions } = await this.compiledTopics(
      tenantId,
      clientId,
    );
    if (!terms.length) return [];
    const congress = currentCongress();

    // Semantic candidates (best-effort — keyword path still works if Bedrock is down).
    const semantic = new Map<string, number>();
    try {
      const vec = await embedText(normalize(terms.join('. ')));
      const scores = await this.repo.semanticBillScores(
        vectorLiteral(vec),
        EMBEDDING_MODEL,
        EMBED_CANDIDATE_FLOOR,
      );
      for (const s of scores) {
        if (congressFromBillId(s.sourceId) === congress) semantic.set(s.sourceId, s.score);
      }
    } catch {
      /* embeddings unavailable → keyword-only fallback */
    }

    const keywordIds = new Set(await this.repo.keywordCandidateIds(terms, congress));

    const [tracked, dismissed] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.trackedBill.findMany({ where: { tenantId, clientId }, select: { billId: true } }),
        tx.intelFeedback.findMany({
          where: {
            tenantId,
            clientId,
            targetType: 'bill',
            signal: { in: ['dismissed', 'marked_irrelevant'] },
          },
          select: { targetRef: true },
        }),
      ]),
    );
    const excluded = new Set<string>([
      ...tracked.map((t) => t.billId),
      ...dismissed.map((d) => d.targetRef),
    ]);

    const candidateIds = Array.from(new Set<string>([...semantic.keys(), ...keywordIds])).filter(
      (id) => !excluded.has(id),
    );

    const nowMs = Date.now();
    const items: RecommendationItem[] = [];
    if (candidateIds.length) {
      const bills = await this.repo.fetchRecommendationBills(candidateIds);
      for (const b of bills) {
        const fit = scoreBillFit(
          toRelevanceBill(b),
          topics,
          issueAreas,
          semantic.get(b.id) ?? 0,
          keywordIds.has(b.id),
        );
        if (fit.fit <= 0 || fit.belowFloor) continue;
        const stage = billStage(b.latestActionText);
        items.push({
          billId: b.id,
          displayNum: humanizeBillId(b.id),
          title: b.title,
          stage,
          stageLabel: stageLabelOf(stage),
          passageProbability: passageProbability({
            latestActionText: b.latestActionText,
            title: b.title,
            latestActionDate: b.latestActionDate,
            nowMs,
          }),
          latestActionText: b.latestActionText,
          latestActionDate: b.latestActionDate,
          sponsorName: b.sponsorName,
          sponsorParty: b.sponsorParty,
          cosponsorsCount: b.cosponsorsCount,
          fit: fit.fit,
          matchedTags: fit.matchedTags,
          why: fit.why,
          whyKind: fit.whyKind,
          matchReasons: fit.matchReasons,
        });
      }
    }

    // ── State Legislation Platform (S5.1): a second candidate pass, EXPLICIT
    // opt-in only — runs ONLY when the client's watchlist has jurisdictions
    // configured (never auto-matched from facility geography in P0;
    // suggestedJurisdictions is a hint, not an implicit filter). No semantic
    // component (DD6 — embed-state-bills ships dark), so compare against the
    // LOWER LEGIWATCH_STATE_FIT_FLOOR directly, not fit.belowFloor (the
    // federal floor would starve every state match).
    if (jurisdictions.length) {
      const stateCandidateIds = (
        await this.stateRepo.stateKeywordCandidateIds(terms, jurisdictions)
      ).filter((id) => !excluded.has(id));
      if (stateCandidateIds.length) {
        const stateBills = await this.stateRepo.getStateBillsByIds(stateCandidateIds);
        for (const b of stateBills) {
          const fit = scoreBillFit(
            {
              title: b.title ?? '',
              policyArea: null,
              subjects: b.subjects,
              latestActionText: b.latestActionText,
            },
            topics,
            issueAreas,
            0,
            true,
          );
          if (fit.fit < LEGIWATCH_STATE_FIT_FLOOR) continue;
          const stage = this.stateStatusToBoardStage(b.status);
          items.push({
            billId: b.id,
            displayNum: humanizeStateBillKey(b.id),
            title: b.title,
            stage,
            stageLabel: stageLabelOf(stage),
            passageProbability: passageProbability({
              latestActionText: b.latestActionText,
              title: b.title,
              latestActionDate: b.latestActionDate,
              nowMs,
            }),
            latestActionText: b.latestActionText,
            latestActionDate: b.latestActionDate,
            sponsorName: b.sponsorName,
            sponsorParty: b.sponsorParty,
            cosponsorsCount: null, // state bills carry sponsorCount, not a cosponsor time series (S1.4)
            fit: fit.fit,
            matchedTags: fit.matchedTags,
            why: fit.why,
            whyKind: fit.whyKind,
            matchReasons: fit.matchReasons,
            jurisdiction: b.state,
            stateUrl: b.stateUrl,
            url: b.url,
          });
        }
      }
    }

    items.sort((a, b) => b.fit - a.fit || b.passageProbability - a.passageProbability);
    return items.slice(0, limit);
  }

  /** The curated tracker board: tracked bills bucketed by stage, newest-first per column. */
  async getBoard(tenantId: string, clientId: string): Promise<{ columns: BoardColumn[] }> {
    const empty = () =>
      BILL_STAGES.map((s) => ({ id: s.id, label: s.label, cards: [] as BoardCard[] }));
    const tracked = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findMany({
        where: { tenantId, clientId },
        orderBy: { trackedAt: 'desc' },
      }),
    );
    if (!tracked.length) return { columns: empty() };

    const billIds = tracked.map((t) => t.billId);
    const [bills, { topics, issueAreas }, recentAlerts, hearingLinks] = await Promise.all([
      this.fetchMergedBills(billIds),
      this.compiledTopics(tenantId, clientId),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.findMany({
          where: {
            tenantId,
            clientId,
            sourceType: { in: ['bill', 'state_bill'] },
            sourceRef: { in: billIds },
            createdAt: { gte: new Date(Date.now() - RECENT_CHANGE_DAYS * DAY_MS) },
          },
          orderBy: { createdAt: 'desc' },
          select: { sourceRef: true, changeType: true, title: true, createdAt: true },
        }),
      ),
      // Phase 9: per-bill "discussed in N hearings" count from the linker's
      // `combined` alerts (tenant+client scoped; dismissed/snoozed excluded).
      this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.groupBy({
          by: ['sourceRef'],
          where: {
            tenantId,
            clientId,
            sourceType: 'combined',
            sourceRef: { in: billIds },
            status: { notIn: ['dismissed', 'snoozed', 'suppressed'] },
          },
          _count: { _all: true },
        }),
      ),
    ]);
    const billById = bills;
    const chipByBill = new Map<string, { label: string; changeType: string | null; at: Date }>();
    for (const a of recentAlerts) {
      if (!chipByBill.has(a.sourceRef)) {
        chipByBill.set(a.sourceRef, { label: a.title, changeType: a.changeType, at: a.createdAt });
      }
    }
    const hearingCountByBill = new Map<string, number>();
    for (const g of hearingLinks) hearingCountByBill.set(g.sourceRef, g._count._all);

    const nowMs = Date.now();
    const columns = empty();
    const colById = new Map(columns.map((c) => [c.id, c]));
    for (const t of tracked) {
      const bill = billById.get(t.billId) ?? null;
      const latestActionText = bill?.latestActionText ?? t.lastSeenActionText ?? null;
      const latestActionDate = bill?.latestActionDate ?? t.lastSeenActionDate ?? null;
      const stage = (t.stage as BillStage | null) ?? billStage(latestActionText);
      const matchedTags = bill
        ? scoreBillFit(toRelevanceBill(bill), topics, issueAreas, 0, false).matchedTags
        : [];
      const card: BoardCard = {
        billId: t.billId,
        displayNum: this.displayNumFor(t.billId),
        title: bill?.title ?? null,
        stage,
        passageProbability: passageProbability({
          latestActionText,
          title: bill?.title ?? null,
          latestActionDate,
          nowMs,
        }),
        latestActionText,
        latestActionDate,
        note: t.note ?? null,
        isManual: t.isManual,
        unread: t.unread,
        trackedAt: t.trackedAt,
        matchedTags,
        changeChip: chipByBill.get(t.billId) ?? null,
        lastHearingSessionId: t.lastHearingSessionId ?? null,
        lastHearingAt: t.lastHearingAt ?? null,
        hearingCount: hearingCountByBill.get(t.billId) ?? 0,
        jurisdiction: this.jurisdictionFor(t.billId),
      };
      (colById.get(stage) ?? columns[0]!).cards.push(card);
    }
    return { columns };
  }

  /**
   * LegiWatch v2 (L2b): the ALL-CLIENTS board roll-up — every client's tracked
   * bills in the same stage columns, each card labelled with its client (U4 /
   * Gherkin "All-clients board roll-up"). Tenant-scoped: every intel_* read goes
   * through `withTenant` (sets the RLS GUC — same as getBoard), so it returns
   * only this tenant's tracked bills + alerts. Change-chip and hearing
   * counts are keyed per (client, bill) since alerts are per-client; matchedTags
   * (the High-fit filter) use each card's OWN client's compiled watchlist,
   * batch-resolved per distinct client (bounded by client count, no per-row work).
   */
  async getTenantBoard(tenantId: string): Promise<{
    columns: Array<{
      id: BillStage;
      label: string;
      cards: Array<BoardCard & { clientId: string; clientName: string | null }>;
    }>;
  }> {
    type Card = BoardCard & { clientId: string; clientName: string | null };
    const empty = () => BILL_STAGES.map((s) => ({ id: s.id, label: s.label, cards: [] as Card[] }));
    const tracked = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findMany({
        where: { tenantId },
        orderBy: { trackedAt: 'desc' },
      }),
    );
    if (!tracked.length) return { columns: empty() };

    const billIds = Array.from(new Set(tracked.map((t) => t.billId)));
    const clientIds = Array.from(new Set(tracked.map((t) => t.clientId)));
    const [bills, recentAlerts, hearingLinks, clientNames] = await Promise.all([
      this.fetchMergedBills(billIds),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.findMany({
          where: {
            tenantId,
            sourceType: { in: ['bill', 'state_bill'] },
            sourceRef: { in: billIds },
            createdAt: { gte: new Date(Date.now() - RECENT_CHANGE_DAYS * DAY_MS) },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            sourceRef: true,
            clientId: true,
            changeType: true,
            title: true,
            createdAt: true,
          },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.groupBy({
          by: ['sourceRef', 'clientId'],
          where: {
            tenantId,
            sourceType: 'combined',
            sourceRef: { in: billIds },
            status: { notIn: ['dismissed', 'snoozed', 'suppressed'] },
          },
          _count: { _all: true },
        }),
      ),
      this.repo.getClientNames(tenantId, clientIds).catch(() => new Map<string, string>()),
    ]);

    // Per-client compiled watchlist (for matchedTags / the High-fit filter).
    const topicsByClient = new Map<
      string,
      { topics: CompiledTopicForFit[]; issueAreas: string[] }
    >();
    await Promise.all(
      clientIds.map(async (cid) => {
        const { topics, issueAreas } = await this.compiledTopics(tenantId, cid);
        topicsByClient.set(cid, { topics, issueAreas });
      }),
    );

    const billById = bills;
    const ck = (cid: string, bid: string) => `${cid}:${bid}`;
    const chipByCB = new Map<string, { label: string; changeType: string | null; at: Date }>();
    for (const a of recentAlerts) {
      const k = ck(a.clientId, a.sourceRef);
      if (!chipByCB.has(k))
        chipByCB.set(k, { label: a.title, changeType: a.changeType, at: a.createdAt });
    }
    const hearingCountByCB = new Map<string, number>();
    for (const g of hearingLinks) hearingCountByCB.set(ck(g.clientId, g.sourceRef), g._count._all);

    const nowMs = Date.now();
    const columns = empty();
    const colById = new Map(columns.map((c) => [c.id, c]));
    for (const t of tracked) {
      const bill = billById.get(t.billId) ?? null;
      const latestActionText = bill?.latestActionText ?? t.lastSeenActionText ?? null;
      const latestActionDate = bill?.latestActionDate ?? t.lastSeenActionDate ?? null;
      const stage = (t.stage as BillStage | null) ?? billStage(latestActionText);
      const ct = topicsByClient.get(t.clientId);
      const matchedTags =
        bill && ct
          ? scoreBillFit(toRelevanceBill(bill), ct.topics, ct.issueAreas, 0, false).matchedTags
          : [];
      const card: Card = {
        billId: t.billId,
        displayNum: this.displayNumFor(t.billId),
        title: bill?.title ?? null,
        stage,
        passageProbability: passageProbability({
          latestActionText,
          title: bill?.title ?? null,
          latestActionDate,
          nowMs,
        }),
        latestActionText,
        latestActionDate,
        note: t.note ?? null,
        isManual: t.isManual,
        unread: t.unread,
        trackedAt: t.trackedAt,
        matchedTags,
        changeChip: chipByCB.get(ck(t.clientId, t.billId)) ?? null,
        lastHearingSessionId: t.lastHearingSessionId ?? null,
        lastHearingAt: t.lastHearingAt ?? null,
        hearingCount: hearingCountByCB.get(ck(t.clientId, t.billId)) ?? 0,
        jurisdiction: this.jurisdictionFor(t.billId),
        clientId: t.clientId,
        clientName: clientNames.get(t.clientId) ?? null,
      };
      (colById.get(stage) ?? columns[0]!).cards.push(card);
    }
    return { columns };
  }

  /**
   * Lightweight board counts for the client-profile tab badge (Phase 7 —
   * repoints the legacy GET .../tracker/summary badge fetch). One tenant-scoped
   * SELECT of the `unread` bits, reduced by the pure summarizeTrackedRows.
   */
  async getSummary(
    tenantId: string,
    clientId: string,
  ): Promise<{ boardCount: number; unread: number }> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findMany({
        where: { tenantId, clientId },
        select: { unread: true },
      }),
    );
    return summarizeTrackedRows(rows);
  }

  /**
   * Add-bill-modal text search (P1.1, ported from apps/api
   * tracker.service.searchBills). Current Congress only; <2 chars → []. Tenant-
   * independent by design (GLOBAL `congress_bill`; auth is the route guards).
   */
  async searchBills(q: string): Promise<BillSearchResult[]> {
    const query = (q ?? '').trim();
    if (query.length < 2) return [];
    const { titleLike, idLike } = billSearchPatterns(query);
    const rows = await this.repo.searchBillRows(titleLike, idLike, currentCongress());
    return rows.map((b) => ({
      billId: b.id,
      displayNum: humanizeBillId(b.id),
      title: b.title,
      stage: billStage(b.latestActionText),
      probability: passageProbability({
        latestActionText: b.latestActionText,
        title: b.title,
        latestActionDate: b.latestActionDate,
      }),
    }));
  }

  private async trackCongressStage(
    billId: string,
  ): Promise<{ stage: BillStage; latestActionText: string | null; latestActionDate: Date | null }> {
    const bill = await this.repo.getBillById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    return {
      stage: billStage(bill.latestActionText),
      latestActionText: bill.latestActionText,
      latestActionDate: bill.latestActionDate,
    };
  }

  private async trackStateStage(
    billId: string,
  ): Promise<{ stage: BillStage; latestActionText: string | null; latestActionDate: Date | null }> {
    const bill = await this.stateRepo.getStateBillById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    return {
      stage: this.stateStatusToBoardStage(bill.status),
      latestActionText: bill.latestActionText,
      latestActionDate: bill.latestActionDate,
    };
  }

  /** Track a bill for a client (idempotent upsert). Verifies the bill exists. */
  async trackBill(
    tenantId: string,
    clientId: string,
    userId: string,
    billId: string,
    opts?: { note?: string | null; source?: string; isManual?: boolean },
  ) {
    // State Legislation Platform (S4.5): a DD1-shaped id ("tx-2025-hb1234")
    // routes to the state-bill lookup + status-rank stage bucketing instead
    // of the congress path. `opts?.source` is honored when given, but the id
    // shape is the authoritative signal — a caller passing a state key
    // without opts.source='state' still tracks correctly.
    const isState = isStateBillKey(billId) || opts?.source === 'state';
    const stage = isState
      ? await this.trackStateStage(billId)
      : await this.trackCongressStage(billId);
    const tb = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.upsert({
        where: { clientId_billId: { clientId, billId } },
        create: {
          tenantId,
          clientId,
          billId,
          source: isState ? 'state' : (opts?.source ?? 'congress'),
          note: opts?.note ?? null,
          isManual: opts?.isManual ?? false,
          trackedBy: userId,
          stage: stage.stage,
          lastSeenActionText: stage.latestActionText,
          lastSeenActionDate: stage.latestActionDate,
          lastSeenAt: new Date(),
        },
        update: opts?.note !== undefined ? { note: opts.note } : {},
      }),
    );
    await this.prisma
      .withTenant(tenantId, (tx) =>
        tx.intelFeedback.create({
          data: {
            tenantId,
            clientId,
            userId,
            targetType: 'bill',
            targetRef: billId,
            signal: 'tracked',
          },
        }),
      )
      .catch(() => undefined);
    return tb;
  }

  /** Untrack a bill (pure removal — does NOT suppress future recommendations). */
  async untrackBill(tenantId: string, clientId: string, billId: string) {
    const res = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.deleteMany({ where: { tenantId, clientId, billId } }),
    );
    return { ok: true, removed: res.count };
  }

  /**
   * Bill 360 editable client-bill context (Release R1, §1.3). Updates ONLY the
   * new analyst context columns on the client's tracked row for this bill. It
   * deliberately:
   *  - NEVER touches `note` (legacy note is preserved) or the canonical bill
   *    status (that lives on apps/api-owned congress_bill, never written here);
   *  - builds the update `data` from ONLY the fields present in the body, so a
   *    partial PUT can't null unspecified context (mirrors trackBill's guard);
   *  - uses updateMany with the { tenantId, clientId, billId } predicate (NOT
   *    update({ clientId_billId }), whose unique key omits tenantId) — intel-api
   *    has no RLS, so app-code tenant scoping is mandatory. res.count === 0 means
   *    the bill isn't tracked for that client (or wrong tenant) → 404.
   *  - end-before-start expected windows are rejected 400 (§1.3).
   */
  async updateBillContext(
    tenantId: string,
    clientId: string,
    userId: string,
    billId: string,
    input: UpdateBillContextInput,
  ) {
    if (input.expectedWindowStart && input.expectedWindowEnd) {
      if (new Date(input.expectedWindowStart) > new Date(input.expectedWindowEnd)) {
        throw new BadRequestException('EXPECTED_WINDOW_END_BEFORE_START');
      }
    }

    const data: Record<string, unknown> = {};
    if (input.position !== undefined) data['position'] = input.position;
    if (input.priority !== undefined) data['priority'] = input.priority;
    if (input.analystNote !== undefined) data['analystNote'] = input.analystNote;

    let touchedExpected = false;
    if (input.expectedMilestoneType !== undefined) {
      data['expectedMilestoneType'] = input.expectedMilestoneType;
      touchedExpected = true;
    }
    if (input.expectedWindowStart !== undefined) {
      data['expectedWindowStart'] = input.expectedWindowStart
        ? new Date(input.expectedWindowStart)
        : null;
      touchedExpected = true;
    }
    if (input.expectedWindowEnd !== undefined) {
      data['expectedWindowEnd'] = input.expectedWindowEnd
        ? new Date(input.expectedWindowEnd)
        : null;
      touchedExpected = true;
    }
    if (input.expectedConfidence !== undefined) {
      data['expectedConfidence'] = input.expectedConfidence;
      touchedExpected = true;
    }
    if (input.expectedRationale !== undefined) {
      data['expectedRationale'] = input.expectedRationale;
      touchedExpected = true;
    }
    if (touchedExpected) {
      data['expectedUpdatedBy'] = userId;
      data['expectedUpdatedAt'] = new Date();
    }

    const res = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.updateMany({ where: { tenantId, clientId, billId }, data }),
    );
    if (!res.count) {
      throw new NotFoundException('CLIENT_BILL_NOT_TRACKED');
    }

    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findFirst({ where: { tenantId, clientId, billId } }),
    );
    return { ok: true, bill: row };
  }

  /**
   * Record a feedback signal (§Registry-2.4). `signal='dismissed'` /
   * `'marked_irrelevant'` suppress a bill from future recommendation feeds;
   * others are learning signals. Signal is allowlisted so the route can't write
   * arbitrary values into `intel_feedback`.
   */
  async recordFeedback(
    tenantId: string,
    clientId: string,
    userId: string,
    input: { targetType?: string; targetRef: string; signal: string; alertId?: string | null },
  ) {
    if (!ALLOWED_FEEDBACK_SIGNALS.has(input.signal)) {
      throw new BadRequestException(`Unknown feedback signal "${input.signal}"`);
    }
    if (!input.targetRef?.trim()) throw new BadRequestException('targetRef is required');
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelFeedback.create({
        data: {
          tenantId,
          clientId,
          userId,
          alertId: input.alertId ?? null,
          targetType: input.targetType ?? 'bill',
          targetRef: input.targetRef,
          signal: input.signal,
        },
      }),
    );
    return { ok: true };
  }
}
