/**
 * District Nexus — the ONE place a row's verification tier is decided.
 *
 * Before this module the same judgement lived twice and disagreed. The evidence
 * layer (district-nexus.evidence.ts) honestly labelled a name-matched contract
 * `inferred`, while the scoring adapter (district-nexus.aggregate.ts) handed
 * every contract full `sourceAuthoritative` credit. A user could open "Evidence
 * and sources", read "Name match only", and still see the score a verified
 * identifier would have earned. The explanation was honest; the number was not.
 *
 * So both axes are derived here, from the same inputs:
 *
 *   - `EvidenceVerificationStatus` — what a human reading one row should believe.
 *   - `EvidenceStrength`           — how many score points that justifies.
 *
 * They remain two axes (a geographic fallback is not a trust judgement), but they
 * are no longer two independent opinions.
 *
 * NOTE ON COMPOUNDING: a grant can be weak on BOTH axes — matched by name AND
 * geolocated from recipient location. Those are not multiplied. The scoring
 * module holds exactly one multiplier per component so that `breakdown` accounts
 * for all 100 points (rule 5), and `weakerStrength` is the established way to
 * collapse several qualities into one claim. Compounding is a calibration
 * decision, not a bug fix — see the plan's §6.
 */
import { weakerStrength, type EvidenceStrength } from './district-nexus-scoring.js';
import type { EvidenceVerificationStatus } from './district-nexus.types.js';

/** How a client was tied to an assistance award. */
export type AssistanceMatchBasis = 'uei' | 'recipient_name';

/** How a facility's district claim was established. */
export interface FacilityTrustInput {
  /** 'matched' | 'no_match' | 'ambiguous' | 'error' | null. */
  geocodeStatus: string | null;
  /** 'user' | 'geocoded' | 'web_import' | null. */
  districtSource: string | null;
}

export interface VerificationTier {
  status: EvidenceVerificationStatus;
  strength: EvidenceStrength;
  /** 0-1 when a real computed confidence exists; null rather than a fabricated one. */
  confidence: number | null;
}

/**
 * Contracts have NO verified-identifier path: `federal_award` is joined on
 * `contractor_name` and nothing else (see aggregateContracts). So every contract
 * attribution is honestly inferred. When a UEI rail is added for contracts, this
 * is the one function to change.
 */
export const CONTRACT_TIER: VerificationTier = Object.freeze({
  status: 'inferred',
  strength: 'inferred',
  confidence: null,
});

/** UEI is a verified external identifier; a recipient-name hit is not. */
export function assistanceTier(basis: AssistanceMatchBasis): VerificationTier {
  return basis === 'uei'
    ? { status: 'source_verified', strength: 'sourceAuthoritative', confidence: 1 }
    : { status: 'inferred', strength: 'inferred', confidence: null };
}

/**
 * A geocoded district is independently confirmed. 'user' and 'web_import' are
 * both unconfirmed client-asserted claims — web_import is machine-parsed rather
 * than hand-typed, but neither has been checked against a geocoder, so both get
 * the same weaker tier rather than a third unsupported one.
 */
export function facilityTier(row: FacilityTrustInput): VerificationTier {
  if (row.districtSource === 'geocoded' || row.geocodeStatus === 'matched') {
    return { status: 'geocode_verified', strength: 'verified', confidence: 1 };
  }
  return { status: 'user_provided', strength: 'userProvided', confidence: null };
}

/**
 * A ClientGrantNexus row's own review state (WS-E / audit F4).
 * `verificationStatus` is a free-text column defaulting to 'unverified'; only an
 * explicit 'verified' earns the verified tier. 'rejected' must be filtered out
 * by the CALLER before it ever reaches here — a rejected relationship is not
 * weak evidence, it is not evidence.
 */
export function relationshipTier(verificationStatus: string | null): VerificationTier {
  return verificationStatus === 'verified'
    ? { status: 'source_verified', strength: 'verified', confidence: 1 }
    : { status: 'user_provided', strength: 'userProvided', confidence: null };
}

/** Collapse several tiers' strengths into the one a component can claim. */
export function weakestStrength(strengths: EvidenceStrength[]): EvidenceStrength {
  return strengths.reduce<EvidenceStrength>(
    (acc, s) => weakerStrength(acc, s),
    'verified',
  );
}

/**
 * Which scoring component a ClientGrantNexus relationship role speaks to
 * (audit F4).
 *
 * `direct_recipient` / `subrecipient` / `project_site` are claims about
 * awarded grant money landing in a district — the same component the
 * assistance-award rail feeds. The rest are claims about a partner or
 * beneficiary relationship, which is a genuinely different kind of evidence
 * with its own weight (`partnerBeneficiary`, 10 points) — wiring them here is
 * what lifts the achievable coverage ceiling above 65%.
 */
export function componentForRelationship(
  relationshipType: string,
): 'grantPlaceOfPerformance' | 'partnerBeneficiary' | null {
  switch (relationshipType) {
    case 'direct_recipient':
    case 'subrecipient':
    case 'project_site':
      return 'grantPlaceOfPerformance';
    case 'research_partner':
    case 'coalition_partner':
    case 'beneficiary':
    case 'matching_contributor':
      return 'partnerBeneficiary';
    default:
      return null;
  }
}

/**
 * Whether a role may claim an award's full obligation/outlay when the
 * reviewer stated no `attributableAmount`. Every other role contributes
 * PRESENCE, not dollars — claiming the whole award for a partial role would
 * be exactly the overstatement this rail exists to avoid.
 */
export function claimsFullAwardAmount(relationshipType: string): boolean {
  return relationshipType === 'direct_recipient';
}
