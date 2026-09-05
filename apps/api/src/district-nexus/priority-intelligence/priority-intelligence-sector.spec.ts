import {
  projectSectorMetric,
  isStale,
  SECTOR_NAICS_RULES,
} from './priority-intelligence-sector.js';

describe('priority-intelligence-sector', () => {
  const base = {
    dataset: 'cbp',
    sourceYear: 2023,
    boundaryCongress: 119,
    metricKey: 'employment',
    unit: 'employees',
    sourceRecordId: 'row-1',
    sourceUrl: 'https://census.gov',
    observedAt: '2026-08-01T00:00:00.000Z',
    lastSyncedAt: new Date().toISOString(),
  };

  it('maps CBP manufacturing NAICS deterministically', () => {
    const out = projectSectorMetric({
      ...base,
      source: 'cbp',
      naicsCode: '336413',
      metricValue: 14280,
    });
    expect(out?.family).toBe('manufacturing_industry');
    expect(out?.label).toContain('Manufacturing');
  });

  it('does not force unmapped CBP NAICS into a family', () => {
    expect(
      projectSectorMetric({ ...base, source: 'cbp', naicsCode: '541611', metricValue: 12 }),
    ).toBeNull();
    expect(
      projectSectorMetric({ ...base, source: 'cbp', naicsCode: null, metricValue: 12 }),
    ).toBeNull();
  });

  it('maps LODES/ACS workforce metrics and GSA federal-presence metrics', () => {
    expect(
      projectSectorMetric({
        ...base,
        source: 'lodes',
        dataset: 'lodes_wac_rac_od',
        naicsCode: null,
        metricKey: 'jobs_total',
        metricValue: 1000,
        unit: 'jobs',
      })?.family,
    ).toBe('workforce');
    expect(
      projectSectorMetric({
        ...base,
        source: 'gsa',
        dataset: 'frpp',
        naicsCode: null,
        metricKey: 'gsa_asset_count',
        metricValue: 5,
        unit: 'assets',
      })?.family,
    ).toBe('defense_federal_presence');
  });

  it('never invents sector links for unmapped sources/keys (no LLM classification)', () => {
    expect(
      projectSectorMetric({
        ...base,
        source: 'acs',
        naicsCode: null,
        metricKey: 'not_a_real_metric',
        metricValue: 1,
      }),
    ).toBeNull();
    expect(SECTOR_NAICS_RULES.length).toBeGreaterThan(0);
  });

  describe('isStale', () => {
    const now = new Date('2026-09-02T00:00:00.000Z');

    it('not loaded → stale; fresh annual sync → current', () => {
      expect(isStale(2023, null, now)).toBe(true);
      expect(isStale(2023, '2026-08-01T00:00:00.000Z', now)).toBe(false);
    });

    it('old sync or old source year → visibly stale', () => {
      expect(isStale(2023, '2025-01-01T00:00:00.000Z', now)).toBe(true);
      expect(isStale(2020, '2026-08-01T00:00:00.000Z', now)).toBe(true);
    });
  });
});
