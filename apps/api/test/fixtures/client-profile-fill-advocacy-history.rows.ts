import type { FederalRegisterCorrelationSuggestion } from '../../src/clients/client-advocacy-matter.service.js';
import { normalizeIdentityText } from '../../src/government-data/community-funding/community-funding.parser.js';

export function ldaRow(overrides: Record<string, unknown> = {}) {
  return {
    filingUuid: 'filing-one',
    clientId: 42,
    clientName: 'Acme Research',
    filingType: 'report',
    filingYear: 2025,
    filingPeriod: 'Q1',
    dtPosted: new Date('2025-04-01T00:00:00.000Z'),
    scanAt: new Date('2025-04-01T00:00:00.000Z'),
    registrantName: 'Public Affairs LLC',
    clientDescription: 'Research funding',
    income: '123.50',
    expenses: null,
    issueCodes: ['SCI'],
    governmentEntities: ['House'],
    lobbyingActivities: [],
    filingDocumentUrl: 'https://example.invalid/filing-one',
    ...overrides,
  };
}

export function faraRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fara-one',
    registrationNumber: '9001',
    registrantName: 'Acme Research',
    foreignPrincipal: 'Other Organization',
    country: 'Canada',
    status: 'active',
    registrationDate: new Date('2025-01-01T00:00:00.000Z'),
    description: 'Research advocacy',
    registrantSimilarity: 1,
    principalSimilarity: 0,
    ...overrides,
  };
}

export function testimonyRow(overrides: Record<string, unknown> = {}) {
  return {
    hearingId: 'hearing-one',
    title: 'Research appropriations',
    committeeName: 'Science',
    chamber: 'House',
    date: new Date('2025-02-01T00:00:00.000Z'),
    syncedAt: new Date('2025-02-02T00:00:00.000Z'),
    url: 'https://example.invalid/hearing',
    witnessText: 'Ada Example, Director, Acme Research',
    similarity: 1,
    ...overrides,
  };
}

export function communityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '66666666-6666-6666-6666-666666666666',
    chamber: 'house',
    requestType: 'cpf',
    fiscalYear: 2026,
    requesterName: 'Member Example',
    recipientName: 'Acme Research',
    recipientNormalized: normalizeIdentityText('Acme Research'),
    state: 'VA',
    city: 'Arlington',
    projectTitle: 'Research laboratory',
    projectDescription: 'New facilities',
    requestedAmountUsd: '2000000',
    finalAmountUsd: null,
    amountStageRaw: 'requested',
    appropriationsAccountRaw: 'Science',
    subcommittee: 'Commerce',
    createdAt: new Date('2025-03-01T00:00:00.000Z'),
    recipientSimilarity: 1,
    provenanceCount: 0,
    provenanceDocs: null,
    ...overrides,
  };
}

export function submissionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'submission-one',
    capabilityName: 'Research',
    createdAt: new Date('2025-03-02T00:00:00.000Z'),
    data: {
      id: 'submission-one',
      title: 'Research funding request',
      detail: 'Proposal detail',
      submitted_at: '2025-03-01T00:00:00.000Z',
      status: 'submitted',
      outcome: null,
    },
    ...overrides,
  };
}

export function privateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'relationship-one',
    appliedAt: new Date('2025-03-03T00:00:00.000Z'),
    proposedValue: {
      title: 'Funding policy meeting',
      entityType: 'meeting',
      entityId: 'meeting-one',
      occurredAt: '2025-03-01T00:00:00.000Z',
      matchReason: 'domain',
      matchedDomains: ['acme.invalid'],
    },
    evidence: [{ label: 'Meeting record', source: 'Capiro private record' }],
    ...overrides,
  };
}

export function federalSuggestion(
  overrides: Partial<FederalRegisterCorrelationSuggestion> = {},
): FederalRegisterCorrelationSuggestion {
  return {
    documentNumber: '2025-00001',
    title: 'Final research rule',
    documentType: 'Rule',
    agencyNames: ['Science Agency'],
    publicationDate: '2025-06-01',
    matchedDocketIds: ['SCI-2025-1'],
    sourceUrl: 'https://example.invalid/rule',
    stage: 'government_movement',
    matchedOn: 'docket_id',
    causationClaimed: false,
    ...overrides,
  };
}
