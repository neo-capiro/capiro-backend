/**
 * PDF text extraction I/O for Meri attachments (assistant-parity F1).
 *
 * Separated from the service so the manual attachment eval
 * (scripts/eval-clio-attachments.ts) exercises the exact same extraction the
 * upload endpoint uses. unpdf (pdf.js under the hood, no native binaries);
 * page and character caps bound parser CPU, and every page boundary is an
 * await so a large document never monopolizes the event loop.
 */

import { getDocumentProxy } from 'unpdf';
import { DOC_TEXT_MAX_CHARS, PDF_MAX_PAGES } from './meri-attachment.helpers.js';

export interface PdfExtraction {
  text: string;
  pages: number;
  pagesRead: number;
  truncated: boolean;
  /** Exact native-text coverage for a requested single-page window. */
  selectedPage?: {
    page: number;
    characterStart: number;
    characterEnd: number;
    nativeCharacters: number;
    truncated: boolean;
  };
  /** Pages with no native text that could not be read completely. */
  unreadablePages: number[];
  visuallyReadPages: number[];
}

export async function extractPdfText(
  buffer: Buffer | Uint8Array,
  options: {
    readScannedPage?: (
      page: number,
      pageCount: number,
    ) => Promise<{ text: string; partial: boolean }>;
    signal?: AbortSignal;
    onPage?: (page: number, text: string) => void;
    /** Explicit bounded source-ingestion limits; ordinary uploads retain defaults. */
    limits?: { pages: number; characters: number };
    /** First 1-based page to decode. Typed section readers use this to avoid
     * walking every preceding page of a large document. */
    firstPage?: number;
    /** Bounded native-text window within firstPage. This intentionally applies
     * only to a one-page extraction; pdf.js still materializes that page's
     * native text, while returned text remains bounded by limits.characters. */
    pageWindow?: { offset: number };
    preserveLineBreaks?: boolean;
  } = {},
): Promise<PdfExtraction> {
  const maxPages=options.limits?.pages??PDF_MAX_PAGES,maxChars=options.limits?.characters??DOC_TEXT_MAX_CHARS;
  if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>500||!Number.isSafeInteger(maxChars)||maxChars<(options.pageWindow?0:1)||maxChars>2_000_000)throw Error('PDF_EXTRACTION_LIMITS_INVALID');
  const firstPage=options.firstPage??1;
  if(!Number.isSafeInteger(firstPage)||firstPage<1)throw Error('PDF_EXTRACTION_FIRST_PAGE_INVALID');
  const pageWindowOffset=options.pageWindow?.offset;
  if(pageWindowOffset!==undefined&&(!Number.isSafeInteger(pageWindowOffset)||pageWindowOffset<0||maxPages!==1))throw Error('PDF_EXTRACTION_PAGE_WINDOW_INVALID');
  const bytes =
    buffer instanceof Uint8Array && !(buffer instanceof Buffer) ? buffer : new Uint8Array(buffer);
  const pdf = await getDocumentProxy(bytes);
  const lastPage = Math.min(pdf.numPages, firstPage + maxPages - 1);
  const parts: string[] = [];
  let chars = 0;
  let pagesRead = 0;
  let truncated = false;
  const unreadablePages: number[] = [];
  const visuallyReadPages: number[] = [];
  let selectedPage: PdfExtraction['selectedPage'];
  try {
    for (let i = firstPage; i <= lastPage && (pageWindowOffset !== undefined || chars < maxChars); i += 1) {
      if (options.signal?.aborted) {
        truncated = true;
        break;
      }
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let pageText = (content.items as Array<{ str?: string;hasEOL?:boolean }>)
        .map((item) => (item.str ?? '')+(options.preserveLineBreaks&&item.hasEOL?'\n':' '))
        .join('');
      if(!options.preserveLineBreaks) pageText=pageText.slice(0,-1);
      if (!pageText.trim()) {
        if (options.readScannedPage) {
          const visual = await options.readScannedPage(i, pdf.numPages);
          pageText = visual.text;
          if (pageText.trim()) visuallyReadPages.push(i);
          if (!pageText.trim() || visual.partial) unreadablePages.push(i);
        } else {
          unreadablePages.push(i);
        }
      }
      if (pageWindowOffset !== undefined) {
        const characterEnd = Math.min(pageText.length, pageWindowOffset + maxChars);
        const part = pageText.slice(pageWindowOffset, characterEnd);
        selectedPage = {
          page: i,
          characterStart: pageWindowOffset,
          characterEnd,
          nativeCharacters: pageText.length,
          truncated: pageWindowOffset > 0 || characterEnd < pageText.length,
        };
        options.onPage?.(i, part);
        parts.push(part);
        chars = part.length;
        pagesRead += 1;
        truncated ||= selectedPage.truncated;
        break;
      }
      const separatorChars = parts.length ? 1 : 0;
      const remaining = maxChars - chars - separatorChars;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const part = pageText.slice(0, remaining);
      options.onPage?.(i, part);
      parts.push(part);
      chars += part.length + separatorChars;
      pagesRead += 1;
      truncated ||= part.length < pageText.length;
    }
    return {
      text: parts.join('\n'),
      pages: pdf.numPages,
      pagesRead,
      truncated: truncated || firstPage > 1 || lastPage < pdf.numPages,
      ...(selectedPage ? { selectedPage } : {}),
      unreadablePages,
      visuallyReadPages,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
