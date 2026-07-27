import { describe, expect, test } from '@jest/globals';
import {
  CONTRACT_TIER,
  assistanceTier,
  claimsFullAwardAmount,
  componentForRelationship,
  facilityTier,
  relationshipTier,
  weakestStrength,
} from './district-nexus.verification.js';

describe('one tier table drives both axes', () => {
  test('CONTRACT_TIER is always inferred — the contract rail has no verified-identifier path', () => {
    expect(CONTRACT_TIER).toEqual({ status: 'inferred', strength: 'inferred', confidence: null });
  });

  test('assistanceTier: a UEI match is source-verified', () => {
    expect(assistanceTier('uei')).toEqual({
      status: 'source_verified',
      strength: 'sourceAuthoritative',
      confidence: 1,
    });
  });

  test('assistanceTier: a recipient-name match is inferred', () => {
    expect(assistanceTier('recipient_name')).toEqual({
      status: 'inferred',
      strength: 'inferred',
      confidence: null,
    });
  });

  test('facilityTier: a geocode match is geocode-verified', () => {
    expect(facilityTier({ geocodeStatus: 'matched', districtSource: null })).toEqual({
      status: 'geocode_verified',
      strength: 'verified',
      confidence: 1,
    });
  });

  test('facilityTier: a hand-typed claim is user-provided', () => {
    expect(facilityTier({ geocodeStatus: 'no_match', districtSource: 'user' })).toEqual({
      status: 'user_provided',
      strength: 'userProvided',
      confidence: null,
    });
  });

  test('facilityTier: a web-imported claim is ALSO user-provided — neither is geocoder-confirmed', () => {
    expect(facilityTier({ geocodeStatus: 'no_match', districtSource: 'web_import' })).toEqual({
      status: 'user_provided',
      strength: 'userProvided',
      confidence: null,
    });
  });

  test('relationshipTier: an explicitly verified relationship earns full weight', () => {
    expect(relationshipTier('verified')).toEqual({
      status: 'source_verified',
      strength: 'verified',
      confidence: 1,
    });
  });

  test('relationshipTier: anything else (including "unverified") is user-provided', () => {
    expect(relationshipTier('unverified')).toEqual({
      status: 'user_provided',
      strength: 'userProvided',
      confidence: null,
    });
  });
});

describe('weakestStrength', () => {
  test('collapses to the weaker of two strengths', () => {
    expect(weakestStrength(['verified', 'inferred'])).toBe('inferred');
  });

  test('sourceAuthoritative loses to recipientLocation', () => {
    expect(weakestStrength(['sourceAuthoritative', 'recipientLocation'])).toBe('recipientLocation');
  });

  test('an empty list defaults to verified — the identity element for weakerStrength', () => {
    expect(weakestStrength([])).toBe('verified');
  });
});

describe('componentForRelationship (audit F4)', () => {
  test.each([
    ['direct_recipient', 'grantPlaceOfPerformance'],
    ['subrecipient', 'grantPlaceOfPerformance'],
    ['project_site', 'grantPlaceOfPerformance'],
    ['research_partner', 'partnerBeneficiary'],
    ['coalition_partner', 'partnerBeneficiary'],
    ['beneficiary', 'partnerBeneficiary'],
    ['matching_contributor', 'partnerBeneficiary'],
  ])('%s maps to %s', (relationshipType, expected) => {
    expect(componentForRelationship(relationshipType)).toBe(expected);
  });

  test('opportunity_candidate maps to null — it is a forecast with its own client-level rail, not scored here', () => {
    expect(componentForRelationship('opportunity_candidate')).toBeNull();
  });

  test('an unrecognised relationship type maps to null rather than guessing', () => {
    expect(componentForRelationship('something_new')).toBeNull();
  });
});

describe('claimsFullAwardAmount (audit F4)', () => {
  test('direct_recipient may claim the award\'s full obligation/outlay', () => {
    expect(claimsFullAwardAmount('direct_recipient')).toBe(true);
  });

  test.each([
    'subrecipient',
    'project_site',
    'research_partner',
    'coalition_partner',
    'beneficiary',
    'matching_contributor',
    'opportunity_candidate',
  ])('%s may not — claiming the whole award for a partial role is the overstatement this rail avoids', (relationshipType) => {
    expect(claimsFullAwardAmount(relationshipType)).toBe(false);
  });
});
