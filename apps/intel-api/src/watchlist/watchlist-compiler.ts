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

  // Deepgram keyterms: lower-cased, de-duped, top-N by weight, then lexical sort
  // for byte-stable output (required for the compiler snapshot test, SC-4).
  const seen = new Set<string>();
  const cand: Array<{ value: string; weight: number }> = [];
  for (const t of hearingTerms) {
    const v = t.value.toLowerCase();
    if (!isAcceptableTerm(t.value) || seen.has(v)) continue;
    seen.add(v);
    cand.push({ value: v, weight: t.weight });
  }
  cand.sort((a, b) => b.weight - a.weight || a.value.localeCompare(b.value));
  const deepgramKeyterms = cand
    .slice(0, DEEPGRAM_KEYTERM_CAP)
    .map((x) => x.value)
    .sort((a, b) => a.localeCompare(b));

  return { issueAreas: [...input.issueAreas], billMatchSet, hearingTerms, deepgramKeyterms };
}
