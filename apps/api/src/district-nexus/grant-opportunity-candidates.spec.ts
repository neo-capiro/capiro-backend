import { describe, expect, test } from '@jest/globals';
import {
  shapeClientRelevanceProfile,
  type ClientRelevanceProfileRows,
} from './grant-opportunity-candidates.js';
import {
  computeEligibility,
  type OpportunityProfile,
} from './grant-opportunity-relevance.js';

function rows(partial: Partial<ClientRelevanceProfileRows> = {}): ClientRelevanceProfileRows {
  return {
    sectorTag: null,
    capabilities: [],
    facilityStates: [],
    priorAssistanceListings: [],
    priorAgencies: [],
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

describe('shapeClientRelevanceProfile', () => {
  test('carries every field through as a fact, never an inference', () => {
    const profile = shapeClientRelevanceProfile(
      rows({
        sectorTag: 'Defense / Aerospace',
        capabilities: [{ name: 'Hypersonics', tags: ['scramjet', 'thermal protection'] }],
        facilityStates: ['tx', 'TX', null, '  '],
        priorAssistanceListings: ['93.778', '93.778', null],
        priorAgencies: ['HHS'],
        applicantTypes: ['12'],
      }),
    );

    expect(profile).toEqual({
      sector: 'Defense / Aerospace',
      capabilityKeywords: ['Hypersonics', 'scramjet', 'thermal protection'],
      priorAssistanceListings: ['93.778'],
      priorAgencies: ['HHS'],
      applicantTypes: ['12'],
      states: ['tx', 'TX'],
      knownPartnerNames: [],
    });
  });

  test('a JSON tags column that is not an array is ignored, not coerced', () => {
    // ClientCapability.tags is a JSON column; a string or object there must not
    // become a keyword.
    const profile = shapeClientRelevanceProfile(
      rows({ capabilities: [{ name: 'C2', tags: 'not-an-array' }] }),
    );
    expect(profile.capabilityKeywords).toEqual(['C2']);
  });

  describe('applicantTypes — the input F3 eligibility was missing', () => {
    test('dedupes and drops blanks like every other code array', () => {
      const profile = shapeClientRelevanceProfile(
        rows({ applicantTypes: ['12', ' 12 ', '', null, '06'] }),
      );
      expect(profile.applicantTypes).toEqual(['12', '06']);
    });

    test('a caller that has not been taught to select the column degrades to empty', () => {
      // The field is optional on the rows interface on purpose: an un-updated
      // caller gets the honest empty profile rather than failing to compile into
      // a wrong one.
      const profile = shapeClientRelevanceProfile(rows({}));
      expect(profile.applicantTypes).toEqual([]);
    });

    /**
     * The point of the whole change. Before `Client.applicantTypes` existed,
     * `shapeClientRelevanceProfile` hardcoded `applicantTypes: []`, so no client
     * profile built through the real shaping path could ever reach
     * `computeEligibility`'s `eligible` branch — the column was honest but inert.
     * These two tests pin both directions through the real function, not a
     * hand-built profile literal.
     */
    test('a populated client CAN now reach eligible', () => {
      const profile = shapeClientRelevanceProfile(rows({ applicantTypes: ['12'] }));
      const result = computeEligibility(profile, opportunity({ eligibleApplicantTypes: ['12'] }));
      expect(result.state).toBe('eligible');
      expect(result.reason).toContain('12');
    });

    test('an unpopulated client still reports needs_review, never eligible', () => {
      const profile = shapeClientRelevanceProfile(rows({}));
      const result = computeEligibility(profile, opportunity({ eligibleApplicantTypes: ['12'] }));
      expect(result.state).toBe('needs_review');
    });

    test('a populated client with a non-matching type is ineligible, not needs_review', () => {
      const profile = shapeClientRelevanceProfile(rows({ applicantTypes: ['12'] }));
      const result = computeEligibility(profile, opportunity({ eligibleApplicantTypes: ['06'] }));
      expect(result.state).toBe('ineligible');
    });

    test('a geographic restriction still gates eligibility even with a matching type', () => {
      const profile = shapeClientRelevanceProfile(
        rows({ applicantTypes: ['12'], facilityStates: ['CA'] }),
      );
      const result = computeEligibility(
        profile,
        opportunity({ eligibleApplicantTypes: ['12'], geographicRestrictions: ['TX'] }),
      );
      expect(result.state).toBe('ineligible');
    });
  });
});
