import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import type { ResolvedAiCredential } from '../ai-credentials/ai-credential-resolver.service.js';
import { AttachmentPdfVisionReader } from '../engagement/attachment-pdf-vision.js';
import { extractPptxDocument } from '../engagement/pptx-extract.js';
import { extractPdfText } from './meri-attachment-extract.js';
import { resolveDocumentStatus, type AttachmentKind, type DocumentExtractionResult } from './meri-attachment.helpers.js';

export const ATTACHMENT_OCR_MAX_PAGES = 8;
export const ATTACHMENT_OCR_TIMEOUT_MS = 45_000;
const visualReader = new AttachmentPdfVisionReader();

/** Reuse the canonical provider page reader; persist its literal result once so
 * regeneration and follow-ups do not run nondeterministic OCR again. */
export async function extractMeriDocument(input: {
  bytes: Buffer;
  kind: AttachmentKind;
  tenantId: string;
  userId: string;
  resolveCredential: () => Promise<ResolvedAiCredential | null>;
}, reader: Pick<AttachmentPdfVisionReader, 'read'> = visualReader): Promise<DocumentExtractionResult & { pages: number | null }> {
  if (input.kind === 'pptx') {
    const extracted = await extractPptxDocument(input.bytes);
    const resolved = resolveDocumentStatus('pptx', extracted.text);
    if (!resolved.text) return { ...resolved, pages: null,
      reason: 'No readable slide text was found. Export the presentation to PDF or upload images of the slides.' };
    const partial = resolved.truncated || extracted.truncated || extracted.unreadableSlides.length > 0;
    const reasons = ['PowerPoint slide text only. Images, charts, and speaker notes are not included; upload a PDF or slide images for those details.'];
    if (extracted.unreadableSlides.length)
      reasons.push(`${extracted.unreadableSlides.length} slide(s) had no readable text.`);
    if (resolved.truncated || extracted.truncated)
      reasons.push('Only part of the slide text is included because it exceeds the reading limit.');
    return { ...resolved, pages: null, status: partial ? 'truncated' : 'parsed',
      truncated: partial, reason: reasons.join(' ').slice(0, 300) };
  }
  if (input.kind !== 'pdf') {
    const raw = input.kind === 'docx'
      ? (await mammoth.extractRawText({ buffer: input.bytes })).value
      : new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
    // A binary .txt should not be accepted as readable replacement characters.
    if (raw.includes('\u0000')) throw new Error('Binary text attachment');
    return { ...resolveDocumentStatus(input.kind, raw), pages: null };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ATTACHMENT_OCR_TIMEOUT_MS);
  const cacheScope = `${input.tenantId}:${input.userId}:${createHash('sha256').update(input.bytes).digest('hex')}`;
  let attempts = 0;
  try {
    const extracted = await extractPdfText(input.bytes, {
      signal: controller.signal,
      readScannedPage: async (section, sectionCount) => {
        if (controller.signal.aborted || attempts >= ATTACHMENT_OCR_MAX_PAGES)
          return { text: '', partial: true };
        attempts += 1;
        let onAbort: () => void = () => {};
        try {
          const deadline = new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('Scanned-page reading timed out'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });
          const result = await Promise.race([reader.read({ bytes: input.bytes, cacheScope, section, sectionCount,
            resolveCredential: input.resolveCredential, signal: controller.signal }), deadline]);
          return { text: result.text, partial: result.readability.status !== 'ocr_readable' };
        } catch {
          // Keep earlier readable pages and disclose the gap if the deadline expires.
          return { text: '', partial: true };
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
        }
      },
    });
    const resolved = resolveDocumentStatus('pdf', extracted.text);
    const partial = extracted.truncated || extracted.unreadablePages.length > 0 || resolved.truncated;
    const reasons: string[] = [];
    if (extracted.visuallyReadPages.length)
      reasons.push('Includes text read from scanned pages. Verify important names and figures against the original.');
    if (extracted.unreadablePages.length)
      reasons.push(`${extracted.unreadablePages.length} page(s) could not be read completely. Retry this file or upload those pages separately.`);
    if (extracted.truncated || resolved.truncated)
      reasons.push('Only part of this document is included because it exceeds the reading limit.');
    return { ...resolved, pages: extracted.pages,
      ...(resolved.text ? { status: partial ? 'truncated' as const : 'parsed' as const, truncated: partial } : {}),
      reason: reasons.length ? reasons.join(' ').slice(0, 300) : resolved.reason };
  } finally {
    clearTimeout(timeout);
  }
}
