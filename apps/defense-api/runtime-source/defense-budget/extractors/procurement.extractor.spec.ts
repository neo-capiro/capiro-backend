import { extractProcurementOrOm, type ProcurementExtractInput, type ParsedPage } from './procurement.extractor.js';

describe('extractProcurementOrOm — identity guardrails', () => {
  const p40Page = (): ParsedPage => ({
    pdfPage: 42,
    printedPage: 'P-1 Line 12',
    markdown: 'Exhibit P-40. This procurement supports PE 0604270A and PE 0603308A.',
    tables: [
      {
        label: 'Cost ($ in Thousands)',
        header: ['Line', 'Item', 'FY2026', 'FY2027', 'Qty FY2027'],
        rows: [
          ['12', 'Radio System (supports 0604270A)', '5,000', '6,000', '25'],
          ['12', 'Radio System Advance Procurement', '1,000', '1,200', '0'],
        ],
      },
    ],
  });

  const input = (): ProcurementExtractInput => ({
    exhibit: 'P-40',
    account: 'Other Procurement, Army',
    component: 'ARMY',
    pages: [p40Page()],
  });

  it('produces PROCUREMENT_BLIN lines, NEVER PE lines, even when PEs are referenced', () => {
    const res = extractProcurementOrOm(input());
    expect(res.lineAssertions.every((l) => l.lineKind === 'PROCUREMENT_BLIN')).toBe(true);
    // No line masquerades as a PE code.
    expect(res.lineAssertions.some((l) => /^[0-9]{7}[A-Z]/.test(l.code))).toBe(false);
  });

  it('records referenced PE codes as cross-refs on the BLIN, not as new PE lines', () => {
    const res = extractProcurementOrOm(input());
    const base = res.lineAssertions.find((l) => l.code === '12')!;
    expect(base.referencedPeCodes).toContain('0604270A');
  });

  it('keeps base and advance-procurement lines DISTINCT (no collapse)', () => {
    const res = extractProcurementOrOm(input());
    const codes = res.lineAssertions.map((l) => l.code);
    expect(codes).toContain('12'); // base
    expect(codes).toContain('12-AP'); // advance procurement
    expect(new Set(codes).size).toBe(2);
  });

  it('carries account + component context into every value assertion', () => {
    const res = extractProcurementOrOm(input());
    expect(res.yearValues.every((v) => v.account === 'Other Procurement, Army' && v.component === 'ARMY')).toBe(true);
  });

  it('emits quantities as integers and dollars as exact decimals with unit', () => {
    const res = extractProcurementOrOm(input());
    const qty = res.yearValues.find((v) => v.code === '12' && v.fieldName === 'quantity')!;
    expect(qty.quantity).toBe(25);
    const dollars = res.yearValues.find((v) => v.code === '12' && v.fy === 2026 && v.fieldName === 'request')!;
    expect(dollars.money).toEqual({ value: 5000, unit: 'thousands' });
  });

  it('classifies OP-5 rows as OM_SAG', () => {
    const res = extractProcurementOrOm({
      exhibit: 'OP-5',
      account: 'O&M, Army',
      component: 'ARMY',
      pages: [
        {
          pdfPage: 3,
          markdown: 'Exhibit OP-5',
          tables: [
            { label: 'Cost ($ in Thousands)', header: ['SAG', 'Title', 'FY2027'], rows: [['111', 'Maneuver Units', '9,000']] },
          ],
        },
      ],
    });
    expect(res.lineAssertions.length).toBeGreaterThan(0);
    expect(res.lineAssertions.every((l) => l.lineKind === 'OM_SAG')).toBe(true);
  });
});
