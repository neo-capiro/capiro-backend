/**
 * Conservative identity matching between a LegiScan person and the
 * OpenStates-keyed `state_legislator` rows (State Legislation Platform S2
 * people crosswalk). Extracted as a PURE module so the error-prone,
 * PD2-sensitive matching logic is unit-tested without a database — it is the
 * bridge every legislator→bill/vote read depends on (explorer
 * `stateLegislatorDetail` joins `state_bill_sponsor` by
 * `state_legislator.legiscan_people_id`, which only this crosswalk populates).
 *
 * PD2 (never guess an identity match) governs every rule here: a candidate is
 * returned ONLY when the evidence resolves to exactly ONE legislator. Any
 * residual ambiguity (two same-name members, a district that maps to several
 * rows) yields null — an unmatched person is honest and recoverable; a wrong
 * match silently misattributes bills, votes and downstream targeting to the
 * wrong person, which is far worse.
 */

/** A LegiScan person to resolve (fields optional so both getSessionPeople and dataset shapes fit). */
export interface MatchPerson {
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  district?: string | null;
  party?: string | null;
  /** LegiScan role_id (1 Representative/lower, 2 Senator/upper) when known. */
  roleId?: number | null;
  /** LegiScan role string ("Rep", "Sen", "Assembly Member", …) when known. */
  role?: string | null;
}

/** An existing state_legislator candidate row. */
export interface MatchCandidate {
  id: string;
  name: string;
  district?: string | null;
  party?: string | null;
  /** OpenStates org_classification, normalized to 'upper' | 'lower'. */
  chamber?: string | null;
}

const SUFFIX_TOKENS = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'vi']);

/**
 * Normalize a person/legislator name to a comparable token string: lowercase,
 * every non-alphanumeric run collapsed to a single space (so "Smith-Jones",
 * "Smith, Jones" and "Smith Jones" converge), and trailing generational
 * suffixes dropped. Middle names/initials are NOT stripped here — they only
 * affect the exact-full-name tier, which last+first token matching backstops.
 */
export function normalizeLegislatorName(raw: string | null | undefined): string {
  const base = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!base) return '';
  const tokens = base.split(' ');
  while (tokens.length > 1 && SUFFIX_TOKENS.has(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  return tokens.join(' ');
}

function nameTokens(raw: string | null | undefined): string[] {
  const n = normalizeLegislatorName(raw);
  return n ? n.split(' ') : [];
}

/** A single normalized name token (for the LegiScan-supplied first/last fields). */
function normalizeToken(raw: string | null | undefined): string {
  return normalizeLegislatorName(raw).split(' ')[0] ?? '';
}

/**
 * Normalize a district to a comparable string. LegiScan and OpenStates disagree
 * on formatting ("HD-034" vs "34" vs "034"), so extract the first digit run and
 * strip leading zeros; a purely non-numeric district (rare named districts)
 * falls back to its alphanumeric-only form. Null/empty → null. Note the digit
 * run alone is chamber-agnostic ("HD-34" and "SD-34" both → "34"), which is why
 * callers pair a district match with a chamber (or name) constraint.
 */
export function normalizeDistrict(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const digits = s.match(/\d+/);
  if (digits) return String(Number(digits[0]));
  const alnum = s.replace(/[^a-z0-9]+/g, '');
  return alnum || null;
}

/** Canonical single-char party token (D/R/I/L/G…). First letter is enough to disambiguate. */
export function normalizeParty(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  return s ? (s[0] ?? null) : null;
}

/** Derive 'upper'/'lower' from a LegiScan person's role_id/role, else null. */
export function personChamber(
  person: Pick<MatchPerson, 'roleId' | 'role'>,
): 'upper' | 'lower' | null {
  if (person.roleId === 2) return 'upper';
  if (person.roleId === 1) return 'lower';
  const r = (person.role ?? '').toLowerCase();
  if (!r) return null;
  if (r.includes('sen')) return 'upper';
  if (
    r.startsWith('rep') ||
    r.includes('assembly') ||
    r.includes('delegate') ||
    r.includes('house')
  ) {
    return 'lower';
  }
  return null;
}

interface Normalized {
  id: string;
  full: string;
  first: string;
  last: string;
  district: string | null;
  party: string | null;
  chamber: string | null;
}

function normalizeCandidate(c: MatchCandidate): Normalized {
  const tokens = nameTokens(c.name);
  return {
    id: c.id,
    full: tokens.join(' '),
    first: tokens[0] ?? '',
    last: tokens.length ? tokens[tokens.length - 1]! : '',
    district: normalizeDistrict(c.district),
    party: normalizeParty(c.party),
    chamber: c.chamber === 'upper' || c.chamber === 'lower' ? c.chamber : null,
  };
}

/**
 * Narrow a candidate set to a single row using district → chamber → party in
 * turn. Returns the id when exactly one survives, else null (ambiguous). Each
 * filter is only applied when the person carries that signal AND it does not
 * empty the set (an absent/mismatched signal must not discard an otherwise-good
 * sole candidate — it just fails to help).
 */
function disambiguate(
  cands: Normalized[],
  pDistrict: string | null,
  pChamber: string | null,
  pParty: string | null,
): string | null {
  let list = cands;
  if (list.length === 0) return null;
  if (list.length === 1) return list[0]!.id;

  if (pDistrict) {
    const narrowed = list.filter((c) => c.district === pDistrict);
    if (narrowed.length === 1) return narrowed[0]!.id;
    if (narrowed.length > 0) list = narrowed;
  }
  if (pChamber) {
    const narrowed = list.filter((c) => c.chamber === pChamber);
    if (narrowed.length === 1) return narrowed[0]!.id;
    if (narrowed.length > 0) list = narrowed;
  }
  if (pParty) {
    const narrowed = list.filter((c) => c.party === pParty);
    if (narrowed.length === 1) return narrowed[0]!.id;
    if (narrowed.length > 0) list = narrowed;
  }
  return null;
}

/**
 * Resolve a LegiScan person to exactly one candidate legislator, or null.
 * Tiers, highest confidence first:
 *   1. exact normalized full name
 *   2. district + chamber + last name (a district holds one member per chamber)
 *   3. last + first token (tolerates middle-name / suffix divergence)
 * Each tier disambiguates residual ties by district → chamber → party; a tie
 * that survives all three yields null.
 */
export function pickLegislatorMatch(
  person: MatchPerson,
  candidates: MatchCandidate[],
): string | null {
  if (!candidates.length) return null;

  const pFull = normalizeLegislatorName(person.name);
  const pLast = person.lastName
    ? normalizeToken(person.lastName)
    : (nameTokens(person.name).slice(-1)[0] ?? '');
  const pFirst = person.firstName
    ? normalizeToken(person.firstName)
    : (nameTokens(person.name)[0] ?? '');
  const pDistrict = normalizeDistrict(person.district);
  const pParty = normalizeParty(person.party);
  const pChamber = personChamber(person);

  const norm = candidates.map(normalizeCandidate);

  // Tier 1 — exact full name.
  if (pFull) {
    const t1 = norm.filter((c) => c.full && c.full === pFull);
    const w = disambiguate(t1, pDistrict, pChamber, pParty);
    if (w) return w;
  }

  // Tier 2 — district + chamber + last name.
  if (pDistrict && pLast) {
    const t2 = norm.filter(
      (c) =>
        c.district === pDistrict &&
        c.last === pLast &&
        // Only enforce chamber when BOTH sides carry it (never discard a
        // candidate whose chamber we don't know).
        (!pChamber || !c.chamber || c.chamber === pChamber),
    );
    const w = disambiguate(t2, null, pChamber, pParty);
    if (w) return w;
  }

  // Tier 3 — last + first token.
  if (pLast && pFirst) {
    const t3 = norm.filter((c) => c.last === pLast && c.first === pFirst);
    const w = disambiguate(t3, pDistrict, pChamber, pParty);
    if (w) return w;
  }

  return null;
}
