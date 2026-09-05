import {
  parseFrppWorksheet,
  frppIdentityPreimage,
  DEFENSE_AGENCY_PATTERNS,
} from './priority-intelligence-gsa-frpp-parser.js';

interface FakeRow {
  values: unknown[];
}

function fakeWorksheet(header: string[], rows: unknown[][]) {
  return {
    eachRow: (_opts: { includeEmpty: boolean }, cb: (row: number, row_2: FakeRow) => void) => {
      cb(1, { values: [undefined, ...header] }); // ExcelJS 1-indexes; values[0] is a slot
      rows.forEach((r, i) => cb(i + 2, { values: [undefined, ...r] }));
    },
  };
}

const FULL_HEADER = [
  'Real Property Unique Identifier',
  'Reporting Agency',
  'Reporting Agency Code',
  'Using Agency',
  'Using Bureau',
  'Installation Name',
  'Installation Id',
  'US/Foreign',
  'Country Name',
  'State Code',
  'State Name',
  'County Name',
  'City Name',
  'Zip Code',
  'Street Address',
  'Latitude',
  'Longitude',
  'Legal Interest Indicator',
  'Real Property Type',
  'Real Property Use',
  'Utilization',
  'Asset Status',
  'Asset Status Code',
  'Historical Status',
  'Square Feet (Buildings)',
  'Square Feet Unit of Measure',
  'Congressional District',
  'Lease Expiration Date',
  'Lease Start Date',
  'Lease Annual Rent to Lessor',
  'Number of Federal Employees',
  'Number of Federal Contractors',
  'FiscalYear',
];

function fullRow(overrides: Record<string, unknown> = {}): unknown[] {
  const base: Record<string, unknown> = {
    'Real Property Unique Identifier': 'RPUID-0001',
    'Reporting Agency': 'GENERAL SERVICES ADMINISTRATION',
    'Reporting Agency Code': '47',
    'Using Agency': 'GENERAL SERVICES ADMINISTRATION',
    'Using Bureau': 'PBS',
    'Installation Name': 'FEDERAL BUILDING',
    'Installation Id': 'INST-01',
    'US/Foreign': 'UNITED STATES',
    'Country Name': 'UNITED STATES',
    'State Code': 'AL',
    'State Name': 'Alabama',
    'County Name': 'Montgomery',
    'City Name': 'Montgomery',
    'Zip Code': '36104',
    'Street Address': '100 S Perry St',
    Latitude: 32.377716,
    Longitude: -86.300568,
    'Legal Interest Indicator': 'Owned',
    'Real Property Type': 'Building',
    'Real Property Use': 'Office',
    Utilization: 'Utilized',
    'Asset Status': 'Current Mission Need',
    'Asset Status Code': 'A',
    'Historical Status': 'Not Evaluated',
    'Square Feet (Buildings)': 120000,
    'Square Feet Unit of Measure': 'SF',
    'Congressional District': '2',
    'Lease Expiration Date': null,
    'Lease Start Date': null,
    'Lease Annual Rent to Lessor': null,
    'Number of Federal Employees': 250,
    'Number of Federal Contractors': 10,
    FiscalYear: 2024,
  };
  const merged = { ...base, ...overrides };
  return FULL_HEADER.map((h) => merged[h] ?? null);
}

describe('parseFrppWorksheet', () => {
  it('parses a well-formed FY24-shaped sheet by header name', () => {
    const result = parseFrppWorksheet(
      fakeWorksheet(FULL_HEADER, [
        fullRow(),
        fullRow({ 'Real Property Unique Identifier': 'RPUID-0002' }),
      ]),
      2024,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rejections).toHaveLength(0);
    expect(result.rows[0]!.rpUid).toBe('RPUID-0001');
    expect(result.rows[0]!.stateCode).toBe('AL');
    expect(result.rows[0]!.congressionalDistrict).toBe('2');
    expect(result.rows[0]!.geographyBasis).toBe('source_coordinates');
    expect(result.rows[0]!.grain).toBe('detailed_asset');
  });

  it('is position-independent: reordered columns still parse', () => {
    const reordered = [...FULL_HEADER].reverse();
    const rowByReversedHeader = reordered.map((h) => fullRow().at(FULL_HEADER.indexOf(h)) ?? null);
    const result = parseFrppWorksheet(fakeWorksheet(reordered, [rowByReversedHeader]), 2024);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.rpUid).toBe('RPUID-0001');
    expect(result.rows[0]!.congressionalDistrict).toBe('2');
  });

  it('treats blank cells as null — never zero (GSA FAQ: blank = N/A or redacted)', () => {
    const result = parseFrppWorksheet(
      fakeWorksheet(FULL_HEADER, [
        fullRow({
          'Square Feet (Buildings)': null,
          'Number of Federal Employees': null,
          'Congressional District': null,
          Latitude: null,
          Longitude: null,
        }),
      ]),
      2024,
    );
    expect(result.rows[0]!.squareFeet).toBeNull();
    expect(result.rows[0]!.federalEmployeesCount).toBeNull();
    expect(result.rows[0]!.congressionalDistrict).toBeNull();
    expect(result.rows[0]!.geographyBasis).toBe('source_state_only');
  });

  it('carries NO boundary congress — the dataset does not publish one (never inferred)', () => {
    const result = parseFrppWorksheet(fakeWorksheet(FULL_HEADER, [fullRow()]), 2024);
    expect(result.rows[0]!.boundaryCongress).toBeNull();
  });

  it('rejects rows with missing identity and FY mismatches', () => {
    const result = parseFrppWorksheet(
      fakeWorksheet(FULL_HEADER, [
        fullRow({ 'Real Property Unique Identifier': null }),
        fullRow({ FiscalYear: 2023 }),
        fullRow({ 'Real Property Unique Identifier': 'RPUID-0003' }),
      ]),
      2024,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.rpUid).toBe('RPUID-0003');
    expect(result.rejections).toHaveLength(2);
  });

  it('reports missing required columns instead of guessing', () => {
    const badHeader = FULL_HEADER.filter((h) => h !== 'Real Property Use');
    const result = parseFrppWorksheet(fakeWorksheet(badHeader, []), 2024);
    expect(result.missingRequiredColumns).toContain('Real Property Use');
    expect(result.rows).toHaveLength(0);
  });

  it('labels defense agencies via deterministic patterns', () => {
    const result = parseFrppWorksheet(
      fakeWorksheet(FULL_HEADER, [
        fullRow({ 'Reporting Agency': 'DEPARTMENT OF THE ARMY' }),
        fullRow({ 'Reporting Agency': 'GENERAL SERVICES ADMINISTRATION' }),
      ]),
      2024,
    );
    expect(result.rows[0]!.isDefense).toBe(true);
    expect(result.rows[1]!.isDefense).toBe(false);
    expect(DEFENSE_AGENCY_PATTERNS.some((p) => p.test('DEPARTMENT OF THE ARMY'))).toBe(true);
  });

  it('foreign rows drop coordinates and district but keep the country', () => {
    const result = parseFrppWorksheet(
      fakeWorksheet(FULL_HEADER, [
        fullRow({
          'US/Foreign': 'FOREIGN COUNTRIES',
          'Country Name': 'FED STATES MICRONESIA',
          'State Code': null,
          Latitude: 9.5,
          Longitude: 138.1,
        }),
      ]),
      2024,
    );
    expect(result.rows[0]!.geographyBasis).toBe('unresolved');
    expect(result.rows[0]!.latitude).toBeNull();
    expect(result.rows[0]!.congressionalDistrict).toBeNull();
    expect(result.rows[0]!.countryName).toBe('FED STATES MICRONESIA');
  });
});

describe('frppIdentityPreimage', () => {
  it('is deterministic and sensitive to identity fields', () => {
    const base = {
      sourceDocumentSha256: 'abc123',
      rpUid: 'RPUID-0001',
      fiscalYear: 2024,
      boundaryCongress: null,
      assetStatusCode: 'A',
    };
    const a = frppIdentityPreimage(base);
    const b = frppIdentityPreimage({ ...base });
    expect(a).toBe(b); // idempotent replays
    expect(frppIdentityPreimage({ ...base, rpUid: 'RPUID-0002' })).not.toBe(a);
    expect(frppIdentityPreimage({ ...base, fiscalYear: 2025 })).not.toBe(a);
    expect(frppIdentityPreimage({ ...base, boundaryCongress: 119 })).not.toBe(a);
  });
});
