/**
 * Pure relevance helpers (Phase 3, plan §6.1) — ported from
 * apps/api/src/tracker/tracker-relevance.util.ts. Whole-word term matching over
 * a bill's searchable text; NO embeddings, NO LLM, so it is safe to run inside
 * the shadow detection cycle for every fired event. Side-effect-free.
 */
import { isAcceptableTerm, isShortExactTerm, MIN_TERM_LEN } from '../watchlist/term-validation.js';
export { MIN_TERM_LEN } from '../watchlist/term-validation.js';
import { matchTerms, type RoutableTerm } from '../watchlist/term-routing.js';

/**
 * P0-04: which reason `kind` a matched term type maps to for the alert
 * explainer — identical set to bill-fit.util.ts's ENTITY_KIND_TYPES, kept as
 * a separate literal here (not imported) to avoid a bill-fit.util.ts <->
 * relevance.util.ts import cycle on top of the existing term-routing.ts one.
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

/**
 * Whole-word match. Terms at/above MIN_TERM_LEN match case-INSENSITIVELY against the
 * lower-cased haystack (unchanged behavior). Identifier-shaped SHORT terms (AI, 5G,
 * C2, F-35) match case-SENSITIVELY against the original-case haystack, so "AI" does
 * not fire on the letters "ai" in ordinary prose (P0-05).
 */
export function wholeWordHit(haystackLower: string, term: string, haystackOriginal?: string): boolean {
  const m = termMatcher(term);
  return m ? m.test(haystackLower, haystackOriginal) : false;
}

/** A term resolved to a reusable predicate. See `termMatcher`. */
export interface TermMatcher {
  test(haystackLower: string, haystackOriginal?: string): boolean;
}

/**
 * Resolve a term to a reusable, CACHED matcher (§4.13).
 *
 * P0-04 turned the recommendations loop into `matchTerms` per topic per candidate
 * bill — bounded by 200 topics × 500 terms, each tested against up to 4 fields. Doing
 * the shape/length validation and the RegExp construction inside the per-field loop
 * meant ~4x redundant work per term on the hottest path in the tracker. Both depend
 * only on the term, so they happen once and are cached.
 *
 * Behavior is identical to the previous inline implementation: same patterns, no `/g`
 * (so no `lastIndex` state to leak between calls), and `null` for a term that fails
 * the shape policy — which is why an unacceptable term still yields `false`, not a
 * match. The cache is bounded so a long-lived multi-tenant process cannot grow it
 * without limit; the cap is far above any single tenant's term count.
 */
const TERM_MATCHER_CACHE = new Map<string, TermMatcher | null>();
const TERM_MATCHER_CACHE_MAX = 5000;

export function termMatcher(term: string): TermMatcher | null {
  const t = (term ?? '').trim();
  const hit = TERM_MATCHER_CACHE.get(t);
  if (hit !== undefined) return hit;
  const built = buildTermMatcher(t);
  if (TERM_MATCHER_CACHE.size >= TERM_MATCHER_CACHE_MAX) TERM_MATCHER_CACHE.clear();
  TERM_MATCHER_CACHE.set(t, built);
  return built;
}

function buildTermMatcher(t: string): TermMatcher | null {
  if (!isAcceptableTerm(t)) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (isShortExactTerm(t)) {
    // Case-SENSITIVE against the ORIGINAL-case text, so "AI" does not fire on the
    // letters "ai" in ordinary prose (P0-05). Custom boundaries rather than `\b`:
    // `\b` treats `-` and `.` as boundaries, so `\bF-35\b` is unpredictable and
    // `\bH.R.\b` is outright wrong. Without the original text we cannot honor case,
    // so refuse rather than produce a false positive.
    const re = new RegExp(`(?<![A-Za-z0-9])${esc(t)}(?![A-Za-z0-9])`);
    return { test: (_lower, original) => (original === undefined ? false : re.test(original)) };
  }
  const re = new RegExp(`\\b${esc(t.toLowerCase())}\\b`);
  return { test: (lower) => re.test(lower) };
}

export interface RelevanceBill {
  title: string;
  policyArea?: string | null;
  subjects?: string[] | null;
  latestActionText?: string | null;
  // P0-04 routing targets (Gate B phase b). Optional: a caller that cannot
  // supply one simply yields no match for the routes that need it, rather
  // than a wrong match — see term-routing.ts matchTerms.
  displayNum?: string | null;
  billId?: string | null;
  sponsorName?: string | null;
  cosponsorNames?: string[] | null;
  committees?: string[] | null;
  programElements?: string[] | null;
}

export function billHaystack(bill: RelevanceBill): string {
  return [bill.title, bill.policyArea ?? '', bill.latestActionText ?? '', ...(bill.subjects ?? [])]
    .join('  ')
    .toLowerCase();
}

/** Original-case twin of billHaystack, for case-sensitive short-term matching. */
export function billHaystackOriginal(bill: RelevanceBill): string {
  return [bill.title, bill.policyArea ?? '', bill.latestActionText ?? '', ...(bill.subjects ?? [])].join('  ');
}

/** Watchlist shape the enricher reads (built from the unified intel watchlist). */
export interface WatchlistLike {
  issueAreas: string[];
  tags: {
    tag: string;
    synonyms?: string[];
    relatedEntities?: string[];
    riskTerms?: string[];
    /** P0-04 (Gate B phase b): every OTHER typed term on this topic. */
    typedTerms?: Array<{ termType: string; value: string; id?: string | null }>;
    topicId?: string | null;
    priority?: string;
  }[];
}

export interface MatchExplanation {
  matchedTags: string[];
  why: string | null;
}

/**
 * Deterministic "why this matters to {client}" for an alert. Reason ordering:
 * entity > keyword > issue area. Returns `why: null` when nothing matched.
 */
export function explainMatch(bill: RelevanceBill, watchlist: WatchlistLike): MatchExplanation {
  const hay = billHaystack(bill);
  const hayOrig = billHaystackOriginal(bill);
  const matchedTags: string[] = [];
  let entityHit: string | null = null;
  let keywordHit: string | null = null;

  for (const tag of watchlist.tags ?? []) {
    const entityTerms = [tag.tag, ...(tag.relatedEntities ?? [])];
    const otherTerms = [...(tag.synonyms ?? []), ...(tag.riskTerms ?? [])];
    const eHit = entityTerms.find((t) => wholeWordHit(hay, t, hayOrig));
    const kHit = eHit ?? otherTerms.find((t) => wholeWordHit(hay, t, hayOrig));
    let tagMatched = false;
    if (kHit) {
      tagMatched = true;
      if (eHit) entityHit = entityHit ?? eHit;
      else keywordHit = keywordHit ?? kHit;
    }

    // P0-04: fold in the 11 canonical typed-term routes on top of the legacy
    // synonym/relatedEntity/riskTerm matching above — additive, so a topic
    // with only those three legacy shapes produces byte-identical output.
    if (tag.typedTerms?.length) {
      const routable: RoutableTerm[] = tag.typedTerms.map((t) => ({
        id: t.id ?? null,
        topicId: tag.topicId ?? null,
        topicLabel: tag.tag,
        termType: t.termType,
        value: t.value,
        topicPriority: tag.priority ?? 'med',
      }));
      const typedMatches = matchTerms(bill, routable);
      if (typedMatches.length) {
        tagMatched = true;
        const primary = typedMatches[0]!;
        if (ENTITY_KIND_TYPES.has(primary.termType)) entityHit = entityHit ?? primary.matchedText;
        else keywordHit = keywordHit ?? primary.matchedText;
      }
    }

    if (tagMatched) {
      matchedTags.push(tag.tag);
    }
  }

  let areaHit: string | null = null;
  for (const area of watchlist.issueAreas ?? []) {
    const tokens = area
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= MIN_TERM_LEN && w !== 'and');
    if (tokens.some((tok) => wholeWordHit(hay, tok, hayOrig))) {
      matchedTags.push(area);
      areaHit = areaHit ?? area;
    }
  }

  let why: string | null = null;
  if (entityHit) why = `Matches your watchlist term "${entityHit}".`;
  else if (keywordHit) why = `Matches your watchlist term "${keywordHit}".`;
  else if (areaHit) why = `In your tracked issue area "${areaHit}".`;

  return { matchedTags: Array.from(new Set(matchedTags)).slice(0, 4), why };
}

const BILL_TYPE_LABEL: Record<string, string> = {
  hr: 'H.R.',
  s: 'S.',
  hjres: 'H.J.Res.',
  sjres: 'S.J.Res.',
  hconres: 'H.Con.Res.',
  sconres: 'S.Con.Res.',
  hres: 'H.Res.',
  sres: 'S.Res.',
};

/** "119-hr-1234" → "H.R. 1234". Falls back to the raw id when unparseable. */
export function humanizeBillId(billId: string): string {
  const m = /^(\d+)-([a-z]+)-(\d+)$/i.exec(billId.trim());
  if (!m) return billId;
  const rawType = (m[2] ?? '').toLowerCase();
  const num = m[3] ?? '';
  const type = BILL_TYPE_LABEL[rawType] ?? rawType.toUpperCase();
  return `${type} ${num}`;
}
