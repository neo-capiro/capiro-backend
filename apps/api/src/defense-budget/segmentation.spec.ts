import {
  selectParseMode,
  segmentExhibits,
  countExhibitHeaders,
  type PageTextStat,
} from './segmentation.js';

function page(page: number, text: string, textChars?: number): PageTextStat {
  return { page, text, textChars: textChars ?? text.length };
}

describe('selectParseMode', () => {
  it('chooses pdf_ocr when embedded-text coverage is low (scanned pages)', () => {
    const pages = [page(1, '', 0), page(2, '', 5), page(3, 'a bit of text here that is long enough to count as real', 200)];
    const d = selectParseMode(pages);
    expect(d.mode).toBe('pdf_ocr');
    expect(d.scannedPages).toEqual([1, 2]);
    expect(d.textCoverage).toBeCloseTo(1 / 3, 5);
  });

  it('chooses pdf_premium for dense exhibit books with a clean text layer', () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      page(i + 1, `Exhibit R-2A RDT&E Project Justification line ${i} `.repeat(4), 300),
    );
    const d = selectParseMode(pages);
    expect(d.mode).toBe('pdf_premium');
    expect(d.textCoverage).toBe(1);
  });

  it('chooses pdf_fast for a clean text layer with few exhibits', () => {
    const pages = [
      page(1, 'Exhibit R-2 narrative '.repeat(20), 400),
      page(2, 'plain text page '.repeat(20), 300),
      page(3, 'more plain text '.repeat(20), 300),
    ];
    const d = selectParseMode(pages);
    expect(d.mode).toBe('pdf_fast');
  });

  it('never returns a non-PDF mode', () => {
    const pages = [page(1, 'x'.repeat(200), 200)];
    expect(['pdf_fast', 'pdf_premium', 'pdf_ocr']).toContain(selectParseMode(pages).mode);
  });
});

describe('exhibit segmentation', () => {
  it('counts only line-anchored exhibit headers, not narrative mentions', () => {
    const pages = [
      page(1, 'This program references the R-2 exhibit in prose only.'),
      page(2, 'Exhibit R-2A\nProject AA1 details'),
      page(3, 'Exhibit P-40\nProcurement line'),
    ];
    expect(countExhibitHeaders(pages)).toBe(2);
  });

  it('splits on exhibit boundaries and rolls leading pages into the first segment', () => {
    const pages = [
      page(1, 'cover page'),
      page(2, 'Exhibit R-2\nPE 0602308A'),
      page(3, 'continuation of R-2'),
      page(4, 'Exhibit R-2A\nProject BX9'),
      page(5, 'continuation of R-2A'),
    ];
    const segs = segmentExhibits(pages);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ exhibitType: 'R-2', pageStart: 1, pageEnd: 3 });
    expect(segs[1]).toMatchObject({ exhibitType: 'R-2A', pageStart: 4, pageEnd: 5 });
    // target_pages are 0-based.
    expect(segs[0]!.targetPages).toEqual([0, 1, 2]);
    expect(segs[1]!.targetPages).toEqual([3, 4]);
  });

  it('treats a header-less document as a single segment (nothing dropped)', () => {
    const pages = [page(1, 'plain'), page(2, 'plain'), page(3, 'plain')];
    const segs = segmentExhibits(pages);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ exhibitType: 'document', pageStart: 1, pageEnd: 3 });
  });

  it('prefers R-2A over R-2 when both could match', () => {
    const pages = [page(1, 'Exhibit R-2A Project Justification')];
    const segs = segmentExhibits(pages);
    expect(segs[0]!.exhibitType).toBe('R-2A');
  });
});
