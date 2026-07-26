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
import { matchTerms, routeFor, type RoutableTerm } from '../watchlist/term-routing.js';

export const RECOMMENDATION_FLOOR = 0.45;

export type MatchReasonKind = 'entity' | 'keyword' | 'issue_code' | 'semantic';
export interface MatchReason {
  kind: MatchReasonKind;
  detail: string;
}
/** One compiled watchlist topic (subset of WatchlistCompiler's CompiledBillTopic). */
export interface CompiledTopicForFit {
  id?: string | null;
  label: string;
  issueArea: string | null;
  priority: string;
  keywords: string[]; // includes the topic label
  synonyms: string[];
  entities: string[];
  riskPhrases: string[];
  /** P0-04: every typed term on this topic, routed and weighted. */
  routableTerms?: RoutableTerm[];
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

/**
 * P0-04: which reason `kind` a matched term type maps to. Kept identical to
 * the pre-routing set ("label or entity term hit" → `entity`, everything
 * else → `keyword`) so MatchReasonKind and the web's whyKind/RecCard
 * rendering are unaffected by widening what can match (b-8).
 */
const ENTITY_KIND_TYPES = new Set([
  'bill',
  'company',
  'competitor',
  'program_element',
  'entity',
  'agency',
  'committee',
  'legislator',
]);

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
    // P0-04: every typed term now reaches the fit function, routed + weighted
    // by term-routing.ts's matchTerms — not just the four legacy buckets.
    const matches = matchTerms(bill, tp.routableTerms ?? []);
    if (matches.length) {
      matchedTags.push(tp.label);
      textMatch = true;
      // Faithful generalization of the old "label or entity term hit" check:
      // a high-confidence (exact_id) match, or a match whose type is
      // inherently entity-like, counts as an exact entity hit.
      const isEntity = matches.some((m) => m.confidence >= 0.9 || ENTITY_KIND_TYPES.has(m.termType));
      if (isEntity) exactEntity = true;
      if (tp.priority === 'high') priorityBoost = 1;
      if (!topTagLabel) topTagLabel = tp.label;
      const primary = matches[0]!; // matchTerms sorts by weight desc — highest-weight match explains the topic
      reasons.push({
        kind: ENTITY_KIND_TYPES.has(primary.termType) ? 'entity' : 'keyword',
        detail: primary.explanation,
      });
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
