/**
 * sam-opportunity-matcher.ts — PURE, deterministic SAM.gov opportunity -> program / PE
 * matcher (Step 3.1). No DB, no NestJS, no I/O: the sync script supplies the inputs
 * (the opportunity, the known-PE set, and the program alias universe) and persists
 * the proposed matches. This keeps the accuracy-critical gating logic exhaustively
 * unit-testable, exactly like PeProgramMatcherService / program-match-thresholds.
 *
 * REVIEW GATING (plan §5 entity-resolution discipline; mirrors deriveMatchStatus):
 * an opportunity is matched to a PE / program by one of four bases, each with a fixed
 * default review_status. A fuzzy or coarse path is NEVER auto-accepted.
 *
 *   description_pe_code   the description names a PE code OR procurement BLIN that
 *                         EXISTS in our program_element set
 *                         -> review_status 'accepted'    (verbatim, exact)
 *   program_alias         a program alias trigram-matches the title/description AND the
 *                         office or PSC agrees
 *                         -> review_status 'candidate'   (NEVER accepted)
 *   psc_naics_component   PSC and/or NAICS alone (no alias / PE corroboration)
 *                         -> review_status 'quarantined' (NEVER accepted)
 *
 * The status is derived structurally from the basis (samMatchStatus), so a high
 * trigram score on an alias can never escalate to 'accepted' — only a real PE-code
 * hit can. This is the single hard invariant the spec asserts across the matrix.
 */

export type SamReviewStatus = 'accepted' | 'candidate' | 'quarantined' | 'rejected';

export type SamMatchBasis =
  | 'program_alias'
  | 'office'
  | 'psc_naics_component'
  | 'description_pe_code';

/**
 * The ONLY basis that may carry 'accepted': a verbatim PE-code hit in the description,
 * filtered to PEs that actually exist. Every fuzzy / coarse basis is review-gated.
 */
const ACCEPTED_BASES: ReadonlySet<SamMatchBasis> = new Set<SamMatchBasis>(['description_pe_code']);

/** Coarse-signal bases that are held back as 'quarantined' (never surfaced as-is). */
const QUARANTINED_BASES: ReadonlySet<SamMatchBasis> = new Set<SamMatchBasis>([
  'psc_naics_component',
]);

/**
 * Default review status for a SAM match, derived STRUCTURALLY from its basis.
 * Independent of confidence so a fuzzy/coarse basis can never reach 'accepted'.
 */
export function samMatchStatus(basis: SamMatchBasis): SamReviewStatus {
  if (ACCEPTED_BASES.has(basis)) return 'accepted';
  if (QUARANTINED_BASES.has(basis)) return 'quarantined';
  // 'program_alias' and 'office' are corroborated-but-fuzzy -> review.
  return 'candidate';
}

// Program codes embedded in opportunity text — two shapes, alternated:
//   - RDT&E PE code: 7 digits + a service letter (+ optional trailing alphanumerics)
//   - procurement BLIN: <4-digit appropriation><1-2 letters><line item>, e.g. 1242C93000
// Word-bounded. Mirrors isValidProgramCode (jbook-extract PE_CODE_REGEX |
// PROCUREMENT_CODE_REGEX) and the bill/award extractors, so all text scans agree.
// A shape match is NOT assumed valid — extractKnownPeCodes filters against the known
// program_element set (which carries both code types), so a stray run is dropped.
const PE_IN_TEXT = /\b(?:[0-9]{7}[A-Z][A-Z0-9]*|[0-9]{4}[A-Z]{1,2}[0-9A-Z]{2,14})\b/gi;

/** The opportunity fields the matcher reads (a slice of SamOpportunity). */
export interface OpportunityForMatch {
  /** Title + description are the free-text fields scanned for PE codes / aliases. */
  title: string | null;
  description: string | null;
  /** Contracting office (free text); used for office agreement on alias matches. */
  office: string | null;
  pscCode: string | null;
  naicsCode: string | null;
}

/** One program alias to trigram-match against, with precomputed trigram set. */
export interface AliasForMatch {
  programId: string;
  /** Upper-cased, punctuation-stripped form (normalizeAlias output). */
  aliasNormalized: string;
  aliasType: string;
  /** Precomputed trigram set of aliasNormalized (pg_trgm-compatible). */
  tg: Set<string>;
  /**
   * Optional corroboration tokens for this alias's program: an office name fragment
   * and/or expected PSC codes. When the opportunity's office contains the fragment OR
   * the PSC matches, the alias match is "office/PSC-agreeing" and may be emitted as a
   * candidate. Without agreement the fuzzy alias match is dropped (precision guard).
   */
  officeHint?: string | null;
  pscHints?: ReadonlySet<string>;
}

/** A proposed SAM opportunity match, ready to upsert into sam_opportunity_match. */
export interface ProposedSamMatch {
  programId: string | null;
  peCode: string | null;
  matchBasis: SamMatchBasis;
  confidence: number;
  reviewStatus: SamReviewStatus;
}

// ── trigram helpers (mirror PeProgramMatcherService so the in-memory math agrees
//    with the pg_trgm index / similarity()) ──────────────────────────────────────

/** Upper-case, punctuation-stripped, whitespace-collapsed comparison form. */
export function normalizeText(s: string | null): string {
  return (s ?? '')
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** pg_trgm-compatible trigram set (lower-cased internally; pg_trgm is case-insensitive). */
export function trigrams(s: string | null): Set<string> {
  const str = '  ' + normalizeText(s).toLowerCase() + ' ';
  const g = new Set<string>();
  for (let i = 0; i < str.length - 2; i++) g.add(str.slice(i, i + 3));
  return g;
}

/** Jaccard over trigram sets — matches Postgres similarity(). */
function simSet(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of Array.from(a)) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Extract candidate PE codes from free text, filtered to PEs that actually exist.
 * Verbatim, exact: only a code that is BOTH well-formed AND present in `knownPeCodes`
 * is returned (so a stray 7-digit run that happens to look like a PE is ignored).
 */
export function extractKnownPeCodes(
  text: string | null,
  knownPeCodes: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  const matches = (text ?? '').toUpperCase().match(PE_IN_TEXT);
  if (matches) {
    for (const raw of matches) {
      const code = raw.trim().toUpperCase();
      if (knownPeCodes.has(code)) found.add(code);
    }
  }
  return Array.from(found);
}

export interface MatchOpportunityOptions {
  /** Minimum trigram similarity for a fuzzy alias match (default 0.45). */
  trgmMin?: number;
  /** Minimum normalized alias length — precision guard (default 6). */
  minAliasLen?: number;
}

/**
 * Match ONE opportunity against the known PEs + the program alias universe. Returns
 * the set of proposed matches with their review_status already gated by basis.
 *
 *  1. description PE-code hit  -> { peCode, basis 'description_pe_code', 'accepted' }
 *  2. alias trigram + office/PSC agreement
 *                              -> { programId, basis 'program_alias', 'candidate' }
 *  3. PSC/NAICS alone (no #1/#2)
 *                              -> { basis 'psc_naics_component', 'quarantined' }
 *
 * De-duped: at most one match per (programId, peCode, basis). The PSC/NAICS fallback
 * is only emitted when there is some PSC or NAICS but NO stronger signal fired, so a
 * well-matched opportunity is not also quarantined.
 */
export function matchOpportunity(
  opp: OpportunityForMatch,
  knownPeCodes: ReadonlySet<string>,
  aliasIndex: AliasForMatch[],
  opts: MatchOpportunityOptions = {},
): ProposedSamMatch[] {
  const trgmMin = opts.trgmMin ?? 0.45;
  const minAliasLen = opts.minAliasLen ?? 6;
  const out: ProposedSamMatch[] = [];
  const seen = new Set<string>();
  const push = (m: ProposedSamMatch): void => {
    const key = `${m.programId ?? ''}|${m.peCode ?? ''}|${m.matchBasis}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  const haystack = `${opp.title ?? ''}\n${opp.description ?? ''}`;
  const officeNorm = normalizeText(opp.office);
  const psc = (opp.pscCode ?? '').trim().toUpperCase() || null;
  const naics = (opp.naicsCode ?? '').trim() || null;

  // ── (1) verbatim PE-code hits in the text -> ACCEPTED ───────────────────────
  const peHits = extractKnownPeCodes(haystack, knownPeCodes);
  for (const peCode of peHits) {
    push({
      programId: null,
      peCode,
      matchBasis: 'description_pe_code',
      confidence: 0.95,
      reviewStatus: samMatchStatus('description_pe_code'),
    });
  }

  // ── (2) program-alias trigram match WITH office/PSC agreement -> CANDIDATE ──
  // Best (highest similarity) alias match per program; only emitted when the office
  // or PSC corroborates (a bare title-similarity is too weak to surface).
  const titleTg = trigrams(opp.title);
  const descTg = trigrams(opp.description);
  const bestByProgram = new Map<string, number>();
  for (const a of aliasIndex) {
    if (a.aliasNormalized.length < minAliasLen) continue;
    const sim = Math.max(simSet(titleTg, a.tg), simSet(descTg, a.tg));
    if (sim < trgmMin) continue;

    const officeAgrees =
      !!a.officeHint &&
      officeNorm.includes(normalizeText(a.officeHint)) &&
      normalizeText(a.officeHint).length > 0;
    const pscAgrees = !!psc && !!a.pscHints && a.pscHints.has(psc);
    if (!officeAgrees && !pscAgrees) continue; // precision guard: corroboration required

    const prev = bestByProgram.get(a.programId);
    if (prev === undefined || sim > prev) bestByProgram.set(a.programId, sim);
  }
  for (const [programId, sim] of Array.from(bestByProgram.entries())) {
    // Confidence is capped in the candidate band — an alias path can NEVER reach the
    // 0.90 auto-accept bar, and review_status is structurally 'candidate' regardless.
    const confidence = Number(Math.min(0.88, sim * 0.8 + 0.1).toFixed(3));
    push({
      programId,
      peCode: null,
      matchBasis: 'program_alias',
      confidence,
      reviewStatus: samMatchStatus('program_alias'),
    });
  }

  // ── (3) PSC / NAICS alone (coarse) -> QUARANTINED ───────────────────────────
  // Only when there is a PSC or NAICS but NO stronger signal (PE hit or alias) fired,
  // so a well-matched opportunity is not redundantly quarantined.
  if ((psc || naics) && out.length === 0) {
    push({
      programId: null,
      peCode: null,
      matchBasis: 'psc_naics_component',
      confidence: 0.4,
      reviewStatus: samMatchStatus('psc_naics_component'),
    });
  }

  return out;
}
