import type { TrackerBoardService } from './tracker-board.service.js';
import type { RecommendationItem } from './tracker-board.contracts.js';
import type { RecommendationBillRow } from '../sourcedata/source-data.repository.js';
import type { SourceStateBill } from '../sourcedata/state-source-data.repository.js';
import { humanizeStateBillKey } from '@capiro/shared';
import { embedText, normalize, vectorLiteral, EMBEDDING_MODEL } from '../embeddings/embedder.js';
import { scoreBillFit, type CompiledTopicForFit, type TopicFeedback } from './bill-fit.util.js';
import {
  billStage,
  congressFromBillId,
  currentCongress,
  passageProbability,
} from './bill-stage.util.js';
import { humanizeBillId } from './relevance.util.js';
import { stageLabelOf, toRelevanceBill } from './tracker-board-presentation.js';

export interface TrackerBoardRecommendationPolicy {
  embedFloor(): number;
  stateFloor(): number;
}

export class TrackerBoardRecommendations {
  constructor(private readonly policy: TrackerBoardRecommendationPolicy) {}

  async getRecommendations(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
    limit: number,
  ): Promise<RecommendationItem[]> {
    const { topics, issueAreas, terms, jurisdictions } = await host['compiledTopics'](
      tenantId,
      clientId,
    );
    if (!terms.length) return [];
    const congress = currentCongress();
    // §4.10 (Gate E phase f): per-topic dismissal signal — down-weights a
    // topic the analyst has repeatedly marked too-broad/wrong-issue. Empty
    // for a client with no such dismissals, which scores byte-identically to
    // pre-phase-f (bill-fit.util.ts topicWeight defaults every topic to 1.0).
    const feedback = await host['feedbackSignal'](tenantId, clientId);

    // Semantic candidates (best-effort — keyword path still works if Bedrock is down).
    const semantic = new Map<string, number>();
    try {
      const vec = await embedText(normalize(terms.join('. ')));
      const scores = await host['repo'].semanticBillScores(
        vectorLiteral(vec),
        EMBEDDING_MODEL,
        this.policy.embedFloor(),
      );
      for (const s of scores) {
        if (congressFromBillId(s.sourceId) === congress) semantic.set(s.sourceId, s.score);
      }
    } catch {
      /* embeddings unavailable → keyword-only fallback */
    }

    const keywordIds = new Set(await host['repo'].keywordCandidateIds(terms, congress));

    const [tracked, dismissed] = await this.readCandidateExclusions(host, tenantId, clientId);
    const { excluded, candidateIds } = this.selectUntrackedCandidates(
      tracked,
      dismissed,
      semantic,
      keywordIds,
    );

    const nowMs = Date.now();
    const items: RecommendationItem[] = [];
    if (candidateIds.length) {
      const bills = await host['repo'].fetchRecommendationBills(candidateIds);
      this.appendFederalMatches(
        bills,
        topics,
        issueAreas,
        semantic,
        keywordIds,
        feedback,
        nowMs,
        items,
      );
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
        await host['stateRepo'].stateKeywordCandidateIds(terms, jurisdictions)
      ).filter((id) => !excluded.has(id));
      if (stateCandidateIds.length) {
        const stateBills = await host['stateRepo'].getStateBillsByIds(stateCandidateIds);
        this.appendStateMatches(host, stateBills, topics, issueAreas, feedback, nowMs, items);
      }
    }

    items.sort((a, b) => b.fit - a.fit || b.passageProbability - a.passageProbability);
    return items.slice(0, limit);
  }

  private readCandidateExclusions(host: TrackerBoardService, tenantId: string, clientId: string) {
    return host['prisma'].withTenant(tenantId, (tx) =>
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
  }

  private selectUntrackedCandidates(
    tracked: Array<{ billId: string }>,
    dismissed: Array<{ targetRef: string }>,
    semantic: Map<string, number>,
    keywordIds: Set<string>,
  ) {
    const excluded = new Set<string>([
      ...tracked.map((t) => t.billId),
      ...dismissed.map((d) => d.targetRef),
    ]);

    const candidateIds = Array.from(new Set<string>([...semantic.keys(), ...keywordIds])).filter(
      (id) => !excluded.has(id),
    );

    return { excluded, candidateIds };
  }

  private appendFederalMatches(
    bills: RecommendationBillRow[],
    topics: CompiledTopicForFit[],
    issueAreas: string[],
    semantic: Map<string, number>,
    keywordIds: Set<string>,
    feedback: Map<string, TopicFeedback>,
    nowMs: number,
    items: RecommendationItem[],
  ): void {
    for (const b of bills) {
      const fit = scoreBillFit(
        toRelevanceBill(b),
        topics,
        issueAreas,
        semantic.get(b.id) ?? 0,
        keywordIds.has(b.id),
        feedback,
      );
      if (fit.fit <= 0 || fit.belowFloor) continue;
      const stage = billStage(b.latestActionText, b.status, b.actionTexts);
      items.push({
        billId: b.id,
        displayNum: humanizeBillId(b.id),
        title: b.title,
        stage,
        stageLabel: stageLabelOf(stage),
        passageProbability: passageProbability({
          latestActionText: b.latestActionText,
          status: b.status,
          actionTexts: b.actionTexts,
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
        matchedTopicIds: fit.matchedTopicIds,
        why: fit.why,
        whyKind: fit.whyKind,
        matchReasons: fit.matchReasons,
      });
    }
  }

  private appendStateMatches(
    host: TrackerBoardService,
    stateBills: SourceStateBill[],
    topics: CompiledTopicForFit[],
    issueAreas: string[],
    feedback: Map<string, TopicFeedback>,
    nowMs: number,
    items: RecommendationItem[],
  ): void {
    for (const b of stateBills) {
      const fit = scoreBillFit(
        toRelevanceBill({
          title: b.title,
          policyArea: null,
          subjects: b.subjects,
          latestActionText: b.latestActionText,
          id: b.id,
          sponsorName: b.sponsorName,
        }),
        topics,
        issueAreas,
        0,
        true,
        feedback,
      );
      if (fit.fit < this.policy.stateFloor()) continue;
      const stage = host['stateStatusToBoardStage'](b.status);
      items.push({
        billId: b.id,
        displayNum: humanizeStateBillKey(b.id),
        title: b.title,
        stage,
        // The coarse lane mislabels a terminal state outcome ('enacted'
        // was emitted for a failed bill) — use the canonical status label.
        stageLabel: host['stateStageLabel'](b.status, stage),
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
        matchedTopicIds: fit.matchedTopicIds,
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
