import { describe, expect, test } from '@jest/globals';
import {
  computeEligibility,
  scoreOpportunityRelevance,
  MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR,
  RELEVANCE_MAX_SCORE,
  RELEVANCE_WEIGHTS,
  type ClientRelevanceProfile,
  type OpportunityProfile,
} from './grant-opportunity-relevance.js';

/**
 * Score expectations below are a share of RELEVANCE_MAX_SCORE, which the Funding
 * Opportunities work moved from 100 to 140 by adding the `applicantType` (25) and
 * `stateRestriction` (15) strong signals. The absolute numbers therefore changed
 * even where the matched-signal SETS did not; the ratios are what is being pinned.
 * They are written as explicit fractions so a future weight change shows up as an
 * arithmetic disagreement rather than as an unexplained magic number.
 */
const pct = (earned: number): number => Math.round((earned / RELEVANCE_MAX_SCORE) * 100);

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
    expect(result.relevanceScore).toBe(pct(RELEVANCE_WEIGHTS.assistanceListing));
  });

  test('an exact Assistance Listing alone clears the producer relevance floor', () => {
    // THE invariant behind generate-grant-opportunity-candidates.ts's default
    // floor: if the client previously received money under 93.778, a new 93.778
    // notice is the same program and must be suggested on that basis alone. The
    // floor used to be the literal 40, correct only while the denominator was
    // 100; this pins the rule itself so a weight change cannot quietly stop the
    // shipped producer from generating listing-only candidates.
    const result = scoreOpportunityRelevance(
      client({ priorAssistanceListings: ['93.778'] }),
      opportunity({ assistanceListingNumber: '93.778' }),
    );
    expect(result.relevanceScore).toBeGreaterThanOrEqual(MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR);
  });

  test('an explicit applicant-type match is a strong relevance signal in its own right', () => {
    // Separate from eligibility, which reads the same two arrays: a notice open
    // to small businesses AND state governments is more relevant to a small
    // business than one open to state governments alone, and both are equally
    // "eligible", so eligibility cannot carry that distinction.
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: ['Small businesses'] }),
      opportunity({ eligibleApplicantTypes: ['Small businesses', 'State governments'] }),
    );
    const hit = result.matchedSignals.find((s) => s.signal === 'applicantType');
    expect(hit).toBeDefined();
    expect(hit?.strength).toBe('strong');
    expect(hit?.matchedOn).toBe('Small businesses');
  });

  test('applicant-type matching tolerates case and whitespace, like eligibility does', () => {
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: ['small  BUSINESSES'] }),
      opportunity({ eligibleApplicantTypes: ['Small businesses'] }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toContain('applicantType');
  });

  test('a state restriction the client satisfies is a positive relevance signal', () => {
    const result = scoreOpportunityRelevance(
      client({ states: ['CA'] }),
      opportunity({ geographicRestrictions: ['CA', 'OR'] }),
    );
    const hit = result.matchedSignals.find((s) => s.signal === 'stateRestriction');
    expect(hit?.matchedOn).toBe('CA');
  });

  test('an UNRESTRICTED opportunity is not a geographic match for everybody', () => {
    // Silence about geography is not agreement about geography.
    const result = scoreOpportunityRelevance(
      client({ states: ['CA'] }),
      opportunity({ geographicRestrictions: [] }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).not.toContain('stateRestriction');
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
    expect(result.relevanceScore).toBe(
      pct(
        RELEVANCE_WEIGHTS.assistanceListing +
          RELEVANCE_WEIGHTS.agency +
          RELEVANCE_WEIGHTS.capabilityKeyword,
      ),
    );
  });

  test('no signals means zero, and an empty matchedSignals list to explain it', () => {
    const result = scoreOpportunityRelevance(client(), opportunity({ title: 'Unrelated' }));
    expect(result.relevanceScore).toBe(0);
    expect(result.matchedSignals).toEqual([]);
  });

  describe('fundingCategory (regression: was client-independent self-match)', () => {
    test('does NOT match just because the category string appears in the opportunity\'s own text', () => {
      // A grant's own title/description mentioning its own funding category is
      // a fact about the OPPORTUNITY, not the client — this client has no
      // sector, no capabilities, nothing that could legitimately signal a match.
      const result = scoreOpportunityRelevance(
        client(),
        opportunity({
          fundingCategory: 'Health',
          title: 'Health Research Initiative',
          description: 'Funding for health-related research.',
        }),
      );
      expect(result.matchedSignals.map((s) => s.signal)).not.toContain('fundingCategory');
    });

    test('still matches when the client sector exactly equals the funding category', () => {
      const result = scoreOpportunityRelevance(
        client({ sector: 'Health' }),
        opportunity({ fundingCategory: 'Health', title: 'Unrelated title', description: null }),
      );
      expect(result.matchedSignals.map((s) => s.signal)).toContain('fundingCategory');
    });
  });

  describe('sector (regression: was whole-string match only)', () => {
    test('a clean single-token sector still matches', () => {
      const result = scoreOpportunityRelevance(
        client({ sector: 'DEFENSE' }),
        opportunity({ description: 'Support for defense modernization programs.' }),
      );
      expect(result.matchedSignals.map((s) => s.signal)).toContain('sector');
    });

    test('a legacy compound sector value ("Defense / Aerospace", confirmed live on RTX) matches on its distinctive tokens', () => {
      const result = scoreOpportunityRelevance(
        client({ sector: 'Defense / Aerospace' }),
        opportunity({ description: 'Advanced aerospace propulsion research.' }),
      );
      const hit = result.matchedSignals.find((s) => s.signal === 'sector');
      expect(hit).toBeDefined();
      expect(hit?.matchedOn).toBe('aerospace');
    });

    test('an underscore-separated legacy sector value tokenizes the same way', () => {
      const result = scoreOpportunityRelevance(
        client({ sector: 'GOVERNMENT_AFFAIRS' }),
        opportunity({ description: 'Public affairs and outreach coordination.' }),
      );
      const hit = result.matchedSignals.find((s) => s.signal === 'sector');
      expect(hit).toBeDefined();
      expect(hit?.matchedOn).toBe('affairs');
    });

    test('a sector value made ONLY of domain-generic words does not manufacture a match', () => {
      // "government"/"federal" are near-tautological in a federal opportunity's
      // own text; matching on them alone would flood every opportunity.
      const result = scoreOpportunityRelevance(
        client({ sector: 'Federal Government' }),
        opportunity({ description: 'A routine federal government notice with no other detail.' }),
      );
      expect(result.matchedSignals.map((s) => s.signal)).not.toContain('sector');
    });

    test('the "OTHER" catch-all sector value does not manufacture a match off the common word "other"', () => {
      const result = scoreOpportunityRelevance(
        client({ sector: 'OTHER' }),
        opportunity({ description: 'This program is unlike any other in the portfolio.' }),
      );
      expect(result.matchedSignals.map((s) => s.signal)).not.toContain('sector');
    });
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
    // assistanceListing + agency only: the client's applicant type ('12') is NOT
    // among the ones this notice accepts ('06'), so applicantType does not fire,
    // and the notice states no geographic restriction.
    expect(result.relevanceScore).toBe(
      pct(RELEVANCE_WEIGHTS.assistanceListing + RELEVANCE_WEIGHTS.agency),
    );
    expect(result.eligibilityState).toBe('ineligible');
  });

  test('an opportunity whose ONLY tie to the client is the applicant type scores low, and stays eligible', () => {
    // This case used to assert a score of zero. It changed deliberately: an
    // applicant-type match is now a strong relevance signal (§6), so a notice
    // aimed at this kind of organization is not "irrelevant" — it is weakly
    // relevant, and separately eligible. The independence being pinned is that
    // eligibility did not inflate the score to something it hasn't earned.
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: ['12'] }),
      opportunity({ eligibleApplicantTypes: ['12'], title: 'Something unrelated' }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toEqual(['applicantType']);
    expect(result.relevanceScore).toBe(pct(RELEVANCE_WEIGHTS.applicantType));
    expect(result.relevanceScore).toBeLessThan(MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR);
    expect(result.eligibilityState).toBe('eligible');
  });

  test('an opportunity with no client tie at all still scores zero', () => {
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: ['12'] }),
      opportunity({ eligibleApplicantTypes: ['06'], title: 'Something unrelated' }),
    );
    expect(result.relevanceScore).toBe(0);
    expect(result.eligibilityState).toBe('ineligible');
  });
});
