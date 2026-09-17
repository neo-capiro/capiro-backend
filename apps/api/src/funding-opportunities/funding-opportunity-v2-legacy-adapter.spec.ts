import { v2RecordToFundingOpportunity } from './funding-opportunity-v2-legacy-adapter.js';
import type { OpportunitySearchRecordV2, FundingOpportunityV2DetailRecord } from '@capiro/shared';

const base = (decoration?: OpportunitySearchRecordV2['decoration']): OpportunitySearchRecordV2 => ({
  id: 'sam_gov:record-1', source: 'sam_gov', sourceRecordId: 'record-1', type: 'solicitation',
  lifecycle: 'active', title: 'Canonical notice', agency: 'Agency', sourceUrl: 'https://sam.gov/record-1',
  postedDate: '2026-09-01T00:00:00Z', deadline: null, closeOrArchiveDate: null, isPursuable: true,
  summary: null, naicsCodes: [], pscCodes: [], setAside: null, applicantTypes: [], geography: [],
  value: null, valueBasis: 'not_stated_by_source', sourceFacts: { provenance: 'test' },
  relevanceScore: null, matchedSignals: [{ signal: 'naics_exact', strength: 'strong', matchedOn: '541715' }],
  eligibility: { state: 'needs_review', reason: 'Insufficient facts.' }, clientId: 'client-1', decoration,
});

const decoration = {
  workflow: {
    available: true, workflowId: 'workflow-1', status: 'pursuing', humanDecision: 'pursue',
    owner: { userId: 'owner-1', name: 'Owner', email: null }, nextAction: 'Review package',
    nextActionDueAt: '2026-09-30T00:00:00Z', stage: null, stageBasis: null, unavailableReason: null,
  },
} as OpportunitySearchRecordV2['decoration'];

describe('v2RecordToFundingOpportunity canonical workflow projection', () => {
  it.each([
    ['base decorated', base(decoration)],
    ['rich decorated', { ...base(), dates: {}, displayReference: { value: 'REF-1' }, sourceReference: { sourceUpdatedAt: '2026-09-01T00:00:00Z' }, provenance: { sourceFacts: { provenance: 'test' } }, decoration } as unknown as FundingOpportunityV2DetailRecord],
  ])('preserves known workflow and leaves unavailable metadata null: %s', (_name, row) => {
    const projected = v2RecordToFundingOpportunity(row);
    expect(projected.relevanceScore).toBeNull();
    expect(projected.matchedSignals[0]).toMatchObject({ signal: 'naics_exact', strength: 'strong', matchedOn: '541715', weight: undefined });
    expect(projected.workflow).toMatchObject({ id: 'workflow-1', status: 'pursuing', nextAction: 'Review package', nextActionDueAt: '2026-09-30T00:00:00Z', createdAt: null, updatedAt: null, userCreated: null });
    expect(projected.decision).toMatchObject({ decision: 'pursue', decidedAt: null, decidedByUserId: null });
  });

  it('does not invent workflow or decision when decoration is absent', () => {
    const projected = v2RecordToFundingOpportunity(base());
    expect(projected.workflow).toBeNull();
    expect(projected.decision).toBeNull();
  });
});
