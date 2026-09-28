import { getDocumentProxy } from 'unpdf';
import { extractPdfText } from './meri-attachment-extract.js';
import { DOC_TEXT_MAX_CHARS, PDF_MAX_PAGES } from './meri-attachment.helpers.js';

jest.mock('unpdf', () => ({ getDocumentProxy: jest.fn() }));

describe('PDF indexing extraction coverage', () => {
  it('uses explicit research limits while retaining ordinary attachment truncation',async()=>{
    const body='A'.repeat(DOC_TEXT_MAX_CHARS+1000);
    document([body]);
    expect((await extractPdfText(Buffer.from('fixture'))).truncated).toBe(true);
    document([body]);
    expect(await extractPdfText(Buffer.from('fixture'),{limits:{pages:500,characters:2_000_000},preserveLineBreaks:true})).toMatchObject({truncated:false,pagesRead:1});
    await expect(extractPdfText(Buffer.from('fixture'),{limits:{pages:501,characters:2_000_000}})).rejects.toThrow('PDF_EXTRACTION_LIMITS_INVALID');
  });
  function document(pageTexts: string[], pageCount = pageTexts.length) {
    const destroy = jest.fn().mockResolvedValue(undefined);
    const getPage = jest.fn(async (page: number) => ({
      getTextContent: async () => ({ items: [{ str: pageTexts[page - 1] ?? '' }] }),
    }));
    (getDocumentProxy as jest.Mock).mockResolvedValue({ numPages: pageCount, getPage, loadingTask: { destroy } });
    return { destroy, getPage };
  }

  it('reports a scanned 22-page document as zero text instead of embedding whitespace as content', async () => {
    const f = document(Array.from({ length: 22 }, () => ''));
    const result = await extractPdfText(Buffer.from('fixture'));
    expect(result.text.trim()).toBe('');
    expect(result).toMatchObject({ pages: 22, pagesRead: 22, truncated: false });
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });

  it('reports character and page limits and releases the PDF worker', async () => {
    const f = document(['A'.repeat(DOC_TEXT_MAX_CHARS + 100)], 22);
    const result = await extractPdfText(Buffer.from('fixture'));
    expect(result.text.length).toBe(DOC_TEXT_MAX_CHARS);
    expect(result).toMatchObject({ pages: 22, pagesRead: 1, truncated: true });
    expect(f.getPage).toHaveBeenCalledTimes(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    const pages = document([], PDF_MAX_PAGES + 1);
    expect((await extractPdfText(Buffer.from('fixture'))).truncated).toBe(true);
    expect(pages.getPage).toHaveBeenCalledTimes(PDF_MAX_PAGES);
  });

  it('returns exact bounded single-page windows with native length and truthful truncation', async () => {
    const body = `${'A'.repeat(40_000)}TAIL_SENTINEL`;
    const firstPage = document([body, 'second page']);
    const first = await extractPdfText(Buffer.from('fixture'), {
      firstPage: 1,
      limits: { pages: 1, characters: 40_000 },
      pageWindow: { offset: 0 },
    });
    expect(first.text).toHaveLength(40_000);
    expect(first.selectedPage).toEqual({
      page: 1,
      characterStart: 0,
      characterEnd: 40_000,
      nativeCharacters: body.length,
      truncated: true,
    });
    expect(firstPage.getPage).toHaveBeenCalledTimes(1);

    document([body, 'second page']);
    const tail = await extractPdfText(Buffer.from('fixture'), {
      firstPage: 1,
      limits: { pages: 1, characters: 40_000 },
      pageWindow: { offset: 40_000 },
    });
    expect(tail.text).toBe('TAIL_SENTINEL');
    expect(tail.selectedPage).toMatchObject({
      characterStart: 40_000,
      characterEnd: body.length,
      nativeCharacters: body.length,
      truncated: true,
    });
  });

  it('releases the worker even when a page fails to parse', async () => {
    const f = document(['first']);
    f.getPage.mockRejectedValue(new Error('parse failure'));
    await expect(extractPdfText(Buffer.from('fixture'))).rejects.toThrow('parse failure');
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });
});
