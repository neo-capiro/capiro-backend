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
  type NexusComponentEvidence,
  type NexusComponentKey,
  type EvidenceStrength,
} from './district-nexus-scoring.js';
import type {
  AwardedFunding,
  ClientDistrictNexusResponse,
  ClientFacilityFootprint,
  ClientNexusLinkage,
  DataQualityWarning,
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
}

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
    components.verifiedFacility = { strength: 'verified', evidenceCount: acc.facilityCount };
  }
  if (acc.employeeCount != null) {
    components.verifiedEmployees = { strength: 'verified', evidenceCount: acc.facilityCount };
  }
  if (acc.contractObligations != null) {
    components.contractPlaceOfPerformance = { strength: 'sourceAuthoritative' };
  }
  if (acc.grantObligations != null) {
    const strength: EvidenceStrength =
      acc.assistanceBasis === 'recipient_location' ? 'recipientLocation' : 'sourceAuthoritative';
    components.grantPlaceOfPerformance = { strength };
  } else if (acc.opportunityEstimatedFunding != null) {
    // Opportunities alone: determinate knowledge worth zero awarded credit.
    components.grantPlaceOfPerformance = { strength: 'sourceAuthoritative', opportunityOnly: true };
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
