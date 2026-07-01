import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { TrackerWatchlistService } from './tracker-watchlist.service.js';
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
/** Change-chip lookback for the board (a tracked bill "changed recently"). */
const RECENT_CHANGE_DAYS = 21;
const DAY_MS = 86_400_000;
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
  ) {}

  private async compiledTopics(
    tenantId: string,
    clientId: string,
  ): Promise<{ topics: CompiledTopicForFit[]; issueAreas: string[]; terms: string[] }> {
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
      for (const v of [...t.keywords, ...t.synonyms, ...t.entities, ...t.riskPhrases]) termSet.add(v);
    }
    for (const a of compiled.issueAreas) termSet.add(a);
    return { topics, issueAreas: compiled.issueAreas, terms: Array.from(termSet) };
  }

  /**
   * Ranked bill recommendations for a client. Union of semantic (Bedrock cosine)
   * + keyword/subject candidates in the current Congress, minus already-tracked
   * and dismissed bills, scored by the composite fit and floored at
   * RECOMMENDATION_FLOOR. Embeddings failure degrades to keyword-only.
   */
  async getRecommendations(tenantId: string, clientId: string, limit = 25): Promise<RecommendationItem[]> {
    const { topics, issueAreas, terms } = await this.compiledTopics(tenantId, clientId);
    if (!terms.length) return [];
    const congress = currentCongress();

    // Semantic candidates (best-effort — keyword path still works if Bedrock is down).
    const semantic = new Map<string, number>();
    try {
      const vec = await embedText(normalize(terms.join('. ')));
      const scores = await this.repo.semanticBillScores(vectorLiteral(vec), EMBEDDING_MODEL, EMBED_CANDIDATE_FLOOR);
      for (const s of scores) {
        if (congressFromBillId(s.sourceId) === congress) semantic.set(s.sourceId, s.score);
      }
    } catch {
      /* embeddings unavailable → keyword-only fallback */
    }

    const keywordIds = new Set(await this.repo.keywordCandidateIds(terms, congress));

    const [tracked, dismissed] = await Promise.all([
      this.prisma.trackedBill.findMany({ where: { tenantId, clientId }, select: { billId: true } }),
      this.prisma.intelFeedback.findMany({
        where: { tenantId, clientId, targetType: 'bill', signal: { in: ['dismissed', 'marked_irrelevant'] } },
        select: { targetRef: true },
      }),
    ]);
    const excluded = new Set<string>([...tracked.map((t) => t.billId), ...dismissed.map((d) => d.targetRef)]);

    const candidateIds = Array.from(new Set<string>([...semantic.keys(), ...keywordIds])).filter(
      (id) => !excluded.has(id),
    );
    if (!candidateIds.length) return [];

    const bills = await this.repo.fetchRecommendationBills(candidateIds);
    const nowMs = Date.now();
    const items: RecommendationItem[] = [];
    for (const b of bills) {
      const fit = scoreBillFit(toRelevanceBill(b), topics, issueAreas, semantic.get(b.id) ?? 0, keywordIds.has(b.id));
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
    items.sort((a, b) => b.fit - a.fit || b.passageProbability - a.passageProbability);
    return items.slice(0, limit);
  }

  /** The curated tracker board: tracked bills bucketed by stage, newest-first per column. */
  async getBoard(tenantId: string, clientId: string): Promise<{ columns: BoardColumn[] }> {
    const empty = () => BILL_STAGES.map((s) => ({ id: s.id, label: s.label, cards: [] as BoardCard[] }));
    const tracked = await this.prisma.trackedBill.findMany({
      where: { tenantId, clientId },
      orderBy: { trackedAt: 'desc' },
    });
    if (!tracked.length) return { columns: empty() };

    const billIds = tracked.map((t) => t.billId);
    const [bills, { topics, issueAreas }, recentAlerts] = await Promise.all([
      this.repo.fetchRecommendationBills(billIds),
      this.compiledTopics(tenantId, clientId),
      this.prisma.intelAlert.findMany({
        where: {
          tenantId,
          clientId,
          sourceType: 'bill',
          sourceRef: { in: billIds },
          createdAt: { gte: new Date(Date.now() - RECENT_CHANGE_DAYS * DAY_MS) },
        },
        orderBy: { createdAt: 'desc' },
        select: { sourceRef: true, changeType: true, title: true, createdAt: true },
      }),
    ]);
    const billById = new Map(bills.map((b) => [b.id, b]));
    const chipByBill = new Map<string, { label: string; changeType: string | null; at: Date }>();
    for (const a of recentAlerts) {
      if (!chipByBill.has(a.sourceRef)) {
        chipByBill.set(a.sourceRef, { label: a.title, changeType: a.changeType, at: a.createdAt });
      }
    }

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
        displayNum: humanizeBillId(t.billId),
        title: bill?.title ?? null,
        stage,
        passageProbability: passageProbability({ latestActionText, title: bill?.title ?? null, latestActionDate, nowMs }),
        latestActionText,
        latestActionDate,
        note: t.note ?? null,
        isManual: t.isManual,
        unread: t.unread,
        trackedAt: t.trackedAt,
        matchedTags,
        changeChip: chipByBill.get(t.billId) ?? null,
      };
      (colById.get(stage) ?? columns[0]!).cards.push(card);
    }
    return { columns };
  }

  /** Track a bill for a client (idempotent upsert). Verifies the bill exists. */
  async trackBill(
    tenantId: string,
    clientId: string,
    userId: string,
    billId: string,
    opts?: { note?: string | null; source?: string; isManual?: boolean },
  ) {
    const bill = await this.repo.getBillById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    const stage = billStage(bill.latestActionText);
    const tb = await this.prisma.trackedBill.upsert({
      where: { clientId_billId: { clientId, billId } },
      create: {
        tenantId,
        clientId,
        billId,
        source: opts?.source ?? 'congress',
        note: opts?.note ?? null,
        isManual: opts?.isManual ?? false,
        trackedBy: userId,
        stage,
        lastSeenActionText: bill.latestActionText,
        lastSeenActionDate: bill.latestActionDate,
        lastSeenAt: new Date(),
      },
      update: opts?.note !== undefined ? { note: opts.note } : {},
    });
    await this.prisma.intelFeedback
      .create({ data: { tenantId, clientId, userId, targetType: 'bill', targetRef: billId, signal: 'tracked' } })
      .catch(() => undefined);
    return tb;
  }

  /** Untrack a bill (pure removal — does NOT suppress future recommendations). */
  async untrackBill(tenantId: string, clientId: string, billId: string) {
    const res = await this.prisma.trackedBill.deleteMany({ where: { tenantId, clientId, billId } });
    return { ok: true, removed: res.count };
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
    await this.prisma.intelFeedback.create({
      data: {
        tenantId,
        clientId,
        userId,
        alertId: input.alertId ?? null,
        targetType: input.targetType ?? 'bill',
        targetRef: input.targetRef,
        signal: input.signal,
      },
    });
    return { ok: true };
  }
}
