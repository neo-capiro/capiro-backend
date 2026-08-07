import { describe, expect, test } from '@jest/globals';
import { toForecastRow } from './tango-forecast.mapper.js';
import type { TangoForecast } from './tango.types.js';

function forecast(overrides: Partial<TangoForecast> = {}): TangoForecast {
  return {
    provenance: {
      provider: 'tango',
      resourceType: 'forecast',
      externalId: 'FCST-1',
      fetchedAt: '2026-08-07T00:00:00.000Z',
      providerUpdatedAt: '2026-08-01T12:00:00.000Z',
    },
    forecastId: 'FCST-1',
    externalId: 'SYN-1',
    title: 'Synthetic Forecast',
    description: 'A synthetic forecast for testing.',
    agency: 'Synthetic Agency',
    departmentCode: 'SYN',
    departmentName: 'Synthetic Department',
    organizationAgencyCode: 'SYNAG',
    organizationAgencyName: null,
    officeCode: 'OFF1',
    officeName: 'Synthetic Office',
    organizationId: 'org-uuid-1',
    anticipatedAwardDate: '2027-04-01T00:00:00.000Z',
    estimatedPeriod: 'Q3 FY27',
    fiscalYear: 2027,
    naicsCode: '336412',
    pscCode: null,
    setAside: 'Total Small Business Set-Aside',
    contractVehicle: 'Synthetic MAC IDIQ',
    placeOfPerformance: 'Ogden, UT',
    primaryContact: { name: 'Jane Contractor', email: 'jane@example.invalid', phone: null, title: 'CO' },
    status: 'Planned',
    isActive: true,
    sourceSystem: 'Synthetic Portal',
    sourceUrl: null,
    ...overrides,
  };
}

describe('toForecastRow', () => {
  test('a fully-populated forecast maps every field', () => {
    const row = toForecastRow(forecast());
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      tangoForecastId: 'FCST-1',
      externalId: 'SYN-1',
      title: 'Synthetic Forecast',
      agency: 'Synthetic Agency',
      departmentCode: 'SYN',
      departmentName: 'Synthetic Department',
      organizationAgencyCode: 'SYNAG',
      organizationAgencyName: null,
      officeCode: 'OFF1',
      officeName: 'Synthetic Office',
      organizationId: 'org-uuid-1',
      estimatedPeriod: 'Q3 FY27',
      fiscalYear: 2027,
      naicsCode: '336412',
      pscCode: null,
      setAside: 'Total Small Business Set-Aside',
      contractVehicle: 'Synthetic MAC IDIQ',
      placeOfPerformance: 'Ogden, UT',
      primaryContactName: 'Jane Contractor',
      primaryContactEmail: 'jane@example.invalid',
      primaryContactPhone: null,
      primaryContactTitle: 'CO',
      status: 'Planned',
      isActive: true,
      sourceSystem: 'Synthetic Portal',
      sourceUrl: null,
    });
    expect(row!.anticipatedAwardDate).toEqual(new Date('2027-04-01T00:00:00.000Z'));
    expect(row!.providerModifiedAt).toEqual(new Date('2026-08-01T12:00:00.000Z'));
  });

  test('no title: dropped, not stored with an invented placeholder', () => {
    expect(toForecastRow(forecast({ title: null }))).toBeNull();
  });

  test('no primary contact: every contact column is null, not an empty string', () => {
    const row = toForecastRow(forecast({ primaryContact: null }));
    expect(row).toMatchObject({
      primaryContactName: null,
      primaryContactEmail: null,
      primaryContactPhone: null,
      primaryContactTitle: null,
    });
  });

  test('no anticipated award date and no provider-modified stamp both map to null, not to a fabricated date', () => {
    const row = toForecastRow(
      forecast({
        anticipatedAwardDate: null,
        provenance: {
          provider: 'tango',
          resourceType: 'forecast',
          externalId: 'FCST-1',
          fetchedAt: '2026-08-07T00:00:00.000Z',
          providerUpdatedAt: null,
        },
      }),
    );
    expect(row!.anticipatedAwardDate).toBeNull();
    expect(row!.providerModifiedAt).toBeNull();
  });

  test('the snapshot column carries the full normalized domain object, not the raw provider payload', () => {
    const f = forecast();
    const row = toForecastRow(f);
    expect(row!.snapshot).toMatchObject({
      forecastId: 'FCST-1',
      title: 'Synthetic Forecast',
      primaryContact: { name: 'Jane Contractor' },
    });
  });

  test('pscCode and sourceUrl pass through null even if a future caller mistakenly supplies a value — this mapper does not fabricate the exception', () => {
    // Documents the CURRENT contract precisely: today, every real caller
    // (mapForecast) always sets both to null (decision-log D-45). This
    // mapper does not itself enforce that — it is a pure passthrough for
    // both fields — so this test pins the passthrough behavior rather than
    // a business rule that belongs in mapForecast instead.
    const row = toForecastRow(forecast({ pscCode: '1560', sourceUrl: 'https://example.invalid/x' }));
    expect(row!.pscCode).toBe('1560');
    expect(row!.sourceUrl).toBe('https://example.invalid/x');
  });
});
