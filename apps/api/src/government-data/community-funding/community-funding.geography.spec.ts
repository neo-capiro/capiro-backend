import { normalizeCommunityFundingGeography } from './community-funding.geography.js';

describe('normalizeCommunityFundingGeography', () => {
  it('derives a House state and padded district from a source STDD code', () => {
    expect(
      normalizeCommunityFundingGeography({
        chamber: 'house',
        requesterState: null,
        requesterDistrict: 'fl08',
        projectState: null,
      }),
    ).toEqual({ state: 'FL', district: '08', conflictReason: null });
  });

  it.each([
    ['AK00', 'AK'],
    ['AKAL', 'AK'],
    ['DC00', 'DC'],
    ['PR00', 'PR'],
  ])('normalizes documented at-large code %s', (code, state) => {
    expect(
      normalizeCommunityFundingGeography({
        chamber: 'house',
        requesterState: null,
        requesterDistrict: code,
        projectState: null,
      }),
    ).toEqual({ state, district: '00', conflictReason: null });
  });

  it('does not turn a Senate statewide request into a House district', () => {
    expect(
      normalizeCommunityFundingGeography({
        chamber: 'senate',
        requesterState: 'FL',
        requesterDistrict: 'FL08',
        projectState: 'FL',
      }),
    ).toEqual({ state: 'FL', district: null, conflictReason: null });
  });

  it.each(['FL8', 'FL00', 'FL29', 'FL98', 'ZZ08', 'AQ00', 'FLXX', 'FL080'])(
    'rejects malformed, sentinel, or out-of-range code %s',
    (code) => {
      expect(
        normalizeCommunityFundingGeography({
          chamber: 'house',
          requesterState: null,
          requesterDistrict: code,
          projectState: null,
        }),
      ).toMatchObject({ state: null, district: null });
    },
  );

  it('leaves conflicting explicit and STDD geography unresolved', () => {
    expect(
      normalizeCommunityFundingGeography({
        chamber: 'house',
        requesterState: 'GA',
        requesterDistrict: 'FL08',
        projectState: 'GA',
      }),
    ).toEqual({
      state: null,
      district: null,
      conflictReason: 'requester state GA conflicts with source district FL08',
    });
  });
});
