import {
  billIdToCongressGovPath,
  formatBillId,
  isValidCanonicalId,
  normalizeCanonicalId,
  parseBillDesignation,
  parseBillId,
  zBioguideId,
  zBillId,
  zCommitteeSystemCode,
} from './canonical-ids';

describe('canonical-ID registry (C6.P6.0)', () => {
  it('validates well-formed ids per type and rejects malformed ones', () => {
    const good: Array<[Parameters<typeof isValidCanonicalId>[0], string]> = [
      ['bioguide', 'B000944'],
      ['billId', '119-hr-8800'],
      ['committee', 'hsas00'],
      ['cik', '320193'],
      ['uei', 'ZQGGHJH74DW7'],
      ['cage', '1CQV5'],
      ['rin', '2060-AV76'],
      ['docketId', 'EPA-HQ-OAR-2021-0317'],
      ['naics', '541511'],
      ['peCode', '0603270A'],
    ];
    for (const [type, v] of good) expect(isValidCanonicalId(type, v)).toBe(true);

    expect(isValidCanonicalId('bioguide', 'b0009')).toBe(false);
    expect(isValidCanonicalId('billId', 'hr-8800')).toBe(false);
    expect(isValidCanonicalId('uei', 'HASIO0000000')).toBe(false); // I/O banned
    expect(isValidCanonicalId('peCode', '12345')).toBe(false);
  });

  it('normalizes casing + CIK leading zeros', () => {
    expect(normalizeCanonicalId('bioguide', ' b000944 ')).toBe('B000944');
    expect(normalizeCanonicalId('committee', 'HSAS00')).toBe('hsas00');
    expect(normalizeCanonicalId('cik', '0000320193')).toBe('320193');
    expect(normalizeCanonicalId('billId', '119-HR-8800')).toBe('119-hr-8800');
  });

  it('round-trips the Capiro bill id house format', () => {
    const parsed = parseBillId('119-hr-8800');
    expect(parsed).toEqual({ congress: 119, type: 'hr', number: 8800 });
    expect(formatBillId(parsed!.congress, parsed!.type, parsed!.number)).toBe('119-hr-8800');
    expect(billIdToCongressGovPath('119-hr-8800')).toBe('/bill/119/hr/8800');
    expect(parseBillId('garbage')).toBeNull();
  });

  it('parses messy human bill designations (feed normalization)', () => {
    expect(parseBillDesignation('H.R. 8800 ', 119)).toEqual({
      congress: 119,
      type: 'hr',
      number: 8800,
    });
    expect(parseBillDesignation('S. 663', 119)).toEqual({ congress: 119, type: 's', number: 663 });
    expect(parseBillDesignation('H. Res. 1234', 119)).toEqual({
      congress: 119,
      type: 'hres',
      number: 1234,
    });
    expect(parseBillDesignation('S.J.Res. 7 (118th)', 119)).toEqual({
      congress: 118,
      type: 'sjres',
      number: 7,
    });
    expect(parseBillDesignation('the NDAA', 119)).toBeNull();
  });
});

describe('canonical-id zod schemas (C6.P6.2 tool enforcement)', () => {
  it('normalizes then accepts real ids', () => {
    expect(zBioguideId.parse('a000360')).toBe('A000360');
    expect(zBillId.parse('119-HR-8800')).toBe('119-hr-8800');
    expect(zCommitteeSystemCode.parse('HSAG00')).toBe('hsag00');
  });

  it('rejects names and fabricated shapes at the schema gate', () => {
    expect(zBioguideId.safeParse('Nancy Pelosi').success).toBe(false);
    expect(zBillId.safeParse('119-xx-8800').success).toBe(false);
    expect(zCommitteeSystemCode.safeParse('House Agriculture').success).toBe(false);
  });
});
