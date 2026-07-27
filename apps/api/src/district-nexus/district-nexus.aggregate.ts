/**
 * District Nexus — pure aggregation core (Rev 2 plan, WS-E Steps E3/E4).
 *
 * Deliberately I/O-free. DistrictNexusService does the batched gathering and
 * hands the raw rows in here; everything that decides what a number *means*
 * lives in this file, so it is unit-testable without a database. That matters
 * more than usual here: the Aurora instance is private-subnet / ECS-only, so
 * an integration test against real data is not available to a local run.
 *
 * The rules encoded below are §5.3 (source precedence) and §8.2 (award
 * geography), which together decide which district a dollar is attributed to
 * and how much that attribution is worth.
 */
import { districtCodeForHouseMatch, normalizeDistrictCode } from '../common/district-code.util.js';
import {
  scoreNexus,
  weakerStrength,
  compoundStrength,
  type NexusComponentEvidence,
  type NexusComponentKey,
  type EvidenceStrength,
} from './district-nexus-scoring.js';
import {
  CONTRACT_TIER,
  assistanceTier,
  facilityTier,
  type AssistanceMatchBasis,
} from './district-nexus.verification.js';
import type {
  AwardedFunding,
  ClientDistrictNexusResponse,
  ClientFacilityFootprint,
  ClientNexusLinkage,
  ClientOpportunitySummary,
  DataQualityWarning,
  DistrictClientSummary,
  DistrictKey,
  DistrictNexusDistrictDetail,
  FacilityRepresentation,
  OpportunityFunding,
  GeographyBasis,
  NexusEvidence,
  SourceFreshness,
  UnmappedFunding,
} from './district-nexus.types.js';

// GeographyBasis lives in district-nexus.types.ts (the plan's full §7-E4
// vocabulary) — re-exported here so existing importers of this module are
// unaffected by the move.
export type { GeographyBasis };

export interface ContractDistrictRow {
  state: string | null;
  district: string | null;
  awardCount: number;
  totalAmount: number;
}

export interface AssistanceDistrictRow {
  state: string | null;
  district: string | null;
  /** 'place_of_performance' when pop_* was present, else 'recipient_location'. */
  basis: 'place_of_performance' | 'recipient_location';
  /**
   * How this row matched the client. Optional so existing specs keep
   * compiling; absent defaults to 'recipient_name' — the conservative
   * direction, since it discounts rather than inflates strength.
   */
  matchBasis?: AssistanceMatchBasis;
  awardCount: number;
  totalObligated: number;
  totalOutlayed: number;
}

export interface OpportunityRow {
  state: string | null;
  district: string | null;
  estimatedFunding: number | null;
  awardCeiling: number | null;
}

export interface FacilityRow {
  state: string | null;
  districtCode: string | null;
  employeeCount: number | null;
  /**
   * How the district claim was established. Optional so existing specs keep
   * compiling; absent is treated as UNCONFIRMED (the honest reading of "the
   * caller did not tell us"), never as geocoded.
   */
  geocodeStatus?: string | null;
  districtSource?: string | null;
}

/**
 * One reviewed ClientGrantNexus relationship (audit F4), already resolved to
 * a district and a scoring component by the caller — the facility >
 * place-of-performance > recipient-location precedence needs the linked
 * award and facility rows, which this I/O-free module deliberately has no
 * access to. See district-nexus.service.ts's aggregateRelationshipNexus.
 */
export interface RelationshipNexusRow {
  clientId: string;
  state: string | null;
  district: string | null;
  /** 'grantPlaceOfPerformance' for recipient-shaped roles, 'partnerBeneficiary' otherwise. */
  component: 'grantPlaceOfPerformance' | 'partnerBeneficiary';
  /** Null when the role is partial and no attributable share was stated. */
  obligatedAmount: number | null;
  outlayedAmount: number | null;
  strength: EvidenceStrength;
  geographyBasis: GeographyBasis;
}

export interface ClientNexusInputs {
  clientId: string;
  contracts: ContractDistrictRow[];
  assistance: AssistanceDistrictRow[];
  opportunities: OpportunityRow[];
  facilities: FacilityRow[];
  freshness: SourceFreshness[];
  generatedAt: string;
  /** Already-resolved representation, batched by the caller. Defaults to []. */
  representativesByFacility?: FacilityRepresentation[];
  /**
   * Record-level evidence (WS-E4), already built and grouped by the district it
   * belongs to. The fold above works in aggregates (SUM/GROUP BY); it has no
   * per-record identity to build evidence from, so the caller fetches and maps
   * individual rows separately and hands them in pre-grouped. Defaults to [].
   */
  evidenceByDistrict?: Map<DistrictKey, NexusEvidence[]>;
  /**
   * Confirmed-mapping status, resolved by the caller inside `withTenant`.
   * Optional so the existing specs keep compiling; defaults to "nothing
   * linked", which is the honest reading of "the caller did not tell us".
   */
  linkage?: ClientNexusLinkage;
  /**
   * The client's own opportunity pipeline (WS-F), computed separately from the
   * district fold — see district-nexus.service.ts's aggregateOpportunitySummary.
   * Optional so existing specs keep compiling; defaults to the honest empty
   * summary below.
   */
  opportunitySummary?: ClientOpportunitySummary;
  /**
   * Reviewed ClientGrantNexus relationships (audit F4) — see
   * district-nexus.service.ts's aggregateRelationshipNexus. Optional so
   * existing specs keep compiling; defaults to [].
   */
  relationships?: RelationshipNexusRow[];
}

/**
 * A second copy of the empty-summary constant is intentional: this module is
 * I/O-free and must not import from district-nexus.service.ts (which owns the
 * identically-shaped EMPTY_OPPORTUNITY_SUMMARY used when the DB has no rows).
 */
const EMPTY_CLIENT_OPPORTUNITY_SUMMARY: ClientOpportunitySummary = Object.freeze({
  activeOpportunityCount: 0,
  closedOpportunityCount: 0,
  totalEstimatedFunding: null,
  maximumAwardCeiling: null,
  topOpportunities: [],
});

/**
 * A district key, or null when the row cannot honestly be pinned to one.
 *
 * `districtCodeForHouseMatch` collapses the sentinels (90 multi-district, 98
 * non-voting delegate, ZZ undefined) to null. Those are NOT districts, and the
 * legacy representative overlay already refuses to resolve a House member for
 * them — attributing spend to them here while refusing to name a
 * representative would be internally inconsistent.
 */
export function districtKeyFor(state: string | null, district: string | null): DistrictKey | null {
  if (!state) return null;
  const code = districtCodeForHouseMatch(district);
  if (!code) return null;
  return `${state}-${code}`;
}

/** True when the row has a state but no district-resolvable code — statewide money. */
export function isStatewide(state: string | null, district: string | null): boolean {
  if (!state) return false;
  return districtCodeForHouseMatch(district) === null && normalizeDistrictCode(district) !== null;
}

export interface DistrictAccumulator {
  districtKey: DistrictKey;
  state: string;
  districtCode: string;
  contractObligations: number | null;
  grantObligations: number | null;
  grantOutlays: number | null;
  opportunityEstimatedFunding: number | null;
  opportunityAwardCeiling: number | null;
  facilityCount: number;
  employeeCount: number | null;
  /**
   * Facilities here that reported no headcount. Keeps "420 employees across the
   * two sites that told us" distinguishable from "420 employees, complete".
   */
  facilitiesMissingEmployeeCount: number;
  /** Weakest basis seen for money in this district — drives the score discount. */
  assistanceBasis: 'place_of_performance' | 'recipient_location' | null;
  /**
   * Weakest verification tier seen per rail in this district. `null` means the
   * rail contributed nothing. These are what carry "matched by name" into the
   * SCORE, not just into the evidence table — see district-nexus.verification.ts.
   */
  contractStrength: EvidenceStrength | null;
  grantStrength: EvidenceStrength | null;
  facilityStrength: EvidenceStrength | null;
  partnerStrength: EvidenceStrength | null;
  /** Records backing partnerBeneficiary, for the breakdown's evidenceCount. */
  partnerEvidenceCount: number;
  warnings: DataQualityWarning[];
}

function emptyAccumulator(key: DistrictKey): DistrictAccumulator {
  const [state = '', districtCode = ''] = key.split('-');
  return {
    districtKey: key,
    state,
    districtCode,
    // null, not 0 — "no figure" is not "zero dollars". Only a contributing row
    // promotes these to a number.
    contractObligations: null,
    grantObligations: null,
    grantOutlays: null,
    opportunityEstimatedFunding: null,
    opportunityAwardCeiling: null,
    facilityCount: 0,
    employeeCount: null,
    facilitiesMissingEmployeeCount: 0,
    assistanceBasis: null,
    contractStrength: null,
    grantStrength: null,
    facilityStrength: null,
    partnerStrength: null,
    partnerEvidenceCount: 0,
    warnings: [],
  };
}

/** Adds `value` to a null-or-number accumulator, promoting null to a real number. */
function addMoney(current: number | null, value: number | null): number | null {
  if (value == null) return current;
  return (current ?? 0) + value;
}

/**
 * Fold every rail into per-district totals plus the amounts that could not be
 * attributed to any district.
 *
 * Unmapped money is returned rather than dropped: a district breakdown that
 * quietly omits 40% of the spend is a wrong answer delivered confidently, and
 * §8.2 requires statewide awards to be visible as statewide rather than
 * silently smeared across a state's districts.
 */
export function foldDistricts(inputs: ClientNexusInputs): {
  districts: DistrictAccumulator[];
  unmapped: UnmappedFunding;
  warnings: DataQualityWarning[];
} {
  const byKey = new Map<DistrictKey, DistrictAccumulator>();
  const warnings: DataQualityWarning[] = [];
  let unmappedContractAmount: number | null = null;
  let unmappedGrantAmount: number | null = null;

  const upsert = (key: DistrictKey): DistrictAccumulator => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const fresh = emptyAccumulator(key);
    byKey.set(key, fresh);
    return fresh;
  };

  let sawStatewideContract = false;
  let sawStatewideGrant = false;

  for (const row of inputs.contracts) {
    const key = districtKeyFor(row.state, row.district);
    if (!key) {
      unmappedContractAmount = addMoney(unmappedContractAmount, row.totalAmount);
      if (isStatewide(row.state, row.district)) sawStatewideContract = true;
      continue;
    }
    const acc = upsert(key);
    acc.contractObligations = addMoney(acc.contractObligations, row.totalAmount);
    acc.contractStrength = weakerStrength(acc.contractStrength ?? 'verified', CONTRACT_TIER.strength);
  }

  for (const row of inputs.assistance) {
    const key = districtKeyFor(row.state, row.district);
    if (!key) {
      unmappedGrantAmount = addMoney(unmappedGrantAmount, row.totalObligated);
      if (isStatewide(row.state, row.district)) sawStatewideGrant = true;
      continue;
    }
    const acc = upsert(key);
    acc.grantObligations = addMoney(acc.grantObligations, row.totalObligated);
    acc.grantOutlays = addMoney(acc.grantOutlays, row.totalOutlayed);
    // Keep the WEAKEST basis: one recipient-location row means the district
    // total is no longer purely place-of-performance evidence.
    if (row.basis === 'recipient_location' || acc.assistanceBasis === 'recipient_location') {
      acc.assistanceBasis = 'recipient_location';
    } else {
      acc.assistanceBasis = 'place_of_performance';
    }
    // Two independent weaknesses on this ROW (name match, recipient location)
    // multiply rather than collapsing to the weaker one alone (Neo, 2026-07-27
    // calibration decision — see compoundStrength's docblock). rowStrength is
    // then POOLED with other rows via weakerStrength, which is the separate,
    // unchanged rule for combining across records.
    const rowStrength = compoundStrength(
      assistanceTier(row.matchBasis ?? 'recipient_name').strength,
      row.basis === 'recipient_location' ? 'recipientLocation' : 'sourceAuthoritative',
    );
    acc.grantStrength = weakerStrength(acc.grantStrength ?? 'verified', rowStrength);
  }

  for (const row of inputs.opportunities) {
    const key = districtKeyFor(row.state, row.district);
    if (!key) continue; // Opportunities are forecasts; unmapped ones are noise.
    const acc = upsert(key);
    acc.opportunityEstimatedFunding = addMoney(acc.opportunityEstimatedFunding, row.estimatedFunding);
    acc.opportunityAwardCeiling = addMoney(acc.opportunityAwardCeiling, row.awardCeiling);
  }

  for (const row of inputs.facilities) {
    const key = districtKeyFor(row.state, row.districtCode);
    if (!key) continue;
    const acc = upsert(key);
    acc.facilityCount += 1;
    acc.employeeCount = addMoney(acc.employeeCount, row.employeeCount);
    if (row.employeeCount == null) acc.facilitiesMissingEmployeeCount += 1;
    acc.facilityStrength = weakerStrength(
      acc.facilityStrength ?? 'verified',
      facilityTier({ geocodeStatus: row.geocodeStatus ?? null, districtSource: row.districtSource ?? null }).strength,
    );
  }

  for (const row of inputs.relationships ?? []) {
    const key = districtKeyFor(row.state, row.district);
    if (!key) {
      // A relationship with no resolvable district is real but unplaceable.
      // Its money joins the unmapped bucket rather than vanishing.
      if (row.component === 'grantPlaceOfPerformance') {
        unmappedGrantAmount = addMoney(unmappedGrantAmount, row.obligatedAmount);
      }
      continue;
    }
    const acc = upsert(key);
    if (row.component === 'grantPlaceOfPerformance') {
      acc.grantObligations = addMoney(acc.grantObligations, row.obligatedAmount);
      acc.grantOutlays = addMoney(acc.grantOutlays, row.outlayedAmount);
      acc.grantStrength = weakerStrength(acc.grantStrength ?? 'verified', row.strength);
      if (row.geographyBasis === 'recipient_location') acc.assistanceBasis = 'recipient_location';
      else if (acc.assistanceBasis == null) acc.assistanceBasis = 'place_of_performance';
    } else {
      acc.partnerStrength = weakerStrength(acc.partnerStrength ?? 'verified', row.strength);
    }
    // Presence counts even when no dollar share was stated — that is the whole
    // point of a partial-role relationship.
    acc.partnerEvidenceCount += row.component === 'partnerBeneficiary' ? 1 : 0;
  }

  if (sawStatewideContract || sawStatewideGrant) {
    warnings.push({
      code: 'statewide_attribution',
      message:
        'Some awards are recorded statewide and cannot be attributed to a single district. They are reported as unmapped rather than spread across districts.',
    });
  }
  if (unmappedContractAmount != null || unmappedGrantAmount != null) {
    warnings.push({
      code: 'unmapped_amount',
      message: 'Some funding could not be attributed to a district — see the unmapped totals.',
    });
  }

  return {
    districts: [...byKey.values()],
    unmapped: { unmappedContractAmount, unmappedGrantAmount },
    warnings,
  };
}

/**
 * Turn one district's accumulated facts into scoring evidence.
 *
 * Only components this aggregation layer can actually speak to are populated.
 * Everything else is left absent on purpose — per WS-F rule 1, an absent
 * component lowers coverage rather than scoring zero, which is what keeps
 * "we have no supplier data" from reading as "this client has no suppliers".
 */
export function evidenceForDistrict(
  acc: DistrictAccumulator,
): Partial<Record<NexusComponentKey, NexusComponentEvidence>> {
  const components: Partial<Record<NexusComponentKey, NexusComponentEvidence>> = {};

  if (acc.facilityCount > 0) {
    components.verifiedFacility = {
      // NOT a hardcoded 'verified'. A hand-typed or web-imported facility
      // district has never been checked against a geocoder, and the evidence
      // table already says so ("Client provided") — the score must agree.
      strength: acc.facilityStrength ?? 'userProvided',
      evidenceCount: acc.facilityCount,
    };
  }
  if (acc.employeeCount != null) {
    // A headcount is only as trustworthy as the facility it is attached to.
    components.verifiedEmployees = {
      strength: acc.facilityStrength ?? 'userProvided',
      evidenceCount: acc.facilityCount,
    };
  }
  if (acc.contractObligations != null) {
    // Always 'inferred' today: the contract rail joins on contractor_name only.
    components.contractPlaceOfPerformance = { strength: acc.contractStrength ?? 'inferred' };
  }
  if (acc.grantObligations != null) {
    components.grantPlaceOfPerformance = { strength: acc.grantStrength ?? 'inferred' };
  } else if (acc.opportunityEstimatedFunding != null) {
    // Opportunities alone: determinate knowledge worth zero awarded credit.
    components.grantPlaceOfPerformance = { strength: 'sourceAuthoritative', opportunityOnly: true };
  }
  if (acc.partnerStrength != null) {
    components.partnerBeneficiary = {
      strength: acc.partnerStrength,
      evidenceCount: acc.partnerEvidenceCount,
    };
  }

  return components;
}

/**
 * Union one client's per-district evidence into a single client-level view.
 *
 * ── Why pooling, and not an average of the per-district scores ───────────────
 *
 * The 0-100 scale is "credited share of a fixed 100 evidence-weight points",
 * and the ONLY thing implementing "missing data is never a verified zero" is the
 * coverage floor inside `scoreNexus` — below it the score is null. An award-only
 * district covers 10% and therefore scores null, and that is the common district
 * shape, not an edge case. So any average has to take a position on nulls, and
 * every available position is wrong:
 *
 *   - null treated as 0 converts "we refused to score this honestly" into a
 *     verified zero, and does so more confidently the thinner the evidence gets.
 *   - Skipping nulls breaks monotonicity: adding a facility to a thin district
 *     flips it from null to a low number and DROPS the client average, so more
 *     verified evidence produces a worse score.
 *   - An average over no scored districts is NaN or 0, and 0 is a verified zero.
 *
 * Independently fatal: `coveragePercent` cannot be averaged meaningfully, so an
 * averaged score has no coverage figure, so the floor cannot be applied at all —
 * rule 1 would have to be reimplemented outside the module that owns it. And a
 * mean-of-shares is not on the module's scale, so the score bands would be
 * applied to a quantity they were never calibrated against.
 *
 * Pooling calls `scoreNexus` exactly once on evidence unioned across districts.
 * Rule 1 is then enforced by the existing, tested mechanism unmodified, the
 * score is monotone non-decreasing in evidence, and `coveragePercent`,
 * `breakdown` and `strongestDrivers` become genuinely client-level — previously
 * they were computed from a single district's evidence while being labelled
 * client-level, which was a live honesty bug.
 *
 * ── The two hazards pooling introduces, and how they are handled ────────────
 *
 * 1. Strength laundering. Presence pools optimistically (a component is present
 *    if ANY district has it — a true statement about the client), but strength
 *    pools PESSIMISTICALLY: the weakest strength among the districts that
 *    actually have that component. Taking the strongest would turn a
 *    recipient-location-only grant into full-weight place-of-performance
 *    evidence. This mirrors the weakest-basis rule `foldDistricts` already
 *    applies within a single district.
 *
 * 2. Non-co-location. A facility in TX-23 plus a grant in CA-27 pool to credit
 *    that exists in no single district. The pooled number is therefore a
 *    FOOTPRINT score — "how well-evidenced is this client's district footprint"
 *    — and not a claim about any one district. Per-district truth stays in
 *    `districts[]`, and `bestDistrictKey` names the strongest single district.
 */
export function poolEvidence(
  accumulators: DistrictAccumulator[],
): Partial<Record<NexusComponentKey, NexusComponentEvidence>> {
  const pooled: Partial<Record<NexusComponentKey, NexusComponentEvidence>> = {};

  for (const acc of accumulators) {
    for (const [key, evidence] of Object.entries(evidenceForDistrict(acc)) as Array<
      [NexusComponentKey, NexusComponentEvidence]
    >) {
      const existing = pooled[key];
      if (!existing) {
        pooled[key] = { ...evidence };
        continue;
      }
      existing.strength = weakerStrength(existing.strength, evidence.strength);
      const count = (existing.evidenceCount ?? 0) + (evidence.evidenceCount ?? 0);
      if (count > 0) existing.evidenceCount = count;
      // Opportunity-only survives only while EVERY contributing district is
      // opportunity-only. One district with awarded money makes the client-level
      // claim awarded-backed.
      existing.opportunityOnly = existing.opportunityOnly === true && evidence.opportunityOnly === true;
    }
  }

  return pooled;
}

function awardedOf(acc: DistrictAccumulator): AwardedFunding {
  return {
    contractObligations: acc.contractObligations,
    grantObligations: acc.grantObligations,
    grantOutlays: acc.grantOutlays,
  };
}

function opportunitiesOf(acc: DistrictAccumulator): OpportunityFunding {
  return {
    opportunityEstimatedFunding: acc.opportunityEstimatedFunding,
    opportunityAwardCeiling: acc.opportunityAwardCeiling,
  };
}

function sumMoney(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length ? present.reduce((s, v) => s + v, 0) : null;
}

const NO_LINKAGE: ClientNexusLinkage = {
  contractingLinked: false,
  contractorNames: [],
  assistanceLinked: false,
  recipientNames: [],
  ueiConfirmedCount: 0,
};

/**
 * Footprint over ALL facilities, not just district-resolved ones — a facility
 * whose geocode failed still exists and still employs people, and reporting it
 * as absent would understate the client's footprint.
 */
function facilityFootprintOf(facilities: FacilityRow[]): ClientFacilityFootprint {
  let employeeCount: number | null = null;
  let facilitiesMissingEmployeeCount = 0;
  let facilitiesWithoutDistrict = 0;
  for (const f of facilities) {
    if (f.employeeCount == null) facilitiesMissingEmployeeCount += 1;
    else employeeCount = (employeeCount ?? 0) + f.employeeCount;
    if (districtKeyFor(f.state, f.districtCode) === null) facilitiesWithoutDistrict += 1;
  }
  return {
    facilityCount: facilities.length,
    facilitiesWithoutDistrict,
    employeeCount,
    facilitiesMissingEmployeeCount,
  };
}

/**
 * Build the WS-E Step E3 client response.
 *
 * Districts are sorted by score descending then contract obligations
 * descending, so the widget's first row is the strongest claim rather than
 * whichever district the database happened to return first.
 */
export function buildClientNexusResponse(
  inputs: ClientNexusInputs,
): ClientDistrictNexusResponse {
  const { districts: accumulators, unmapped, warnings } = foldDistricts(inputs);

  const districts: DistrictNexusDistrictDetail[] = accumulators.map((acc) => {
    const scored = scoreNexus({ components: evidenceForDistrict(acc) });
    return {
      districtKey: acc.districtKey,
      state: acc.state,
      districtCode: acc.districtCode,
      status: 'C',
      name: null,
      awarded: awardedOf(acc),
      opportunities: opportunitiesOf(acc),
      clientCount: 1,
      score: scored.score,
      coveragePercent: scored.coveragePercent,
      employeeCount: acc.employeeCount,
      employeesUnreported: acc.facilitiesMissingEmployeeCount > 0,
      warnings: [...acc.warnings, ...scored.warnings],
      evidence: inputs.evidenceByDistrict?.get(acc.districtKey) ?? [],
      breakdown: scored.breakdown,
      freshness: inputs.freshness,
    };
  });

  districts.sort((a, b) => {
    const scoreDelta = (b.score ?? -1) - (a.score ?? -1);
    if (scoreDelta !== 0) return scoreDelta;
    return (b.awarded.contractObligations ?? 0) - (a.awarded.contractObligations ?? 0);
  });

  // The client-level roll-up POOLS evidence across every district and scores it
  // once — see `poolEvidence` for why neither the best district nor an average
  // of per-district scores is a defensible client number. `bestDistrictKey`
  // keeps the strongest-single-district signal available as a fact.
  const clientScore = scoreNexus({ components: poolEvidence(accumulators) });
  const bestDistrictKey = districts.find((d) => d.score != null)?.districtKey ?? null;

  return {
    clientId: inputs.clientId,
    districts,
    representativesByFacility: inputs.representativesByFacility ?? [],
    linkage: inputs.linkage ?? NO_LINKAGE,
    opportunitySummary: inputs.opportunitySummary ?? EMPTY_CLIENT_OPPORTUNITY_SUMMARY,
    facilityFootprint: facilityFootprintOf(inputs.facilities),
    awarded: {
      contractObligations: sumMoney(districts.map((d) => d.awarded.contractObligations)),
      grantObligations: sumMoney(districts.map((d) => d.awarded.grantObligations)),
      grantOutlays: sumMoney(districts.map((d) => d.awarded.grantOutlays)),
    },
    opportunities: {
      opportunityEstimatedFunding: sumMoney(
        districts.map((d) => d.opportunities.opportunityEstimatedFunding),
      ),
      opportunityAwardCeiling: sumMoney(districts.map((d) => d.opportunities.opportunityAwardCeiling)),
    },
    unmapped,
    score: clientScore.score,
    bestDistrictKey,
    coveragePercent: clientScore.coveragePercent,
    breakdown: clientScore.breakdown,
    strongestDrivers: clientScore.strongestDrivers,
    freshness: inputs.freshness,
    warnings: [...warnings, ...clientScore.warnings],
    generatedAt: inputs.generatedAt,
  };
}

// ── District detail: per-client breakdown (audit F5) ───────────────────────

export interface DistrictClientBreakdownInputs {
  districtKey: DistrictKey;
  facilities: Array<{ clientId: string; clientName: string; employeeCount: number | null }>;
  /** Confirmed contractor/recipient identifiers, keyed by client. */
  byClient: ReadonlyMap<
    string,
    { clientName: string; contractorNames: string[]; recipientUeis: string[]; recipientNames: string[] }
  >;
  /** Firm-wide contract rows carrying the identifier each group matched on. */
  contractRows: Array<{ identifier: string | null; state: string | null; district: string | null; totalAmount: number }>;
  /** Firm-wide assistance rows carrying both identifiers a row could have matched. */
  assistanceRows: Array<{
    uei: string | null;
    nameLower: string | null;
    state: string | null;
    district: string | null;
    totalObligated: number;
    totalOutlayed: number;
  }>;
  relationships: Array<{
    clientId: string;
    clientName: string;
    state: string | null;
    district: string | null;
    component: 'grantPlaceOfPerformance' | 'partnerBeneficiary';
    obligatedAmount: number | null;
    outlayedAmount: number | null;
  }>;
}

/**
 * One district's "Clients in this district" breakdown (audit F5).
 *
 * A client belongs here if ANYTHING creates nexus in this district — a
 * facility, a matched contract, a matched award, or a reviewed relationship.
 * Seeding this from facilities alone (the pre-fix behaviour) hid every client
 * whose nexus is award geography, and left the Contracts/Grants columns
 * permanently em-dashed for the clients it did show, because nothing ever
 * populated them.
 *
 * The facility loop MUST run first: for a client with a facility but no
 * confirmed mapping, it is the only source of `clientName`, and `ensureClient`
 * only creates a fresh entry the first time a client is seen.
 */
export function buildDistrictClientBreakdown(
  inputs: DistrictClientBreakdownInputs,
): DistrictClientSummary[] {
  const clients = new Map<string, DistrictClientSummary>();
  const ensureClient = (clientId: string, clientName: string): DistrictClientSummary => {
    const existing = clients.get(clientId);
    if (existing) return existing;
    const fresh: DistrictClientSummary = {
      clientId,
      clientName,
      awarded: { contractObligations: null, grantObligations: null, grantOutlays: null },
      facilityCount: 0,
      employeeCount: null,
    };
    clients.set(clientId, fresh);
    return fresh;
  };

  for (const f of inputs.facilities) {
    const entry = ensureClient(f.clientId, f.clientName);
    entry.facilityCount += 1;
    if (f.employeeCount != null) entry.employeeCount = (entry.employeeCount ?? 0) + f.employeeCount;
  }

  for (const [clientId, ids] of inputs.byClient) {
    const names = new Set(ids.contractorNames);
    const ueis = new Set(ids.recipientUeis);
    const lowerNames = new Set(ids.recipientNames.map((n) => n.toLowerCase()));

    const contractTotal = inputs.contractRows
      .filter((r) => r.identifier != null && names.has(r.identifier))
      .filter((r) => districtKeyFor(r.state, r.district) === inputs.districtKey)
      .reduce<number | null>((sum, r) => (sum ?? 0) + r.totalAmount, null);

    const assistanceHere = inputs.assistanceRows
      .filter((r) => (r.uei != null && ueis.has(r.uei)) || (r.nameLower != null && lowerNames.has(r.nameLower)))
      .filter((r) => districtKeyFor(r.state, r.district) === inputs.districtKey);
    const grantObligations = assistanceHere.length
      ? assistanceHere.reduce((sum, r) => sum + r.totalObligated, 0)
      : null;
    const grantOutlays = assistanceHere.length
      ? assistanceHere.reduce((sum, r) => sum + r.totalOutlayed, 0)
      : null;

    if (contractTotal == null && grantObligations == null && !clients.has(clientId)) continue;
    const entry = ensureClient(clientId, ids.clientName);
    entry.awarded.contractObligations = contractTotal;
    entry.awarded.grantObligations = grantObligations;
    entry.awarded.grantOutlays = grantOutlays;
  }

  // Reviewed relationships (audit F4) can create nexus with neither a
  // facility nor a mapped identifier.
  for (const r of inputs.relationships) {
    if (districtKeyFor(r.state, r.district) !== inputs.districtKey) continue;
    const entry = ensureClient(r.clientId, r.clientName);
    if (r.component === 'grantPlaceOfPerformance' && r.obligatedAmount != null) {
      entry.awarded.grantObligations = (entry.awarded.grantObligations ?? 0) + r.obligatedAmount;
      if (r.outlayedAmount != null) {
        entry.awarded.grantOutlays = (entry.awarded.grantOutlays ?? 0) + r.outlayedAmount;
      }
    }
  }

  return [...clients.values()];
}
