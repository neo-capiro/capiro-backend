/**
 * Composite recommendation fit (Phase 3 §6.2 / §6.1) — pure. Ported from
 * apps/api tracker.service.getRecommendations, adapted to score against the
 * UNIFIED compiled watchlist (Phase 2 WatchlistCompiler) instead of the apps/api
 * IntelligenceService LDA/capability terms.
 *
 *   fit = clamp01( 0.40·semantic + 0.30·textMatch + 0.15·exactEntity
 *                + 0.10·subjectMatch + 0.05·priorityBoost )
 */
import { billHaystack, billHaystackOriginal, wholeWordHit, MIN_TERM_LEN, type RelevanceBill } from './relevance.util.js';

export const RECOMMENDATION_FLOOR = 0.45;

export type MatchReasonKind = 'entity' | 'keyword' | 'issue_code' | 'semantic';
export interface MatchReason {
  kind: MatchReasonKind;
  detail: string;
}
/** One compiled watchlist topic (subset of WatchlistCompiler's CompiledBillTopic). */
export interface CompiledTopicForFit {
  label: string;
  issueArea: string | null;
  priority: string;
  keywords: string[]; // includes the topic label
  synonyms: string[];
  entities: string[];
  riskPhrases: string[];
}
export interface BillFit {
  fit: number;
  belowFloor: boolean;
  matchedTags: string[];
  matchReasons: MatchReason[];
  whyKind: MatchReasonKind;
  why: string;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function scoreBillFit(
  bill: RelevanceBill,
  topics: CompiledTopicForFit[],
  issueAreas: string[],
  semantic: number,
  keywordHit: boolean,
): BillFit {
  const hay = billHaystack(bill);
  const hayOrig = billHaystackOriginal(bill);
  const matchedTags: string[] = [];
  const reasons: MatchReason[] = [];
  let exactEntity = false;
  let textMatch = false;
  let subjectMatch = false;
  let priorityBoost = 0;
  let topTagLabel: string | null = null;

  for (const tp of topics) {
    const entityTerms = [...tp.keywords, ...tp.entities]; // label lives in keywords
    const allTerms = [...tp.keywords, ...tp.synonyms, ...tp.entities, ...tp.riskPhrases];
    const hit = allTerms.find((t) => wholeWordHit(hay, t, hayOrig));
    if (hit) {
      matchedTags.push(tp.label);
      textMatch = true;
      const isEntity = entityTerms.some((t) => wholeWordHit(hay, t, hayOrig));
      if (isEntity) exactEntity = true;
      if (tp.priority === 'high') priorityBoost = 1;
      if (!topTagLabel) topTagLabel = tp.label;
      reasons.push({ kind: isEntity ? 'entity' : 'keyword', detail: `Matches your watchlist term "${hit}".` });
    }
  }
  for (const area of issueAreas) {
    const tokens = area.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= MIN_TERM_LEN && w !== 'and');
    if (tokens.some((tok) => wholeWordHit(hay, tok, hayOrig))) {
      matchedTags.push(area);
      subjectMatch = true;
      if (!topTagLabel) topTagLabel = area;
      reasons.push({ kind: 'issue_code', detail: `In your issue area "${area}".` });
    }
  }
  if (keywordHit && !textMatch) {
    textMatch = true;
    reasons.push({ kind: 'keyword', detail: "Matches this client's tracked issue areas." });
  }
  if (semantic > 0) {
    reasons.push({
      kind: 'semantic',
      detail: topTagLabel
        ? `Semantic match to your watchlist (≈ "${topTagLabel}").`
        : "Semantically similar to this client's tracked topics.",
    });
  }

  const fit = clamp01(
    0.4 * semantic + 0.3 * (textMatch ? 1 : 0) + 0.15 * (exactEntity ? 1 : 0) + 0.1 * (subjectMatch ? 1 : 0) + 0.05 * priorityBoost,
  );
  const order: MatchReasonKind[] = ['entity', 'keyword', 'issue_code', 'semantic'];
  const primary =
    reasons.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0] ??
    ({ kind: 'semantic', detail: "Semantically related to this client's topics." } as MatchReason);

  return {
    fit,
    belowFloor: fit < RECOMMENDATION_FLOOR,
    matchedTags: Array.from(new Set(matchedTags)).slice(0, 4),
    matchReasons: reasons.slice(0, 3),
    whyKind: primary.kind,
    why: primary.detail,
  };
}
