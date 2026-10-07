import { describe, expect, it } from '@jest/globals';
import {
  BILL_TEXT_PASSAGE_CHARS,
  BILL_TEXT_RESPONSE_BUDGET,
  MAX_BILL_TEXT_PASSAGES,
  billTextSearchResponse,
  groupBillTextSearchRows,
  type BillTextSearchRow,
  locateBillTextPassages,
  parseBillTextQuery,
} from './meri-bill-text-search.js';

function bill(): string {
  const filler = (n: number) => 'General provisions apply. '.repeat(n);
  return [
    'SECTION 1. SHORT TITLE.\n',
    filler(200),
    '\nSEC. 101. CRITICAL MINERAL STOCKPILE.\n',
    'The Secretary shall maintain a national defense stockpile of critical minerals, ',
    'including gallium and germanium, for hypersonic weapons programs. ',
    filler(300),
    '\nSEC. 202. REPORTING.\n',
    'Not later than 180 days after enactment, the Secretary shall report on the stockpile. ',
    filler(100),
  ].join('');
}

describe('bill text query parsing', () => {
  it('keeps quoted phrases whole and drops stop words and short words', () => {
    expect(parseBillTextQuery('"national defense stockpile" of the gallium GE')).toEqual({
      phrases: ['national defense stockpile'],
      terms: ['gallium'],
    });
  });
});

describe('locating passages in one bill version', () => {
  it('returns the best non-overlapping passages with the section heading above each', () => {
    const text = bill();
    const located = locateBillTextPassages(text, '"defense stockpile" gallium germanium');
    expect(located.passages.length).toBeGreaterThan(0);
    const best = located.passages.find((passage) =>
      passage.matchedTerms.includes('defense stockpile'),
    );
    expect(best?.heading).toBe('SEC. 101. CRITICAL MINERAL STOCKPILE.');
    expect(text.slice(best!.startOffset, best!.endOffset)).toContain('gallium and germanium');
    for (const passage of located.passages) {
      expect(passage.endOffset - passage.startOffset).toBeLessThanOrEqual(BILL_TEXT_PASSAGE_CHARS);
    }
    const sorted = [...located.passages].sort((a, b) => a.startOffset - b.startOffset);
    for (let index = 1; index < sorted.length; index += 1)
      expect(sorted[index]!.startOffset).toBeGreaterThanOrEqual(sorted[index - 1]!.endOffset);
  });

  it('is deterministic, so a re-checked read reproduces it exactly', () => {
    const text = bill();
    expect(locateBillTextPassages(text, 'stockpile report')).toEqual(
      locateBillTextPassages(text, 'stockpile report'),
    );
  });

  it('finds the later section for its own words', () => {
    const located = locateBillTextPassages(bill(), '"180 days"');
    expect(located.passages).toHaveLength(1);
    expect(located.passages[0]?.heading).toBe('SEC. 202. REPORTING.');
  });

  it('caps the passages and reports no match honestly', () => {
    const many = locateBillTextPassages(bill(), 'general provisions');
    expect(many.passages.length).toBeLessThanOrEqual(MAX_BILL_TEXT_PASSAGES);
    expect(many.totalHits).toBeGreaterThan(MAX_BILL_TEXT_PASSAGES);
    expect(locateBillTextPassages(bill(), 'quantum')).toEqual({
      passages: [],
      totalHits: 0,
      parts: ['quantum'],
    });
  });
});

describe('grouping text search rows by bill', () => {
  it('keeps rank order, groups passages, and gives a read cursor past the start', () => {
    const rows = [
      {
        billId: '119-hr-1',
        versionCode: 'ih',
        revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        extractionHash: 'a'.repeat(64),
        startOffset: 7200,
        endOffset: 11200,
        rank: 0.9,
        snippet: 'the «stockpile»   of minerals',
        title: 'Minerals Act',
      },
      {
        billId: '119-s-2',
        versionCode: 'is',
        revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        extractionHash: 'b'.repeat(64),
        startOffset: 0,
        endOffset: 4000,
        rank: 0.5,
        snippet: '«stockpile» report',
        title: null,
      },
      {
        billId: '119-hr-1',
        versionCode: 'ih',
        revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        extractionHash: 'a'.repeat(64),
        startOffset: 0,
        endOffset: 4000,
        rank: 0.4,
        snippet: 'short title',
        title: 'Minerals Act',
      },
    ];
    const grouped = groupBillTextSearchRows(rows);
    expect(grouped.map((bill) => bill.billId)).toEqual(['119-hr-1', '119-s-2']);
    expect(grouped[0]?.passages).toHaveLength(2);
    expect(grouped[0]?.passages[0]?.snippet).toBe('the «stockpile» of minerals');
    const cursor = grouped[0]?.passages[0]?.readCursor;
    expect(JSON.parse(Buffer.from(cursor!, 'base64url').toString('utf8'))).toEqual([
      '119-hr-1',
      'ih',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'a'.repeat(64),
      7200,
    ]);
    expect(grouped[1]?.passages[0]?.readCursor).toBeNull();
  });
});

describe('a bill text search page', () => {
  const words = (n: number, seed: string) =>
    Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
  function rows(bills: number, perBill: number, snippetWords: number, totalBills = bills) {
    const out: BillTextSearchRow[] = [];
    for (let b = 0; b < bills; b += 1)
      for (let p = 0; p < perBill; p += 1)
        out.push({
          billId: `119-hr-${100 + b}`,
          versionCode: 'ih',
          revisionId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(b).padStart(12, '0')}`,
          extractionHash: 'a'.repeat(64),
          startOffset: 3600 * (p + 1),
          endOffset: 3600 * (p + 1) + 4000,
          rank: 1 - b / 100 - p / 1000,
          totalBills,
          snippet: `the «critical minerals» ${words(snippetWords, `b${b}p${p}w`)}`,
          title: `Critical Minerals Act number ${b} of the One Hundred Nineteenth Congress`,
        });
    return out;
  }
  const request = {
    textQuery: 'critical minerals',
    page: 1,
    perPage: 8,
    generatedAt: '2026-10-07T00:00:00.000Z',
  };

  it('fits a full page of eight bills under the budget and says how many match', () => {
    const page = billTextSearchResponse(rows(8, 2, 35, 54), request);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(BILL_TEXT_RESPONSE_BUDGET);
    expect(page.results).toHaveLength(8);
    expect(page).toMatchObject({ totalBills: 54, hasMore: true, nextPage: 2, page: 1, perPage: 8 });
    expect(page.note).toContain('54 bills match in all. Ask for page 2 for more.');
    expect(page).not.toHaveProperty('omittedBills');
  });

  it('stays under the 12,000-character projection limit even with long snippets', () => {
    const page = billTextSearchResponse(rows(10, 2, 120, 10), { ...request, perPage: 10 });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(BILL_TEXT_RESPONSE_BUDGET);
    expect(BILL_TEXT_RESPONSE_BUDGET).toBeLessThan(12_000);
    // Second passages go before any bill does.
    expect(page.results.every((bill) => bill.passages.length === 1)).toBe(true);
    expect(page.note).toContain('Only the best passage is shown');
    expect(page.hasMore).toBe(false);
  });

  it('drops the lowest-ranked bills last and names how many were left out', () => {
    const page = billTextSearchResponse(rows(10, 1, 400, 30), { ...request, perPage: 10 });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(BILL_TEXT_RESPONSE_BUDGET);
    expect(page.omittedBills).toBeGreaterThan(0);
    expect(page.results.length + page.omittedBills!).toBe(10);
    expect(page.results[0]!.billId).toBe('119-hr-100');
    // The next page still starts after this whole page.
    expect(page).toMatchObject({ nextPage: 2, totalBills: 30 });
  });

  it('reports an exhausted later page and an empty first page honestly', () => {
    expect(billTextSearchResponse([], { ...request, page: 3 })).toMatchObject({
      results: [],
      totalBills: null,
      hasMore: false,
      note: 'No more matching bills on this page.',
    });
    const none = billTextSearchResponse([], request);
    expect(none).toMatchObject({ totalBills: 0, hasMore: false });
    expect(none.note).toContain('No stored bill text matches.');
  });

  it('ends paging on the last page', () => {
    const last = billTextSearchResponse(rows(3, 1, 20, 19), { ...request, page: 3 });
    expect(last).toMatchObject({ totalBills: 19, hasMore: false });
    expect(last).not.toHaveProperty('nextPage');
  });
});
