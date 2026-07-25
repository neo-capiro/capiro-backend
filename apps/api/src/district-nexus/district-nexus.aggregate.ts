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
  type NexusComponentEvidence,
  type NexusComponentKey,
  type EvidenceStrength,
} from './district-nexus-scoring.js';
import type {
  AwardedFunding,
  ClientDistrictNexusResponse,
  DataQualityWarning,
  DistrictKey,
  DistrictNexusDistrictDetail,
  OpportunityFunding,
  SourceFreshness,
  UnmappedFunding,
} from './district-nexus.types.js';

/**
 * Where a row's district attribution came from. Mirrors the plan's §E4
 * `geographyBasis` vocabulary, restricted to the values the aggregation layer
 * can actually produce.
 */
export type GeographyBasis =
  | 'place_of_performance'
  | 'recipient_location'
  | 'facility'
  | 'statewide'
  | 'unknown';

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

interface DistrictAccumulator {
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
      warnings: [...acc.warnings, ...scored.warnings],
      evidence: [],
      breakdown: scored.breakdown,
      freshness: inputs.freshness,
    };
  });

  districts.sort((a, b) => {
    const scoreDelta = (b.score ?? -1) - (a.score ?? -1);
    if (scoreDelta !== 0) return scoreDelta;
    return (b.awarded.contractObligations ?? 0) - (a.awarded.contractObligations ?? 0);
  });

  // The client-level roll-up scores the client's BEST district rather than an
  // average: a firm with one deeply-rooted district and six incidental ones has
  // a strong nexus somewhere, and averaging would hide it.
  const best = districts.find((d) => d.score != null);
  const clientEvidence = accumulators.length
    ? evidenceForDistrict(
        accumulators.find((a) => a.districtKey === best?.districtKey) ?? accumulators[0]!,
      )
    : {};
  const clientScore = scoreNexus({ components: clientEvidence });

  return {
    clientId: inputs.clientId,
    districts,
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
    coveragePercent: clientScore.coveragePercent,
    breakdown: clientScore.breakdown,
    freshness: inputs.freshness,
    warnings: [...warnings, ...clientScore.warnings],
    generatedAt: inputs.generatedAt,
  };
}
