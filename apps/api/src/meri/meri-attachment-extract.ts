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
}

export async function extractPdfText(buffer: Buffer | Uint8Array): Promise<PdfExtraction> {
  const bytes = buffer instanceof Uint8Array && !(buffer instanceof Buffer)
    ? buffer
    : new Uint8Array(buffer);
  const pdf = await getDocumentProxy(bytes);
  const pageCount = Math.min(pdf.numPages, PDF_MAX_PAGES);
  const parts: string[] = [];
  let chars = 0;
  let pagesRead = 0;
  let truncated = false;
  try {
    for (let i = 1; i <= pageCount && chars < DOC_TEXT_MAX_CHARS; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = (content.items as Array<{ str?: string }>)
        .map((item) => item.str ?? '')
        .join(' ');
      const separatorChars = parts.length ? 1 : 0;
      const remaining = DOC_TEXT_MAX_CHARS - chars - separatorChars;
      if (remaining <= 0) { truncated = true; break; }
      const part = pageText.slice(0, remaining);
      parts.push(part);
      chars += part.length + separatorChars;
      pagesRead += 1;
      truncated ||= part.length < pageText.length;
    }
    return { text: parts.join('\n'), pages: pdf.numPages, pagesRead,
      truncated: truncated || pagesRead < pdf.numPages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
