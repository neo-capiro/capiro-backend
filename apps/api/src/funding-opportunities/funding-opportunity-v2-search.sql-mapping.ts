import type { OpportunitySearchCriteriaV2 } from '@capiro/shared';
import type { SqlRow } from './funding-opportunity-v2-search.sql.js';
import type { CatalogOpportunityRecord } from './funding-opportunity-v2-search.service.js';

export type OpportunitySourceFactsV2 = {
  provenance: string;
  [key: string]: unknown;
};

export function iso(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function asFacts(value: unknown): OpportunitySourceFactsV2 {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as OpportunitySourceFactsV2
    : { provenance: 'source projection' };
}

export function mapSqlSearchRow(row: SqlRow, criteria: OpportunitySearchCriteriaV2): CatalogOpportunityRecord {
  const facts = asFacts(row.source_facts);
  const applicantTypes = row.applicant_types ?? [];
  const internalEligibility = row.eligibility_state
    ? { state: row.eligibility_state as 'eligible' | 'ineligible' | 'needs_review' | 'unknown', reason: row.eligibility_reason ?? 'The source did not state client eligibility.' }
    : null;
  const eligibility = criteria.mode === 'matched' && criteria.clientId && internalEligibility
    ? internalEligibility
    : null;
  return {
    id: row.id,
    source: row.source,
    sourceRecordId: row.source_record_id,
    title: row.title,
    agency: row.agency,
    sourceUrl: row.source_url,
    type: row.type,
    lifecycle: row.lifecycle,
    postedDate: iso(row.posted_date),
    deadline: iso(row.deadline),
    closeOrArchiveDate: iso(row.close_date),
    isPursuable: row.is_pursuable,
    summary: row.summary,
    naicsCodes: row.naics_codes ?? [],
    pscCodes: row.psc_codes ?? [],
    setAside: row.set_aside,
    applicantTypes,
    geography: row.geography ?? [],
    value: finiteNumber(row.value),
    valueBasis: row.value_basis,
    relevanceScore: criteria.mode === 'matched' ? row.relevance_score : null,
    matchedSignals: criteria.mode === 'matched' ? [
      row.naics_match ? { signal: 'naicsExact', strength: 'strong' as const, matchedOn: row.naics_match_on ?? '' } : null,
      row.psc_match ? { signal: 'pscExact', strength: 'strong' as const, matchedOn: row.psc_match_on ?? '' } : null,
      row.agency_match ? { signal: 'agency', strength: 'moderate' as const, matchedOn: row.agency ?? '' } : null,
      row.capability_match ? { signal: 'capabilityKeyword', strength: 'moderate' as const, matchedOn: row.capability_match } : null,
      row.topical_match ? { signal: 'genericTopical', strength: 'weak' as const, matchedOn: row.topical_match } : null,
    ].filter((signal): signal is NonNullable<typeof signal> => signal !== null) : [],
    eligibility,
    clientId: criteria.clientId,
    clientCapability: criteria.clientId
      ? {
        state: internalEligibility?.state ?? 'unknown',
        // Capability is a source/workflow gate, not a legal eligibility assertion.
        allowed: row.is_pursuable && internalEligibility?.state !== 'ineligible',
        reason: row.is_pursuable
          ? (internalEligibility?.state === 'ineligible' ? internalEligibility.reason : 'The source is currently pursuable; client eligibility remains subject to review where facts are incomplete.')
          : 'The source record is not currently pursuable.',
      }
      : null,
    sourceFacts: facts,
    sectors: row.sectors ?? [],
    funding: row.funding ?? [],
    costShare: row.cost_share ?? [],
    methods: row.methods ?? [],
    disbursement: row.disbursement ?? [],
    grantPrerequisites: row.grant_prerequisites ?? [],
    codes: row.codes ?? [],
    internalEligibility: internalEligibility?.state ?? 'unknown',
    internalEligibilityReason: internalEligibility?.reason ?? 'Client-specific eligibility is unavailable without a selected client.',
    syncedAt: iso(row.synced_at),
    updatedAt: iso(row.updated_at),
    _sqlTitleKey: row.sort_title_key ?? null,
    _sqlAgencyKey: row.sort_agency_key ?? null,
  };
}
