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
import { districtMatchesHouse } from '../../common/district-code.util.js';

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
  row: Pick<
    CommunityFundingRequestRow,
    'chamber' | 'requesterState' | 'requesterDistrict' | 'state'
  >,
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

/** A directory identity, distinct from the geography a request concerns. */
export interface MemberPriorityIdentity {
  bioguideId: string;
  chamber: CommunityFundingChamber;
  state: string | null;
  district: string | null;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  isCurrent: boolean;
}

export interface MemberPrioritySummary {
  bioguideId: string;
  memberName: string;
  attributionMethod: 'source_requester_name';
  chamber: CommunityFundingChamber;
  state: string | null;
  fiscalYears: number[];
  requestedTotalUsd: number;
  finalTotalUsd: number;
  includesStatewideAttribution: boolean;
}

export interface MemberPriorityAggregation {
  byMember: MemberPrioritySummary[];
  distinctRequestIds: string[];
  /** Joint requests contribute once to this cross-member total. */
  requestedTotalUsd: number;
  unattributedRequestIds: string[];
}

function memberNameKey(value: string): string {
  const parts = value.split(',');
  const ordered = parts.length === 2 ? `${parts[1]?.trim()} ${parts[0]?.trim()}` : value;
  return ordered
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.,'’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match source-named requesters, never all representatives of a geography.
 * Exact full names (either order) and unambiguous bare surnames are accepted.
 * Unknown names, ambiguous surnames and conflicting state suffixes abstain.
 * Historical roster rows must be present so an old surname cannot silently
 * resolve to a different current member. No fiscal year implies a service term.
 */
export function createRequesterResolver(members: MemberPriorityIdentity[]) {
  // Build aliases once per directory batch, not once per request/member pair.
  // Both read paths can examine thousands of requests in one state.
  const scopes = new Map<string, Map<string, Map<string, MemberPriorityIdentity>>>();
  for (const member of members) {
    const scopeKey = `${member.chamber}:${member.state}`;
    const aliases = scopes.get(scopeKey) ?? new Map<string, Map<string, MemberPriorityIdentity>>();
    for (const name of [
      member.fullName ?? '',
      member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : '',
      member.firstName && member.lastName ? `${member.lastName} ${member.firstName}` : '',
      member.lastName ?? '',
    ]) {
      const key = memberNameKey(name);
      if (!key) continue;
      const identities = aliases.get(key) ?? new Map<string, MemberPriorityIdentity>();
      identities.set(member.bioguideId, member);
      aliases.set(key, identities);
    }
    scopes.set(scopeKey, aliases);
  }
  return (
    request: Pick<ProjectedCpfCdsSignal, 'chamber' | 'requesterName' | 'geography'>,
  ): MemberPriorityIdentity[] => {
    const geography = request.geography;
    if (geography.basis === 'unresolved') return [];
    const aliases = scopes.get(`${request.chamber}:${geography.state}`);
    const resolved = new Map<string, MemberPriorityIdentity>();
    // Commas alone are not split: they can mean "Last, First".
    for (const raw of request.requesterName.split(/;|\s+and\s+|\s*&\s*/i)) {
      const suffix = raw.match(/\(([A-Z]{2})\)\s*$/i);
      if (suffix && suffix[1]?.toUpperCase() !== geography.state) continue;
      const name = raw
        .replace(/\([A-Z]{2}\)\s*$/i, '')
        .trim()
        .replace(/^(?:senators?|sens?|representatives?|reps?|honorable|hon)\.?\s+/i, '');
      const identities = aliases?.get(memberNameKey(name));
      if (identities?.size !== 1) continue;
      const member = [...identities.values()][0]!;
      const memberDistrict = normalizeCpfCdsDistrict(member.district);
      if (
        request.chamber === 'house' &&
        (geography.basis !== 'house_district' ||
          (member.district != null && memberDistrict == null) ||
          !districtMatchesHouse(
            geography.district,
            memberDistrict == null ? null : Number(memberDistrict),
          ))
      )
        continue;
      if (request.chamber === 'senate' && geography.basis === 'house_district') continue;
      resolved.set(member.bioguideId, member);
    }
    return [...resolved.values()];
  };
}

export function aggregateMemberPriorities(
  projections: ProjectedCpfCdsSignal[],
  members: MemberPriorityIdentity[],
  eligibleBioguideIds: ReadonlySet<string> = new Set(
    members.filter((m) => m.isCurrent).map((m) => m.bioguideId),
  ),
): MemberPriorityAggregation {
  const byMember = new Map<string, MemberPrioritySummary>();
  const seen = new Set<string>();
  const resolveRequesters = createRequesterResolver(members);
  const distinctRequestIds: string[] = [];
  const unattributedRequestIds: string[] = [];
  let requestedTotalUsd = 0;
  for (const p of projections) {
    if (seen.has(p.requestId)) continue;
    seen.add(p.requestId);
    const requesters = resolveRequesters(p).filter(
      (m) => eligibleBioguideIds.has(m.bioguideId) && m.isCurrent === true,
    );
    if (!requesters.length) {
      unattributedRequestIds.push(p.requestId);
      continue;
    }
    distinctRequestIds.push(p.requestId);
    requestedTotalUsd += p.requestedAmountUsd;
    for (const member of requesters) {
      const summary = byMember.get(member.bioguideId) ?? {
        bioguideId: member.bioguideId,
        memberName: member.fullName || `${member.firstName ?? ''} ${member.lastName ?? ''}`.trim(),
        attributionMethod: 'source_requester_name' as const,
        chamber: member.chamber,
        state: member.state,
        fiscalYears: [],
        requestedTotalUsd: 0,
        finalTotalUsd: 0,
        includesStatewideAttribution: false,
      };
      if (!summary.fiscalYears.includes(p.fiscalYear)) summary.fiscalYears.push(p.fiscalYear);
      summary.fiscalYears.sort((a, b) => a - b);
      summary.requestedTotalUsd += p.requestedAmountUsd;
      if (p.finalAmountUsd != null) summary.finalTotalUsd += p.finalAmountUsd;
      summary.includesStatewideAttribution ||= p.geography.basis === 'senate_statewide';
      byMember.set(member.bioguideId, summary);
    }
  }
  return {
    byMember: [...byMember.values()],
    distinctRequestIds,
    requestedTotalUsd,
    unattributedRequestIds,
  };
}

export type { DistrictNexusChangeSeverity };
