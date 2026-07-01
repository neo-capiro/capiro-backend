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
export const MIN_TERM_LEN = 3;
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
}
export interface CompiledWatchlist {
  issueAreas: string[];
  billMatchSet: CompiledBillTopic[];
  hearingTerms: Array<{ value: string; weight: number }>;
  deepgramKeyterms: string[];
}

/** Trim, drop < MIN_TERM_LEN, case-insensitive de-dupe, lexical sort. */
function dedupeClean(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = (raw ?? '').trim();
    if (v.length < MIN_TERM_LEN) continue;
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
      };
    });

  // Hearing terms: every term (topic-scoped or global) with len ≥ MIN_TERM_LEN.
  const hearingTerms = input.terms
    .map((t) => ({ value: t.value.trim(), weight: t.weight }))
    .filter((t) => t.value.length >= MIN_TERM_LEN);

  // Deepgram keyterms: lower-cased, de-duped, top-N by weight, then lexical sort
  // for byte-stable output (required for the compiler snapshot test, SC-4).
  const seen = new Set<string>();
  const cand: Array<{ value: string; weight: number }> = [];
  for (const t of hearingTerms) {
    const v = t.value.toLowerCase();
    if (v.length < MIN_TERM_LEN || seen.has(v)) continue;
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
