/**
 * Funding Opportunities — deterministic client ↔ SAM.gov notice relevance.
 *
 * Pure and I/O-free, and deliberately no LLM anywhere: a later summary may
 * EXPLAIN the signals computed here but must never change them. Same contract as
 * grant-opportunity-relevance.ts, for the same reason — a pursue/no-pursue call
 * has to be reproducible and auditable on every run.
 *
 * ── What makes contract matching different from grant matching ───────────────
 *
 * A grant names its eligible applicant types, so relevance and eligibility are
 * both computable from structured fields. A contract notice names NAICS, PSC, a
 * contracting office and (sometimes) a set-aside — none of which says whether
 * this client may bid. Contract eligibility depends on responsibility
 * determinations and SBA size standards Capiro does not hold, so
 * `computeSamEligibility` below never returns `eligible` or `ineligible`. It
 * returns `needs_review` or `unknown` WITH A SPECIFIC REASON, which is the
 * honest answer, and it is reported separately from the score exactly as it is
 * on the grant side.
 *
 * ── The suggestion floor is the point of this file ───────────────────────────
 *
 * DoD notices are full of words like "systems", "services", "technologies" and
 * "defense". A matcher that scores on those alone suggests every notice to every
 * defense client, which is indistinguishable from no matching at all. So a score
 * is not sufficient to surface a suggestion: `meetsSuggestionFloor` additionally
 * requires at least one STRONG signal, or two independent MODERATE ones. A hit
 * on generic vocabulary can raise a score that already had a real signal behind
 * it; it can never create one.
 *
 * Note the deliberate asymmetry with rejection: a defense opportunity is NOT
 * discarded because "defense" is generic. It simply needs a second meaningful
 * signal before it counts as a suggestion.
 */

/** Ordered strongest-first; the order is the tie-break for matchedSignals. */
export const SAM_RELEVANCE_SIGNALS = [
  'naicsExact',
  'pscExact',
  'programElement',
  'agencyHistory',
  'placeOfPerformanceSite',
  'setAsideSelfReported',
  'naicsIndustryGroup',
  'pscCategory',
  'capabilityKeyword',
  'officeHistory',
  'facilityState',
  'sector',
  'genericTopical',
] as const;

export type SamRelevanceSignalKey = (typeof SAM_RELEVANCE_SIGNALS)[number];

export type SignalStrength = 'strong' | 'moderate' | 'weak';

/**
 * Strength bands. These, not the weights, decide whether something is
 * suggestible — a band is a statement about EVIDENCE QUALITY, a weight is only
 * about ordering. Keeping them separate is what stops "tune the weight up" from
 * quietly turning a generic word into a sufficient reason to suggest a notice.
 */
export const SAM_SIGNAL_STRENGTH: Readonly<Record<SamRelevanceSignalKey, SignalStrength>> =
  Object.freeze({
    naicsExact: 'strong',
    pscExact: 'strong',
    programElement: 'strong',
    agencyHistory: 'strong',
    placeOfPerformanceSite: 'strong',
    setAsideSelfReported: 'strong',
    naicsIndustryGroup: 'moderate',
    pscCategory: 'moderate',
    capabilityKeyword: 'moderate',
    officeHistory: 'moderate',
    facilityState: 'moderate',
    sector: 'weak',
    genericTopical: 'weak',
  });

export const SAM_RELEVANCE_WEIGHTS: Readonly<Record<SamRelevanceSignalKey, number>> = Object.freeze({
  // A 6-digit NAICS or a full PSC is a procurement-classification identity, not
  // a topical guess: the same code on a client's profile and on a notice means
  // the government classified both as the same kind of work.
  naicsExact: 30,
  pscExact: 28,
  // An accepted (verbatim PE-code) opportunity→PE link intersected with a PE the
  // client's own capabilities name. Two independent structured facts.
  programElement: 26,
  agencyHistory: 18,
  placeOfPerformanceSite: 14,
  setAsideSelfReported: 10,
  naicsIndustryGroup: 10,
  pscCategory: 8,
  capabilityKeyword: 12,
  officeHistory: 9,
  facilityState: 6,
  sector: 4,
  genericTopical: 1,
});

/**
 * Low-distinctiveness tokens. A hit on one of these is recorded (so an operator
 * can see WHY a weak match is weak) but is banded `weak`, so it can never clear
 * the suggestion floor alone.
 *
 * "defense" is here on purpose and it is the subtle one: in a DoD notice corpus
 * it is near-tautological, so it must not manufacture a match — but a defense
 * opportunity is never discarded for it either. It just needs a second
 * meaningful signal, which is what the floor enforces.
 */
export const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'systems',
  'system',
  'technology',
  'technologies',
  'services',
  'service',
  'solutions',
  'solution',
  'group',
  'company',
  'companies',
  'corporation',
  'incorporated',
  'federal',
  'government',
  'defense',
  'national',
  'support',
  'management',
  'general',
  'program',
  'contract',
  'and',
  'the',
  'of',
  'for',
]);

export interface SamMatchedSignal {
  signal: SamRelevanceSignalKey;
  strength: SignalStrength;
  weight: number;
  /** The verbatim value that matched. Never a paraphrase. */
  matchedOn: string;
}

/** Structured facts about the client. Every field is a FACT, never an inference. */
export interface SamClientProfile {
  /** `Client.naicsCodes`, verbatim. */
  naicsCodes: string[];
  /** `Client.pscCodes`, verbatim. */
  pscCodes: string[];
  /** `ClientCapability.name` + `.keywords` + `.tags`, deduped. */
  capabilityKeywords: string[];
  /** `ClientCapability.peNumbers`, uppercased. */
  programElementCodes: string[];
  /** Awarding agencies the client has prior federal awards from. */
  priorAgencies: string[];
  /** Contracting offices the client has prior federal awards from. */
  priorOffices: string[];
  /** `ClientFacility.state` values. */
  facilityStates: string[];
  /** `Client.sectorTag`. */
  sector: string | null;
  /**
   * `Client.applicantTypes` — Grants.gov applicant-type LABELS. Used for exactly
   * one contract purpose: a client that states "Small businesses" is a
   * self-reported small business, which is relevant to a small-business
   * set-aside. It is NOT a certification and never establishes eligibility.
   */
  applicantTypes: string[];
}

/** Structured facts about the notice, as ingested. */
export interface SamOpportunityProfile {
  title: string | null;
  description: string | null;
  agency: string | null;
  subAgency: string | null;
  office: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  setAside: string | null;
  setAsideCode: string | null;
  /** Source-stated place of performance. Absent fields stay null. */
  placeOfPerformance: { city: string | null; state: string | null; zip: string | null } | null;
  /**
   * PE codes linked to this notice by an ACCEPTED `sam_opportunity_match` row.
   * Only 'accepted' rows belong here — the matcher only auto-accepts a verbatim
   * PE-code hit in the notice text, and a quarantined PSC/NAICS-only guess is
   * not evidence of a program relationship.
   */
  acceptedProgramElementCodes: string[];
}

export interface SamRelevanceResult {
  relevanceScore: number;
  matchedSignals: SamMatchedSignal[];
  /**
   * TRUE when the evidence is strong enough to SURFACE this as a suggestion:
   * at least one strong signal, or at least two distinct moderate signals.
   * A score alone is never sufficient — see the file header.
   */
  meetsSuggestionFloor: boolean;
}

// Fixed denominator, same rationale as the grant scorer's MAX_SCORE: a thin
// client profile scores LOWER, it is not excused from the scale. Excludes the
// weak band so a pile of generic-word hits cannot inflate the percentage.
const MAX_SCORE = (Object.keys(SAM_RELEVANCE_WEIGHTS) as SamRelevanceSignalKey[])
  .filter((k) => SAM_SIGNAL_STRENGTH[k] !== 'weak')
  .reduce((sum, k) => sum + SAM_RELEVANCE_WEIGHTS[k], 0);

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

/** NAICS/PSC codes are compared as uppercase alphanumerics — no spaces, no dots. */
function normCode(v: string | null | undefined): string {
  return (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function tokens(v: string | null | undefined): string[] {
  return norm(v)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function push(
  out: SamMatchedSignal[],
  signal: SamRelevanceSignalKey,
  matchedOn: string,
): void {
  out.push({
    signal,
    strength: SAM_SIGNAL_STRENGTH[signal],
    weight: SAM_RELEVANCE_WEIGHTS[signal],
    matchedOn,
  });
}

/**
 * Is this a small-business set-aside, per SAM's own set-aside code vocabulary?
 *
 * Only the two GENERAL small-business codes count: 'SBA' (Total Small Business
 * Set-Aside) and 'SBP' (Partial Small Business Set-Aside). The socioeconomic
 * programs — 8(a) ('8A','8AN'), SDVOSB ('SDVOSBC','SDVOSBS'), WOSB
 * ('WOSB','WOSBSS','EDWOSB','EDWOSBSS'), HUBZone ('HZC','HZS') — are
 * deliberately EXCLUDED: each requires a certification Capiro holds no record
 * of, and a client's self-reported "Small businesses" applicant type says
 * nothing about whether it holds one.
 */
export function isGeneralSmallBusinessSetAside(setAsideCode: string | null | undefined): boolean {
  const c = normCode(setAsideCode);
  return c === 'SBA' || c === 'SBP';
}

/** Does the client self-report as a small business? A REPORT, not a certification. */
export function selfReportsSmallBusiness(applicantTypes: string[]): boolean {
  return applicantTypes.some((t) => norm(t).includes('small business'));
}

/**
 * Score a client against one SAM notice.
 *
 * Score is 0-100 as a share of the fixed non-weak signal weight. Read it
 * together with `meetsSuggestionFloor`: a notice can carry a non-trivial score
 * built entirely from moderate signals and still be below the floor, and the
 * floor is what decides visibility.
 */
export function scoreSamOpportunityRelevance(
  client: SamClientProfile,
  opp: SamOpportunityProfile,
): SamRelevanceResult {
  const signals: SamMatchedSignal[] = [];

  // ── NAICS ────────────────────────────────────────────────────────────────
  const oppNaics = normCode(opp.naicsCode);
  const clientNaics = client.naicsCodes.map(normCode).filter(Boolean);
  if (oppNaics && clientNaics.includes(oppNaics)) {
    push(signals, 'naicsExact', opp.naicsCode ?? oppNaics);
  } else if (oppNaics.length >= 4) {
    // 4-digit industry group. A real, checkable relationship ("both are
    // 3364 Aerospace Product and Parts Manufacturing") but genuinely weaker than
    // an exact 6-digit match, so it bands moderate and is reported as the GROUP,
    // not as the notice's own code — the operator must be able to see that the
    // last two digits differed.
    const group = oppNaics.slice(0, 4);
    const hit = clientNaics.find((c) => c.length >= 4 && c.slice(0, 4) === group);
    if (hit) push(signals, 'naicsIndustryGroup', `${group} (client ${hit} / notice ${oppNaics})`);
  }

  // ── PSC ──────────────────────────────────────────────────────────────────
  const oppPsc = normCode(opp.pscCode);
  const clientPsc = client.pscCodes.map(normCode).filter(Boolean);
  if (oppPsc && clientPsc.includes(oppPsc)) {
    push(signals, 'pscExact', opp.pscCode ?? oppPsc);
  } else if (oppPsc.length >= 2) {
    // PSC's first two characters are the product/service CATEGORY (e.g. '15' =
    // aircraft, 'R4' = professional services) — §7's "service or product
    // category" signal.
    const cat = oppPsc.slice(0, 2);
    const hit = clientPsc.find((c) => c.length >= 2 && c.slice(0, 2) === cat);
    if (hit) push(signals, 'pscCategory', `${cat} (client ${hit} / notice ${oppPsc})`);
  }

  // ── Program Element ──────────────────────────────────────────────────────
  // Two independent structured facts must agree: the notice text carried a
  // verbatim PE code (which is the only basis sam-opportunity-matcher ever
  // auto-accepts), AND that PE is one the client's own capabilities name.
  const clientPes = new Set(client.programElementCodes.map((p) => normCode(p)));
  const peHit = opp.acceptedProgramElementCodes.map(normCode).find((p) => clientPes.has(p));
  if (peHit) push(signals, 'programElement', peHit);

  // ── Agency / office history ──────────────────────────────────────────────
  const priorAgencies = new Set(client.priorAgencies.map(norm).filter(Boolean));
  const agencyHit = [opp.agency, opp.subAgency].find((a) => a && priorAgencies.has(norm(a)));
  if (agencyHit) push(signals, 'agencyHistory', agencyHit);

  const priorOffices = new Set(client.priorOffices.map(norm).filter(Boolean));
  if (opp.office && priorOffices.has(norm(opp.office))) {
    push(signals, 'officeHistory', opp.office);
  }

  // ── Geography ────────────────────────────────────────────────────────────
  // Two bands, and the difference between them is how specific the SOURCE was.
  // A notice that names a city or ZIP in a state where the client has a plant is
  // real evidence of local performance. A state-only place of performance is a
  // much weaker statement — plenty of DoD notices name a whole state — so it
  // bands moderate. Neither is ever inferred from the client side alone.
  const popState = (opp.placeOfPerformance?.state ?? '').toUpperCase().trim();
  const facilityStates = new Set(
    client.facilityStates.map((s) => (s ?? '').toUpperCase().trim()).filter(Boolean),
  );
  if (popState && facilityStates.has(popState)) {
    const specific = Boolean(opp.placeOfPerformance?.city || opp.placeOfPerformance?.zip);
    if (specific) {
      const where = [opp.placeOfPerformance?.city, popState].filter(Boolean).join(', ');
      push(signals, 'placeOfPerformanceSite', where);
    } else {
      push(signals, 'facilityState', popState);
    }
  }

  // ── Set-aside ────────────────────────────────────────────────────────────
  // Relevance only, never eligibility: a self-reported small business is the
  // right audience for a small-business set-aside, but whether it MEETS the SBA
  // size standard for this NAICS is not something we hold.
  if (
    isGeneralSmallBusinessSetAside(opp.setAsideCode) &&
    selfReportsSmallBusiness(client.applicantTypes)
  ) {
    push(signals, 'setAsideSelfReported', opp.setAside ?? opp.setAsideCode ?? 'Small business set-aside');
  }

  // ── Text signals ─────────────────────────────────────────────────────────
  // Substring, not fuzzy: a deterministic hit an operator can go and find in the
  // notice is the requirement. A near-miss nobody can see is worse than no hit.
  const haystack = `${norm(opp.title)} ${norm(opp.description)}`;
  const distinctiveKeyword = client.capabilityKeywords.find((k) => {
    const needle = norm(k);
    if (needle.length <= 2) return false;
    // A capability keyword that IS a generic token carries no signal. A
    // multi-word phrase containing one ("radar systems") does, and passes.
    if (!needle.includes(' ') && GENERIC_TOKENS.has(needle)) return false;
    return haystack.includes(needle);
  });
  if (distinctiveKeyword) push(signals, 'capabilityKeyword', distinctiveKeyword);

  // Sector tokens, minus the generic ones. `Client.sectorTag` carries
  // pre-migration free text on older clients ("Defense / Aerospace"), so it is
  // tokenized rather than compared whole — same handling, and the same reason, as
  // grant-opportunity-relevance.ts's sectorTokens.
  const sectorHit = tokens(client.sector).find(
    (t) => !GENERIC_TOKENS.has(t) && haystack.includes(t),
  );
  if (sectorHit) push(signals, 'sector', sectorHit);

  // Record the generic hit explicitly rather than dropping it. The operator
  // question this answers is "why is this a weak match" — an empty signal list
  // on a notice the system nonetheless scored is unexplainable.
  const genericHit = tokens(client.sector)
    .concat(client.capabilityKeywords.flatMap(tokens))
    .find((t) => GENERIC_TOKENS.has(t) && haystack.includes(t));
  if (genericHit) push(signals, 'genericTopical', genericHit);

  signals.sort(
    (a, b) => SAM_RELEVANCE_SIGNALS.indexOf(a.signal) - SAM_RELEVANCE_SIGNALS.indexOf(b.signal),
  );

  const earned = signals
    .filter((s) => s.strength !== 'weak')
    .reduce((sum, s) => sum + s.weight, 0);
  const relevanceScore = Math.round((earned / MAX_SCORE) * 100);

  const strongCount = signals.filter((s) => s.strength === 'strong').length;
  const moderateCount = signals.filter((s) => s.strength === 'moderate').length;
  const meetsSuggestionFloor = strongCount >= 1 || moderateCount >= 2;

  return { relevanceScore, matchedSignals: signals, meetsSuggestionFloor };
}

/**
 * Contract eligibility, from structured fields only.
 *
 * Returns `needs_review` or `unknown` — never `eligible`, never `ineligible`.
 * That is not a placeholder, it is the honest ceiling of what Capiro holds:
 *
 *   - A set-aside restricts who may bid, and every socioeconomic set-aside turns
 *     on a CERTIFICATION (8(a), SDVOSB, WOSB, HUBZone) that we store nowhere. An
 *     absent certification record is not evidence the client lacks one, so
 *     `ineligible` would be a guess in the dangerous direction.
 *   - A small-business set-aside additionally turns on the SBA size standard for
 *     the notice's own NAICS, which we do not hold either. A client's
 *     self-reported "Small businesses" applicant type is a report, not a
 *     determination.
 *   - Full-and-open is open to any RESPONSIBLE source, and responsibility is a
 *     contracting-officer determination, not a field.
 *
 * See docs/funding-opportunities/data-gap-audit.md for the specific column that
 * would let this return `eligible` (SAM Entity-Management set-aside
 * certifications on the client), and note that grant eligibility sat in exactly
 * this position until `Client.applicantTypes` was added.
 */
export function computeSamEligibility(
  client: SamClientProfile,
  opp: SamOpportunityProfile,
): { state: 'needs_review' | 'unknown'; reason: string } {
  if (opp.setAsideCode || opp.setAside) {
    const label = opp.setAside ?? opp.setAsideCode ?? 'a set-aside';
    if (isGeneralSmallBusinessSetAside(opp.setAsideCode)) {
      return {
        state: 'needs_review',
        reason: selfReportsSmallBusiness(client.applicantTypes)
          ? `Restricted to ${label}. This client self-reports as a small business, but the SBA size standard for NAICS ${opp.naicsCode ?? '(not stated)'} is not held here — confirm size status before bidding.`
          : `Restricted to ${label}, and no small-business status is recorded for this client — confirm before bidding.`,
      };
    }
    return {
      state: 'needs_review',
      reason: `Restricted to ${label}. Capiro holds no set-aside certifications for this client, so qualification cannot be confirmed from structured fields.`,
    };
  }
  return {
    state: 'unknown',
    reason:
      'This notice records no set-aside in the fields Capiro holds. Contract eligibility also depends on a contracting officer’s responsibility determination, which is not published as data, so it is not asserted here.',
  };
}
