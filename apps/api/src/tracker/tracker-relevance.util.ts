/**
 * Pure, dependency-free relevance helpers shared by the recommendations matcher
 * (TrackerService.getRecommendations) and the alert enricher (the change
 * detector's "why this matters to {client}" line).
 *
 * Whole-word term matching against a bill's searchable text — NO embeddings and
 * NO LLM, so it is cheap and deterministic enough to run inside the alert cron
 * for every fired event. Kept side-effect-free so it is trivially unit-testable.
 */

export const MIN_TERM_LEN = 3;

/** A normalized lower-cased haystack for whole-word term matching. */
export function wholeWordHit(haystackLower: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < MIN_TERM_LEN) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystackLower);
}

/** The minimum bill shape needed to explain a watchlist match. */
export interface RelevanceBill {
  title: string;
  policyArea?: string | null;
  subjects?: string[] | null;
  /** The action text is included so a move like "Amendment re: F-35" matches. */
  latestActionText?: string | null;
}

export function billHaystack(bill: RelevanceBill): string {
  return [bill.title, bill.policyArea ?? '', bill.latestActionText ?? '', ...(bill.subjects ?? [])]
    .join('  ')
    .toLowerCase();
}

/** The minimal watchlist shape (subset of WatchlistPayload) the enricher reads. */
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
  /** Watchlist tags / issue areas this bill hit (for chips), de-duped. */
  matchedTags: string[];
  /** Single highest-signal human reason, or null when nothing matched. */
  why: string | null;
}

/**
 * Deterministic "why this matters to {client}" for an alert. Mirrors the
 * recommendations matcher's reason ordering (entity > keyword > issue area) but
 * drops the semantic/embedding leg, so it is safe to call in the cron path.
 * Returns `why: null` when there is no match (caller omits the line).
 */
export function explainMatch(bill: RelevanceBill, watchlist: WatchlistLike): MatchExplanation {
  const hay = billHaystack(bill);
  const matchedTags: string[] = [];
  let entityHit: string | null = null;
  let keywordHit: string | null = null;

  for (const tag of watchlist.tags ?? []) {
    const entityTerms = [tag.tag, ...(tag.relatedEntities ?? [])];
    const otherTerms = [...(tag.synonyms ?? []), ...(tag.riskTerms ?? [])];
    const eHit = entityTerms.find((t) => wholeWordHit(hay, t));
    const kHit = eHit ?? otherTerms.find((t) => wholeWordHit(hay, t));
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
    if (tokens.some((tok) => wholeWordHit(hay, tok))) {
      matchedTags.push(area);
      areaHit = areaHit ?? area;
    }
  }

  let why: string | null = null;
  if (entityHit) why = `Matches your watchlist term “${entityHit}”.`;
  else if (keywordHit) why = `Matches your watchlist term “${keywordHit}”.`;
  else if (areaHit) why = `In your tracked issue area “${areaHit}”.`;

  return { matchedTags: Array.from(new Set(matchedTags)).slice(0, 4), why };
}
