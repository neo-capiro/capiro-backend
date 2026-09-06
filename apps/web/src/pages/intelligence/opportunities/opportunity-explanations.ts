/**
 * Mirrors `opportunity-explanation.ts` in apps/api.
 *
 * WHY THIS IS MIRRORED RATHER THAN SENT
 * ------------------------------------
 * Same convention as `funding-opportunities-api.ts` and the note in
 * `district-nexus.types.ts`: `packages/shared` is for constants both sides need at
 * RUNTIME, not for copy. Sending rendered prose over the wire would also mean the
 * API decided how a chip reads, which is a layout decision.
 *
 * The API spec asserts this file labels every key the API labels, so a signal added
 * on one side and not the other fails the build rather than rendering a machine key
 * to a user.
 *
 * WHAT WAS WRONG
 * --------------
 * The card printed `matchedSignals` keys verbatim — `naicsExact`,
 * `genericTopical`, `placeOfPerformanceSite` — next to a bare number. A reader
 * could not tell which was an exact classification match and which was the word
 * "defense" appearing in a DoD notice, because once both are a bullet in a list
 * they look identical.
 */

export type SignalStrength = 'strong' | 'moderate' | 'weak';

export const FIT_BAND_LABELS: Record<SignalStrength, string> = {
  strong: 'Strong fit',
  moderate: 'Moderate fit',
  weak: 'Weak fit',
};

export const FIT_BAND_COLORS: Record<SignalStrength, string> = {
  strong: 'green',
  moderate: 'orange',
  // Not red: a weak fit is not an error, it is thin evidence.
  weak: 'default',
};

/** Short chip label per signal key. Keep in step with the API's SIGNAL_COPY. */
export const SIGNAL_LABELS: Record<string, string> = {
  // Grant rail
  assistanceListing: 'Prior award under this Assistance Listing',
  applicantType: 'Organization type meets the applicant rule',
  agency: 'Prior award history with this agency',
  stateRestriction: 'Restricted to a state the client is in',
  fundingCategory: 'Funding category match',
  knownPartner: 'Known partner named',
  // Contract rail
  naicsExact: 'Exact NAICS match',
  pscExact: 'Exact product/service code match',
  programElement: 'Client-relevant Program Element',
  agencyHistory: 'Prior award history with this agency',
  placeOfPerformanceSite: 'Work happens at a client site',
  setAsideSelfReported: 'Set-aside the client reports qualifying for',
  naicsIndustryGroup: 'Same NAICS industry group',
  pscCategory: 'Same product/service category',
  officeHistory: 'Prior award history with this office',
  facilityState: 'Client has a site in this state',
  // Shared
  capabilityKeyword: 'Capability match',
  sector: 'Same sector',
  genericTopical: 'Common industry term',
  // Agency forecast rail
  funding_priority_match: 'Funding priority match',
  exact_naics_match: 'Exact NAICS match',
  exact_psc_match: 'Exact product/service code match',
  capability_match: 'Capability match',
  prior_agency_history: 'Prior award history with this agency',
  program_element_linked_source_backed: 'Client-relevant Program Element',
  location_match: 'Client location match',
  known_vehicle_access: 'Recorded vehicle access',
  reviewed_strategic_priority: 'Reviewed strategic priority',
};

/**
 * A signal's label, or an honest fallback.
 *
 * Never returns the raw key: an unlabelled key rendering as itself is the exact
 * defect P09 removes.
 */
export type MatchSignalSource = 'capability' | 'funding_priority';

export function signalLabel(signal: string, source?: MatchSignalSource): string {
  if (signal === 'capabilityKeyword' && source === 'funding_priority') {
    return 'Funding priority match';
  }
  return SIGNAL_LABELS[signal] ?? 'Unrecognized match signal';
}

/** Eligibility context must not become fit evidence, including on older saved rows. */
export function isFitSignal(signal: { signal: string; weight?: number }): boolean {
  return (
    signal.signal !== 'applicantType' &&
    signal.signal !== 'stateRestriction' &&
    (signal.weight == null || signal.weight > 0)
  );
}

/** Forecast cards show the stored assessment; only the detail performs a fresh assessment. */
export function forecastAssessmentReason(signals: ReadonlyArray<unknown> = []): string | null {
  for (const signal of signals) {
    if (!signal || typeof signal !== 'object') continue;
    const record = signal as Record<string, unknown>;
    if (record.signal === 'forecast_assessment' && typeof record.primaryReason === 'string') {
      return record.primaryReason.trim() || null;
    }
  }
  return null;
}

export interface ExplainedSignalView {
  signal: string;
  label: string;
  strength: SignalStrength;
  matchedOn: string;
  source?: MatchSignalSource;
}

/**
 * Sort signals strongest-first and attach labels.
 *
 * Sorted here rather than trusted from the API so the leading reason cannot change
 * because a response happened to serialise in a different order.
 */
const STRENGTH_ORDER: Record<SignalStrength, number> = { strong: 0, moderate: 1, weak: 2 };

export function explainSignals(
  matchedSignals: ReadonlyArray<{
    signal: string;
    strength: SignalStrength;
    matchedOn: string;
    weight?: number;
    source?: MatchSignalSource;
  }>,
): {
  fitBand: SignalStrength;
  strongest: ExplainedSignalView | null;
  signals: ExplainedSignalView[];
} {
  const signals = matchedSignals
    .filter(isFitSignal)
    .map((s) => ({
      signal: s.signal,
      label: signalLabel(s.signal, s.source),
      strength: s.strength,
      matchedOn: s.matchedOn,
      ...(s.source ? { source: s.source } : {}),
    }))
    .sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength]);

  const strongest = signals[0] ?? null;
  return {
    // From the strongest signal, never from a count: five weak hits must not
    // out-rank one exact match.
    fitBand: strongest ? strongest.strength : 'weak',
    strongest,
    signals,
  };
}
