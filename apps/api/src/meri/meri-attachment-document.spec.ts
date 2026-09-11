import { getDocumentProxy } from 'unpdf';
import { Document, Packer, Paragraph } from 'docx';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { extractMeriDocument, ATTACHMENT_OCR_MAX_PAGES, ATTACHMENT_OCR_TIMEOUT_MS } from './meri-attachment-document.js';
import { DOC_TEXT_MAX_CHARS, validateAttachment, verifyMagicBytes } from './meri-attachment.helpers.js';

jest.mock('unpdf', () => ({ getDocumentProxy: jest.fn() }));
const input = { bytes: Buffer.from('%PDF-1.7 fixture'), kind: 'pdf' as const, tenantId: 'tenant-a', userId: 'user-a', resolveCredential: async () => null };
function pages(texts: string[]) {
  const destroy = jest.fn(async () => undefined);
  (getDocumentProxy as jest.Mock).mockResolvedValue({ numPages: texts.length,
    getPage: async (page: number) => ({ getTextContent: async () => ({ items: [{ str: texts[page - 1] }] }) }),
    loadingTask: { destroy },
  });
  return destroy;
}
const visual = (text: string, status = 'ocr_readable') => ({ text, readability: { status } });

describe('Meri document ingestion', () => {
  afterEach(() => jest.useRealTimers());

  async function presentation(slides: string[]): Promise<Buffer> {
    const deck = new PptxGenJS();
    for (const text of slides) {
      const slide = deck.addSlide();
      if (text) slide.addText(text, { x: 1, y: 1, w: 8, h: 4 });
    }
    return await deck.write({ outputType: 'nodebuffer' }) as Buffer;
  }

  it('accepts a real PowerPoint upload and reads its slide text without a provider call', async () => {
    const bytes = await presentation(['QA-PPTX-0911: Budget $42,000. Status: draft, not approved.', 'Second slide: requested evaluation.']);
    const validation = validateAttachment({ contentType: 'application/octet-stream', filename: 'Strat Discussion.pptx', byteSize: bytes.length });
    expect(validation).toMatchObject({ ok: true, kind: 'pptx' });
    expect(verifyMagicBytes(validation.kind, bytes).ok).toBe(true);
    const reader = { read: jest.fn() };
    const result = await extractMeriDocument({ ...input, bytes, kind: validation.kind }, reader);
    expect(result).toMatchObject({ status: 'parsed', truncated: false, pages: null });
    expect(result.text).toContain('Budget $42,000. Status: draft, not approved.');
    expect(result.text).toContain('Slide 2:\nSecond slide: requested evaluation.');
    expect(result.reason).toContain('Images, charts, and speaker notes are not included');
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('discloses missing slide text and keeps readable slides usable', async () => {
    const result = await extractMeriDocument({ ...input, kind: 'pptx', bytes: await presentation(['Readable first slide', '']) });
    expect(result).toMatchObject({ status: 'truncated', truncated: true });
    expect(result.text).toContain('Readable first slide');
    expect(result.reason).toContain('1 slide(s) had no readable text');
  });

  it('does not label empty decks or another OOXML format as readable PowerPoint', async () => {
    const zip = new JSZip().file('word/document.xml', '<document>Not a presentation</document>');
    const result = await extractMeriDocument({ ...input, kind: 'pptx', bytes: await presentation(['']) });
    expect(result).toMatchObject({ status: 'unsupported', text: null });
    expect(result.reason).toContain('No readable slide text');
    await expect(extractMeriDocument({ ...input, kind: 'pptx', bytes: await zip.generateAsync({ type: 'nodebuffer' }) })).rejects.toThrow();
    await expect(extractMeriDocument({ ...input, kind: 'pptx', bytes: Buffer.from('PK broken') })).rejects.toThrow();
  });

  it('discloses both the shared per-slide cap and Meri total text cap', async () => {
    for (const slides of [['A'.repeat(25_000)], Array(5).fill('A'.repeat(10_000))]) {
      const result = await extractMeriDocument({ ...input, kind: 'pptx', bytes: await presentation(slides) });
      expect(result).toMatchObject({ status: 'truncated', truncated: true });
      expect(result.reason).toContain('reading limit');
      expect(result.text!.length).toBeLessThanOrEqual(DOC_TEXT_MAX_CHARS + 20);
    }
  });

  it('keeps a short readable PDF without invoking OCR', async () => {
    pages(['Requested amount: $7,500,000. Stage: internal draft.']);
    const reader = { read: jest.fn() };
    const result = await extractMeriDocument(input, reader);
    expect(result).toMatchObject({ status: 'parsed', truncated: false, pages: 1 });
    expect(result.text).toContain('$7,500,000');
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('preserves the PDF extractor character cap as partial, even when the text fits the status helper cap exactly', async () => {
    pages(['A'.repeat(DOC_TEXT_MAX_CHARS + 50), 'Never reached']);
    const result = await extractMeriDocument(input, { read: jest.fn() });
    expect(result).toMatchObject({ status: 'truncated', truncated: true, pages: 2 });
    expect(result.reason).toContain('Only part');
  });

  it('uses the canonical page reader for scanned and mixed PDFs with tenant-scoped cache identity', async () => {
    pages(['TAG advocacy letter: FortressHUMS / UH-72 LUT.', '']);
    const reader = { read: jest.fn().mockResolvedValue(visual('Requested evaluation in FY2027. Not enacted.')) };
    const result = await extractMeriDocument(input, reader as never);
    expect(result).toMatchObject({ status: 'parsed', truncated: false });
    expect(result.text).toContain('FortressHUMS / UH-72 LUT');
    expect(result.text).toContain('Not enacted');
    expect(result.reason).toContain('scanned pages');
    expect(reader.read).toHaveBeenCalledWith(expect.objectContaining({
      section: 2, sectionCount: 2, bytes: input.bytes, cacheScope: expect.stringMatching(/^tenant-a:user-a:/),
      resolveCredential: input.resolveCredential, signal: expect.any(AbortSignal),
    }));
  });

  it('keeps readable pages but discloses failed and partial OCR', async () => {
    pages(['Original recommendation.', '', '']);
    const reader = { read: jest.fn().mockResolvedValueOnce(visual('Amount [illegible]', 'ocr_partial')).mockResolvedValueOnce(visual('', 'ocr_unavailable')) };
    const result = await extractMeriDocument(input, reader as never);
    expect(result).toMatchObject({ status: 'truncated', truncated: true });
    expect(result.text).toContain('Amount [illegible]');
    expect(result.reason).toContain('2 page(s)');
  });

  it('bounds provider calls and explains omitted pages', async () => {
    pages(Array(ATTACHMENT_OCR_MAX_PAGES + 2).fill(''));
    const reader = { read: jest.fn().mockResolvedValue(visual('Read page')) };
    const result = await extractMeriDocument(input, reader as never);
    expect(reader.read).toHaveBeenCalledTimes(ATTACHMENT_OCR_MAX_PAGES);
    expect(result).toMatchObject({ status: 'truncated', truncated: true });
    expect(result.reason).toContain('2 page(s)');
  });

  it('returns an explicit unavailable state instead of claiming OCR support failed for all attachments', async () => {
    pages(['']);
    const result = await extractMeriDocument(input, { read: jest.fn().mockResolvedValue(visual('', 'ocr_unavailable')) } as never);
    expect(result).toMatchObject({ status: 'scanned', text: null });
    expect(result.reason).toContain('Retry');
    expect(result.reason).not.toContain('paste');
  });

  it('bounds a stuck OCR/credential lookup and releases the parser', async () => {
    jest.useFakeTimers();
    const destroy = pages(['']);
    const result = extractMeriDocument(input, { read: jest.fn(() => new Promise(() => {})) } as never);
    await jest.advanceTimersByTimeAsync(ATTACHMENT_OCR_TIMEOUT_MS + 1);
    expect(await result).toMatchObject({ status: 'scanned', text: null });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('extracts an actual DOCX advocacy letter and text without a provider call', async () => {
    const line = 'FortressHUMS / UH-72 LUT: requested evaluation in FY2027, not enacted.';
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(line)] }] }));
    const reader = { read: jest.fn() };
    const docx = await extractMeriDocument({ ...input, bytes, kind: 'docx' }, reader);
    const txt = await extractMeriDocument({ ...input, bytes: Buffer.from(line), kind: 'text' }, reader);
    expect(docx).toMatchObject({ status: 'parsed', text: line });
    expect(txt).toMatchObject({ status: 'parsed', text: line });
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('rejects malformed DOCX and binary or invalid UTF-8 text', async () => {
    await expect(extractMeriDocument({ ...input, bytes: Buffer.from('PK broken'), kind: 'docx' })).rejects.toThrow();
    await expect(extractMeriDocument({ ...input, bytes: Buffer.from([0xff, 0xfe, 0]), kind: 'text' })).rejects.toThrow();
    await expect(extractMeriDocument({ ...input, bytes: Buffer.from('abc\u0000def'), kind: 'text' })).rejects.toThrow();
  });
});
