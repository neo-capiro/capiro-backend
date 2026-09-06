/** Shared, database-free forecast signals for detail reads and background recommendations. */
import { normAgency, GENERIC_TOKENS } from './sam-opportunity-relevance.js';
import type { ForecastRelevanceInput } from './forecast-relevance.js';

/**
 * Every signal `scoreForecastRelevance` takes, plus WHY the ones that can never
 * fire today cannot.
 *
 * `unavailable` is not a synonym for `false`. `pscCode` is confirmed absent from
 * the provider's forecast resource (D-45), and no strategic-priority review
 * workflow exists anywhere in this codebase — so those two signals are not
 * "the client does not match", they are "there is nothing to match against".
 * A UI that rendered them as plain false would be stating an absence of the
 * client's fit rather than an absence of data.
 */
export interface ForecastSignalEvidence {
  exactNaicsMatch: boolean;
  exactPscMatch: boolean;
  capabilityMatch: boolean;
  priorAgencyHistory: boolean;
  programElementLinkedSourceBacked: boolean;
  locationMatch: boolean;
  knownVehicleAccess: boolean;
  reviewedStrategicPriority: boolean;
  /** Signals that could not be evaluated at all, and the reason for each. */
  unavailable: Array<{ signal: string; reason: string }>;
}

// ── Normalization: exact only, deliberately narrow ───────────────────────────

/**
 * NAICS/PSC comparison form: uppercase alphanumerics, nothing else.
 *
 * Byte-for-byte the same rule `sam-opportunity-relevance.ts`'s own private
 * `normCode` uses, and deliberately WITHOUT that file's banded near-miss logic
 * (4-digit industry group, 2-character PSC category). `ForecastRelevanceInput`
 * declares `exactNaicsMatch` / `exactPscMatch` — exact is the contract, and a
 * near miss scored as a match here would silently widen what "exact" means for
 * the one caller P25's scorer has.
 */
function normCode(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Lowercase, punctuation collapsed to single spaces. */
function norm(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Does `needle` appear in `haystack` as a WHOLE token run?
 *
 * Whole-token, not substring: a client capability of "air" must not match
 * "airport", "repair" or "millionaire". Both sides are normalized to
 * space-separated tokens first and the needle is required to sit on token
 * boundaries — which is what makes this a fact check rather than a fuzzy match.
 *
 * Tokens of two characters or fewer are refused outright. A capability keyword
 * of "IT" or "AI" matches somewhere in almost any government description, and a
 * signal that fires on almost everything is noise that reads as evidence.
 */
export function containsWholeToken(haystack: string | null, needle: string | null): boolean {
  const h = norm(haystack);
  const n = norm(needle);
  if (!h || !n || n.length <= 2 || (!n.includes(' ') && GENERIC_TOKENS.has(n))) return false;
  return ` ${h} `.includes(` ${n} `);
}

/** The forecast facts {@link deriveForecastSignals} reads. */
export interface ForecastSignalSource {
  title: string;
  description: string | null;
  agency: string | null;
  departmentName: string | null;
  organizationAgencyName: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  placeOfPerformance: string | null;
}

/** The client facts {@link deriveForecastSignals} reads. From `ClientOpportunityProfileV1.sam`. */
export interface ForecastSignalProfile {
  naicsCodes: string[];
  pscCodes: string[];
  capabilityKeywords: string[];
  programElementCodes: string[];
  priorAgencies: string[];
  facilityStates: string[];
}

/**
 * US state comparison: the two-letter postal code, when the text states one as
 * a whole token.
 *
 * Deliberately NOT a geocoder and not a city-name match. `placeOfPerformance` on
 * this provider resource is free text with no structure at all, so the only
 * honest fact available is "the client has a facility in a state this text
 * names". Anything more would be an inference dressed as a location match.
 */
function statesNamedIn(text: string | null): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const token of text.toUpperCase().split(/[^A-Z]+/)) {
    if (token.length === 2) out.add(token);
  }
  return out;
}

/**
 * The six establishable signals, plus the two that cannot be established today.
 *
 * PURE and DB-free, exactly like `scoreForecastRelevance` itself, so the whole
 * derivation is provable from fixtures.
 *
 * `knownVehicleAccess` is a parameter rather than derived here: it is a
 * CLIENT-level fact owned by P23's `AcquisitionPositionService`, gated by its
 * own `funding_opportunities_vehicle_fit` flag, and reading it is a database
 * call this function must not make.
 */
export function deriveForecastSignals(
  forecast: ForecastSignalSource,
  profile: ForecastSignalProfile,
  opts: { knownVehicleAccess: boolean; vehicleFitEnabled: boolean },
): ForecastSignalEvidence {
  const forecastNaics = normCode(forecast.naicsCode);
  const clientNaics = new Set(profile.naicsCodes.map(normCode).filter(Boolean));
  const exactNaicsMatch = forecastNaics !== '' && clientNaics.has(forecastNaics);

  const forecastPsc = normCode(forecast.pscCode);
  const clientPsc = new Set(profile.pscCodes.map(normCode).filter(Boolean));
  const exactPscMatch = forecastPsc !== '' && clientPsc.has(forecastPsc);

  // Title AND description, joined — a capability named only in the body of a
  // forecast is the same evidence as one named in its title.
  const text = [forecast.title, forecast.description].filter(Boolean).join(' ');
  const capabilityMatch = profile.capabilityKeywords.some((kw) => containsWholeToken(text, kw));

  // Every level of the provider's hierarchy, because prior-award history is
  // recorded against whichever level the award itself named.
  const forecastAgencies = [
    forecast.agency,
    forecast.departmentName,
    forecast.organizationAgencyName,
  ]
    .map(normAgency)
    .filter(Boolean);
  const priorAgencies = new Set(profile.priorAgencies.map(normAgency).filter(Boolean));
  const priorAgencyHistory = forecastAgencies.some((a) => priorAgencies.has(a));

  /**
   * A PE link is source-backed only when the client's own asserted PE code
   * appears VERBATIM in the forecast's own text.
   *
   * The same evidentiary bar `sam-opportunity-matcher.ts` requires before it
   * will auto-accept a PE match, and for the same reason: a PE number is an
   * identifier, and a NAICS or subject-matter coincidence is explicitly capped
   * at `quarantined` there, never `accepted`. `forecast-relevance.ts`'s input is
   * named `programElementLinkedSourceBacked` precisely so a weaker link cannot
   * be passed in as this one.
   */
  const upperText = (forecast.title + ' ' + (forecast.description ?? '')).toUpperCase();
  const programElementLinkedSourceBacked = profile.programElementCodes
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length >= 4)
    .some((code) => upperText.includes(code));

  const forecastStates = statesNamedIn(forecast.placeOfPerformance);
  const locationMatch = profile.facilityStates
    .map((s) => (s ?? '').trim().toUpperCase())
    .filter((s) => s.length === 2)
    .some((s) => forecastStates.has(s));

  const unavailable: Array<{ signal: string; reason: string }> = [];
  if (forecast.pscCode == null) {
    unavailable.push({
      signal: 'exactPscMatch',
      reason:
        'This provider resource states no product/service code at all, so there is nothing to compare against the client’s PSC codes.',
    });
  }
  if (!opts.vehicleFitEnabled) {
    unavailable.push({
      signal: 'knownVehicleAccess',
      reason:
        'Acquisition-position scoring is not enabled for this workspace, so the client’s contract-vehicle access was not read.',
    });
  }
  unavailable.push({
    signal: 'reviewedStrategicPriority',
    reason:
      'No reviewed strategic-priority watch list exists yet, so this signal cannot be established for any client.',
  });

  return {
    exactNaicsMatch,
    exactPscMatch,
    capabilityMatch,
    priorAgencyHistory,
    programElementLinkedSourceBacked,
    locationMatch,
    knownVehicleAccess: opts.vehicleFitEnabled ? opts.knownVehicleAccess : false,
    // Always false, and `unavailable` above says why. Not a claim about the client.
    reviewedStrategicPriority: false,
    unavailable,
  };
}

/** Compose the signal evidence into `scoreForecastRelevance`'s own input shape. */
export function toForecastRelevanceInput(
  facts: { isActive: boolean | null; anticipatedAwardDate: string | null },
  signals: ForecastSignalEvidence,
  profileTooThin: boolean,
  asOf: Date,
): ForecastRelevanceInput {
  return {
    isActive: facts.isActive,
    profileTooThin,
    exactNaicsMatch: signals.exactNaicsMatch,
    exactPscMatch: signals.exactPscMatch,
    capabilityMatch: signals.capabilityMatch,
    priorAgencyHistory: signals.priorAgencyHistory,
    programElementLinkedSourceBacked: signals.programElementLinkedSourceBacked,
    locationMatch: signals.locationMatch,
    knownVehicleAccess: signals.knownVehicleAccess,
    reviewedStrategicPriority: signals.reviewedStrategicPriority,
    anticipatedAwardDate: facts.anticipatedAwardDate,
    asOf,
  };
}
