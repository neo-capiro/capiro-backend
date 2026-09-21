import { parseHousePdfRows, parseHouseXlsxRows, parseSenatePdfRows, parseUsd } from './community-funding.parser.js';

describe('community funding pure parsers', () => {
  it('parses a normal House row and preserves wrapped titles', () => {
    const result = parseHousePdfRows([{ page: 3, row: 4, columns: ['DOC', 'NIST—STRS', 'University', 'A wrapped multi-line title', 'Austin, TX', '$1,031,000', 'Smith'] }], 2026, 'CJS');
    expect(result.candidates[0]).toMatchObject({ chamber: 'house', requestedAmountUsd: '1031000.00', state: 'TX', finalAmountUsd: null, sourcePage: 3 });
  });
  it('parses Senate recommendation without mislabeling it as a request', () => {
    const result = parseSenatePdfRows([{ page: 1, row: 1, columns: ['Research', 'AK', 'Project', 'Recipient', '750,000', 'Murkowski'] }], 2026, 'Agriculture');
    expect(result.candidates[0]).toMatchObject({ amountStageRaw: 'senate_recommendation', requesterState: 'AK', requestedAmountUsd: '750000.00' });
  });
  it.each(['bad', '-1,000', '($1,000)', '(1,000)'])('rejects malformed or negative amount %s', value => expect(parseUsd(value)).toBeNull());
  it('rejects shifted columns and invalid states', () => {
    expect(parseHousePdfRows([{ page: 1, row: 1, columns: ['too', 'few'] }], 2026).rejected[0]!.reason).toContain('expected 7');
    expect(parseSenatePdfRows([{ page: 1, row: 1, columns: ['a', 'ZZ', 'p', 'r', '2', 's'] }], 2026).rejected[0]!.reason).toContain('invalid state');
  });
  it('warns and suppresses exact duplicate rows', () => {
    const row = { page: 1, row: 1, columns: ['A','B','R','P','Reno, NV','100','X'] };
    const result = parseHousePdfRows([row, row], 2026); expect(result.candidates).toHaveLength(1); expect(result.warnings).toHaveLength(1);
  });
  it('handles blank optional XLSX fields and row provenance', () => {
    const result = parseHouseXlsxRows([{ 'Member First Name':'A','Member Last Name':'B',Recipient:'R','Project Description':'P','Amount Requested':'$2,000' }], 2026);
    expect(result.candidates[0]).toMatchObject({ sourceRow: 2, recipientAddress: null, requestedAmountUsd: '2000.00' });
  });
  it('derives requester state from strict STDD while preserving the source district', () => {
    const result = parseHouseXlsxRows([{ 'Member First Name':'A','Member Last Name':'B',District:'FL08',Recipient:'R','Project Description':'P','Amount Requested':'$2,000' }], 2026);
    expect(result.candidates[0]).toMatchObject({ requesterState: 'FL', requesterDistrict: 'FL08' });
  });
  it('keeps invalid source districts unresolved rather than inventing geography', () => {
    const result = parseHouseXlsxRows([{ 'Member First Name':'A','Member Last Name':'B',District:'AQ00',Recipient:'R','Project Description':'P','Amount Requested':'$2,000' }], 2026);
    expect(result.candidates[0]).toMatchObject({ requesterState: null, requesterDistrict: 'AQ00' });
  });
  it('preserves page breaks and multiple tables per page as independent provenance', () => {
    const rows = [
      { page: 8, row: 9, columns: ['A','B','R1','Wrapped title ending on this row','Austin, TX','100','One'] },
      { page: 9, row: 1, columns: ['A','B','R2','Continuation-page table row','Dallas, TX','200','Two'] },
      { page: 9, row: 12, columns: ['C','D','R3','Second table same page','Houston, TX','300','Three'] },
    ];
    expect(parseHousePdfRows(rows, 2026).candidates.map(row => [row.sourcePage, row.sourceRow])).toEqual([[8,9],[9,1],[9,12]]);
  });
});
