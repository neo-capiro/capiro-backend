import {
  expandFootprintRows,
  parseCongressionalGeography,
  parseFootprintImport,
} from './district-nexus-economic-import.js';

describe('District Nexus Release 3 footprint import', () => {
  it('maps CSV headers and preserves missing values as null rather than zero', async () => {
    const csv = [
      'facility_name,address,city,state,zip,employees,payroll',
      'Plant One,100 Main St,Dayton,OH,45402,125,',
    ].join('\n');
    const parsed = await parseFootprintImport({
      filename: 'footprint.csv',
      format: 'csv',
      contentBase64: Buffer.from(csv).toString('base64'),
    });
    const evidence = expandFootprintRows(parsed.rows, {
      sourceType: 'client_import',
    });
    expect(parsed.rows).toHaveLength(1);
    expect(evidence.map((row) => row.evidenceType)).toEqual(['facility', 'employee']);
    expect(evidence.find((row) => row.evidenceType === 'employee')?.numericValue).toBe(125);
    expect(evidence.some((row) => row.evidenceType === 'payroll')).toBe(false);
  });

  it('expands one structured row into distinct facility, jobs, money and supplier evidence', async () => {
    const parsed = await parseFootprintImport({
      filename: 'meri-reviewed.json',
      format: 'meri_structured',
      rows: [
        {
          facilityName: 'Factory A',
          addressLine1: '10 Test Way',
          city: 'Austin',
          state: 'tx',
          congressionalDistrict: 'TX-10',
          employeeCount: '250',
          payroll: '$12,500,000',
          capitalInvestment: '(1000)',
          supplierName: 'Supplier LLC',
          supplierSpend: '400000',
        },
      ],
    });
    const evidence = expandFootprintRows(parsed.rows, {
      sourceType: 'meri_structured',
      effectiveDate: '2026-08-01',
    });
    expect(evidence.map((row) => row.evidenceType)).toEqual([
      'facility',
      'employee',
      'payroll',
      'capital_investment',
      'supplier',
      'supplier_spend',
    ]);
    expect(evidence[0]?.geography).toMatchObject({
      state: 'TX',
      congressionalDistrict: '10',
      districtSource: 'provided',
    });
    expect(evidence.find((row) => row.evidenceType === 'capital_investment')?.numericValue).toBe(-1000);
    expect(evidence.every((row) => row.verificationStatus === 'user_provided')).toBe(true);
  });

  it('treats state and district as one pair and blocks a cross-state hybrid', () => {
    expect(parseCongressionalGeography('VA', 'TX-10')).toEqual({
      state: 'VA',
      district: null,
      warnings: ['District state prefix TX does not match supplied state VA; requires review.'],
    });
    const evidence = expandFootprintRows(
      [{ supplierName: 'Supplier', supplierSpend: 10, state: 'VA', congressionalDistrict: 'TX-10' }],
      { sourceType: 'client_import' },
    );
    expect(evidence.every((row) => row.geography.congressionalDistrict === null)).toBe(true);
    expect(evidence.every((row) => row.warnings.some((warning) => warning.includes('requires review')))).toBe(true);
  });

  it('derives state from a state-qualified district and recognizes at-large', () => {
    expect(parseCongressionalGeography(null, 'WY-AL')).toEqual({
      state: 'WY',
      district: '00',
      warnings: [],
    });
    expect(parseCongressionalGeography('AK', '0')).toEqual({
      state: 'AK',
      district: '00',
      warnings: [],
    });
  });

  it('does not invent a district when neither district nor a complete address exists', async () => {
    const parsed = await parseFootprintImport({
      filename: 'manual',
      format: 'manual',
      rows: [{ supplierName: 'Local Supplier', supplierSpend: 10_000 }],
    });
    const evidence = expandFootprintRows(parsed.rows, { sourceType: 'client_import' });
    expect(evidence).toHaveLength(2);
    expect(evidence.every((row) => row.geography.congressionalDistrict === null)).toBe(true);
    expect(evidence.every((row) => row.warnings.some((warning) => warning.startsWith('No district')))).toBe(true);
  });

  it('marks nonnumeric and invalid temporal values as blocking review warnings instead of zero', async () => {
    const parsed = await parseFootprintImport({
      filename: 'manual',
      format: 'manual',
      rows: [
        {
          evidenceType: 'employee',
          numericValue: 'unknown',
          state: 'VA',
          congressionalDistrict: '10',
          effectiveFrom: 'not-a-date',
          observedAt: 'not-a-time',
        },
      ],
    });
    const evidence = expandFootprintRows(parsed.rows, { sourceType: 'client_import' });
    expect(evidence[0]?.numericValue).toBeNull();
    expect(evidence[0]?.warnings).toContain('employee requires a numeric value.');
    expect(evidence[0]?.warnings).toContain('effective_from is not a valid date; requires review.');
    expect(evidence[0]?.warnings).toContain('observed_at is not a valid timestamp; requires review.');
  });

  it('rejects unsupported formats before any import can be persisted', async () => {
    await expect(
      parseFootprintImport({
        filename: 'bad.txt',
        format: 'pdf' as never,
        contentBase64: Buffer.from('x').toString('base64'),
      }),
    ).rejects.toThrow('Unsupported footprint import format');
  });
});
