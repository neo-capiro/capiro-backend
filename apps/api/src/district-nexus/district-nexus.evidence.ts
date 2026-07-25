/**
 * District Nexus — record-level evidence rows (Rev 2 plan, WS-E Step E4).
 *
 * Deliberately I/O-free, matching `district-nexus.aggregate.ts`'s split: the
 * service fetches rows, this module decides what each row MEANS as evidence.
 *
 * `foldDistricts`/`evidenceForDistrict` work in aggregates — SUM/GROUP BY over
 * a district — and have no per-record identity left to point back to. Evidence
 * needs the opposite: one row per federal_award / federal_assistance_award /
 * client_facilities record, carrying enough of itself that a person can verify
 * the claim rather than trust the score. Hence a separate module and a separate
 * (record-level) query shape from the aggregate rails.
 *
 * Scope, restated from the NexusEvidence docblock: this only covers the
 * components that earn score credit today (facility, employees, contract,
 * awarded grant). Grant opportunities contribute zero credit by rule 3
 * (district-nexus-scoring.ts) — there is no "point" for one to trace back to —
 * so they are not mapped to NexusEvidence here.
 *
 * A second boundary, easy to get wrong: the caller MUST fetch rows already
 * filtered to the same confirmed contractor/recipient identifiers that fed the
 * score being explained — never every award in a district regardless of client
 * match. `district-nexus.controller`'s district-detail endpoint separately
 * exposes an UNSCOPED "top awards in this district" list for browsing, which
 * is a different feature (activity, not evidence) and must not be the source
 * for these mappers — an award nobody's client is tied to cannot "explain" a
 * client's score no matter how large it is.
 */
import { districtKeyFor } from './district-nexus.aggregate.js';
import type { DistrictKey, NexusEvidence } from './district-nexus.types.js';

/** Per-district-per-rail cap, matching the existing topContractAwards/topGrantAwards precedent. */
export const EVIDENCE_CAP_PER_DISTRICT = 10;

export interface ContractEvidenceSourceRow {
  id: string;
  contractorName: string | null;
  state: string | null;
  /** Raw pop_congressional_district, before districtKeyFor normalizes it. */
  district: string | null;
  amount: number | null;
  actionDate: string | null;
  lastSyncedAt: string | null;
}

export interface AssistanceEvidenceSourceRow {
  id: string;
  recipientUei: string | null;
  recipientName: string | null;
  state: string | null;
  district: string | null;
  basis: 'place_of_performance' | 'recipient_location';
  totalObligated: number | null;
  startDate: string | null;
  lastSyncedAt: string | null;
  /** federal_assistance_award.pop_cd_vintage — 'original' | 'current' | null. */
  popCdVintage: string | null;
}

export interface FacilityEvidenceSourceRow {
  id: string;
  name: string;
  state: string | null;
  districtCode: string | null;
  employeeCount: number | null;
  /** 'matched' | 'no_match' | 'ambiguous' | 'error' | null. */
  geocodeStatus: string | null;
  /** 'user' | 'geocoded' | 'web_import' | null. */
  districtSource: string | null;
  updatedAt: string | null;
}

/**
 * Contracts are matched to a client by contractor NAME — there is no UEI path
 * for the contract rail (the plan's own callout: "the legacy contract rail
 * joins by contractor name; keep it, label it." This is the label). So every
 * contract evidence row is honestly `inferred`, and `federal_award` carries no
 * CD-vintage column at all, so `boundaryVintage` is honestly `unknown` rather
 * than assumed `original`.
 */
export function contractRowToEvidence(
  row: ContractEvidenceSourceRow,
): { districtKey: DistrictKey; evidence: NexusEvidence } | null {
  const districtKey = districtKeyFor(row.state, row.district);
  if (!districtKey) return null;
  return {
    districtKey,
    evidence: {
      component: 'contractPlaceOfPerformance',
      sourceType: 'federal_award',
      label: row.contractorName ?? 'Federal contract award',
      sourceRecordId: row.id,
      sourceUpdatedAt: row.lastSyncedAt,
      observedAt: row.actionDate,
      geographyBasis: 'place_of_performance',
      verificationStatus: 'inferred',
      confidence: null,
      externalUseApproved: true,
      boundaryVintage: 'unknown',
      amount: row.amount,
    },
  };
}

/**
 * Assistance rows carry a real verified-identifier path (UEI), unlike
 * contracts. `matchedUeis` is the client's own confirmed-UEI set (already
 * uppercased, as `isUeiShaped`/`dedupe` produce it in the service) — a row
 * whose `recipientUei` is in that set is source-verified; anything else that
 * still matched (by name only) is inferred, exactly the same distinction
 * `evidenceForDistrict`'s `EvidenceStrength` draws for the basis itself, kept
 * separate here because verification and geography-strength are different axes.
 */
export function assistanceRowToEvidence(
  row: AssistanceEvidenceSourceRow,
  matchedUeis: ReadonlySet<string>,
): { districtKey: DistrictKey; evidence: NexusEvidence } | null {
  const districtKey = districtKeyFor(row.state, row.district);
  if (!districtKey) return null;
  const matchedByUei = !!row.recipientUei && matchedUeis.has(row.recipientUei.toUpperCase());
  const vintage: NexusEvidence['boundaryVintage'] =
    row.popCdVintage === 'original' || row.popCdVintage === 'current' ? row.popCdVintage : 'unknown';
  return {
    districtKey,
    evidence: {
      component: 'grantPlaceOfPerformance',
      sourceType: 'federal_assistance_award',
      label: row.recipientName ?? 'Federal assistance award',
      sourceRecordId: row.id,
      sourceUpdatedAt: row.lastSyncedAt,
      observedAt: row.startDate,
      geographyBasis: row.basis,
      verificationStatus: matchedByUei ? 'source_verified' : 'inferred',
      confidence: matchedByUei ? 1 : null,
      externalUseApproved: true,
      boundaryVintage: vintage,
      amount: row.totalObligated,
    },
  };
}

/** How a hand-typed or web-imported district claim is trusted, absent a geocode. */
function facilityVerificationStatus(row: FacilityEvidenceSourceRow): {
  status: 'geocode_verified' | 'user_provided';
  confidence: number | null;
} {
  if (row.districtSource === 'geocoded' || row.geocodeStatus === 'matched') {
    return { status: 'geocode_verified', confidence: 1 };
  }
  // 'user' and 'web_import' are both unconfirmed client-asserted district
  // claims — web_import is machine-parsed rather than hand-typed, but neither
  // has been independently checked against a geocoder, so both get the same
  // (weaker) trust tier rather than a third, unsupported confidence tier.
  return { status: 'user_provided', confidence: null };
}

/**
 * One facility backs up to TWO scoring components — its mere existence
 * (`verifiedFacility`) and, separately, its headcount (`verifiedEmployees`).
 * Those are independently weighted in the score, so a person asking "why do we
 * get facility credit" and "why do we get employee credit" need independently
 * inspectable answers, not one blended row. `employees` is null when the
 * facility reported no headcount — the caller must not synthesize a $0/zero row
 * for it (null means "we don't know", not "there are none").
 *
 * Facility data is client-supplied, never government-published, so
 * `externalUseApproved` is always false here — see plan §8.5 and the deferred
 * §6.3 evidence-approval table. `geographyBasis` is always 'facility';
 * `boundaryVintage` is 'current' because a facility's district is read against
 * whatever map is live today, not an as-reported historical vintage.
 */
export function facilityRowToEvidence(
  row: FacilityEvidenceSourceRow,
): { districtKey: DistrictKey; facility: NexusEvidence; employees: NexusEvidence | null } | null {
  const districtKey = districtKeyFor(row.state, row.districtCode);
  if (!districtKey) return null;
  const { status, confidence } = facilityVerificationStatus(row);

  const facility: NexusEvidence = {
    component: 'verifiedFacility',
    sourceType: 'client_facility',
    label: row.name,
    sourceRecordId: row.id,
    sourceUpdatedAt: row.updatedAt,
    observedAt: row.updatedAt,
    geographyBasis: 'facility',
    verificationStatus: status,
    confidence,
    externalUseApproved: false,
    boundaryVintage: 'current',
    amount: null,
  };

  const employees: NexusEvidence | null =
    row.employeeCount == null
      ? null
      : {
          ...facility,
          component: 'verifiedEmployees',
          label: `${row.name} — ${row.employeeCount} employees`,
          amount: null,
        };

  return { districtKey, facility, employees };
}
