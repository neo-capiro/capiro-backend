/**
 * pe-mention-matcher — pure logic for the match-pe-mentions verb (PE Watch
 * auto-update plan, Phase 3; docs/plans/2026-07-06-pe-watch-auto-update-plan.md).
 *
 * Turns hearing-transcript text into PE mention candidates and bill titles into
 * candidate bill ↔ PE links, using a name bank built from three curated
 * sources (program canonical names, capability names/aliases, PE titles).
 * NOTHING here auto-accepts: every hit is a candidate with a tier-derived
 * confidence + render-safe evidence, per the plan's ambiguity rules (§1.3).
 *
 * Everything in this module is deterministic and side-effect free so it can be
 * golden-fixture spec'd; the script (scripts/match-pe-mentions.ts) owns the
 * Prisma wiring (bank loading, dedupe against intelligence_change, upserts).
 */

export type NameBankTier = 'program_name' | 'platform_designator' | 'capability_alias' | 'pe_title';

/** Tier → candidate confidence (plan Phase 3: fuzzy tiers, never 1.0). */
export const TIER_CONFIDENCE: Record<NameBankTier, number> = {
  program_name: 0.9,
  // A bare weapon-system designator ("F-35", "CH-53K") extracted from a PE title
  // is a strong per-PE signal — an unambiguous platform token — but below the
  // curated program_name bar, since it can fan to every PE that funds the platform.
  platform_designator: 0.75,
  capability_alias: 0.7,
  pe_title: 0.55,
};

/**
 * Bill titles only match the strong, low-fan tiers — pe_title is too noisy and
 * capability_alias fans one thematic word to every tagged PE. A designator in a
 * bill title ("F-35 Sustainment Act") is a genuine, specific link, so it joins.
 */
export const BILL_MATCH_TIERS: ReadonlySet<NameBankTier> = new Set<NameBankTier>([
  'program_name',
  'platform_designator',
  'capability_alias',
]);

/** ±chars of context captured around the first hit of a term. */
export const SNIPPET_RADIUS = 180;

/** Aggregated occurrences of a PE in one transcript at/above this → 'notable'. */
export const NOTABLE_MENTION_THRESHOLD = 3;

export interface NameBankEntryInput {
  peCode: string;
  term: string;
  tier: NameBankTier;
}

export interface BankTerm {
  /** Normalized (trimmed, whitespace-collapsed) display form. */
  term: string;
  peCode: string;
  tier: NameBankTier;
  confidence: number;
}

export interface NameBank {
  /** Accepted (term, peCode) pairs. */
  entries: BankTerm[];
  /** Lowercased term → every bank entry sharing that term (1 term can map N PEs). */
  byTermLower: Map<string, BankTerm[]>;
  /** Input rows rejected by the term-quality rules / stoplist. */
  rejectedCount: number;
}

/**
 * Generic phrases that appear in virtually every defense hearing / J-book and
 * carry zero program identity. Compared against the lowercased normalized term.
 * Appropriation/BA boilerplate + chamber/committee/department names.
 */
export const TERM_STOPLIST: ReadonlySet<string> = new Set([
  // appropriation / budget-activity boilerplate
  'research and development',
  'research, development, test and evaluation',
  'research development test and evaluation',
  'test and evaluation',
  'developmental test and evaluation',
  'operational test and evaluation',
  'operation and maintenance',
  'operations and maintenance',
  'national defense',
  'defense-wide',
  'defense wide',
  'management support',
  'program element',
  'program elements',
  'budget activity',
  'basic research',
  'applied research',
  'advanced technology development',
  'advanced component development',
  'advanced component development and prototypes',
  'system development and demonstration',
  'engineering and manufacturing development',
  'operational systems development',
  'software and digital technology pilot programs',
  'science and technology',
  'major range and test facility base',
  'classified programs',
  'undistributed adjustment',
  // chambers / committees
  'house of representatives',
  'united states senate',
  'united states congress',
  'armed services committee',
  'committee on armed services',
  'house armed services committee',
  'senate armed services committee',
  'appropriations committee',
  'committee on appropriations',
  'house appropriations committee',
  'senate appropriations committee',
  'subcommittee on defense',
  'defense subcommittee',
  // department / service boilerplate
  'department of defense',
  'department of the army',
  'department of the navy',
  'department of the air force',
  'office of the secretary of defense',
  'united states army',
  'united states navy',
  'united states air force',
  'united states marine corps',
  'united states space force',
]);

/** Trim + collapse internal whitespace (incl. newlines) to single spaces. */
export function normalizeTerm(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Designator shapes like "F-35", "MQ-9", "AIM-260", "B-21A": a letter and a
 * digit adjacent (optionally hyphen-joined). This is what lets a short
 * single-token program_name through the length gate.
 */
const DESIGNATOR_RE = /[a-z]-?\d|\d-?[a-z]/i;

/**
 * A BARE weapon-system designator token: a short alpha prefix, a REQUIRED
 * hyphen, 1–4 digits, and an optional 1–2 letter suffix — "F-35", "B-21",
 * "MQ-25", "CH-53K", "KC-130J", "AH-64E", "E-2D", "P-8A", "EA-18G". The hyphen
 * requirement is deliberate: no-hyphen ground codes ("M1", "M10", "C2") are
 * ambiguous (a road, a tag, "command and control") and excluded from v1.
 * `_ANCHORED` validates one token; `_SCAN` pulls tokens out of a title.
 */
const DESIGNATOR_TOKEN_ANCHORED_RE = /^[a-z]{1,3}-\d{1,4}[a-z]{0,2}$/i;
const DESIGNATOR_TOKEN_SCAN_RE = /\b[a-z]{1,3}-\d{1,4}[a-z]{0,2}\b/gi;

/**
 * Designator-SHAPED tokens that are not programs (sites, standards, dates).
 * Compared lowercased. Kept tiny on purpose — the ≥3-alphanumeric + hyphen
 * rule already excludes the common ambiguous forms.
 */
export const DESIGNATOR_STOPLIST: ReadonlySet<string> = new Set<string>(['y-12']);

/**
 * Procurement-appropriation prefixes that form designator-SHAPED budget tags in
 * PE titles — "(OPA-3)" is Other Procurement, Army, Budget Activity 3, not a
 * platform; likewise OPN/APN/APA/WPN/PMC/OMA/OMN. No real weapon designator uses
 * these 3-letter prefixes, so rejecting the whole family is safe (and beats a
 * hand-maintained token list of every BA suffix).
 */
const APPROPRIATION_PREFIXES: ReadonlySet<string> = new Set<string>([
  'opa',
  'opn',
  'apn',
  'apa',
  'wpn',
  'pmc',
  'oma',
  'omn',
]);

/** Count of [A-Za-z0-9] chars in a token (the hyphen does not count). */
function alphanumLength(token: string): number {
  let n = 0;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)) n += 1;
  }
  return n;
}

/** True when a NORMALIZED single token is an admissible weapon-system designator. */
export function isDesignatorToken(token: string): boolean {
  if (!DESIGNATOR_TOKEN_ANCHORED_RE.test(token)) return false;
  if (alphanumLength(token) < 3) return false;
  const lower = token.toLowerCase();
  if (DESIGNATOR_STOPLIST.has(lower)) return false;
  const prefix = lower.slice(0, lower.indexOf('-'));
  if (APPROPRIATION_PREFIXES.has(prefix)) return false;
  return true;
}

/**
 * Pull admissible bare designators out of a PE title — the source rows for the
 * platform_designator tier. "B-21 Raider Advance Procurement" -> ["B-21"];
 * "CH-53K (Heavy Lift Replacement)" -> ["CH-53K"]; "Base Support" -> [].
 * De-duped, order-stable.
 */
export function extractDesignatorTerms(title: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const matches = (title ?? '').match(DESIGNATOR_TOKEN_SCAN_RE) ?? [];
  for (const raw of matches) {
    const token = normalizeTerm(raw);
    if (!isDesignatorToken(token)) continue;
    const lower = token.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(token);
  }
  return out;
}

/**
 * Term-quality gate (expects a NORMALIZED term).
 *
 * Base rule: accept only ≥8 chars AND ≥2 whitespace-separated tokens — single
 * generic words ("aircraft", "munitions", "hypersonics") are noise at every tier.
 * Exception: tier='program_name' with length ≥5 also passes when it is
 * multi-token OR carries a digit+letter designator pattern ("MQ-9A", "F-35A").
 * "F-35" (4 chars) and bare acronyms ("CCA") stay rejected AS program names —
 * too risky as curated names. The platform_designator tier admits those bare
 * designators separately (hyphen + ≥3 alphanumerics), a distinct evidence class.
 * Stoplisted phrases are rejected at every tier.
 */
export function isTermAcceptable(term: string, tier: NameBankTier): boolean {
  if (TERM_STOPLIST.has(term.toLowerCase())) return false;
  if (tier === 'platform_designator') return isDesignatorToken(term);
  const multiWord = term.includes(' ');
  if (term.length >= 8 && multiWord) return true;
  if (tier === 'program_name' && term.length >= 5 && (multiWord || DESIGNATOR_RE.test(term))) {
    return true;
  }
  return false;
}

/**
 * Build the matchable name bank. Normalizes + quality-gates every input row and
 * dedupes identical (term, peCode) pairs keeping the highest-confidence tier.
 */
export function buildNameBank(inputs: NameBankEntryInput[]): NameBank {
  const byPair = new Map<string, BankTerm>();
  let rejectedCount = 0;
  for (const input of inputs) {
    const term = normalizeTerm(input.term ?? '');
    const peCode = (input.peCode ?? '').trim();
    if (!term || !peCode) {
      rejectedCount += 1;
      continue;
    }
    if (!isTermAcceptable(term, input.tier)) {
      rejectedCount += 1;
      continue;
    }
    const key = `${term.toLowerCase()}|${peCode}`;
    const confidence = TIER_CONFIDENCE[input.tier];
    const existing = byPair.get(key);
    if (!existing || confidence > existing.confidence) {
      byPair.set(key, { term, peCode, tier: input.tier, confidence });
    }
  }
  const entries = [...byPair.values()];
  const byTermLower = new Map<string, BankTerm[]>();
  for (const entry of entries) {
    const lower = entry.term.toLowerCase();
    const list = byTermLower.get(lower);
    if (list) list.push(entry);
    else byTermLower.set(lower, [entry]);
  }
  return { entries, byTermLower, rejectedCount };
}

export interface PeMention {
  /** Bank display form of the matched term. */
  term: string;
  peCode: string;
  tier: NameBankTier;
  confidence: number;
  /** Whole-word occurrences of the term in the text. */
  occurrences: number;
  /** Index (in the original text) of the first whole-word occurrence. */
  firstIndex: number;
  /** ±SNIPPET_RADIUS chars around the first hit, whitespace-collapsed. */
  snippet: string;
}

/** a-z / 0-9 on the lowercased text — hyphen & punctuation are boundaries. */
function isWordCharCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

/** Single-line evidence window around a hit, ellipsized when truncated. */
export function extractSnippet(
  text: string,
  index: number,
  matchLength: number,
  radius: number = SNIPPET_RADIUS,
): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchLength + radius);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return snippet;
}

/**
 * Case-insensitive whole-word scan of every bank term over one text.
 *
 * Efficiency (one transcript ≈ 1MB, bank ≈ 3–4k terms): the text is lowercased
 * ONCE and its unique [a-z0-9]+ tokens are set-indexed as a prescreen — a term
 * whose first token is absent can't whole-word match, so most terms cost O(1).
 * Surviving terms use indexOf scanning with char-code boundary checks — no
 * per-term RegExp construction. Word boundary = a non-[a-z0-9] char (or string
 * edge) on both sides, so "GPS-denied navigation" does NOT hit inside
 * "…navigational" and "F-35A" does not hit inside "F-35AB".
 */
export function findMentions(text: string, bank: NameBank): PeMention[] {
  if (!text || bank.byTermLower.size === 0) return [];
  const lower = text.toLowerCase();

  const tokenSet = new Set<string>();
  const tokenRe = /[a-z0-9]+/g;
  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = tokenRe.exec(lower)) !== null) tokenSet.add(tokenMatch[0]);

  const out: PeMention[] = [];
  for (const [termLower, entries] of bank.byTermLower) {
    const firstToken = /[a-z0-9]+/.exec(termLower)?.[0];
    if (firstToken && !tokenSet.has(firstToken)) continue;

    let occurrences = 0;
    let firstIndex = -1;
    let from = 0;
    for (;;) {
      const i = lower.indexOf(termLower, from);
      if (i === -1) break;
      const end = i + termLower.length;
      const beforeOk = i === 0 || !isWordCharCode(lower.charCodeAt(i - 1));
      const afterOk = end >= lower.length || !isWordCharCode(lower.charCodeAt(end));
      if (beforeOk && afterOk) {
        occurrences += 1;
        if (firstIndex === -1) firstIndex = i;
      }
      from = i + 1;
    }
    if (occurrences === 0) continue;

    const snippet = extractSnippet(text, firstIndex, termLower.length);
    for (const entry of entries) {
      out.push({
        term: entry.term,
        peCode: entry.peCode,
        tier: entry.tier,
        confidence: entry.confidence,
        occurrences,
        firstIndex,
        snippet,
      });
    }
  }
  out.sort(
    (a, b) =>
      a.firstIndex - b.firstIndex ||
      a.peCode.localeCompare(b.peCode) ||
      a.term.localeCompare(b.term),
  );
  return out;
}

export interface PeMentionSummary {
  peCode: string;
  /** Representative term: highest confidence, then most occurrences. */
  matchedTerm: string;
  tier: NameBankTier;
  confidence: number;
  /** Total whole-word occurrences across ALL matched terms for this PE. */
  occurrences: number;
  snippet: string;
  /** Every distinct bank term that hit this PE in the text. */
  terms: string[];
}

/**
 * Collapse per-term mentions to one row per PE (the IntelligenceChange grain —
 * dedupe key is mention:<transcriptId>:<peCode>, so one row per PE per transcript).
 */
export function aggregateMentionsByPe(mentions: PeMention[]): PeMentionSummary[] {
  const byPe = new Map<string, PeMention[]>();
  for (const mention of mentions) {
    const list = byPe.get(mention.peCode);
    if (list) list.push(mention);
    else byPe.set(mention.peCode, [mention]);
  }
  const out: PeMentionSummary[] = [];
  for (const [peCode, list] of byPe) {
    const best = list.reduce((a, b) =>
      b.confidence > a.confidence ||
      (b.confidence === a.confidence && b.occurrences > a.occurrences)
        ? b
        : a,
    );
    out.push({
      peCode,
      matchedTerm: best.term,
      tier: best.tier,
      confidence: best.confidence,
      occurrences: list.reduce((sum, m) => sum + m.occurrences, 0),
      snippet: best.snippet,
      terms: [...new Set(list.map((m) => m.term))],
    });
  }
  out.sort((a, b) => a.peCode.localeCompare(b.peCode));
  return out;
}

/** ≥NOTABLE_MENTION_THRESHOLD mentions of one PE in one transcript → notable. */
export function mentionSeverity(totalOccurrences: number): 'info' | 'notable' {
  return totalOccurrences >= NOTABLE_MENTION_THRESHOLD ? 'notable' : 'info';
}

/** Stable freshness-layer identity for one (transcript, PE) mention row. */
export function mentionDedupeKey(transcriptId: string, peCode: string): string {
  return `mention:${transcriptId}:${peCode}`;
}

export interface BillTitleInput {
  billId: string;
  title: string;
  /** CongressBill has no shortTitle column today; accepted for forward-compat. */
  shortTitle?: string | null;
}

export interface BillLinkCandidate {
  billId: string;
  peCode: string;
  term: string;
  tier: NameBankTier;
  confidence: number;
  /** Render-safe evidence quoting the matched term + the matched title. */
  evidence: string;
}

const TIER_LABEL: Record<NameBankTier, string> = {
  program_name: 'program name',
  platform_designator: 'platform designator',
  capability_alias: 'capability alias',
  pe_title: 'PE title',
};

function truncateForEvidence(value: string, max = 240): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Match bank terms against bill titles. Only the program_name and
 * capability_alias tiers participate (BILL_MATCH_TIERS) — PE titles against
 * bill titles are too noisy. One candidate per (billId, peCode), keeping the
 * highest-confidence matching term.
 */
export function matchBillTitles(bills: BillTitleInput[], bank: NameBank): BillLinkCandidate[] {
  const billEntries = bank.entries.filter((e) => BILL_MATCH_TIERS.has(e.tier));
  if (billEntries.length === 0) return [];
  const billBank = buildBankFromEntries(billEntries);

  const out: BillLinkCandidate[] = [];
  for (const bill of bills) {
    const fields: Array<{ label: string; value: string }> = [
      { label: 'title', value: bill.title ?? '' },
    ];
    if (bill.shortTitle) fields.push({ label: 'short title', value: bill.shortTitle });

    const bestByPe = new Map<string, BillLinkCandidate>();
    for (const field of fields) {
      if (!field.value) continue;
      for (const mention of findMentions(field.value, billBank)) {
        const previous = bestByPe.get(mention.peCode);
        if (previous && previous.confidence >= mention.confidence) continue;
        bestByPe.set(mention.peCode, {
          billId: bill.billId,
          peCode: mention.peCode,
          term: mention.term,
          tier: mention.tier,
          confidence: mention.confidence,
          evidence: `Bill ${field.label} matched ${TIER_LABEL[mention.tier]} "${mention.term}": "${truncateForEvidence(field.value)}"`,
        });
      }
    }
    out.push(...[...bestByPe.values()].sort((a, b) => a.peCode.localeCompare(b.peCode)));
  }
  return out;
}

/** Re-index already-accepted entries (skips the quality gate — they passed it). */
function buildBankFromEntries(entries: BankTerm[]): NameBank {
  const byTermLower = new Map<string, BankTerm[]>();
  for (const entry of entries) {
    const lower = entry.term.toLowerCase();
    const list = byTermLower.get(lower);
    if (list) list.push(entry);
    else byTermLower.set(lower, [entry]);
  }
  return { entries, byTermLower, rejectedCount: 0 };
}
