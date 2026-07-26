/**
 * WatchlistCompiler (Phase 2, plan §5.3) — pure, no side effects.
 *
 * Compiles the persisted unified watchlist (topics + terms) into the two
 * matching-path outputs plus Deepgram keyterms:
 *  - billMatchSet   → Bill match engine (Phase 3): per-topic keyword/synonym/
 *                     entity/risk buckets + issueAreas + position + priority.
 *  - hearingTerms   → hearing matcher: flat {value, weight} list.
 *  - deepgramKeyterms → DeepgramStreamManager.open() keyterms (F1): deduped,
 *                     lower-cased, capped, byte-stable across runs.
 */
import { isAcceptableTerm } from './term-validation.js';
import { routeFor, weightFor, type RoutableTerm } from './term-routing.js';
export { MIN_TERM_LEN } from './term-validation.js';
export const DEEPGRAM_KEYTERM_CAP = 100;
/**
 * §4.13: hard ceiling on the terms one topic contributes to bill matching.
 *
 * `matchTerms` runs per topic per CANDIDATE bill, and `WatchlistTopicDto` bounds a
 * payload at 200 topics x 500 terms x up to 4 fields — so the unbounded worst case
 * is ~400k bounded-regex scans per bill, multiplied again by the candidate count in
 * getRecommendations. Capping the per-topic contribution by descending weight bounds
 * it at 200 x 100 x 4 and keeps the terms that matter most. Live volume is nowhere
 * near this (13 topics / 31 terms tenant-wide on 2026-07-26), so in practice this
 * never fires — but an unbounded hot loop behind a user-editable form is a cliff,
 * not a hypothetical.
 */
export const ROUTABLE_TERMS_PER_TOPIC_CAP = 100;

export interface CompilerTopic {
  label: string;
  issueArea: string | null;
  position: string;
  priority: string;
}
export interface CompilerTerm {
  termType: string;
  value: string;
  weight: number;
  /** null = watchlist-global (hearing-style flat term); else the owning topic label. */
  topicLabel: string | null;
  /** P0-04 (Gate B phase b): the owning topic's priority, for routableTerms weighting. */
  topicPriority?: string;
  /** P0-04: the persisted term's own id, for per-match attribution (TermMatch.termId). */
  termId?: string | null;
}
export interface CompiledBillTopic {
  label: string;
  issueArea: string | null;
  position: string;
  priority: string;
  keywords: string[];
  synonyms: string[];
  entities: string[];
  riskPhrases: string[];
  /** P0-04: every typed term on this topic, routed and weighted. */
  routableTerms: RoutableTerm[];
}
export interface CompiledWatchlist {
  issueAreas: string[];
  billMatchSet: CompiledBillTopic[];
  hearingTerms: Array<{ value: string; weight: number }>;
  deepgramKeyterms: string[];
  /**
   * §4.13: topics whose `routableTerms` hit ROUTABLE_TERMS_PER_TOPIC_CAP, reported
   * so the CALLER can log it — `compileWatchlist` must stay pure (boundary §2.4.5),
   * and a cap that nobody surfaces reads as full coverage. Empty in every realistic
   * case; non-empty means that topic's lowest-weight terms are not matching bills.
   */
  truncatedTopics: Array<{ label: string; kept: number; dropped: number }>;
}

/** Trim, drop unacceptable-shaped terms, case-insensitive de-dupe, lexical sort. */
export function dedupeClean(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = (raw ?? '').trim();
    if (!isAcceptableTerm(v)) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function compileWatchlist(input: {
  issueAreas: string[];
  topics: CompilerTopic[];
  terms: CompilerTerm[];
}): CompiledWatchlist {
  const byTopic = new Map<string, CompilerTerm[]>();
  for (const t of input.terms) {
    if (!t.topicLabel) continue;
    const arr = byTopic.get(t.topicLabel) ?? [];
    arr.push(t);
    byTopic.set(t.topicLabel, arr);
  }

  const bucket = (terms: CompilerTerm[], type: string) =>
    dedupeClean(terms.filter((x) => x.termType === type).map((x) => x.value));

  const truncatedTopics: Array<{ label: string; kept: number; dropped: number }> = [];
  const billMatchSet: CompiledBillTopic[] = [...input.topics]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((tp) => {
      const terms = byTopic.get(tp.label) ?? [];
      // P0-04: every typed term on this topic, routed + weighted. Includes the
      // legacy synonym/entity/risk types too — TERM_ROUTES has entries for
      // them so the table stays total. Also carries a SYNTHETIC keyword-typed
      // entry for the topic's own label — the `keywords` bucket below has
      // always treated the label as an implicit search term, and scoreBillFit
      // now reads routableTerms exclusively, so without this a label-only
      // topic (no terms configured yet) would silently stop matching anything.
      // Sorted for the compiler's byte-stability requirement (SC-4).
      const labelTerm: RoutableTerm = {
        id: null,
        topicId: null,
        topicLabel: tp.label,
        termType: 'keyword',
        value: tp.label,
        topicPriority: tp.priority,
      };
      const routableTerms: RoutableTerm[] = [
        labelTerm,
        ...terms
          .filter((t) => isAcceptableTerm(t.value) && routeFor(t.termType))
          .map((t) => ({
            id: t.termId ?? null,
            topicId: null,
            topicLabel: tp.label,
            termType: t.termType,
            value: t.value.trim(),
            topicPriority: t.topicPriority ?? tp.priority,
          })),
      ]
        .filter((t) => isAcceptableTerm(t.value))
        .sort(
          (a, b) =>
            weightFor(routeFor(b.termType)!, b.topicPriority) - weightFor(routeFor(a.termType)!, a.topicPriority) ||
            a.termType.localeCompare(b.termType) ||
            a.value.localeCompare(b.value),
        );
      // §4.13: keep the highest-weight ROUTABLE_TERMS_PER_TOPIC_CAP. Already sorted
      // weight-desc above, so the slice keeps what matters most, and the drop is
      // reported rather than silent.
      if (routableTerms.length > ROUTABLE_TERMS_PER_TOPIC_CAP) {
        truncatedTopics.push({
          label: tp.label,
          kept: ROUTABLE_TERMS_PER_TOPIC_CAP,
          dropped: routableTerms.length - ROUTABLE_TERMS_PER_TOPIC_CAP,
        });
        routableTerms.length = ROUTABLE_TERMS_PER_TOPIC_CAP;
      }
      return {
        label: tp.label,
        issueArea: tp.issueArea,
        position: tp.position,
        priority: tp.priority,
        // The topic label is itself the primary keyword (the "tag"), plus any
        // explicit keyword-typed terms.
        keywords: dedupeClean([tp.label, ...terms.filter((x) => x.termType === 'keyword').map((x) => x.value)]),
        synonyms: bucket(terms, 'synonym'),
        entities: bucket(terms, 'entity'),
        riskPhrases: bucket(terms, 'risk'),
        routableTerms,
      };
    });

  // Hearing terms: every term (topic-scoped or global) with len ≥ MIN_TERM_LEN.
  const hearingTerms = input.terms
    .map((t) => ({ value: t.value.trim(), weight: t.weight }))
    .filter((t) => isAcceptableTerm(t.value));

  // Deepgram keyterms: lower-cased, de-duped, selected by weight with a per-topic
  // reservation, then lexical sort for byte-stable output (required for the
  // compiler snapshot test, SC-4).
  //
  // §4.10 CAUTION: keyterms are LOWER-CASED here, which destroys the case signal
  // that makes identifier-shaped short terms (`AI`, `VA`) safe in the BILL matcher
  // (relevance.util wholeWordHit matches those case-sensitively). That is fine for
  // transcription boosting — a spurious boost costs nothing — but do NOT "unify"
  // the two paths by lower-casing the bill matcher too.
  const seen = new Set<string>();
  const cand: Array<{ value: string; weight: number; topicLabel: string }> = [];
  for (const t of input.terms) {
    const raw = t.value.trim();
    if (!isAcceptableTerm(raw)) continue;
    const v = raw.toLowerCase();
    if (seen.has(v)) continue;
    seen.add(v);
    cand.push({ value: v, weight: t.weight, topicLabel: t.topicLabel ?? '' });
  }
  cand.sort((a, b) => b.weight - a.weight || a.value.localeCompare(b.value));
  // §4.9: reserve a per-topic share so one 400-term topic cannot consume the whole
  // cap and starve every other topic. Pass 1 takes each topic's top `perTopic` by
  // weight; pass 2 fills any remaining capacity globally, still by weight. With a
  // single topic `perTopic` IS the cap, so the pre-change behavior is unchanged.
  const topicCount = Math.max(1, new Set(cand.map((t) => t.topicLabel)).size);
  const perTopic = Math.max(1, Math.floor(DEEPGRAM_KEYTERM_CAP / topicCount));
  const picked: typeof cand = [];
  const overflow: typeof cand = [];
  const takenPerTopic = new Map<string, number>();
  for (const t of cand) {
    const n = takenPerTopic.get(t.topicLabel) ?? 0;
    if (n < perTopic && picked.length < DEEPGRAM_KEYTERM_CAP) {
      takenPerTopic.set(t.topicLabel, n + 1);
      picked.push(t);
    } else {
      overflow.push(t);
    }
  }
  for (const t of overflow) {
    if (picked.length >= DEEPGRAM_KEYTERM_CAP) break;
    picked.push(t);
  }
  const deepgramKeyterms = picked.map((x) => x.value).sort((a, b) => a.localeCompare(b));

  return {
    issueAreas: [...input.issueAreas],
    billMatchSet,
    hearingTerms,
    deepgramKeyterms,
    truncatedTopics,
  };
}
