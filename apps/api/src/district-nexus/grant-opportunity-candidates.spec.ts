import { describe, expect, test } from '@jest/globals';
import { GRANTS_GOV_OTHER_APPLICANTS, GRANTS_GOV_UNRESTRICTED_APPLICANTS } from '@capiro/shared';
import {
  shapeClientRelevanceProfile,
  type ClientRelevanceProfileRows,
} from './grant-opportunity-candidates.js';
import { computeEligibility, type OpportunityProfile } from './grant-opportunity-relevance.js';

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
        capabilities: [
          {
            name: 'Hypersonics',
            keywords: ['thermal protection'],
            tags: ['scramjet', 'thermal protection'],
          },
        ],
        fundingPriorities: ['Field demonstration', ' Field demonstration ', ''],
        facilityStates: ['tx', 'TX', null, '  '],
        priorAssistanceListings: ['93.778', '93.778', null],
        priorAgencies: ['HHS'],
        applicantTypes: ['Small businesses'],
      }),
    );

    expect(profile).toEqual({
      sector: 'Defense / Aerospace',
      capabilityKeywords: ['Hypersonics', 'thermal protection', 'scramjet'],
      fundingPriorities: ['Field demonstration'],
      priorAssistanceListings: ['93.778'],
      priorAgencies: ['HHS'],
      applicantTypes: ['Small businesses'],
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
    test('legacy source-only and numeric values remain stored but cannot establish organization eligibility', () => {
      const stored = rows({
        applicantTypes: ['12', GRANTS_GOV_OTHER_APPLICANTS, GRANTS_GOV_UNRESTRICTED_APPLICANTS],
      });
      const before = [...stored.applicantTypes!];
      const profile = shapeClientRelevanceProfile(stored);
      expect(stored.applicantTypes).toEqual(before);
      expect(profile.applicantTypes).toEqual([]);
      expect(
        computeEligibility(profile, opportunity({ eligibleApplicantTypes: ['Small businesses'] }))
          .state,
      ).toBe('needs_review');
    });

    test('normalizes recognized organization labels and drops blanks', () => {
      const profile = shapeClientRelevanceProfile(
        rows({
          applicantTypes: [
            'Small businesses',
            ' small  BUSINESSES ',
            '',
            null,
            'State governments',
          ],
        }),
      );
      expect(profile.applicantTypes).toEqual(['Small businesses', 'State governments']);
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
      const profile = shapeClientRelevanceProfile(rows({ applicantTypes: ['Small businesses'] }));
      const result = computeEligibility(
        profile,
        opportunity({ eligibleApplicantTypes: ['Small businesses'] }),
      );
      expect(result.state).toBe('eligible');
      expect(result.reason).toContain('Small businesses');
    });

    test('an unpopulated client still reports needs_review, never eligible', () => {
      const profile = shapeClientRelevanceProfile(rows({}));
      const result = computeEligibility(
        profile,
        opportunity({ eligibleApplicantTypes: ['Small businesses'] }),
      );
      expect(result.state).toBe('needs_review');
    });

    test('a populated client with a non-matching type is ineligible, not needs_review', () => {
      const profile = shapeClientRelevanceProfile(rows({ applicantTypes: ['Small businesses'] }));
      const result = computeEligibility(
        profile,
        opportunity({ eligibleApplicantTypes: ['State governments'] }),
      );
      expect(result.state).toBe('ineligible');
    });

    test('a geographic restriction still gates eligibility even with a matching type', () => {
      const profile = shapeClientRelevanceProfile(
        rows({ applicantTypes: ['Small businesses'], facilityStates: ['CA'] }),
      );
      const result = computeEligibility(
        profile,
        opportunity({
          eligibleApplicantTypes: ['Small businesses'],
          geographicRestrictions: ['TX'],
        }),
      );
      expect(result.state).toBe('ineligible');
    });
  });
});
