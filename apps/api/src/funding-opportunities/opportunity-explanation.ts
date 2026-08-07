/**
 * Operator-readable explanations for why an opportunity surfaced.
 *
 * WHAT WAS WRONG
 * --------------
 * The card led with a number and a list of machine keys. `naicsExact`,
 * `genericTopical`, `placeOfPerformanceSite` are field names, not reasons — a
 * reader could not tell which of them was strong evidence and which was a
 * near-tautological word hit, and "relevance 62" is not a claim anybody can check
 * or dispute.
 *
 * Two separate failures, and this file fixes both:
 *
 *  1. NO LABEL. A raw key renders as itself, so the UI silently taught operators a
 *     private vocabulary.
 *  2. NO STRENGTH IN THE PROSE. A weak `genericTopical` hit on the word "defense"
 *     in a DoD corpus looked exactly like an exact NAICS match once both were a
 *     bullet in a list.
 *
 * THE VOCABULARY IS BOUNDED, AND COVERS BOTH RAILS
 * -----------------------------------------------
 * Every key either rail's scorer can emit has an entry here, asserted by a test
 * that reads the scorers' own key lists. An unlabelled key would fall back to
 * rendering itself, which is the defect.
 *
 * EVERY EXPLANATION CITES THE MATCHED VALUE
 * ----------------------------------------
 * `matchedOn` is carried verbatim from the scorer — the actual NAICS code, the
 * actual agency string. The point of the field is that an operator can go and
 * check it, so it is never paraphrased and never summarised.
 *
 * UNKNOWN IS NOT NEGATIVE
 * ----------------------
 * The absence of a signal produces no explanation at all. It never produces
 * "no agency history" as though that were a finding: we did not look for
 * something and fail to find it, we simply hold nothing.
 */

import type { SignalStrength } from './sam-opportunity-relevance.js';

/**
 * How a signal reads to a person, per rail-agnostic key.
 *
 * `label` is the short form for a chip. `detail` is a sentence template that ends
 * with the matched value, so the rendered string always names the fact.
 */
interface SignalCopy {
  label: string;
  detail: (matchedOn: string) => string;
}

const SIGNAL_COPY: Readonly<Record<string, SignalCopy>> = Object.freeze({
  // ── Grant rail ────────────────────────────────────────────────────────────
  assistanceListing: {
    label: 'Prior award under this Assistance Listing',
    detail: (v) => `The client has previously received funding under Assistance Listing ${v}.`,
  },
  applicantType: {
    label: 'Aimed at this kind of organization',
    detail: (v) => `The notice names ${v} among its eligible applicant types.`,
  },
  agency: {
    label: 'Prior award history with this agency',
    detail: (v) => `The client has prior federal award history with ${v}.`,
  },
  stateRestriction: {
    label: 'Restricted to a state the client is in',
    detail: (v) => `The notice restricts itself to ${v}, where the client has a site.`,
  },
  fundingCategory: {
    label: 'Funding category match',
    detail: (v) => `The notice's funding category is ${v}.`,
  },
  knownPartner: {
    label: 'Known partner named',
    detail: (v) => `${v} is a recorded partner of the client.`,
  },

  // ── Contract rail ─────────────────────────────────────────────────────────
  naicsExact: {
    label: 'Exact NAICS match',
    detail: (v) => `The notice and the client are both classified under NAICS ${v}.`,
  },
  pscExact: {
    label: 'Exact product/service code match',
    detail: (v) => `The notice and the client share Product/Service Code ${v}.`,
  },
  programElement: {
    label: 'Client-relevant Program Element',
    detail: (v) => `The notice names Program Element ${v}, which the client's capabilities cover.`,
  },
  agencyHistory: {
    label: 'Prior award history with this agency',
    detail: (v) => `The client has prior federal contract history with ${v}.`,
  },
  placeOfPerformanceSite: {
    label: 'Work happens at a client site',
    detail: (v) => `The stated place of performance matches the client's site at ${v}.`,
  },
  setAsideSelfReported: {
    label: 'Set-aside the client reports qualifying for',
    detail: (v) => `The notice is set aside for ${v}, which the client reports qualifying for.`,
  },
  naicsIndustryGroup: {
    label: 'Same NAICS industry group',
    detail: (v) => `Both sit in NAICS industry group ${v}, but the full codes differ.`,
  },
  pscCategory: {
    label: 'Same product/service category',
    detail: (v) => `Both sit in Product/Service category ${v}, but the full codes differ.`,
  },
  officeHistory: {
    label: 'Prior award history with this office',
    detail: (v) => `The client has prior contract history with ${v}.`,
  },
  facilityState: {
    label: 'Client has a site in this state',
    detail: (v) => `The client has a site in ${v}.`,
  },

  // ── Shared ────────────────────────────────────────────────────────────────
  capabilityKeyword: {
    label: 'Capability keyword match',
    detail: (v) => `A recorded client capability matches on "${v}".`,
  },
  sector: {
    label: 'Same sector',
    detail: (v) => `The client's sector is ${v}.`,
  },
  genericTopical: {
    label: 'Common industry term',
    // Named as weak IN THE PROSE, not only in a band the reader has to notice.
    // "defense" in a DoD corpus is near-tautological; it must never read as a
    // reason on its own.
    detail: (v) => `The word "${v}" appears on both sides. This is a common term, not evidence on its own.`,
  },
});

/** Fit bands. Three, matching the three signal strengths a scorer can emit. */
export const FIT_BANDS = ['strong', 'moderate', 'weak'] as const;
export type FitBand = (typeof FIT_BANDS)[number];

export const FIT_BAND_LABELS: Readonly<Record<FitBand, string>> = Object.freeze({
  strong: 'Strong fit',
  moderate: 'Moderate fit',
  weak: 'Weak fit',
});

export interface ExplainedSignal {
  /** The scorer's own key. Kept for the evidence panel; never rendered as prose. */
  signal: string;
  label: string;
  detail: string;
  strength: SignalStrength;
  /** The verbatim value that matched, so an operator can check it. */
  matchedOn: string;
}

export interface OpportunityExplanation {
  /** Overall fit band, derived from the STRONGEST signal present. */
  fitBand: FitBand;
  fitLabel: string;
  /** The single strongest explained signal, or null when there are none. */
  strongest: ExplainedSignal | null;
  /** Every signal, strongest first. Feeds the expandable evidence panel. */
  signals: ExplainedSignal[];
  /** True when the evidence would not clear the suggestion floor on its own. */
  weakOnly: boolean;
}

const STRENGTH_ORDER: Readonly<Record<SignalStrength, number>> = Object.freeze({
  strong: 0,
  moderate: 1,
  weak: 2,
});

/** Fall back to the key ONLY as a last resort, and say so rather than pretending. */
function copyFor(signal: string): SignalCopy {
  return (
    SIGNAL_COPY[signal] ?? {
      label: 'Unrecognized match signal',
      detail: (v) => `An unlabelled signal (${signal}) matched on ${v}.`,
    }
  );
}

export function isLabelledSignal(signal: string): boolean {
  return signal in SIGNAL_COPY;
}

export function labelledSignalKeys(): string[] {
  return Object.keys(SIGNAL_COPY);
}

/**
 * Explain a scored opportunity's matched signals.
 *
 * Order-independent: signals are sorted by strength band here, so the caller's
 * array order cannot change which reason leads the card.
 */
export function explainOpportunity(
  matchedSignals: ReadonlyArray<{ signal: string; strength: SignalStrength; matchedOn: string }>,
): OpportunityExplanation {
  const signals: ExplainedSignal[] = matchedSignals
    .map((sig) => {
      const copy = copyFor(sig.signal);
      return {
        signal: sig.signal,
        label: copy.label,
        detail: copy.detail(sig.matchedOn),
        strength: sig.strength,
        matchedOn: sig.matchedOn,
      };
    })
    // Stable within a band: equal strengths keep their incoming order, so the
    // result is deterministic without depending on it for the leading reason.
    .sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength]);

  const strongest = signals[0] ?? null;
  // Derived from the strongest signal, NOT from the numeric score. A pile of weak
  // hits can push a score up; it cannot make the fit strong.
  const fitBand: FitBand = strongest ? strongest.strength : 'weak';
  const strongCount = signals.filter((s) => s.strength === 'strong').length;
  const moderateCount = signals.filter((s) => s.strength === 'moderate').length;

  return {
    fitBand,
    fitLabel: FIT_BAND_LABELS[fitBand],
    strongest,
    signals,
    // The same floor the producers and P06 use: one strong, or two moderate.
    weakOnly: strongCount === 0 && moderateCount < 2,
  };
}
