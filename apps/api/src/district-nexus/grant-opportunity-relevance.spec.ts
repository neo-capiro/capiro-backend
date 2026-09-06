import { describe, expect, test } from '@jest/globals';
import {
  GRANTS_GOV_APPLICANT_TYPES,
  GRANTS_GOV_ORGANIZATION_TYPE_GROUPS,
  GRANTS_GOV_OTHER_APPLICANTS,
  GRANTS_GOV_UNRESTRICTED_APPLICANTS,
  getClientOrganizationTypes,
  getGrantsGovOrganizationTypeLabel,
  isGrantsGovSourceEligibilityRule,
} from '@capiro/shared';
import {
  computeEligibility,
  meetsGrantSuggestionFloor,
  scoreOpportunityRelevance,
  MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR,
  RELEVANCE_MAX_SCORE,
  RELEVANCE_WEIGHTS,
  type ClientRelevanceProfile,
  type OpportunityProfile,
} from './grant-opportunity-relevance.js';

/**
 * Scores measure fit evidence. Applicant type and geography remain explanatory
 * signals with zero weight; neither can inflate thematic relevance. Expectations
 * use the exported denominator so the program-match floor stays reproducible.
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

  test('an applicant-type match explains eligibility without establishing substantive fit', () => {
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: ['Small businesses'] }),
      opportunity({ eligibleApplicantTypes: ['Small businesses', 'State governments'] }),
    );
    const hit = result.matchedSignals.find((s) => s.signal === 'applicantType');
    expect(hit).toBeDefined();
    expect(hit?.strength).toBe('weak');
    expect(hit?.matchedOn).toBe('Small businesses');
    expect(result.eligibilityState).toBe('eligible');
    expect(result.relevanceScore).toBe(0);
    expect(result.meetsSuggestionFloor).toBe(false);
  });

  test('applicant-type matching tolerates case and whitespace, like eligibility does', () => {
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: ['small  BUSINESSES'] }),
      opportunity({ eligibleApplicantTypes: ['Small businesses'] }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toContain('applicantType');
  });

  test('a state restriction the client satisfies is eligibility context with no fit score', () => {
    const result = scoreOpportunityRelevance(
      client({ states: ['CA'] }),
      opportunity({ geographicRestrictions: ['CA', 'OR'] }),
    );
    const hit = result.matchedSignals.find((s) => s.signal === 'stateRestriction');
    expect(hit?.matchedOn).toBe('CA');
    expect(hit?.weight).toBe(0);
    expect(result.relevanceScore).toBe(0);
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

  /**
   * G2. `normalizeListing` used to be `replace(/[^0-9.]/g, '')`, which DELETED
   * the letter suffix instead of keeping it, so `93.00R`, `93.00E`, `93.00F`,
   * `93.00G`, `93.00J` and `93.00K` — six genuinely different federal listings —
   * all collapsed to `93.00` and matched each other. That manufactured the
   * highest-weighted signal in the table, which clears the suggestion floor on
   * its own. Proven against production data: `93.00R` alone has 75 real award
   * rows behind it.
   */
  describe('Assistance Listing identity (regression: suffix collapse)', () => {
    const listingSignals = (clientListing: string, opportunityListing: string): string[] =>
      scoreOpportunityRelevance(
        client({ priorAssistanceListings: [clientListing] }),
        opportunity({ assistanceListingNumber: opportunityListing }),
      ).matchedSignals.map((s) => s.signal);

    test('two listings differing ONLY in their letter suffix are different programs', () => {
      expect(listingSignals('93.00E', '93.00R')).not.toContain('assistanceListing');
      expect(listingSignals('93.00F', '93.00R')).not.toContain('assistanceListing');
      expect(listingSignals('93.00J', '93.00K')).not.toContain('assistanceListing');
    });

    test('a suffixed listing is not the same program as the unsuffixed stem', () => {
      expect(listingSignals('93.00', '93.00R')).not.toContain('assistanceListing');
      expect(listingSignals('93.00R', '93.00')).not.toContain('assistanceListing');
    });

    test('a suffixed listing still matches ITSELF — the fix keeps the true positive', () => {
      // Deleting the suffix was one wrong answer; refusing to parse it at all
      // would be the other. `93.00R` is a real listing and two of them are the
      // same program.
      expect(listingSignals('93.00R', '93.00R')).toContain('assistanceListing');
      expect(listingSignals('cfda 93.00r', '93.00R')).toContain('assistanceListing');
    });

    test("'CFDA 93.778', '93.778 ' and '93.778' are all one listing", () => {
      for (const stored of ['CFDA 93.778', '93.778 ', '93.778']) {
        for (const notice of ['CFDA 93.778', '93.778 ', '93.778']) {
          expect(listingSignals(stored, notice)).toContain('assistanceListing');
        }
      }
    });

    test('two unparseable values are NOT a match — an empty normalization is not a value', () => {
      // The whole class of bug: any normalizer that can map junk to a shared
      // token turns "we know nothing about either side" into the strongest
      // signal we have.
      for (const junk of ['', '   ', 'n/a', 'unknown', 'CFDA', '--']) {
        expect(listingSignals(junk, junk)).toEqual([]);
      }
    });

    test('a listing embedded in a longer number cannot be truncated into a match', () => {
      // Truncating `93.7789` to `93.778` would invent an equality, which is the
      // same failure in a different disguise.
      expect(listingSignals('93.778', '93.7789')).not.toContain('assistanceListing');
      expect(listingSignals('93.778', '1293.778')).not.toContain('assistanceListing');
    });

    test('a client holding ONLY 93.00E earns no strong signal against a 93.00R notice', () => {
      // The end-to-end statement of G2: not merely "the signal is absent" but
      // "the pair does not reach the suggestion floor on the strength of a
      // listing it does not actually share".
      const result = scoreOpportunityRelevance(
        client({ priorAssistanceListings: ['93.00E'] }),
        opportunity({
          assistanceListingNumber: '93.00R',
          title: 'A notice under a different listing',
        }),
      );
      expect(result.matchedSignals.filter((s) => s.strength === 'strong')).toEqual([]);
      expect(result.relevanceScore).toBe(0);
      expect(result.meetsSuggestionFloor).toBe(false);
    });
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
    test("does NOT match just because the category string appears in the opportunity's own text", () => {
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
      client({ applicantTypes: ['Small businesses'] }),
      opportunity({ eligibleApplicantTypes: ['Small businesses', 'State governments'] }),
    );
    expect(result.state).toBe('eligible');
  });

  test('a non-matching applicant type is ineligible, and the reason names both sides', () => {
    const result = computeEligibility(
      client({ applicantTypes: ['Small businesses'] }),
      opportunity({ eligibleApplicantTypes: ['State governments'] }),
    );
    expect(result.state).toBe('ineligible');
    expect(result.reason).toContain('State governments');
    expect(result.reason).toContain('Small businesses');
  });

  test('an opportunity that states no applicant types is unknown, never eligible', () => {
    // Defaulting to eligible is the dangerous direction to be wrong in.
    const result = computeEligibility(
      client({ applicantTypes: ['Small businesses'] }),
      opportunity(),
    );
    expect(result.state).toBe('unknown');
  });

  test('missing client applicant type is needs_review, not a guess', () => {
    const result = computeEligibility(
      client(),
      opportunity({ eligibleApplicantTypes: ['Small businesses'] }),
    );
    expect(result.state).toBe('needs_review');
  });

  test('geographic restriction with no client presence is ineligible', () => {
    const result = computeEligibility(
      client({ states: ['TX'], applicantTypes: ['Small businesses'] }),
      opportunity({
        geographicRestrictions: ['CA', 'OR'],
        eligibleApplicantTypes: ['Small businesses'],
      }),
    );
    expect(result.state).toBe('ineligible');
    expect(result.reason).toContain('CA');
  });

  test('geographic restriction the client satisfies does not block eligibility', () => {
    const result = computeEligibility(
      client({ states: ['CA'], applicantTypes: ['Small businesses'] }),
      opportunity({ geographicRestrictions: ['CA'], eligibleApplicantTypes: ['Small businesses'] }),
    );
    expect(result.state).toBe('eligible');
  });

  test('geographic restriction with no known client state needs review', () => {
    const result = computeEligibility(
      client({ applicantTypes: ['Small businesses'] }),
      opportunity({ geographicRestrictions: ['CA'], eligibleApplicantTypes: ['Small businesses'] }),
    );
    expect(result.state).toBe('needs_review');
  });

  test('every outcome carries a reason', () => {
    const cases = [
      computeEligibility(
        client({ applicantTypes: ['Small businesses'] }),
        opportunity({ eligibleApplicantTypes: ['Small businesses'] }),
      ),
      computeEligibility(
        client({ applicantTypes: ['Small businesses'] }),
        opportunity({ eligibleApplicantTypes: ['State governments'] }),
      ),
      computeEligibility(client(), opportunity()),
      computeEligibility(client(), opportunity({ eligibleApplicantTypes: ['Small businesses'] })),
    ];
    for (const c of cases) expect(c.reason.length).toBeGreaterThan(10);
  });
});

describe('organization types and source eligibility rules', () => {
  test('the client picker preserves fifteen source identities without source-only rules', () => {
    const values = GRANTS_GOV_ORGANIZATION_TYPE_GROUPS.flatMap((group) =>
      group.options.map((option) => option.value),
    );
    expect(GRANTS_GOV_APPLICANT_TYPES).toHaveLength(17);
    expect(new Set(values).size).toBe(15);
    expect(values.every((value) => GRANTS_GOV_APPLICANT_TYPES.includes(value))).toBe(true);
    expect(values.some(isGrantsGovSourceEligibilityRule)).toBe(false);
    expect(getGrantsGovOrganizationTypeLabel('Small businesses')).toBe('Small business');
    expect(getGrantsGovOrganizationTypeLabel('Legacy organization')).toBe('Legacy organization');
  });

  test('reading client types canonicalizes real identities without mutating saved legacy values', () => {
    const stored = [
      'small  BUSINESSES',
      GRANTS_GOV_OTHER_APPLICANTS,
      GRANTS_GOV_UNRESTRICTED_APPLICANTS,
      '12',
      'Small businesses',
    ];
    const before = [...stored];
    expect(getClientOrganizationTypes(stored)).toEqual(['Small businesses']);
    expect(stored).toEqual(before);
  });

  test('unrestricted source eligibility accepts a recorded organization with an explicit limitation', () => {
    const result = computeEligibility(
      client({ applicantTypes: ['Small businesses'] }),
      opportunity({ eligibleApplicantTypes: [GRANTS_GOV_UNRESTRICTED_APPLICANTS] }),
    );
    expect(result.state).toBe('eligible');
    expect(result.reason).toContain('accepts all organization types');
    expect(result.reason).toContain('Additional Information on Eligibility');
    expect(result.reason).toContain('check only');
  });

  test.each([[], [GRANTS_GOV_UNRESTRICTED_APPLICANTS], [GRANTS_GOV_OTHER_APPLICANTS], ['12']])(
    'unrestricted source does not invent a client identity from %j',
    (...values: string[]) => {
      const result = computeEligibility(
        client({ applicantTypes: values }),
        opportunity({ eligibleApplicantTypes: [GRANTS_GOV_UNRESTRICTED_APPLICANTS] }),
      );
      expect(result.state).toBe('needs_review');
    },
  );

  test.each([
    [GRANTS_GOV_OTHER_APPLICANTS],
    [GRANTS_GOV_OTHER_APPLICANTS, 'State governments'],
    ['A newly introduced source category'],
  ])('source eligibility %j cannot establish a false mismatch', (...types: string[]) => {
    const result = computeEligibility(
      client({ applicantTypes: ['Small businesses'] }),
      opportunity({ eligibleApplicantTypes: types }),
    );
    expect(result.state).toBe('needs_review');
  });

  test('an explicit organization match still resolves the type check when Other is also accepted', () => {
    const result = computeEligibility(
      client({ applicantTypes: ['Small businesses'] }),
      opportunity({ eligibleApplicantTypes: [GRANTS_GOV_OTHER_APPLICANTS, 'Small businesses'] }),
    );
    expect(result.state).toBe('eligible');
    expect(result.reason).toContain('review additional eligibility requirements');
  });

  test('unrestricted applicant types do not override an explicit geographic mismatch', () => {
    const result = computeEligibility(
      client({ applicantTypes: ['Small businesses'], states: ['TX'] }),
      opportunity({
        eligibleApplicantTypes: [GRANTS_GOV_UNRESTRICTED_APPLICANTS],
        geographicRestrictions: ['CA'],
      }),
    );
    expect(result.state).toBe('ineligible');
  });

  test('legacy source-only selections neither establish identity nor generate match evidence', () => {
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: [GRANTS_GOV_OTHER_APPLICANTS, GRANTS_GOV_UNRESTRICTED_APPLICANTS] }),
      opportunity({
        eligibleApplicantTypes: [GRANTS_GOV_OTHER_APPLICANTS, GRANTS_GOV_UNRESTRICTED_APPLICANTS],
      }),
    );
    expect(result.eligibilityState).toBe('needs_review');
    expect(result.matchedSignals).toEqual([]);
    expect(result.relevanceScore).toBe(0);
    expect(result.meetsSuggestionFloor).toBe(false);
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
        applicantTypes: ['Small businesses'],
        states: ['TX'],
      }),
      opportunity({
        assistanceListingNumber: '93.778',
        agency: 'HHS',
        eligibleApplicantTypes: ['State governments'],
      }),
    );
    // assistanceListing + agency only: the client's applicant type ('Small businesses') is NOT
    // among the ones this notice accepts ('State governments'), so applicantType does not fire,
    // and the notice states no geographic restriction.
    expect(result.relevanceScore).toBe(
      pct(RELEVANCE_WEIGHTS.assistanceListing + RELEVANCE_WEIGHTS.agency),
    );
    expect(result.eligibilityState).toBe('ineligible');
  });

  test('an opportunity whose ONLY tie to the client is the applicant type scores low, and stays eligible', () => {
    // Eligibility can be displayed as context without recommending an unrelated
    // program to every organization of the same legal form.
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: ['Small businesses'] }),
      opportunity({ eligibleApplicantTypes: ['Small businesses'], title: 'Something unrelated' }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toEqual(['applicantType']);
    expect(result.relevanceScore).toBe(pct(RELEVANCE_WEIGHTS.applicantType));
    expect(result.relevanceScore).toBeLessThan(MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR);
    expect(result.eligibilityState).toBe('eligible');
    expect(result.meetsSuggestionFloor).toBe(false);
  });

  test('an opportunity with no client tie at all still scores zero', () => {
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: ['Small businesses'] }),
      opportunity({ eligibleApplicantTypes: ['State governments'], title: 'Something unrelated' }),
    );
    expect(result.relevanceScore).toBe(0);
    expect(result.eligibilityState).toBe('ineligible');
  });
});

describe('funding priorities as explicit client intent', () => {
  test('a specific project priority with independent agency evidence can establish fit', () => {
    const result = scoreOpportunityRelevance(
      client({
        fundingPriorities: ['Autonomous ground vehicles'],
        priorAgencies: ['Department of Energy'],
      }),
      opportunity({
        title: 'Autonomous ground vehicles for field demonstration',
        agency: 'Department of Energy',
      }),
    );
    expect(result.matchedSignals).toContainEqual({
      signal: 'capabilityKeyword',
      matchedOn: 'Autonomous ground vehicles',
      source: 'funding_priority',
      weight: 15,
      strength: 'moderate',
    });
    expect(result.meetsSuggestionFloor).toBe(true);
    expect(result.relevanceScore).toBe(35);
  });

  test('capability and funding priority matching the same topic score once with capability provenance', () => {
    const profile = client({
      capabilityKeywords: ['Battery storage'],
      priorAgencies: ['Department of Energy'],
    });
    const notice = opportunity({
      title: 'Battery storage demonstrations',
      agency: 'Department of Energy',
    });
    const baseline = scoreOpportunityRelevance(profile, notice);
    const withPriority = scoreOpportunityRelevance(
      { ...profile, fundingPriorities: ['Battery storage', 'Battery storage demonstrations'] },
      notice,
    );
    expect(withPriority.relevanceScore).toBe(baseline.relevanceScore);
    expect(
      withPriority.matchedSignals.filter((signal) => signal.signal === 'capabilityKeyword'),
    ).toEqual([
      {
        signal: 'capabilityKeyword',
        matchedOn: 'Battery storage',
        source: 'capability',
        weight: 15,
        strength: 'moderate',
      },
    ]);
  });

  test.each(['funding opportunities', 'research and development', 'advanced systems'])(
    'generic priority %s creates no topical evidence',
    (priority) => {
      const result = scoreOpportunityRelevance(
        client({ fundingPriorities: [priority], priorAgencies: ['DOE'] }),
        opportunity({ title: priority, agency: 'DOE' }),
      );
      expect(result.matchedSignals.some((signal) => signal.signal === 'capabilityKeyword')).toBe(
        false,
      );
      expect(result.meetsSuggestionFloor).toBe(false);
    },
  );

  test('a priority repeated as sector and funding category cannot corroborate itself', () => {
    const result = scoreOpportunityRelevance(
      client({ fundingPriorities: ['energy'], sector: 'Energy' }),
      opportunity({ title: 'Energy projects', fundingCategory: 'Energy' }),
    );
    expect(result.matchedSignals.map((signal) => signal.signal)).toEqual(['capabilityKeyword']);
    expect(result.meetsSuggestionFloor).toBe(false);
  });

  test('priority matching observes word boundaries', () => {
    const result = scoreOpportunityRelevance(
      client({ fundingPriorities: ['care'] }),
      opportunity({ title: 'Medicare operations' }),
    );
    expect(result.matchedSignals).toEqual([]);
  });
});

describe('grant suggestion floor', () => {
  test('small-business eligibility and permitted geography cannot recommend an unrelated program', () => {
    const result = scoreOpportunityRelevance(
      client({ applicantTypes: ['Small businesses'], states: ['FL'], sector: 'Aerospace' }),
      opportunity({
        title: 'Community arts education',
        eligibleApplicantTypes: ['Small businesses'],
        geographicRestrictions: ['FL'],
      }),
    );
    expect(result.eligibilityState).toBe('eligible');
    expect(result.relevanceScore).toBe(0);
    expect(result.meetsSuggestionFloor).toBe(false);
  });

  test('prior agency history alone does not recommend every program at that agency', () => {
    const result = scoreOpportunityRelevance(
      client({ priorAgencies: ['Department of Energy'], applicantTypes: ['Small businesses'] }),
      opportunity({ agency: 'Department of Energy', eligibleApplicantTypes: ['Small businesses'] }),
    );
    expect(result.meetsSuggestionFloor).toBe(false);
  });

  test('specific grid capability with prior Energy agency history remains discoverable', () => {
    const result = scoreOpportunityRelevance(
      client({ capabilityKeywords: ['grid resilience'], priorAgencies: ['Department of Energy'] }),
      opportunity({ title: 'Grid-resilience demonstration', agency: 'Department of Energy' }),
    );
    expect(result.meetsSuggestionFloor).toBe(true);
  });

  test.each([
    'research',
    'research and development',
    'technology',
    'advanced systems',
    'small business',
    'funding opportunities',
  ])('generic capability "%s" cannot turn a broad sector match into a suggestion', (keyword) => {
    const result = scoreOpportunityRelevance(
      client({
        capabilityKeywords: [keyword],
        sector: 'Health',
        applicantTypes: ['Small businesses'],
      }),
      opportunity({ title: `Health ${keyword}`, eligibleApplicantTypes: ['Small businesses'] }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).not.toContain('capabilityKeyword');
    expect(result.meetsSuggestionFloor).toBe(false);
  });

  test('a word embedded inside another word is not capability evidence', () => {
    const result = scoreOpportunityRelevance(
      client({ capabilityKeywords: ['care'], sector: 'Health' }),
      opportunity({ title: 'Health analytics for Medicare administration' }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).not.toContain('capabilityKeyword');
    expect(result.meetsSuggestionFloor).toBe(false);
  });

  test('one topic repeated as capability, sector and category counts once', () => {
    const result = scoreOpportunityRelevance(
      client({ capabilityKeywords: ['energy', 'ENERGY'], sector: 'Energy' }),
      opportunity({ title: 'Energy funding', fundingCategory: 'Energy' }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toEqual(['capabilityKeyword']);
    expect(result.meetsSuggestionFloor).toBe(false);
  });

  test('a category repeating the sector does not inflate a genuine match', () => {
    const result = scoreOpportunityRelevance(
      client({ capabilityKeywords: ['grid resilience'], sector: 'Energy' }),
      opportunity({ title: 'Grid resilience for energy systems', fundingCategory: 'Energy' }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toEqual(['capabilityKeyword', 'sector']);
    expect(result.relevanceScore).toBe(
      pct(RELEVANCE_WEIGHTS.capabilityKeyword + RELEVANCE_WEIGHTS.sector),
    );
    expect(result.meetsSuggestionFloor).toBe(true);
  });

  test('a broad tag cannot shadow a more specific matching capability', () => {
    const result = scoreOpportunityRelevance(
      client({ capabilityKeywords: ['energy', 'grid resilience'], sector: 'Energy' }),
      opportunity({ title: 'Grid resilience for energy systems' }),
    );
    expect(result.matchedSignals.find((s) => s.signal === 'capabilityKeyword')?.matchedOn).toBe(
      'grid resilience',
    );
    expect(result.meetsSuggestionFloor).toBe(true);
  });

  test('legacy strong eligibility labels and duplicated capability signals cannot bypass the floor', () => {
    expect(
      meetsGrantSuggestionFloor([
        { signal: 'applicantType', strength: 'strong', matchedOn: 'Small businesses' },
        { signal: 'stateRestriction', strength: 'strong', matchedOn: 'FL' },
      ]),
    ).toBe(false);
    expect(
      meetsGrantSuggestionFloor([
        { signal: 'capabilityKeyword', strength: 'moderate', matchedOn: 'energy' },
        { signal: 'capabilityKeyword', strength: 'moderate', matchedOn: 'energy' },
        { signal: 'sector', strength: 'weak', matchedOn: 'Energy' },
      ]),
    ).toBe(false);
  });

  test('an assistance-listing hit alone clears the floor', () => {
    const result = scoreOpportunityRelevance(
      client({ priorAssistanceListings: ['93.778'] }),
      opportunity({ assistanceListingNumber: '93.778' }),
    );
    expect(result.meetsSuggestionFloor).toBe(true);
    expect(meetsGrantSuggestionFloor(result.matchedSignals)).toBe(true);
  });

  test('a capability keyword PLUS a distinctive sector token clears the floor', () => {
    // Keyword alone is moderate; sector is weak. Together they are enough to
    // surface a grant that previously stayed hidden under the SAM-style floor.
    const result = scoreOpportunityRelevance(
      client({ capabilityKeywords: ['hypersonics'], sector: 'Aerospace' }),
      opportunity({
        title: 'Hypersonics research for aerospace platforms',
        description: 'Propulsion and materials for hypersonic flight.',
      }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toEqual(
      expect.arrayContaining(['capabilityKeyword', 'sector']),
    );
    expect(result.meetsSuggestionFloor).toBe(true);
  });

  test('a capability keyword alone does NOT clear the floor', () => {
    const result = scoreOpportunityRelevance(
      client({ capabilityKeywords: ['hypersonics'] }),
      opportunity({ title: 'Hypersonics research initiative', description: null }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toEqual(['capabilityKeyword']);
    expect(result.meetsSuggestionFloor).toBe(false);
  });

  test('a sector-only weak hit does NOT clear the floor', () => {
    const result = scoreOpportunityRelevance(
      client({ sector: 'Aerospace' }),
      opportunity({ title: 'Aerospace materials program', description: null }),
    );
    expect(result.matchedSignals.map((s) => s.signal)).toEqual(['sector']);
    expect(result.meetsSuggestionFloor).toBe(false);
  });
});
