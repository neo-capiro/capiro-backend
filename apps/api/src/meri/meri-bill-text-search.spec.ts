import { describe, expect, it } from '@jest/globals';
import {
  BILL_TEXT_PASSAGE_CHARS,
  MAX_BILL_TEXT_PASSAGES,
  groupBillTextSearchRows,
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
