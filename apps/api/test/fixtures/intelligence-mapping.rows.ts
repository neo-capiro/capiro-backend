import type { IntelligenceService } from '../../src/intelligence/intelligence.service.js';
export type ManualInput = Parameters<IntelligenceService['createManualMapping']>[2];
export type RejectionInput = Parameters<IntelligenceService['rejectMappingCandidate']>[2];
export type ConfirmationInput = Parameters<IntelligenceService['confirmMapping']>[1];

export const tenantId = '00000000-0000-0000-0000-000000000001';
export const clientId = '00000000-0000-0000-0000-000000000010';
export const mappingId = '00000000-0000-0000-0000-000000000020';
export const actorUserId = 'actor-one';
export const now = new Date('2026-10-13T12:00:00.000Z');
export function clientRow(overrides: Record<string, unknown> = {}) {
  return { id: clientId, name: 'Acme Research', sectorTag: null, issueCodes: [], ...overrides };
}
export function mappingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: mappingId,
    tenantId,
    clientId,
    source: 'lda',
    externalId: '12',
    externalName: 'Acme Research',
    confidence: 0.9,
    confirmed: false,
    matchBasis: 'fuzzy_name',
    matchTier: 4,
    reviewStatus: 'candidate',
    relationshipType: null,
    rollUpAwards: null,
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    matchEvidence: { marker: 'mapping-evidence' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
export function manualInput(overrides: Record<string, unknown> = {}): ManualInput {
  return {
    source: 'lda',
    externalId: '12',
    externalName: 'Acme Research',
    actorUserId,
    ...overrides,
  };
}
export function rejectionInput(overrides: Record<string, unknown> = {}): RejectionInput {
  return {
    source: 'contracting' as const,
    externalId: 'contractor-one',
    externalName: 'Acme Research',
    reason: null as string | null,
    actorUserId,
    ...overrides,
  };
}
export function confirmationInput(overrides: Record<string, unknown> = {}): ConfirmationInput {
  return { confirmed: true, actorUserId, ...overrides };
}
export function ldaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    name: 'Acme Research',
    state: 'VA',
    total_filings: 2,
    latest_filing_year: 2026,
    total_spending: 1500,
    issue_codes: ['DEF'],
    similarity: 0.9,
    ...overrides,
  };
}
export function employerRow(overrides: Record<string, unknown> = {}) {
  return {
    employer: 'Acme Research',
    contribution_count: 2,
    total_amount: 1500,
    latest_year: 2026,
    similarity: 0.9,
    ...overrides,
  };
}
export function committeeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'C12345678',
    name: 'Research PAC',
    committee_type: 'Q',
    cycles: [2024, 2026],
    last_synced_at: now,
    ...overrides,
  };
}
export function contractorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000030',
    name: 'Acme Research',
    uei: 'ABCDEF123456',
    category: 'Research',
    total_contracts: 1500,
    rank_by_contracts: 1,
    last_synced_at: now,
    similarity: 0.9,
    ...overrides,
  };
}
export function assistanceRow(overrides: Record<string, unknown> = {}) {
  return {
    uei: 'ABCDEF123456',
    name: 'Acme Research',
    state: 'VA',
    award_count: 2,
    total_obligated: 1500,
    similarity: 0.9,
    ...overrides,
  };
}
