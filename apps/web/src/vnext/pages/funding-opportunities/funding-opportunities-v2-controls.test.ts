import { describe, expect, test } from 'vitest';
import { filterChips } from './FundingOpportunitiesPage.js';
import { criteriaFromSearchParams, DEFAULT_V2_CRITERIA, updateCriteria } from './funding-opportunities-v2-state.js';

describe('funding opportunities v2 main control semantics', () => {
  test('Any agency clears the agency restriction and does not create a chip', () => {
    const restricted = updateCriteria(DEFAULT_V2_CRITERIA, { agencies: ['disa'] });
    const discovery = updateCriteria(restricted, { agencies: [] });
    expect(discovery.agencies).toEqual([]);
    expect(filterChips(discovery).some((chip) => chip.key === 'agencies')).toBe(false);
  });

  test('typed filter chips use group option labels and remove exact values', () => {
    const criteria = updateCriteria(DEFAULT_V2_CRITERIA, {
      agencies: ['army'],
      funding: ['u1'],
      methods: ['grantsgov'],
      costShare: ['required'],
      codes: ['541715'],
      deadlineWindow: '30d',
    });
    const chips = filterChips(criteria);
    expect(chips.map((chip) => chip.label)).toEqual(expect.arrayContaining([
      'Department of the Army', 'Under $1M', 'Grants.gov workspace', 'Required', 'NAICS 541715', 'within 30d',
    ]));
    expect(chips.filter((chip) => chip.key === 'agencies')).toHaveLength(1);
    const after = updateCriteria(criteria, { costShare: [] });
    expect(filterChips(after).some((chip) => chip.key === 'costShare')).toBe(false);
  });

  test('an unscoped route starts in valid all-opportunities mode', () => {
    const criteria = criteriaFromSearchParams(new URLSearchParams());
    expect(criteria.mode).toBe('all');
    expect(criteria.clientId).toBeNull();
  });

  test('preserves explicit matched mode only for a nonempty client and normalizes orphaned routes', () => {
    const matched = criteriaFromSearchParams(new URLSearchParams('mode=matched&client=client-1'));
    expect(matched).toMatchObject({ mode: 'matched', clientId: 'client-1' });

    for (const search of ['mode=matched', 'mode=matched&client=', 'mode=matched&client=%20']) {
      expect(criteriaFromSearchParams(new URLSearchParams(search))).toMatchObject({ mode: 'all', clientId: null });
    }
  });

  test('clearing a matched client transitions back to an all-opportunities catalog search', () => {
    const matched = criteriaFromSearchParams(new URLSearchParams('mode=matched&client=client-1'));
    const cleared = updateCriteria(matched, { clientId: null, mode: 'all' });
    expect(cleared).toMatchObject({ mode: 'all', clientId: null });
  });
});
