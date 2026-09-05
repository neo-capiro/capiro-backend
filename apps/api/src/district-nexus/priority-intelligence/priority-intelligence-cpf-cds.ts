/**
 * District Nexus Release 4 — CPF/CDS priority-intelligence rules (pure).
 *
 * Consumes canonical `community_funding_request` rows (already deduplicated by
 * `identity_hash` upstream — one real request = one row) plus their
 * `community_funding_request_source` occurrences, and projects them into
 * District Nexus priority-intelligence shapes.
 *
 * Hard rules (mission §3):
 *  - House CPF and Senate CDS remain DISTINCT types everywhere.
 *  - Deduplication is by canonical request id (identity hash) — the same real
 *    request with two source occurrences can never be counted twice.
 *  - Requested and final amounts remain separate. Requested dollars are NEVER
 *    interpreted as awarded dollars.
 *  - House district attribution requires a source-backed requester state AND
 *    district. Senate records are labeled STATEWIDE unless the request itself
 *    carries an independently source-backed project district.
 *  - Member request history contributes only to memberHistoricalPriorities /
 *    priority intelligence — it can never increase Nexus Strength (this module
 *    has no pathway into any Nexus Strength scorer by construction).
 *  - Client attribution requires a deterministic reviewed relationship supplied
 *    by the caller; without one, requests render as public district context.
 *  - If production has no corpus, callers return an honest unavailable state —
 *    this module never converts "not loaded" into "empty".
 */

import type { DistrictNexusChangeSeverity } from './priority-intelligence-change-policy.js';

export type CommunityFundingChamber = 'house' | 'senate';

/** One canonical request projected for district keying. */
export interface CommunityFundingRequestRow {
  requestId: string;
  chamber: CommunityFundingChamber;
  fiscalYear: number;
  requesterName: string;
  requesterState: string | null;
  requesterDistrict: string | null;
  recipientName: string;
  recipientNormalized: string;
  city: string | null;
  state: string | null;
  projectTitle: string;
  requestedAmountUsd: string;
  finalAmountUsd: string | null;
  amountStageRaw: string;
  appropriationsAccountRaw: string | null;
  /** Number of distinct source occurrences backing this canonical request. */
  sourceOccurrenceCount: number;
}

/** One source occurrence (provenance) for a canonical request. */
export interface CommunityFundingSourceOccurrence {
  sourceDocumentId: string;
  sourcePage: number | null;
  sourceRow: number;
  requesterNameRaw: string;
  amountStageRaw: string;
  requestedAmountUsd: string;
  finalAmountUsd: string | null;
  retrievedAt: string;
}

export interface CommunityFundingAvailability {
  status: 'unavailable' | 'loaded';
  /**
   * 'unavailable' means the corpus is not loaded in this environment — it is
   * NOT the same as "loaded but zero matching requests".
   */
  reason: 'corpus_not_loaded' | 'source_error' | null;
  lastIngestRunAt: string | null;
  loadedFiscalYears: number[];
}

/** Deterministic client↔request attribution input (reviewed relationship). */
export interface CommunityFundingClientLink {
  method: 'confirmed_client_intel_mapping' | 'exact_recipient_normalized' | 'exact_alias';
  /** e.g. ClientIntelMapping row id or advocacy finding id — provenance. */
  evidenceId: string | null;
}

export type CommunityFundingGeographyAttribution =
  | { basis: 'house_district'; state: string; district: string }
  | { basis: 'senate_statewide'; state: string }
  | { basis: 'senate_project_district'; state: string; district: string }
  | { basis: 'unresolved'; reason: string };

export interface ProjectedCpfCdsSignal {
  requestId: string;
  chamber: CommunityFundingChamber;
  requestType: 'cpf' | 'cds';
  fiscalYear: number;
  requesterName: string;
  recipientName: string;
  projectTitle: string;
  /** Canonical district key or null when the geography cannot be attributed. */
  districtKey: string | null;
  geography: CommunityFundingGeographyAttribution;
  /** Requested amount — always present; NEVER summed with final. */
  requestedAmountUsd: number;
  /** Final/enacted amount only when a source explicitly distinguishes it. */
  finalAmountUsd: number | null;
  amountStageRaw: string;
  appropriationsAccountRaw: string | null;
  sourceOccurrenceCount: number;
  occurrences: CommunityFundingSourceOccurrence[];
  /** Present only when the caller supplied a deterministic reviewed link. */
  clientAttribution: CommunityFundingClientLink | null;
}

function parseMoney(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a district code to the canonical padded form used by District
 * Nexus district keys ("AL"/""/"00" → "00"; "5" → "05"). Returns null for
 * sentinel/invalid codes — those are NOT districts.
 */
export function normalizeCpfCdsDistrict(value: string | null): string | null {
  if (value == null) return null;
  const text = value.trim().toUpperCase();
  if (!text) return null;
  if (text === 'AL' || text === '00' || text === 'AT LARGE') return '00';
  if (!/^\d{1,2}$/.test(text)) return null;
  const n = Number(text);
  if (n === 0) return '00';
  // 90/98/ZZ-class sentinel codes ("statewide/undefined award geography") are
  // NOT congressional districts — never let them join a district key.
  if (n >= 90) return null;
  return String(n).padStart(2, '0');
}

/**
 * Attribute geography deterministically:
 *  - house: requester state + requester district must BOTH be source-backed.
 *  - senate: statewide by construction; project district only when the request
 *    itself carries one (independent of the senator's state).
 *  - anything else: unresolved with reason — never guessed.
 */
export function attributeGeography(
  row: CommunityFundingRequestRow,
): CommunityFundingGeographyAttribution {
  const state = (row.requesterState ?? row.state ?? '').trim().toUpperCase();

  if (row.chamber === 'house') {
    const district = normalizeCpfCdsDistrict(row.requesterDistrict);
    if (state.length === 2 && district) {
      return { basis: 'house_district', state, district };
    }
    if (state.length === 2 && !district) {
      return { basis: 'unresolved', reason: 'house request without a source-backed district' };
    }
    return { basis: 'unresolved', reason: 'house request without a source-backed state' };
  }

  // Senate: the request is a statewide CDS request. A project district may be
  // recorded only when the request row itself carries one.
  const projectDistrict = normalizeCpfCdsDistrict(row.requesterDistrict);
  if (state.length === 2 && projectDistrict) {
    return { basis: 'senate_project_district', state, district: projectDistrict };
  }
  if (state.length === 2) {
    return { basis: 'senate_statewide', state };
  }
  return { basis: 'unresolved', reason: 'senate request without a source-backed state' };
}

export function districtKeyOf(attribution: CommunityFundingGeographyAttribution): string | null {
  if (attribution.basis === 'house_district' || attribution.basis === 'senate_project_district') {
    return `${attribution.state}-${attribution.district}`;
  }
  return null;
}

export function projectRequest(
  row: CommunityFundingRequestRow,
  occurrences: CommunityFundingSourceOccurrence[],
  clientLink: CommunityFundingClientLink | null,
): ProjectedCpfCdsSignal {
  const geography = attributeGeography(row);
  const requested = parseMoney(row.requestedAmountUsd) ?? 0;
  const final = parseMoney(row.finalAmountUsd);
  return {
    requestId: row.requestId,
    chamber: row.chamber,
    requestType: row.chamber === 'house' ? 'cpf' : 'cds',
    fiscalYear: row.fiscalYear,
    requesterName: row.requesterName,
    recipientName: row.recipientName,
    projectTitle: row.projectTitle,
    districtKey: districtKeyOf(geography),
    geography,
    requestedAmountUsd: requested,
    finalAmountUsd: final,
    amountStageRaw: row.amountStageRaw,
    appropriationsAccountRaw: row.appropriationsAccountRaw,
    sourceOccurrenceCount: Math.max(row.sourceOccurrenceCount, occurrences.length),
    occurrences,
    clientAttribution: clientLink,
  };
}

/**
 * Filter for a district: house-district requests keyed to the district, plus
 * senate requests for the state. Senate STATEWIDE records are labeled
 * statewide in the projection — they join the state, never a specific
 * district, so `senateInclude` controls whether the caller wants them.
 */
export function filterForDistrict(
  projections: ProjectedCpfCdsSignal[],
  state: string,
  district: string,
  options: { includeSenateStatewide: boolean },
): ProjectedCpfCdsSignal[] {
  const stateCode = state.trim().toUpperCase();
  const districtPadded = normalizeCpfCdsDistrict(district);
  return projections.filter((p) => {
    if (p.geography.basis === 'house_district') {
      return p.geography.state === stateCode && p.geography.district === districtPadded;
    }
    if (p.geography.basis === 'senate_project_district') {
      return p.geography.state === stateCode && p.geography.district === districtPadded;
    }
    if (p.geography.basis === 'senate_statewide') {
      return options.includeSenateStatewide && p.geography.state === stateCode;
    }
    return false;
  });
}

/**
 * Member historical priorities aggregation for the Strategic Relevance
 * memberHistoricalPriorities component. Sums requested amounts BY MEMBER-YEAR
 * for display only. This output feeds strategic relevance — never nexus.
 * Senate statewide requests attribute to the state's senators collectively;
 * they do not fabricate a district.
 */
export interface MemberPrioritySummary {
  bioguideId: string;
  chamber: CommunityFundingChamber;
  state: string | null;
  /** FYs with request activity, ascending. */
  fiscalYears: number[];
  requestedTotalUsd: number;
  finalTotalUsd: number;
  /** True when any FY relied on statewide attribution (visible in UI). */
  includesStatewideAttribution: boolean;
}

export interface MemberPriorityAggregation {
  byMember: MemberPrioritySummary[];
  /** Distinct canonical request ids aggregated — proves no double counting. */
  distinctRequestIds: string[];
}

/**
 * @param memberGeography member bioguide + the geography the MEMBER represents
 *   (already resolved by the caller from the directory — senate members carry
 *   state only). A request attributes to a member when the request's
 *   attribution geography matches the member's represented geography.
 */
export function aggregateMemberPriorities(
  projections: ProjectedCpfCdsSignal[],
  members: Array<{
    bioguideId: string;
    chamber: CommunityFundingChamber;
    state: string | null;
    district: string | null;
  }>,
): MemberPriorityAggregation {
  const byMember: MemberPrioritySummary[] = [];
  const distinctRequestIds = new Set<string>();

  // Canonical-request dedup FIRST: the same real request can arrive as several
  // projections (multiple source occurrences). Deduplication is by canonical
  // request id — provenance-row count can never inflate a member total.
  const seenRequestIds = new Set<string>();
  const dedupedProjections: ProjectedCpfCdsSignal[] = [];
  for (const p of projections) {
    if (seenRequestIds.has(p.requestId)) continue;
    seenRequestIds.add(p.requestId);
    dedupedProjections.push(p);
  }

  for (const member of members) {
    const memberState = (member.state ?? '').trim().toUpperCase();
    const memberDistrict =
      member.chamber === 'house' ? normalizeCpfCdsDistrict(member.district) : null;
    if (memberState.length !== 2) continue;

    let requestedTotal = 0;
    let finalTotal = 0;
    const years = new Set<number>();
    let includesStatewide = false;
    let hasAny = false;

    for (const p of dedupedProjections) {
      let matches = false;
      let statewide = false;
      if (p.geography.basis === 'house_district') {
        matches =
          p.geography.state === memberState &&
          member.chamber === 'house' &&
          memberDistrict != null &&
          p.geography.district === memberDistrict;
      } else if (p.geography.basis === 'senate_project_district') {
        matches =
          p.geography.state === memberState &&
          member.chamber === 'senate' &&
          memberDistrict == null;
      } else if (p.geography.basis === 'senate_statewide') {
        matches = p.geography.state === memberState && member.chamber === 'senate';
        statewide = matches;
      }
      if (!matches) continue;
      hasAny = true;
      if (statewide) includesStatewide = true;
      years.add(p.fiscalYear);
      requestedTotal += p.requestedAmountUsd;
      if (p.finalAmountUsd != null) finalTotal += p.finalAmountUsd;
      distinctRequestIds.add(p.requestId);
    }

    if (hasAny) {
      byMember.push({
        bioguideId: member.bioguideId,
        chamber: member.chamber,
        state: memberState,
        fiscalYears: [...years].sort((a, b) => a - b),
        requestedTotalUsd: requestedTotal,
        finalTotalUsd: finalTotal,
        includesStatewideAttribution: includesStatewide,
      });
    }
  }

  return { byMember, distinctRequestIds: [...distinctRequestIds] };
}

/** Severity decision for a CPF/CDS change — delegates to the central policy. */
export function cpfCdsChangeKindFromRow(
  previous: { requestedAmountUsd: string | null; finalAmountUsd: string | null } | null,
  current: { requestedAmountUsd: string | null; finalAmountUsd: string | null },
): 'cpf_cds_request_new' | 'cpf_cds_amount_stage_correction' {
  if (previous == null) return 'cpf_cds_request_new';
  return 'cpf_cds_amount_stage_correction';
}

export type { DistrictNexusChangeSeverity };
