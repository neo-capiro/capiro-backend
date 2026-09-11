import {
  expandFirmMapWithAllDistricts,
  zeroNexusDistrictSummary,
} from './district-nexus.firm-aggregate.js';
import type { DistrictNexusMapResponse } from './district-nexus.types.js';
import { US_HOUSE_SEATS } from '../common/us-congressional-districts.js';

function emptyMap(partial: Partial<DistrictNexusMapResponse> = {}): DistrictNexusMapResponse {
  return {
    districts: [],
    unmapped: { unmappedContractAmount: null, unmappedGrantAmount: null },
    freshness: [],
    warnings: [],
    generatedAt: '2026-09-11T00:00:00.000Z',
    ...partial,
  };
}

function nexusRow(key: string, score = 25) {
  const [state, districtCode] = key.split('-') as [string, string];
  return {
    ...zeroNexusDistrictSummary(state, districtCode),
    clientCount: 1,
    score,
    coveragePercent: 40,
    awarded: { contractObligations: 1_000_000, grantObligations: null, grantOutlays: null },
  };
}

describe('expandFirmMapWithAllDistricts', () => {
  test('WY (at-large) expands to a single 00 seat with null score', () => {
    const out = expandFirmMapWithAllDistricts(emptyMap(), { state: 'WY' });
    expect(out.districts).toHaveLength(1);
    expect(out.districts[0]).toMatchObject({
      districtKey: 'WY-00',
      districtCode: '00',
      score: null,
      coveragePercent: 0,
      clientCount: 0,
      awarded: { contractObligations: null, grantObligations: null, grantOutlays: null },
    });
  });

  test('DE (at-large) uses 00, not 01', () => {
    const out = expandFirmMapWithAllDistricts(emptyMap(), { state: 'DE' });
    expect(out.districts.map((d) => d.districtKey)).toEqual(['DE-00']);
  });

  test('FL expands to 28 seats and preserves an existing nexus row', () => {
    const existing = nexusRow('FL-08', 25);
    const out = expandFirmMapWithAllDistricts(emptyMap({ districts: [existing] }), { state: 'FL' });
    expect(out.districts).toHaveLength(28);
    const fl08 = out.districts.find((d) => d.districtKey === 'FL-08');
    expect(fl08?.score).toBe(25);
    expect(fl08?.clientCount).toBe(1);
    expect(fl08?.awarded.contractObligations).toBe(1_000_000);
    const empty = out.districts.find((d) => d.districtKey === 'FL-01');
    expect(empty?.score).toBeNull();
    expect(empty?.coveragePercent).toBe(0);
  });

  test('full national expand matches US_HOUSE_SEATS seat total', () => {
    const expected = Object.values(US_HOUSE_SEATS).reduce((a, b) => a + b, 0);
    const out = expandFirmMapWithAllDistricts(emptyMap());
    expect(out.districts).toHaveLength(expected);
    // No invented money on placeholders
    expect(out.districts.every((d) => d.score == null && d.coveragePercent === 0)).toBe(true);
  });

  test('nexus rows sort above zero-nexus placeholders', () => {
    const out = expandFirmMapWithAllDistricts(
      emptyMap({ districts: [nexusRow('TX-02', 10)] }),
      { state: 'TX' },
    );
    expect(out.districts).toHaveLength(38);
    expect(out.districts[0]!.districtKey).toBe('TX-02');
    expect(out.districts[0]!.score).toBe(10);
    expect(out.districts.slice(1).every((d) => d.score == null)).toBe(true);
  });
});
