import { describe, expect, test } from '@jest/globals';
import {
  computeEligibility,
  scoreOpportunityRelevance,
  type ClientRelevanceProfile,
  type OpportunityProfile,
} from './grant-opportunity-relevance.js';

function client(partial: Partial<ClientRelevanceProfile> = {}): ClientRelevanceProfile {
  return {
    sector: null,
    capabilityKeywords: [],
    priorAssistanceListings: [],
    priorAgencies: [],
    applicantTypes: [],
    states: [],
    knownPartnerNames: [],
    ...partial,
  };
}

function opportunity(partial: Partial<OpportunityProfile> = {}): OpportunityProfile {
  return {
    assistanceListingNumber: null,
    agency: null,
    fundingCategory: null,
    title: null,
    description: null,
    eligibleApplicantTypes: [],
    geographicRestrictions: [],
    ...partial,
  };
}

describe('relevance signals', () => {
  test('an exact prior Assistance Listing is the strongest single signal', () => {
    const result = scoreOpportunityRelevance(
      client({ priorAssistanceListings: ['93.778'] }),
      opportunity({ assistanceListingNumber: '93.778' }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toEqual(['assistanceListing']);
    expect(result.relevanceScore).toBe(40);
  });

  test('listing comparison ignores formatting noise', () => {
    const result = scoreOpportunityRelevance(
      client({ priorAssistanceListings: ['CFDA 93.778'] }),
      opportunity({ assistanceListingNumber: ' 93.778 ' }),
    );
    expect(result.matchedSignals).toHaveLength(1);
  });

  test('capability keywords match against title and description', () => {
    const result = scoreOpportunityRelevance(
      client({ capabilityKeywords: ['hypersonics'] }),
      opportunity({ description: 'Research into HYPERSONICS testing infrastructure.' }),
    );
    expect(result.matchedSignals[0]?.signal).toBe('capabilityKeyword');
    expect(result.matchedSignals[0]?.matchedOn).toBe('hypersonics');
  });

  test('very short keywords are ignored so noise cannot manufacture a match', () => {
    const result = scoreOpportunityRelevance(
      client({ capabilityKeywords: ['AI'] }),
      opportunity({ description: 'Maintaining rail infrastructure.' }),
    );
    // "ai" appears inside "maintaining"; a 2-char keyword must not fire.
    expect(result.matchedSignals).toHaveLength(0);
  });

  test('signals accumulate and are reported strongest-first', () => {
    const result = scoreOpportunityRelevance(
      client({
        priorAssistanceListings: ['93.778'],
        priorAgencies: ['Department of Health and Human Services'],
        capabilityKeywords: ['medicaid'],
      }),
      opportunity({
        assistanceListingNumber: '93.778',
        agency: 'Department of Health and Human Services',
        description: 'Medicaid administration modernization.',
      }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toEqual([
      'assistanceListing',
      'agency',
      'capabilityKeyword',
    ]);
    expect(result.relevanceScore).toBe(75); // (40+20+15)/100
  });

  test('no signals means zero, and an empty matchedSignals list to explain it', () => {
    const result = scoreOpportunityRelevance(client(), opportunity({ title: 'Unrelated' }));
    expect(result.relevanceScore).toBe(0);
    expect(result.matchedSignals).toEqual([]);
  });
});

describe('eligibility is computed only from structured fields', () => {
  test('a matching applicant type is eligible', () => {
    const result = computeEligibility(
      client({ applicantTypes: ['12'] }),
      opportunity({ eligibleApplicantTypes: ['12', '20'] }),
    );
    expect(result.state).toBe('eligible');
  });

  test('a non-matching applicant type is ineligible, and the reason names both sides', () => {
    const result = computeEligibility(
      client({ applicantTypes: ['12'] }),
      opportunity({ eligibleApplicantTypes: ['06'] }),
    );
    expect(result.state).toBe('ineligible');
    expect(result.reason).toContain('06');
    expect(result.reason).toContain('12');
  });

  test('an opportunity that states no applicant types is unknown, never eligible', () => {
    // Defaulting to eligible is the dangerous direction to be wrong in.
    const result = computeEligibility(client({ applicantTypes: ['12'] }), opportunity());
    expect(result.state).toBe('unknown');
  });

  test('missing client applicant type is needs_review, not a guess', () => {
    const result = computeEligibility(client(), opportunity({ eligibleApplicantTypes: ['12'] }));
    expect(result.state).toBe('needs_review');
  });

  test('geographic restriction with no client presence is ineligible', () => {
    const result = computeEligibility(
      client({ states: ['TX'], applicantTypes: ['12'] }),
      opportunity({ geographicRestrictions: ['CA', 'OR'], eligibleApplicantTypes: ['12'] }),
    );
    expect(result.state).toBe('ineligible');
    expect(result.reason).toContain('CA');
  });

  test('geographic restriction the client satisfies does not block eligibility', () => {
    const result = computeEligibility(
      client({ states: ['CA'], applicantTypes: ['12'] }),
      opportunity({ geographicRestrictions: ['CA'], eligibleApplicantTypes: ['12'] }),
    );
    expect(result.state).toBe('eligible');
  });

  test('geographic restriction with no known client state needs review', () => {
    const result = computeEligibility(
      client({ applicantTypes: ['12'] }),
      opportunity({ geographicRestrictions: ['CA'], eligibleApplicantTypes: ['12'] }),
    );
    expect(result.state).toBe('needs_review');
  });

  test('every outcome carries a reason', () => {
    const cases = [
      computeEligibility(client({ applicantTypes: ['12'] }), opportunity({ eligibleApplicantTypes: ['12'] })),
      computeEligibility(client({ applicantTypes: ['12'] }), opportunity({ eligibleApplicantTypes: ['06'] })),
      computeEligibility(client(), opportunity()),
      computeEligibility(client(), opportunity({ eligibleApplicantTypes: ['12'] })),
    ];
    for (const c of cases) expect(c.reason.length).toBeGreaterThan(10);
  });
});

describe('relevance and eligibility are independent', () => {
  test('a perfect thematic match the client legally cannot apply for stays high-scoring and ineligible', () => {
    // Folding eligibility into the score would turn "you are barred from this"
    // into "this is a weak match" — the client could waste a week on the bid.
    const result = scoreOpportunityRelevance(
      client({
        priorAssistanceListings: ['93.778'],
        priorAgencies: ['HHS'],
        applicantTypes: ['12'],
        states: ['TX'],
      }),
      opportunity({
        assistanceListingNumber: '93.778',
        agency: 'HHS',
        eligibleApplicantTypes: ['06'],
      }),
    );
    expect(result.relevanceScore).toBe(60);
    expect(result.eligibilityState).toBe('ineligible');
  });

  test('an eligible but irrelevant opportunity scores zero and stays eligible', () => {
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: ['12'] }),
      opportunity({ eligibleApplicantTypes: ['12'], title: 'Something unrelated' }),
    );
    expect(result.relevanceScore).toBe(0);
    expect(result.eligibilityState).toBe('eligible');
  });
});
