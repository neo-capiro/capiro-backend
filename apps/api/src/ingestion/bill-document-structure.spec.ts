import {
  structureMarkup,
  structureText,
  structurePdfPage,
  extractBillDocumentStructure,
} from './bill-document-structure';
import { passages } from './bill-text-passages';

describe('ordered statutory structure', () => {
  it('preserves mixed inline order, hierarchy, tables, definitions and references', () => {
    const result = structureMarkup(
      `<bill><section id="s2"><num>2</num><heading>Definitions</heading><text>The <b>covered</b> entity.</text><subsection id="s2a"><num>(a)</num><text>“Agency” means the office under section 101.2.</text><table><tr><th>Year</th><th>Amount</th></tr><tr><td>2026</td><td>$5</td></tr></table></subsection><text>Final parent text.</text></section></bill>`,
      'xml',
    );
    expect(result.completeness).toBe('complete');
    expect(result.sections.map((s) => s.path)).toEqual([['2'], ['2', '(a)'], ['2']]);
    expect(result.text).toContain('The covered entity.');
    expect(result.text.indexOf('Agency')).toBeLessThan(result.text.indexOf('Final parent'));
    const child = result.sections[1]!;
    expect(child.definitionTerms).toEqual(['Agency']);
    expect(child.references).toEqual(['101.2']);
    expect(child.tables[0]!.rows).toEqual([
      ['Year', 'Amount'],
      ['2026', '$5'],
    ]);
    expect(child.text.slice(child.tables[0]!.startOffset, child.tables[0]!.endOffset)).toBe(
      'Year\tAmount\n2026\t$5',
    );
    for (const section of result.sections)
      expect(result.text.slice(section.startOffset, section.endOffset)).toBe(section.text);
    expect(
      structureMarkup(
        `<bill><section id="s2"><num>2</num><heading>Definitions</heading><text>The <b>covered</b> entity.</text><subsection id="s2a"><num>(a)</num><text>“Agency” means the office under section 101.2.</text><table><tr><th>Year</th><th>Amount</th></tr><tr><td>2026</td><td>$5</td></tr></table></subsection><text>Final parent text.</text></section></bill>`,
        'xml',
      ).structureHash,
    ).toBe(result.structureHash);
  });
  it('retains HTML headings, cells, and explicit incomplete table status', () => {
    const html = structureMarkup(
      '<html><head><title>Ignore</title></head><body><h2>SECTION 3. Grants</h2><p>First <em>second</em> third.</p><table><tr><td>A</td><td>B</td></tr></table></body></html>',
      'html',
    );
    expect(html.text).not.toContain('Ignore');
    expect(html.sections[0]!.heading).toBe('SECTION 3. Grants');
    expect(html.sections[0]!.tables[0]!.rows).toEqual([['A', 'B']]);
    expect(
      structureMarkup('<bill><table><unknown>Unstructured</unknown></table></bill>', 'xml')
        .completeness,
    ).toBe('partial');
    expect(structureMarkup('<broken>', 'xml').completeness).toBe('unreadable');
  });
  it('keeps every short heading and overlapping long subsection with exact Unicode offsets', () => {
    const result = structureText(
      'SECTION 2. A\n(a) ' + 'A sentence with emoji 😀. '.repeat(500) + '\nSECTION 3. B',
    );
    const rows = passages(result.sections);
    expect(rows.at(-1)!.text).toBe('SECTION 3. B');
    for (const row of rows) {
      expect(result.text.slice(row.start, row.end)).toBe(row.text);
      expect(row.text.length).toBeLessThanOrEqual(4000);
      expect(row.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    const same = rows.filter((r) => r.section === 1);
    expect(same.length).toBeGreaterThan(2);
    expect(same[1]!.start).toBeLessThan(same[0]!.end);
    expect(result.sections[1]!.path).toEqual(['2', '(a)']);
  });
  it('recognizes aligned native PDF cells without fabricating scanned text', async () => {
    const item = (str: string, x: number, y: number) => ({
      str,
      transform: [1, 0, 0, 1, x, y],
      width: 20,
      height: 10,
    });
    const page = structurePdfPage(
      [item('Year', 10, 100), item('Amount', 100, 100), item('2026', 10, 80), item('$5', 100, 80)],
      '',
      1,
    );
    expect(page.sections[0]!.tables[0]!.rows).toEqual([
      ['Year', 'Amount'],
      ['2026', '$5'],
    ]);
    expect(structurePdfPage([{ str: 'Native' }], 'Native', 1).completeness).toBe('partial');
    expect(
      (await extractBillDocumentStructure(Buffer.from('not a pdf'), 'application/pdf'))
        .completeness,
    ).toBe('unreadable');
    expect(
      (await extractBillDocumentStructure(Buffer.from([255]), 'text/plain')).warnings,
    ).toContain('DOCUMENT_TEXT_ENCODING_UNQUALIFIED');
  });
  it('carries PDF section context across page boundaries and tables, and ignores numbered margins', () => {
    const item = (str: string, x: number, y: number) => ({
      str,
      transform: [1, 0, 0, 1, x, y],
      width: 20,
      height: 10,
    });
    const first = structurePdfPage(
      [item('SECTION 1. Grants', 100, 100), item('(a) Eligible agency text.', 100, 80)],
      '',
      1,
    );
    const prior = first.sections.at(-1)!;
    const second = structurePdfPage(
      [
        item('Continued subsection text.', 100, 200),
        item('Year', 100, 180),
        item('Amount', 250, 180),
        item('2026', 100, 160),
        item('$5', 250, 160),
        item('Further continuation.', 100, 140),
        item('SECTION 2. Other', 100, 120),
      ],
      '',
      2,
      prior,
    );
    expect(second.sections.slice(0, -1).every((s) => s.path.join('/') === '1/(a)')).toBe(true);
    expect(second.sections.some((s) => s.tables.length && s.path.join('/') === '1/(a)')).toBe(true);
    expect(second.sections.at(-1)!.path).toEqual(['2']);
    expect(second.sections.every((s) => s.sourceLocator === 'page:2')).toBe(true);
    const numbered = structurePdfPage(
      [
        'SECTION 3. Authorization',
        '(a) The Secretary may act.',
        'The first continued line.',
        'The second continued line.',
        'The final continued line.',
      ].flatMap((text, index) => [
        item(String(index + 1), 30, 200 - index * 20),
        item(text, 100, 200 - index * 20),
      ]),
      '',
      3,
    );
    expect(numbered.sections.every((s) => s.tables.length === 0)).toBe(true);
    expect(numbered.sections.at(-1)!.path).toEqual(['3', '(a)']);
    expect(numbered.text).toContain('SECTION 3. Authorization');
    expect(numbered.text).not.toContain('1\tSECTION');
  });
  it('never discards genuine sequential numeric table keys', () => {
    const item = (str: string, x: number, y: number) => ({
      str,
      transform: [1, 0, 0, 1, x, y],
      width: 20,
      height: 10,
    });
    const table = structurePdfPage(
      [1, 2, 3, 4].flatMap((n) => [
        item(String(n), 30, 200 - n * 20),
        item('A description of item ' + n, 100, 200 - n * 20),
      ]),
      '',
      1,
    );
    expect(table.sections[0]!.tables[0]!.rows.map((row) => row[0])).toEqual(['1', '2', '3', '4']);
    expect(table.warnings).toContain('PDF_AMBIGUOUS_NUMBERED_COLUMNS');
    expect(table.completeness).toBe('partial');
  });
});
