import { extractRdte, type RdteExtractInput, type ParsedPage } from './rdte.extractor.js';
import { isValidPeCode, parseMoneyToken, classifyLineKind } from './types.js';

describe('identity primitives', () => {
  it('validates PE codes strictly (7 digits + component letter)', () => {
    expect(isValidPeCode('0602308A')).toBe(true);
    expect(isValidPeCode('0603790F')).toBe(true);
    expect(isValidPeCode('123')).toBe(false);
    expect(isValidPeCode('AAA')).toBe(false);
  });

  it('parses printed money exactly, including parenthesised negatives', () => {
    expect(parseMoneyToken('1,234')).toBe(1234);
    expect(parseMoneyToken('$5,678.9')).toBe(5678.9);
    expect(parseMoneyToken('(1,000)')).toBe(-1000);
    expect(parseMoneyToken('-')).toBeNull();
    expect(parseMoneyToken('')).toBeNull();
  });

  it('classifies line kind by exhibit, never by code pattern', () => {
    expect(classifyLineKind('R-2')).toBe('RDTE_PE');
    expect(classifyLineKind('P-40')).toBe('PROCUREMENT_BLIN');
    expect(classifyLineKind('OP-5')).toBe('OM_SAG');
  });
});

describe('extractRdte', () => {
  const page = (): ParsedPage => ({
    pdfPage: 17,
    printedPage: 'Volume 1 - 17',
    markdown: 'Exhibit R-2\n0602308A Advanced Technology mission narrative text here.',
    tables: [
      {
        label: 'Cost ($ in Thousands)',
        header: ['Line Item', 'Title', 'FY2026', 'FY2027', 'FY2028'],
        rows: [
          ['0602308A', 'Advanced Technology', '12,345', '13,500', '14,000'],
          ['0602890A', 'Future Combat', '(500)', '2,000', '2,100'],
          ['0602308', 'Missing component letter', '1', '2', '3'],
        ],
      },
    ],
  });

  const input = (): RdteExtractInput => ({
    exhibit: 'R-2',
    component: 'ARMY',
    pages: [page()],
    fyColumns: [2026, 2027, 2028],
  });

  it('produces RDTE_PE line + independent per-FY request assertions with full provenance', () => {
    const res = extractRdte(input());
    // Two valid PE lines (third is quarantined).
    const lines = res.lineAssertions.filter((l) => l.code === '0602308A');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.lineKind).toBe('RDTE_PE');
    expect(lines[0]!.title).toBe('Advanced Technology');
    expect(lines[0]!.component).toBe('ARMY');

    const vals = res.yearValues.filter((v) => v.code === '0602308A');
    expect(vals).toHaveLength(3);
    const fy27 = vals.find((v) => v.fy === 2027)!;
    expect(fy27.fieldName).toBe('request');
    expect(fy27.money).toEqual({ value: 13500, unit: 'thousands' });
    // Provenance is page + exhibit + table + row/col level.
    expect(fy27.provenance.pdfPage).toBe(17);
    expect(fy27.provenance.printedPage).toBe('Volume 1 - 17');
    expect(fy27.provenance.exhibit).toBe('R-2');
    expect(fy27.provenance.tableLabel).toBe('Cost ($ in Thousands)');
    expect(fy27.provenance.extractionMethod).toBe('llamaparse');
  });

  it('keeps parenthesised negatives exact', () => {
    const res = extractRdte(input());
    const neg = res.yearValues.find((v) => v.code === '0602890A' && v.fy === 2026)!;
    expect(neg.money!.value).toBe(-500);
  });

  it('quarantines invalid PE codes into warnings, never coerces them', () => {
    const res = extractRdte(input());
    expect(res.warnings.some((w) => w.includes('0602308') && w.includes('quarantined'))).toBe(true);
    // The malformed code must not appear as a line or value assertion.
    expect(res.lineAssertions.some((l) => l.title === 'Missing component letter')).toBe(false);
  });

  it('does not collapse independent PE assertions (both PEs retained)', () => {
    const res = extractRdte(input());
    const codes = new Set(res.lineAssertions.map((l) => l.code));
    expect(codes.has('0602308A')).toBe(true);
    expect(codes.has('0602890A')).toBe(true);
  });
});

describe('extractRdte — real R-2 cost table (structure B: PE code in heading, not the row)', () => {
  // Mirrors the FY2027 Army RDT&E Vol 1 structure: the PE code sits in a preceding heading,
  // the cost row is "Total Program Element", and FY columns include Base/OOC/Total splits.
  const page = (): ParsedPage => ({
    pdfPage: 118,
    printedPage: 'Volume 1a - 118',
    markdown:
      'UNCLASSIFIED Exhibit R-2, RDT&E Budget Item Justification: PB 2027 Army\n' +
      'PE 0601601A / Artificial Intelligence and Machine Learning Basic Research',
    tables: [
      {
        label: 'COST ($ in Millions)',
        header: [
          'COST ($ in Millions)', 'Prior Years', 'FY 2025', 'FY 2026', 'FY 2027 Base',
          'FY 2027 OOC', 'FY 2027 Total', 'FY 2028', 'Cost To Complete', 'Total Cost',
        ],
        rows: [
          ['Total Program Element', '-', '9.933', '17.012', '12.500', '2.160', '14.660', '-', '0.000', '26.945'],
        ],
      },
    ],
  });

  it('attributes the cost row to the PE-context code and picks the FY Total column', () => {
    const res = extractRdte({ exhibit: 'R-2', component: 'ARMY', pages: [page()], fyColumns: [2025, 2026, 2027] });
    // The PE line is emitted from context.
    expect(res.lineAssertions.some((l) => l.code === '0601601A')).toBe(true);

    const vals = res.yearValues.filter((v) => v.code === '0601601A');
    const fy27 = vals.find((v) => v.fy === 2027)!;
    // FY2027 must be the *Total* (14.660), NOT Base (12.5) or OOC (2.16) — no collision.
    expect(fy27.money).toEqual({ value: 14.66, unit: 'millions' });
    expect(vals.filter((v) => v.fy === 2027)).toHaveLength(1);

    const fy25 = vals.find((v) => v.fy === 2025)!;
    expect(fy25.money).toEqual({ value: 9.933, unit: 'millions' });
    // Provenance points at the real page.
    expect(fy27.provenance.pdfPage).toBe(118);
    expect(fy27.provenance.printedPage).toBe('Volume 1a - 118');
  });
});
