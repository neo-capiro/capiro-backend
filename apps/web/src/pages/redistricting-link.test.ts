import { describe, expect, test } from 'vitest';
import { redistrictingHref } from './redistricting-link.js';

/**
 * WS-D3. Before this, redistricting change-cards hard-coded
 * `/intelligence/changes` because no per-district page existed. It does now
 * (`/directory/districts/:state/:districtNo`), and these pin the two ways the
 * new link can silently break: pointing at a 404, or regressing to the inbox.
 *
 * The payload shape under test is exactly what
 * `apps/api/scripts/emit-redistricting-alerts.ts` writes into
 * `intelligence_change.data`.
 */
describe('redistrictingHref', () => {
  test('links to the district page using the zero-padded facility district code', () => {
    expect(
      redistrictingHref({
        legistormDistrictId: '603',
        state: 'TX',
        districtNo: '23',
        facilityDistrictCode: '23',
        name: 'Texas 23rd',
      }),
    ).toBe('/directory/districts/TX/23');
  });

  test("uses '00' for an at-large district, matching the route's at-large convention", () => {
    expect(
      redistrictingHref({
        state: 'WY',
        districtNo: null,
        facilityDistrictCode: '00',
        name: 'Wyoming At-Large',
      }),
    ).toBe('/directory/districts/WY/00');
  });

  test('uses facilityDistrictCode, NOT the bare districtNo which would 404', () => {
    // The emitter writes both: districtNo '7' (bare) and facilityDistrictCode
    // '07' (padded). Only the padded one resolves.
    expect(redistrictingHref({ state: 'CO', districtNo: '7', facilityDistrictCode: '07' })).toBe(
      '/directory/districts/CO/07',
    );
  });

  test('falls back to the changes inbox rather than building a broken URL', () => {
    expect(redistrictingHref({ state: 'TX' })).toBe('/intelligence/changes');
    expect(redistrictingHref({ facilityDistrictCode: '23' })).toBe('/intelligence/changes');
    expect(redistrictingHref({})).toBe('/intelligence/changes');
    expect(redistrictingHref(null)).toBe('/intelligence/changes');
    expect(redistrictingHref(undefined)).toBe('/intelligence/changes');
  });

  test('ignores non-string values instead of coercing them into the path', () => {
    expect(redistrictingHref({ state: 51, facilityDistrictCode: 23 })).toBe('/intelligence/changes');
  });
});
