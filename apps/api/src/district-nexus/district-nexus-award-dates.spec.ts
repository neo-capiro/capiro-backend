import { describe, expect, test } from '@jest/globals';
import { contractTopAward } from './district-nexus.service.js';

const row = {
  id: 'award-1',
  contractor_name: 'Acme Defense',
  description: 'Test award',
  amount: 100,
  action_date: new Date('2026-03-05T00:00:00Z'),
  award_unique_id: 'CONT_AWD_1',
  base_award_signed_date: new Date('2026-02-15T00:00:00Z'),
  latest_action_date: new Date('2026-03-01T00:00:00Z'),
};

describe('district nexus contract award dates', () => {
  test('off mode is deep-equal to the legacy payload', () => {
    expect(contractTopAward(row, false)).toEqual({
      id: 'award-1',
      label: 'Test award',
      counterparty: 'Acme Defense',
      amount: 100,
      awardedAt: '2026-03-05T00:00:00.000Z',
      externalUrl: 'https://www.usaspending.gov/award/CONT_AWD_1',
    });
  });

  test('enforce mode uses and labels the authoritative base signed date', () => {
    expect(contractTopAward(row, true)).toEqual({
      id: 'award-1',
      label: 'Test award',
      counterparty: 'Acme Defense',
      amount: 100,
      awardedAt: '2026-02-15T00:00:00.000Z',
      awardedAtSemantics: 'base_award_signed',
      baseAwardSignedDate: '2026-02-15T00:00:00.000Z',
      externalUrl: 'https://www.usaspending.gov/award/CONT_AWD_1',
    });
  });

  test('never substitutes legacy action_date when corrected dates are absent', () => {
    expect(
      contractTopAward(
        { ...row, base_award_signed_date: null, latest_action_date: null },
        true,
      ),
    ).toEqual(expect.objectContaining({
      awardedAt: null,
      awardedAtSemantics: 'latest_action',
      baseAwardSignedDate: null,
    }));
  });
});
