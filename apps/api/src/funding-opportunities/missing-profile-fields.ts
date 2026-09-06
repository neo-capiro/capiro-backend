/**
 * Funding Opportunities — "what would make this matching better".
 *
 * Pure and I/O-free. Exists because "no opportunities matched" is an answer a
 * user can do nothing with, while "no opportunities matched, and this client has
 * no NAICS codes, which is what contract matching keys on" is actionable.
 *
 * ── Why this is computed, not authored ──────────────────────────────────────
 *
 * Every entry corresponds to a field a relevance signal actually reads. If a
 * signal is added or removed, this list has to move with it or the UI starts
 * telling users to fill in something that changes nothing. The signal each entry
 * feeds is named in its `impact` string so the connection is visible at the point
 * of maintenance, not just in a design doc.
 *
 * `href` points at the real settings surface. A gap with nowhere to go is a
 * complaint, not guidance.
 */
import type { MissingProfileField, OpportunitySource } from './funding-opportunities.types.js';

/** The client facts every gap check reads. Booleans/counts only — no PII. */
export interface ProfileCompleteness {
  clientId: string;
  hasUei: boolean;
  hasCageCode: boolean;
  naicsCount: number;
  pscCount: number;
  applicantTypeCount: number;
  capabilityCount: number;
  fundingPriorityCount?: number;
  facilityCount: number;
  hasSector: boolean;
  /** Confirmed `contracting` ClientIntelMapping rows — the contractor identity. */
  confirmedContractorMappings: number;
  /** Prior federal-assistance history reachable from confirmed identities. */
  priorAssistanceListingCount: number;
  priorAgencyCount: number;
  /** `ClientCapability.peNumbers` across the client's capabilities. */
  programElementCount: number;
}

function clientSettingsHref(clientId: string): string {
  // The client workspace is a single route with the client selected; the profile
  // fields (UEI/CAGE/NAICS/PSC/applicant types/capabilities/facilities) are all
  // edited from there. Deliberately not a deep anchor: anchors on that page are
  // not stable and a dead anchor is worse than the page itself.
  return `/clients?client=${encodeURIComponent(clientId)}`;
}

function mappingsHref(clientId: string): string {
  return `/settings/intelligence-mappings?source=contracting&clientId=${encodeURIComponent(clientId)}`;
}

/**
 * Gaps that matter for the given source (or both when `source` is omitted).
 *
 * Scoped by source on purpose: telling somebody looking at grant opportunities
 * that their PSC codes are missing is noise — PSC feeds no grant signal.
 *
 * Ordered most-actionable-first for the selected rail so the UI's "complete
 * these fields" list starts with what unlocks the strongest signals, not an
 * arbitrary field-enumeration order.
 */
export function missingProfileFields(
  p: ProfileCompleteness,
  source?: OpportunitySource,
): MissingProfileField[] {
  const wantGrants = source === undefined || source === 'grants_gov';
  const wantSam = source === undefined || source === 'sam_gov';
  const out: MissingProfileField[] = [];

  // Contractor identity first when SAM is in play: without it agency-history is
  // permanently silent even for clients that already hold a UEI.
  if (wantSam && p.confirmedContractorMappings === 0) {
    out.push({
      field: 'contractorIdentity',
      label: p.hasUei
        ? 'Confirm federal contractor identity (UEI on file)'
        : 'Confirmed federal contractor identity',
      impact: p.hasUei
        ? 'This client already has a UEI, but no accepted contracting mapping links it to federal award history. Until that mapping is confirmed, the agency-history and contracting-office signals stay silent and pursue confidence cannot rise on prior awards.'
        : 'Without a confirmed contractor identity, this client has no award history, so the agency-history and contracting-office signals have nothing to compare against.',
      href: mappingsHref(p.clientId),
    });
  }

  if (wantSam && p.naicsCount === 0) {
    out.push({
      field: 'naicsCodes',
      label: 'NAICS codes',
      impact:
        'NAICS is the strongest contract-matching signal. With none recorded, contract opportunities can only match on PSC, agency history or capability text. Prefer full 6-digit codes; shorter industry codes still match within their prefix but exact identity is stronger.',
      href: clientSettingsHref(p.clientId),
    });
  }

  if (wantSam && p.pscCount === 0) {
    out.push({
      field: 'pscCodes',
      label: 'PSC codes',
      impact:
        'Product/Service Codes are how SAM.gov classifies what is being bought; without them the product-and-service-category signal cannot fire. Most active notices carry a PSC — missing this field is the single largest structured gap after NAICS.',
      href: clientSettingsHref(p.clientId),
    });
  }

  if (wantGrants && p.applicantTypeCount === 0) {
    out.push({
      field: 'applicantTypes',
      label: 'Organization types',
      impact:
        'Select the organization types this client actually qualifies as so grant applicant eligibility can be checked. Organization type does not increase the relevance score. “Unrestricted” and “Other” describe opportunity rules and do not establish client identity.',
      href: clientSettingsHref(p.clientId),
    });
  }

  if (p.capabilityCount === 0 && (p.fundingPriorityCount ?? 0) === 0) {
    out.push({
      field: 'capabilities',
      label: 'Capabilities or funding priorities',
      impact:
        'Add concrete capabilities or funding priorities, such as “battery recycling” or “rural broadband.” Matching checks these phrases against notice text alongside codes, sector and award history. Broad terms such as “funding” or “services” do not establish fit.',
      href: clientSettingsHref(p.clientId),
    });
  }

  if (
    p.confirmedContractorMappings > 0 &&
    p.priorAgencyCount === 0 &&
    p.priorAssistanceListingCount === 0
  ) {
    out.push({
      field: 'awardHistory',
      label: 'Federal award history',
      impact:
        'A contractor identity is confirmed, but no awards resolve from it — the agency, office and Assistance Listing signals stay silent until ingestion finds award records for it.',
      href: mappingsHref(p.clientId),
    });
  }

  if (p.facilityCount === 0) {
    out.push({
      field: 'facilities',
      label: 'Facilities / project sites',
      impact:
        'Facilities supply the state list used for geographic matching, and a facility is the only way an opportunity can ever be tied to a congressional district.',
      href: clientSettingsHref(p.clientId),
    });
  }

  if (!p.hasUei) {
    out.push({
      field: 'uei',
      label: 'UEI',
      impact:
        'A UEI is the only identifier that can confirm a federal contractor identity automatically. Without it, every candidate needs manual review.',
      href: clientSettingsHref(p.clientId),
    });
  }

  return out;
}

/**
 * Is the profile too thin for matching to mean anything?
 *
 * The threshold is deliberately about SIGNAL SOURCES, not field count: a client
 * with codes but no capabilities can still match on codes, and one with
 * capabilities but no codes can still match on text. A client with none of
 * NAICS, PSC, capabilities, funding priorities OR award history has no fit
 * signal reads, so "no matches" says nothing about the opportunity universe —
 * and the UI must say THAT rather than implying the market is empty.
 */
export function profileIsTooThin(p: ProfileCompleteness): boolean {
  return (
    p.naicsCount === 0 &&
    p.pscCount === 0 &&
    p.capabilityCount === 0 &&
    (p.fundingPriorityCount ?? 0) === 0 &&
    p.priorAssistanceListingCount === 0 &&
    p.priorAgencyCount === 0
  );
}
