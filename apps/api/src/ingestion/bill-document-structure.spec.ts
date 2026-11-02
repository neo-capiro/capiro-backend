import {
  structureMarkup,
  structureText,
  structurePdfPage,
  extractBillDocumentStructure,
} from './bill-document-structure';
import { passages } from './bill-text-passages';

// Small geometry fixture derived from the retained Florida House layout: the gutter
// ends at x=54 even when a label grows from one to four digits; body starts at x=72+.
function floridaPage(
  start: number,
  body: Array<string | Array<[string, number]>>,
  amendment = false,
) {
  const item = (str: string, x: number, y: number, width = str.length * 7.2) => ({
    str,
    transform: [12, 0, 0, 12, x, y],
    width,
    height: 12,
  });
  const frame = amendment
    ? [
        item('HOUSE AMENDMENT', 432, 720),
        item('Bill No. CS/CS/HB 405 (2026)', 331, 700),
        item('Amendment No.', 72, 685),
        item('643271', 56, 125),
        item('Approved For Filing: 2/6/2026 6:38:15 PM', 63, 105),
        item('Page 2 of 25', 263, 84),
      ]
    : [
        item('F L O R I D A H O U S E O F R E P R E S E N T A T I V E S', 36, 752),
        item('HB 1207', 72, 693, 35),
        item('2026', 520, 693, 20),
        item('Page 1 of 173', 275, 116),
        item('CODING: Words stricken are deletions; words underlined are additions.', 56, 84),
        item('hb1207-00', 513, 63),
      ];
  return [
    ...frame,
    ...body.flatMap((line, index) => {
      const label = String(start + index),
        y = 638 - index * 20.4;
      return [
        item(label, 54 - label.length * 7.2, y),
        ...(typeof line === 'string'
          ? line
            ? [item(line, index === 0 && start === 1 ? 230 : 108, y)]
            : []
          : line.map(([text, x]) => item(text, x, y))),
      ];
    }),
  ];
}

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
  it('requires the whole heading number and never backtracks a wrapped statutory reference at a decimal dot', () => {
    const references = [381.028, 390.025, 790.338, 743.067].map(
      (number) => `section ${number}, Florida Statutes, are amended to read:`,
    );
    const result = structureText(
      [
        'Section 3. Health care.',
        ...references,
        'SEC. 101. Other provisions.',
        '§ 101.2 Definitions.',
        'Section 12.',
      ].join('\n'),
    );
    expect(result.sections.map((s) => s.path)).toEqual([['3'], ['101'], ['101.2'], ['12']]);
    for (const reference of references) expect(result.sections[0]!.text).toContain(reference);
    expect(result.sections.at(-1)!.heading).toBeNull();
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
  it('qualifies Florida title and continuation pages independently of legal headings and label digit width', () => {
    const title = [
      'A bill to be entitled',
      'An act relating to health care;',
      '',
      'creating requirements;',
      'providing an effective date.',
    ];
    const first = structurePdfPage(floridaPage(1, title), '', 1);
    expect(first.completeness).toBe('complete');
    expect(first.text).toBe(title.join('\n'));
    expect(first.sections.flatMap((s) => s.tables)).toHaveLength(0);
    const prior = { number: '(a)', heading: null, path: ['3', '(a)'] };
    for (const start of [26, 98, 998, 4307]) {
      const body = [
        'Continued subsection text.',
        'A requirement for the facility.',
        '1. An actual numbered legal clause.',
        'The next continued line.',
        'The final continued line.',
      ];
      const result = structurePdfPage(floridaPage(start, body), '', 2, prior);
      expect(result.completeness).toBe('complete');
      expect(result.text).toBe(body.join('\n'));
      expect(
        result.sections.every((s) => s.path.join('/') === '3/(a)' && s.sourceLocator === 'page:2'),
      ).toBe(true);
      expect(result.sections.flatMap((s) => s.tables)).toHaveLength(0);
      for (const chunk of passages(result.sections))
        expect(result.text.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });
  it('qualifies the Florida amendment frame and preserves section labels and cross-page context', () => {
    const body = [
      'Continued requirement.',
      'Section 5. New program.',
      '(a) Eligible applicant.',
      '',
      'The applicant must comply.',
    ];
    const result = structurePdfPage(floridaPage(98, body, true), '', 5, {
      number: '4',
      heading: 'Prior',
      path: ['4'],
    });
    expect(result.completeness).toBe('complete');
    expect(result.text).toBe(body.join('\n'));
    expect(result.sections.map((s) => s.path)).toEqual([['4'], ['5'], ['5', '(a)']]);
    expect(result.text).not.toMatch(/HOUSE AMENDMENT|Approved For Filing|643271|Amendment No/);
    for (const section of result.sections)
      expect(result.text.slice(section.startOffset, section.endOffset)).toBe(section.text);
  });
  it('removes only the proven gutter while retaining real numeric table columns on the same page', () => {
    const body: Array<Array<[string, number]>> = [
      [
        ['Item', 108],
        ['Year', 300],
        ['Amount', 430],
      ],
      [
        ['1', 108],
        ['2026', 300],
        ['$1000', 430],
      ],
      [
        ['2', 108],
        ['2027', 300],
        ['$2000', 430],
      ],
      [
        ['3', 108],
        ['2028', 300],
        ['$3000', 430],
      ],
      [
        ['4', 108],
        ['2029', 300],
        ['$4000', 430],
      ],
    ];
    const result = structurePdfPage(floridaPage(998, body), '', 40);
    expect(result.completeness).toBe('complete');
    expect(result.sections.flatMap((s) => s.tables).map((t) => t.rows)).toEqual([
      body.map((line) => line.map(([text]) => text)),
    ]);
    expect(result.text).not.toMatch(/998|999/);
    expect(result.text).toContain('1\t2026\t$1000');
  });
  it('retains numeric data when a similar page lacks the proven frame or a consecutive aligned gutter', () => {
    const body = [
      'A description of item one.',
      'A description of item two.',
      'A description of item three.',
      'A description of item four.',
    ];
    const noFrame = floridaPage(998, body).filter((item) => !item.str.startsWith('CODING:'));
    const misaligned = floridaPage(998, body).map((item) =>
      item.str === '1000' ? { ...item, transform: [12, 0, 0, 12, 40, item.transform[5]!] } : item,
    );
    const skipped = floridaPage(998, body).map((item) =>
      item.str === '1000' ? { ...item, str: '1005' } : item,
    );
    const bodyFooter = floridaPage(998, body).map((item) =>
      item.str.startsWith('CODING:') ? { ...item, transform: [12, 0, 0, 12, 56, 700] } : item,
    );
    for (const geometry of [noFrame, misaligned, skipped, bodyFooter]) {
      const result = structurePdfPage(geometry, '', 40);
      expect(result.text).toContain('998');
      expect(result.text).toContain('999');
      expect(result.text).toContain('1001');
      expect(result.text).toContain('A description of item one.');
    }
  });
});
