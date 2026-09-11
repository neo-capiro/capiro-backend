/**
 * District Nexus — firm-wide (all-clients) aggregation core (WS-E Step E1).
 *
 * Pure and I/O-free, like the per-client core it builds on. The service does the
 * batched gathering; every decision about what a merged number MEANS lives here.
 *
 * ── Why this is a merge of per-client folds, not a second fold ──────────────
 *
 * `foldDistricts` is already tested and already encodes the attribution rules
 * (§5.3 source precedence, §8.2 award geography, statewide money to unmapped).
 * Re-implementing those firm-wide would give us two places for the same rules to
 * drift apart. So each client is folded with the existing function and the
 * results are merged here, which leaves exactly one definition of "which
 * district does this dollar belong to".
 *
 * The merge has to carry client identity, which a per-client fold discards —
 * that is the one thing this layer adds, and it is what makes `clientCount`
 * real rather than a hardcoded 1.
 */
import {
  foldDistricts,
  poolEvidence,
  type ClientNexusInputs,
  type DistrictAccumulator,
} from './district-nexus.aggregate.js';
import { scoreNexus } from './district-nexus-scoring.js';
import type { ResolvedDistrictName } from './district-nexus.district-names.js';
import { US_HOUSE_SEATS } from '../common/us-congressional-districts.js';
import type {
  DataQualityWarning,
  DistrictKey,
  DistrictNexusDistrictSummary,
  DistrictNexusMapResponse,
  SourceFreshness,
  UnmappedFunding,
} from './district-nexus.types.js';

export interface FirmNexusInputs {
  /** One entry per visible client. Each is folded with the per-client core. */
  perClient: ClientNexusInputs[];
  freshness: SourceFreshness[];
  generatedAt: string;
  /** District display names/status, resolved by the caller in one query. */
  districtNames?: Map<DistrictKey, ResolvedDistrictName>;
}

interface MergedDistrict {
  acc: DistrictAccumulator;
  clientIds: Set<string>;
}

/** Adds `value` to a null-or-number accumulator, promoting null to a number. */
function addMoney(current: number | null, value: number | null): number | null {
  if (value == null) return current;
  return (current ?? 0) + value;
}

/**
 * Fold one client's accumulator into the firm-wide one for the same district.
 *
 * Money sums. Counts sum. The assistance basis takes the WEAKER of the two, for
 * the same reason `foldDistricts` does within a client: if any contributing
 * client's grant geography came from recipient location, the district's grant
 * total is no longer purely place-of-performance evidence, and reporting the
 * stronger basis would launder it.
 */
function mergeInto(target: DistrictAccumulator, source: DistrictAccumulator): void {
  target.contractObligations = addMoney(target.contractObligations, source.contractObligations);
  target.grantObligations = addMoney(target.grantObligations, source.grantObligations);
  target.grantOutlays = addMoney(target.grantOutlays, source.grantOutlays);
  target.opportunityEstimatedFunding = addMoney(
    target.opportunityEstimatedFunding,
    source.opportunityEstimatedFunding,
  );
  target.opportunityAwardCeiling = addMoney(
    target.opportunityAwardCeiling,
    source.opportunityAwardCeiling,
  );
  target.facilityCount += source.facilityCount;
  target.employeeCount = addMoney(target.employeeCount, source.employeeCount);
  target.facilitiesMissingEmployeeCount += source.facilitiesMissingEmployeeCount;

  if (source.assistanceBasis === 'recipient_location' || target.assistanceBasis === 'recipient_location') {
    target.assistanceBasis = 'recipient_location';
  } else if (source.assistanceBasis === 'place_of_performance') {
    target.assistanceBasis = 'place_of_performance';
  }

  target.warnings.push(...source.warnings);
}

/** Distinct warnings, keyed on the pair that makes two warnings the same claim. */
function dedupeWarnings(warnings: DataQualityWarning[]): DataQualityWarning[] {
  const seen = new Set<string>();
  const out: DataQualityWarning[] = [];
  for (const w of warnings) {
    const key = `${w.code}|${w.districtKey ?? ''}|${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * Score one merged district by pooling its contributing clients' evidence.
 *
 * `poolEvidence` is the same function the client roll-up uses, applied along the
 * other axis: there it unions a client's districts, here it unions a district's
 * clients. Both want presence-optimistic / strength-pessimistic semantics — the
 * district genuinely has a facility if any client does, but its strength is the
 * weakest any contributor can support — so they should not be two functions
 * that have to be kept in agreement.
 */
function scoreMerged(contributors: DistrictAccumulator[]) {
  return scoreNexus({ components: poolEvidence(contributors) });
}

/**
 * Build the WS-E1 firm-wide map payload.
 *
 * Districts are sorted score-desc then contract-obligations-desc, matching the
 * per-client rail so the two views agree about what "strongest" means.
 */
export function buildFirmNexusResponse(inputs: FirmNexusInputs): DistrictNexusMapResponse {
  const merged = new Map<DistrictKey, MergedDistrict>();
  const contributorsByKey = new Map<DistrictKey, DistrictAccumulator[]>();
  const warnings: DataQualityWarning[] = [];

  let unmappedContractAmount: number | null = null;
  let unmappedGrantAmount: number | null = null;

  for (const client of inputs.perClient) {
    const folded = foldDistricts(client);
    warnings.push(...folded.warnings);
    unmappedContractAmount = addMoney(unmappedContractAmount, folded.unmapped.unmappedContractAmount);
    unmappedGrantAmount = addMoney(unmappedGrantAmount, folded.unmapped.unmappedGrantAmount);

    for (const acc of folded.districts) {
      const existing = merged.get(acc.districtKey);
      if (existing) {
        mergeInto(existing.acc, acc);
        existing.clientIds.add(client.clientId);
      } else {
        // Copy so the merge never mutates a caller's accumulator.
        merged.set(acc.districtKey, {
          acc: { ...acc, warnings: [...acc.warnings] },
          clientIds: new Set([client.clientId]),
        });
      }
      const bucket = contributorsByKey.get(acc.districtKey);
      if (bucket) bucket.push(acc);
      else contributorsByKey.set(acc.districtKey, [acc]);
    }
  }

  const districts: DistrictNexusDistrictSummary[] = [...merged.values()].map((entry) => {
    const scored = scoreMerged(contributorsByKey.get(entry.acc.districtKey) ?? [entry.acc]);
    const named = inputs.districtNames?.get(entry.acc.districtKey);
    return {
      districtKey: entry.acc.districtKey,
      state: entry.acc.state,
      districtCode: entry.acc.districtCode,
      // Only the current rail is buildable today — see district-nexus.view.ts.
      status: named?.status ?? 'C',
      name: named?.name ?? null,
      awarded: {
        contractObligations: entry.acc.contractObligations,
        grantObligations: entry.acc.grantObligations,
        grantOutlays: entry.acc.grantOutlays,
      },
      opportunities: {
        opportunityEstimatedFunding: entry.acc.opportunityEstimatedFunding,
        opportunityAwardCeiling: entry.acc.opportunityAwardCeiling,
      },
      clientCount: entry.clientIds.size,
      score: scored.score,
      coveragePercent: scored.coveragePercent,
      employeeCount: entry.acc.employeeCount,
      employeesUnreported: entry.acc.facilitiesMissingEmployeeCount > 0,
      warnings: dedupeWarnings([...entry.acc.warnings, ...scored.warnings]),
    };
  });

  districts.sort((a, b) => {
    const scoreDelta = (b.score ?? -1) - (a.score ?? -1);
    if (scoreDelta !== 0) return scoreDelta;
    return (b.awarded.contractObligations ?? 0) - (a.awarded.contractObligations ?? 0);
  });

  const unmapped: UnmappedFunding = { unmappedContractAmount, unmappedGrantAmount };

  return {
    districts,
    unmapped,
    freshness: inputs.freshness,
    warnings: dedupeWarnings(warnings),
    generatedAt: inputs.generatedAt,
  };
}


/**
 * Zero-nexus placeholder for a real House district.
 *
 * Used by the optional "all districts" coverage mode: public intel is still
 * available via the drawer, but Nexus Strength stays null / coverage 0 so
 * public context can never inflate verified footprint (three-outputs rule).
 */
export function zeroNexusDistrictSummary(
  state: string,
  districtCode: string,
  named?: { name: string | null; status: 'C' | 'F' },
): DistrictNexusDistrictSummary {
  return {
    districtKey: `${state}-${districtCode}`,
    state,
    districtCode,
    status: named?.status ?? 'C',
    name: named?.name ?? null,
    awarded: { contractObligations: null, grantObligations: null, grantOutlays: null },
    opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
    clientCount: 0,
    score: null,
    coveragePercent: 0,
    employeeCount: null,
    employeesUnreported: false,
    warnings: [],
  };
}

/**
 * Expand a firm map with every current House seat (optionally one state).
 * Existing nexus rows win; placeholders fill the rest. Does not invent money
 * or scores.
 */
export function expandFirmMapWithAllDistricts(
  response: DistrictNexusMapResponse,
  options: { state?: string | null; names?: Map<string, { name: string | null; status: 'C' | 'F' }> } = {},
): DistrictNexusMapResponse {
  const existing = new Map(response.districts.map((d) => [d.districtKey, d]));
  const states = options.state
    ? [options.state.toUpperCase()].filter((s) => US_HOUSE_SEATS[s] != null)
    : Object.keys(US_HOUSE_SEATS);
  const expanded: DistrictNexusDistrictSummary[] = [];
  for (const state of states) {
    const seats = US_HOUSE_SEATS[state]!;
    if (seats === 1) {
      const key = `${state}-00`;
      const named = options.names?.get(key);
      expanded.push(existing.get(key) ?? zeroNexusDistrictSummary(state, '00', named));
      continue;
    }
    for (let n = 1; n <= seats; n++) {
      const code = String(n).padStart(2, '0');
      const key = `${state}-${code}`;
      const named = options.names?.get(key);
      expanded.push(existing.get(key) ?? zeroNexusDistrictSummary(state, code, named));
    }
  }
  // Keep any nexus keys outside the seat table (should not happen) at the end.
  for (const d of response.districts) {
    if (!expanded.some((e) => e.districtKey === d.districtKey)) expanded.push(d);
  }
  expanded.sort((a, b) => {
    const aN = a.clientCount > 0 || a.score != null ? 1 : 0;
    const bN = b.clientCount > 0 || b.score != null ? 1 : 0;
    if (bN !== aN) return bN - aN;
    const scoreDelta = (b.score ?? -1) - (a.score ?? -1);
    if (scoreDelta !== 0) return scoreDelta;
    return a.districtKey.localeCompare(b.districtKey);
  });
  return { ...response, districts: expanded };
}
