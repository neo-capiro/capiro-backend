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
  /**
   * P0-06: the client's stance on this topic ('support'|'oppose'|'monitor'), carried
   * so the board can label a matched card without a second watchlist read. Optional
   * — `scoreBillFit` itself never reads it.
   */
  position?: string;
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
  /**
   * Gate K (MP-09): the topic ids behind `matchedTags`'s topic entries
   * (never issue areas, which have no topic id — c-4's keyspace split).
   * This is what `recordFeedback` should persist so a topic rename can no
   * longer sever an already-accumulated dismissal signal.
   */
  matchedTopicIds: string[];
  matchReasons: MatchReason[];
  whyKind: MatchReasonKind;
  why: string;
}

/** Gate K (c-5, Neo-confirmed 2026-07-27): raised from 4 now that ids make
 *  each entry cheap — live volume is ~13 topics/31 terms tenant-wide. */
const MATCHED_TAGS_CAP = 10;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

const PRIORITY_RANK: Record<string, number> = { high: 3, med: 2, low: 1 };

/**
 * P0-06: the high-priority subset of a card's `matchedTags`, plus the client's
 * stance on the highest-priority matched topic.
 *
 * Why the SERVER computes this: the web's High-fit filter used to derive the
 * high-priority tag set from the watchlist query, which is `enabled` only while the
 * Configure panel is open — and Configure is a SIBLING Radar tab rendered by a
 * different TrackerSurface instance, so on the Bills surface that query never ran
 * and High-fit deterministically matched nothing.
 *
 * Pure, and derived from the same compiled topics `scoreBillFit` was already given —
 * never a second watchlist read. Entries in `matchedTags` that are issue areas
 * rather than topics simply do not resolve, which is correct: they carry no priority.
 */
export function highPriorityMatches(
  matchedTags: string[],
  topics: CompiledTopicForFit[],
): { matchedHighPriorityTopics: string[]; matchedPosition: string | null } {
  const byLabel = new Map(topics.map((t) => [t.label, t]));
  const matched = matchedTags
    .map((l) => byLabel.get(l))
    .filter((t): t is CompiledTopicForFit => t !== undefined);
  let best: CompiledTopicForFit | null = null;
  for (const t of matched) {
    if (!best || (PRIORITY_RANK[t.priority] ?? 0) > (PRIORITY_RANK[best.priority] ?? 0)) best = t;
  }
  return {
    matchedHighPriorityTopics: matched.filter((t) => t.priority === 'high').map((t) => t.label),
    matchedPosition: best?.position ?? null,
  };
}

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

/** §4.10 (Gate E phase f): per-topic dismissal counts, keyed by topic label. */
export interface TopicFeedback {
  total: number;
  byReason: Record<string, number>;
}
/** Only these two reasons say the MATCH ITSELF over-matches; `already_handled`
 *  etc. say nothing about match quality (f-7 case 6) and must not count. */
const MATCH_QUALITY_REASONS = new Set(['too_broad', 'wrong_issue']);

/**
 * §4.10: 1.0 below 3 qualifying dismissals, 0.75 at 3-5, 0.5 at 6+ — a FLOOR,
 * never zero, so a topic can always recover (f-4/f-7 case 5). Absent
 * feedback (undefined, or no entry for this label) is 1.0 — i.e. identical
 * to today's unweighted behavior.
 */
/**
 * Gate K (MP-09, c-6): look up by topic id FIRST, label second. A rename
 * changes `label` but not `id`, so an id hit is what keeps a topic's
 * accumulated dismissal signal attached to it across a rename; the label
 * fallback is what still serves historical `intel_feedback` rows written
 * before `matched_topic_ids` existed.
 */
function topicWeight(
  feedback: Map<string, TopicFeedback> | undefined,
  label: string,
  id?: string | null,
): number {
  const entry = (id ? feedback?.get(id) : undefined) ?? feedback?.get(label);
  if (!entry) return 1;
  const n = MATCH_QUALITY_REASONS_COUNT(entry);
  if (n >= 6) return 0.5;
  if (n >= 3) return 0.75;
  return 1;
}
function MATCH_QUALITY_REASONS_COUNT(entry: TopicFeedback): number {
  let n = 0;
  for (const reason of MATCH_QUALITY_REASONS) n += entry.byReason[reason] ?? 0;
  return n;
}

export function scoreBillFit(
  bill: RelevanceBill,
  topics: CompiledTopicForFit[],
  issueAreas: string[],
  semantic: number,
  keywordHit: boolean,
  /**
   * §4.10 (Gate E phase f): per-topic dismissal signal (tracker-board.service
   * .feedbackSignal). Absent/empty is BYTE-IDENTICAL to pre-phase-f scoring
   * (f-7 case 4) — every topic's weight defaults to 1.0 either way.
   */
  feedback?: Map<string, TopicFeedback>,
): BillFit {
  const hay = billHaystack(bill);
  const hayOrig = billHaystackOriginal(bill);
  const matchedTags: string[] = [];
  const matchedTopicIds: string[] = [];
  const reasons: MatchReason[] = [];
  // These were plain booleans/0-1 flags before phase f. Now they track the
  // MAX weight among contributing topics — with feedback absent, `topicWeight`
  // always returns 1, so `Math.max(w, 1)` behaves exactly like the old
  // `= true` / `= 1` assignment (never reset, never re-lowered).
  let exactEntityWeight = 0;
  let textMatchWeight = 0;
  let topicTextMatch = false; // mirrors the OLD `textMatch` boolean exactly, for the keywordHit gate below
  let subjectMatch = false;
  let priorityBoostWeight = 0;
  let topTagLabel: string | null = null;

  for (const tp of topics) {
    // P0-04: every typed term now reaches the fit function, routed + weighted
    // by term-routing.ts's matchTerms — not just the four legacy buckets.
    const matches = matchTerms(bill, tp.routableTerms ?? []);
    if (matches.length) {
      matchedTags.push(tp.label);
      if (tp.id) matchedTopicIds.push(tp.id);
      topicTextMatch = true;
      const w = topicWeight(feedback, tp.label, tp.id);
      textMatchWeight = Math.max(textMatchWeight, w);
      // Faithful generalization of the old "label or entity term hit" check:
      // a high-confidence (exact_id) match, or a match whose type is
      // inherently entity-like, counts as an exact entity hit.
      const isEntity = matches.some((m) => m.confidence >= 0.9 || ENTITY_KIND_TYPES.has(m.termType));
      if (isEntity) exactEntityWeight = Math.max(exactEntityWeight, w);
      if (tp.priority === 'high') priorityBoostWeight = Math.max(priorityBoostWeight, w);
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
  if (keywordHit && !topicTextMatch) {
    textMatchWeight = Math.max(textMatchWeight, 1);
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
    0.4 * semantic +
      0.3 * textMatchWeight +
      0.15 * exactEntityWeight +
      0.1 * (subjectMatch ? 1 : 0) +
      0.05 * priorityBoostWeight,
  );
  const order: MatchReasonKind[] = ['entity', 'keyword', 'issue_code', 'semantic'];
  const primary =
    reasons.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0] ??
    ({ kind: 'semantic', detail: "Semantically related to this client's topics." } as MatchReason);

  return {
    fit,
    belowFloor: fit < RECOMMENDATION_FLOOR,
    matchedTags: Array.from(new Set(matchedTags)).slice(0, MATCHED_TAGS_CAP),
    matchedTopicIds: Array.from(new Set(matchedTopicIds)).slice(0, MATCHED_TAGS_CAP),
    matchReasons: reasons.slice(0, 3),
    whyKind: primary.kind,
    why: primary.detail,
  };
}
