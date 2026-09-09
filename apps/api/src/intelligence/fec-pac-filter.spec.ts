import { describe, expect, test } from '@jest/globals';
import { isPacGiving, type ScheduleBRow } from '../../scripts/fec-pac-sync.js';

const contribution: ScheduleBRow = {
  filing_form: 'F3X',
  line_number: '23',
  recipient_name: 'Candidate committee',
  disbursement_amount: 5000,
};

describe('PAC giving source classification', () => {
  test('keeps a federal contribution even when the recipient ID was not resolved', () => {
    expect(isPacGiving(contribution)).toBe(true);
  });
  test('preserves negative corrections', () => {
    expect(isPacGiving({ ...contribution, disbursement_amount: -50 })).toBe(true);
  });
  test('excludes named operating vendors and refunds even if a committee ID is present', () => {
    expect(
      isPacGiving({ ...contribution, recipient_name: 'Named vendor', line_number: '21B' }),
    ).toBe(false);
    expect(
      isPacGiving({ ...contribution, line_number: '28C', recipient_committee_id: 'C00100321' }),
    ).toBe(false);
  });
  test('excludes double-counted memo entries', () => {
    expect(isPacGiving({ ...contribution, memo_code: 'X' })).toBe(false);
    expect(isPacGiving({ ...contribution, memoed_subtotal: true })).toBe(false);
  });
  test('does not count zero or missing amounts', () => {
    expect(isPacGiving({ ...contribution, disbursement_amount: 0 })).toBe(false);
    expect(isPacGiving({ ...contribution, disbursement_amount: undefined })).toBe(false);
  });
});
