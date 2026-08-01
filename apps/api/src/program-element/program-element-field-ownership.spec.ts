import { describe, expect, test } from '@jest/globals';
import {
  authorityForSource,
  mayOwnCanonicalField,
  type CanonicalPeYearField,
  type PeSourceAuthority,
} from './program-element-field-ownership.js';

describe('Program Element canonical field ownership', () => {
  const cases: Array<[string, PeSourceAuthority, CanonicalPeYearField]> = [
    ['r_doc_army_fy27', 'presidents_budget_request', 'request'],
    ['p_doc_navy_fy27', 'presidents_budget_request', 'request'],
    ['o1_army_fy27', 'presidents_budget_request', 'request'],
    ['hasc_report_fy27', 'hasc_authorization', 'hascMark'],
    ['sasc_report_fy27', 'sasc_authorization', 'sascMark'],
    ['hac_d_report_fy27', 'hacd_appropriations', 'hacDMark'],
    ['sac_d_report_fy27', 'sacd_appropriations', 'sacDMark'],
    ['conference_report_fy27', 'ndaa_conference', 'ndaaConference'],
    ['approps_conference_report_fy27', 'appropriations_conference', 'conference'],
    ['public_law_fy27', 'enacted_public_law', 'enacted'],
    ['reprogramming_fy27', 'reprogramming', 'reprogrammed'],
    ['execution_fy27', 'execution', 'executed'],
  ];

  test.each(cases)('%s maps to %s and owns only %s', (source, authority, ownedField) => {
    expect(authorityForSource(source)).toBe(authority);
    expect(mayOwnCanonicalField(authority, ownedField)).toBe(true);
    expect(mayOwnCanonicalField(authority, ownedField === 'request' ? 'enacted' : 'request')).toBe(false);
  });

  test('unknown sources cannot own a canonical field', () => {
    expect(authorityForSource('mystery_scrape')).toBe('unknown');
    expect(mayOwnCanonicalField('unknown', 'request')).toBe(false);
  });

  test('unsupported Phase L source families cannot own canonical fields', () => {
    expect(authorityForSource('milcon_army_fy27')).toBe('unknown');
    expect(authorityForSource('execution_feed_q1')).toBe('unknown');
    expect(authorityForSource('p5_unreviewed_blob')).toBe('unknown');
    expect(mayOwnCanonicalField('unknown', 'request')).toBe(false);
    expect(
      mayOwnCanonicalField('presidents_budget_request', 'request', 'production', 'milcon_fy27'),
    ).toBe(false);
  });

  test('fixture ownership is allowed only in NODE_ENV=test', () => {
    expect(mayOwnCanonicalField('fixture', 'request', 'test')).toBe(true);
    expect(mayOwnCanonicalField('fixture', 'request', 'production')).toBe(false);
  });

  test('manual override owns every canonical field', () => {
    for (const field of [
      'request',
      'hascMark',
      'sascMark',
      'hacDMark',
      'sacDMark',
      'conference',
      'ndaaConference',
      'enacted',
      'reprogrammed',
      'executed',
    ] as const) {
      expect(mayOwnCanonicalField('manual_override', field)).toBe(true);
    }
  });
});
