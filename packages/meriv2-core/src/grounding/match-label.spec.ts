import { describe, expect, it } from '@jest/globals';
import type { AssuredEvidence } from '../assurance/claim-ledger';
import { deriveMatchLabel } from './match-label';

const opportunity: AssuredEvidence = {
  id: 'opp', sourceType: 'search_procurement_forecasts', sourceId: 'forecast-1',
  evidenceClass: 'official_government_data', title: 'Open opportunity', primary: true,
  authoritative: true, requirementIds: [],
};
const client: AssuredEvidence = {
  id: 'client', sourceType: 'read_client_documents', sourceId: 'document-1',
  evidenceClass: 'client_approved_context', title: 'Client capability profile', primary: true,
  authoritative: true, requirementIds: [],
};
const award: AssuredEvidence = {
  id: 'award', sourceType: 'search_federal_awards', sourceId: 'award-1',
  evidenceClass: 'official_government_data', title: 'Historical award', primary: true,
  authoritative: true, requirementIds: [],
};
const eligible = { mandatoryRequirementsKnown: true, mandatoryRequirementsSatisfied: true };

describe('deriveMatchLabel', () => {
  const cases: Array<[
    string,
    'direct_match' | 'conditional_niche' | 'adjacency',
    'explicit_linkage' | 'conditional_linkage',
    number,
    readonly AssuredEvidence[],
    typeof eligible,
    string,
    boolean,
  ]> = [
    ['direct with both sides and Jev agreement', 'direct_match', 'explicit_linkage', 0.9, [opportunity, client], eligible, 'explicit_linkage', false],
    ['direct missing client side', 'direct_match', 'explicit_linkage', 0.9, [opportunity], eligible, 'conditional_linkage', true],
    ['direct without Jev agreement', 'direct_match', 'conditional_linkage', 0.9, [opportunity, client], eligible, 'conditional_linkage', true],
    ['failed eligibility caps direct', 'direct_match', 'explicit_linkage', 0.9, [opportunity, client], { mandatoryRequirementsKnown: true, mandatoryRequirementsSatisfied: false }, 'conditional_linkage', true],
    ['historical award alone is class evidence', 'direct_match', 'explicit_linkage', 0.9, [award], eligible, 'capability_class_alignment', true],
    ['scores cannot rescue absent linkage', 'direct_match', 'explicit_linkage', 1, [], eligible, 'insufficient_evidence', true],
    ['conditional tier stays conditional', 'conditional_niche', 'explicit_linkage', 0.9, [opportunity, client], eligible, 'conditional_linkage', false],
    ['adjacency stays adjacency', 'adjacency', 'explicit_linkage', 0.9, [opportunity, client], eligible, 'adjacency', false],
  ];
  it.each(cases)('%s', (_name, assertedTier, jevCategory, jevConfidence, evidence, eligibility, label, downgraded) => {
    expect(deriveMatchLabel({ assertedTier, jevCategory, jevConfidence, evidence: [...evidence], eligibility }))
      .toMatchObject({ label, downgraded });
  });

  it('requires resolved authoritative evidence on each side', () => {
    expect(deriveMatchLabel({
      assertedTier: 'direct_match', jevCategory: 'explicit_linkage', jevConfidence: 0.9,
      evidence: [{ ...opportunity, authoritative: false }, client], eligibility: eligible,
    })).toMatchObject({
      label: 'conditional_linkage', reasons: expect.arrayContaining(['missing_opportunity_authority']),
    });
  });
});
