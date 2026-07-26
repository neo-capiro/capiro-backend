/**
 * Pure relevance helpers (Phase 3, plan §6.1) — ported from
 * apps/api/src/tracker/tracker-relevance.util.ts. Whole-word term matching over
 * a bill's searchable text; NO embeddings, NO LLM, so it is safe to run inside
 * the shadow detection cycle for every fired event. Side-effect-free.
 */
import { isAcceptableTerm, isShortExactTerm, MIN_TERM_LEN } from '../watchlist/term-validation.js';
export { MIN_TERM_LEN } from '../watchlist/term-validation.js';

/**
 * Whole-word match. Terms at/above MIN_TERM_LEN match case-INSENSITIVELY against the
 * lower-cased haystack (unchanged behavior). Identifier-shaped SHORT terms (AI, 5G,
 * C2, F-35) match case-SENSITIVELY against the original-case haystack, so "AI" does
 * not fire on the letters "ai" in ordinary prose (P0-05).
 */
export function wholeWordHit(haystackLower: string, term: string, haystackOriginal?: string): boolean {
  const t = (term ?? '').trim();
  if (!isAcceptableTerm(t)) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (isShortExactTerm(t)) {
    // Case-sensitive, original case. Without the original text we cannot honor case,
    // so refuse rather than produce a false positive.
    if (haystackOriginal === undefined) return false;
    return new RegExp(`(?<![A-Za-z0-9])${esc(t)}(?![A-Za-z0-9])`).test(haystackOriginal);
  }
  return new RegExp(`\\b${esc(t.toLowerCase())}\\b`).test(haystackLower);
}

export interface RelevanceBill {
  title: string;
  policyArea?: string | null;
  subjects?: string[] | null;
  latestActionText?: string | null;
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
    if (kHit) {
      matchedTags.push(tag.tag);
      if (eHit) entityHit = entityHit ?? eHit;
      else keywordHit = keywordHit ?? kHit;
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
