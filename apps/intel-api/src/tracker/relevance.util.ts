/**
 * Pure relevance helpers (Phase 3, plan §6.1) — ported from
 * apps/api/src/tracker/tracker-relevance.util.ts. Whole-word term matching over
 * a bill's searchable text; NO embeddings, NO LLM, so it is safe to run inside
 * the shadow detection cycle for every fired event. Side-effect-free.
 */
export const MIN_TERM_LEN = 3;

/** Whole-word (regex-boundary) match of a term against a lower-cased haystack. */
export function wholeWordHit(haystackLower: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < MIN_TERM_LEN) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystackLower);
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
