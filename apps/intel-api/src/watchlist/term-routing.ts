import { termMatcher, type RelevanceBill } from '../tracker/relevance.util.js';

/** Which field of a bill a term is matched against. */
export type BillField =
  | 'displayNum'
  | 'billId'
  | 'title'
  | 'policyArea'
  | 'subjects'
  | 'latestActionText'
  | 'sponsorName'
  | 'cosponsorNames'
  | 'committees'
  | 'programElements';

export type TermMatchKind = 'exact_id' | 'exact_token' | 'whole_word';

/** The audit's required per-match metadata (P0-04). */
export interface TermMatch {
  termId: string | null;
  topicId: string | null;
  topicLabel: string;
  termType: string;
  matchType: TermMatchKind;
  matchedText: string;
  sourceField: BillField;
  weight: number;
  confidence: number;
  explanation: string;
}

export interface TermRoute {
  /** Fields this type is matched against, in priority order. */
  fields: BillField[];
  kind: TermMatchKind;
  /** Contribution weight; also the hearing-keyterm weight (see §4.9 / phase g). */
  weight: number;
  /** How the match is described to the user. */
  reason: (term: string, field: BillField) => string;
  /** Which downstream surfaces this route feeds — drives the UI preview (b-7). */
  surfaces: Array<'recommendations' | 'alert_relevance' | 'hearing_keyterms' | 'program_element'>;
}

/** The audit's P0-04 matrix, made executable. Do not improvise entries. */
export const TERM_ROUTES: Record<string, TermRoute> = {
  bill: {
    fields: ['displayNum', 'billId', 'title'],
    kind: 'exact_id',
    weight: 5,
    reason: (t) => `Directly names the bill you track ("${t}").`,
    surfaces: ['recommendations', 'alert_relevance'],
  },
  program_element: {
    fields: ['programElements', 'title', 'latestActionText'],
    kind: 'exact_id',
    weight: 5,
    reason: (t) => `Touches Program Element ${t}.`,
    surfaces: ['recommendations', 'alert_relevance', 'program_element'],
  },
  company: {
    fields: ['title', 'latestActionText', 'subjects'],
    kind: 'whole_word',
    weight: 5,
    reason: (t) => `Names ${t} directly.`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  competitor: {
    fields: ['title', 'latestActionText', 'subjects'],
    kind: 'whole_word',
    weight: 4,
    reason: (t) => `Names a competitor (${t}) — competitive-risk exposure.`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  risk_phrase: {
    fields: ['title', 'latestActionText', 'subjects'],
    kind: 'whole_word',
    weight: 4,
    reason: (t) => `Contains risk language you flagged ("${t}").`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  support_language: {
    fields: ['title', 'latestActionText'],
    kind: 'whole_word',
    weight: 4,
    reason: (t) => `Contains language this client supports ("${t}").`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  opposition_language: {
    fields: ['title', 'latestActionText'],
    kind: 'whole_word',
    weight: 4,
    reason: (t) => `Contains language this client opposes ("${t}").`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  agency: {
    fields: ['title', 'latestActionText', 'subjects', 'policyArea'],
    kind: 'whole_word',
    weight: 3,
    reason: (t) => `Involves ${t}.`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  committee: {
    fields: ['committees', 'latestActionText', 'title'],
    kind: 'whole_word',
    weight: 3,
    reason: (t) => `Before ${t}.`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  legislator: {
    fields: ['sponsorName', 'cosponsorNames', 'latestActionText'],
    kind: 'whole_word',
    weight: 3,
    reason: (t) => `Sponsored or advanced by ${t}.`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  topic: {
    fields: ['title', 'policyArea', 'subjects', 'latestActionText'],
    kind: 'whole_word',
    weight: 2,
    reason: (t) => `Matches the topic "${t}".`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  // ── legacy chip types: behavior UNCHANGED, listed so the table is total ──
  entity: {
    fields: ['title', 'latestActionText', 'subjects'],
    kind: 'whole_word',
    weight: 3,
    reason: (t) => `Matches your watchlist term "${t}".`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  synonym: {
    fields: ['title', 'policyArea', 'subjects', 'latestActionText'],
    kind: 'whole_word',
    weight: 2,
    reason: (t) => `Matches your watchlist term "${t}".`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  risk: {
    fields: ['title', 'latestActionText', 'subjects'],
    kind: 'whole_word',
    weight: 4,
    reason: (t) => `Matches your watchlist term "${t}".`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
  keyword: {
    fields: ['title', 'policyArea', 'subjects', 'latestActionText'],
    kind: 'whole_word',
    weight: 2,
    reason: (t) => `Matches your watchlist term "${t}".`,
    surfaces: ['recommendations', 'alert_relevance', 'hearing_keyterms'],
  },
};

/** A term type with no route contributes to hearing keyterms only. */
export function routeFor(termType: string): TermRoute | null {
  return TERM_ROUTES[termType] ?? null;
}

/** termType → the surfaces it affects. Serialized to the web via GET .../compiled. */
export function termSurfaceMap(): Record<string, TermRoute['surfaces']> {
  return Object.fromEntries(Object.entries(TERM_ROUTES).map(([k, v]) => [k, v.surfaces]));
}

/**
 * "H.R. 1234" / "hr1234" / "H R 1234" / "119-hr-1234" → "hr1234". Used for
 * `bill`-typed exact matching so a user can type the designation any way.
 */
export function normalizeIdentifier(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/^\d+-/, '')
    .replace(/[^a-z0-9]/g, '');
}

export interface RoutableTerm {
  id: string | null;
  topicId: string | null;
  topicLabel: string;
  termType: string;
  value: string;
  topicPriority: string;
}

/** Confidence table — hard-coded per b-4 rule 6, never computed. */
function confidenceFor(kind: TermMatchKind, field: BillField): number {
  if (kind === 'exact_id') return 1.0;
  if (field === 'displayNum' || field === 'billId' || field === 'sponsorName' || field === 'programElements') {
    return 0.9;
  }
  if (field === 'title' || field === 'policyArea' || field === 'committees') return 0.75;
  return 0.6; // subjects, latestActionText, cosponsorNames
}

const IDENTIFIER_EQUALITY_FIELDS: ReadonlySet<BillField> = new Set(['displayNum', 'billId', 'programElements']);

/** Raw (un-joined) field value, for identifier-equality fields that may be arrays. */
function rawFieldValue(bill: RelevanceBill, field: BillField): string | string[] | null | undefined {
  return (bill as unknown as Record<BillField, string | string[] | null | undefined>)[field];
}

/** Original-case joined text for a field, for whole-word / bounded-occurrence matching. */
function fieldTextOriginal(bill: RelevanceBill, field: BillField): string | null {
  const raw = rawFieldValue(bill, field);
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) return raw.length ? raw.join('  ') : null;
  return raw.length ? raw : null;
}

/** route.weight × priority multiplier (1.25 high / 0.75 low / 1 med), rounded to 2dp (b-4 rule 7). */
export function weightFor(route: TermRoute, topicPriority: string): number {
  const mult = topicPriority === 'high' ? 1.25 : topicPriority === 'low' ? 0.75 : 1;
  return Math.round(route.weight * mult * 100) / 100;
}

/**
 * §4.9: every hearing keyterm carried weight 1 — `putWatchlist` never wrote the
 * column and `getCompiled` hardcoded 1 — so once the Deepgram cap of 100 was
 * exceeded, selection fell through to the alphabetical tiebreak and a client's
 * highest-priority company name lost to any earlier-alphabet noise term.
 *
 * Weight = the term type's routing weight scaled by the owning topic's priority,
 * i.e. the SAME signal matchTerms uses — deliberately not a second table that could
 * drift from TERM_ROUTES. An unrouted (hearing-native) type falls back to 1, its
 * previous value, so nothing regresses.
 *
 * Yields §4.9's banding: high bill/PE/company 6.25 · high risk/support/opposition 5
 * · med entity/agency/committee/legislator 3 · med topic/synonym/keyword 2 · low
 * broad term 1.5.
 */
export function weightForTerm(termType: string, topicPriority: string): number {
  const route = routeFor(termType);
  if (!route) return 1;
  return weightFor(route, topicPriority);
}

/**
 * Deterministic per-term matching. Pure; no I/O. Returns EVERY match, ordered
 * by weight desc then field order then term value, so output is byte-stable.
 */
export function matchTerms(bill: RelevanceBill, terms: RoutableTerm[]): TermMatch[] {
  const out: TermMatch[] = [];
  // §4.13: memoize each field's joined original + lower-cased text for the whole
  // call. Without this, a 50-term topic re-joined `subjects`/`committees` and
  // re-lower-cased every field once PER TERM — 200 redundant string builds per
  // topic per bill, on the recommendations hot path.
  const fieldText = new Map<BillField, { original: string; lower: string } | null>();
  const textFor = (field: BillField) => {
    const memo = fieldText.get(field);
    if (memo !== undefined) return memo;
    const original = fieldTextOriginal(bill, field);
    const built = original === null ? null : { original, lower: original.toLowerCase() };
    fieldText.set(field, built);
    return built;
  };
  for (const term of terms) {
    // §4.13: resolve the term's validation + compiled pattern ONCE, then reuse it
    // across this route's fields. `null` means the term fails the shape/length
    // policy and can never match — the same outcome isAcceptableTerm gave.
    const matcher = termMatcher(term.value);
    if (!matcher) continue;
    const route = routeFor(term.termType);
    if (!route) continue;

    for (const field of route.fields) {
      let matched = false;

      if (route.kind === 'exact_id' && IDENTIFIER_EQUALITY_FIELDS.has(field)) {
        // Structured identifier field: equality on the normalized form, never substring.
        const needle = normalizeIdentifier(term.value);
        const raw = rawFieldValue(bill, field);
        if (needle && raw != null) {
          const parts = Array.isArray(raw) ? raw : [raw];
          matched = parts.some((v) => normalizeIdentifier(v) === needle);
        }
      } else {
        // Free-text field: bounded (whole-word) occurrence — never substring.
        // Reuses wholeWordHit so identifier-shaped SHORT terms (AI, 5G, C2)
        // keep their case-sensitive, false-positive-safe matching (P0-05).
        const text = textFor(field);
        if (text) {
          matched = matcher.test(text.lower, text.original);
        }
      }

      if (matched) {
        out.push({
          termId: term.id,
          topicId: term.topicId,
          topicLabel: term.topicLabel,
          termType: term.termType,
          matchType: route.kind,
          matchedText: term.value,
          sourceField: field,
          weight: weightFor(route, term.topicPriority),
          confidence: confidenceFor(route.kind, field),
          explanation: route.reason(term.value, field),
        });
        break; // first matching field wins per term (rule 5)
      }
    }
  }

  return out.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    const routeA = routeFor(a.termType);
    const routeB = routeFor(b.termType);
    const idxA = routeA ? routeA.fields.indexOf(a.sourceField) : 0;
    const idxB = routeB ? routeB.fields.indexOf(b.sourceField) : 0;
    if (idxA !== idxB) return idxA - idxB;
    return a.matchedText.localeCompare(b.matchedText);
  });
}
