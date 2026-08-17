import { adaptLlamaParseJson, parseMarkdownTables } from './llamaparse-adapter.js';

describe('parseMarkdownTables', () => {
  it('parses a GitHub pipe table with a separator row', () => {
    const md = [
      '| Line Item | Title | FY2027 |',
      '| --- | --- | --- |',
      '| 0602308A | Advanced Tech | 13,500 |',
    ].join('\n');
    const tables = parseMarkdownTables(md);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.header).toEqual(['Line Item', 'Title', 'FY2027']);
    expect(tables[0]!.rows).toEqual([['0602308A', 'Advanced Tech', '13,500']]);
  });
});

describe('adaptLlamaParseJson', () => {
  it('normalizes structured table items into ParsedPage tables', () => {
    const json = {
      pages: [
        {
          page: 17,
          md: 'Exhibit R-2',
          items: [
            {
              type: 'table',
              rows: [
                ['Line', 'Title', 'FY2027'],
                ['0602308A', 'Advanced Tech', '13,500'],
              ],
            },
          ],
        },
      ],
    };
    const pages = adaptLlamaParseJson(json);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.pdfPage).toBe(17);
    expect(pages[0]!.tables[0]!.header).toEqual(['Line', 'Title', 'FY2027']);
    expect(pages[0]!.tables[0]!.rows[0]).toEqual(['0602308A', 'Advanced Tech', '13,500']);
  });

  it('falls back to markdown pipe tables when no structured table items exist', () => {
    const json = {
      pages: [{ page: 1, md: '| A | B |\n| --- | --- |\n| 1 | 2 |' }],
    };
    const pages = adaptLlamaParseJson(json);
    expect(pages[0]!.tables[0]!.rows).toEqual([['1', '2']]);
  });

  it('uses whole-document markdown fallback when pages are empty', () => {
    const pages = adaptLlamaParseJson({}, { markdownFallback: '| X | Y |\n| --- | --- |\n| 9 | 8 |' });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.tables[0]!.rows).toEqual([['9', '8']]);
  });
});
