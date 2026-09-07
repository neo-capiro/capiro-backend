import { PDFDocument } from 'pdf-lib';
import { AttachmentPdfVisionReader } from './attachment-pdf-vision.js';
import { LlmCompletionService } from './llm-completion.service.js';
import {
  buildDocumentReadPage,
  parseDocumentReadInput,
} from '../meri/meri-document-read.helpers.js';

const credential = {
  provider: 'openai' as const,
  apiKey: 'tenant-fixture-key',
  model: 'configured-vision-model',
  usedTenantKey: true,
  modelOverridden: true,
};

async function fixture() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 22; i++) doc.addPage();
  const complete = jest
    .fn()
    .mockResolvedValue({
      text: JSON.stringify({ text: 'Late evidence', partial: false }),
      truncated: false,
      stopReason: 'completed',
    });
  const reader = new AttachmentPdfVisionReader({ complete } as unknown as LlmCompletionService);
  const input = {
    bytes: Buffer.from(await doc.save()),
    cacheScope: 'tenant-1:document-1:hash',
    section: 22,
    sectionCount: 22,
    resolveCredential: jest.fn(async () => credential),
  };
  return { input, reader, complete };
}

describe('authorized scanned-page fallback', () => {
  it('sends only page 22 through tenant-selected credentials and stabilizes long continuation reads', async () => {
    const { input, reader, complete } = await fixture();
    const expected = `${'A literal section. '.repeat(950)}DECISIVE FINAL CONDITION`;
    complete.mockResolvedValue({
      text: JSON.stringify({ text: expected, partial: false }),
      truncated: false,
      stopReason: 'completed',
    });
    const visual = await reader.read(input);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: credential.apiKey,
        model: credential.model,
        timeoutMs: 30000,
        maxRetries: 0,
        pdfInput: expect.objectContaining({ filename: 'page-22.pdf' }),
      }),
    );
    const onePage = await PDFDocument.load(
      Buffer.from(complete.mock.calls[0]![0].pdfInput.base64, 'base64'),
    );
    expect(onePage.getPageCount()).toBe(1);
    expect(visual.readability).toMatchObject({
      status: 'ocr_readable',
      section: 22,
      sectionCount: 22,
    });
    let cursor: string | null = null;
    const parts: string[] = [];
    do {
      const selected = parseDocumentReadInput(
        { documentId: 'doc', ...(cursor ? { cursor } : { section: 22 }) },
        'client',
      );
      const repeated = await reader.read(input);
      const page = buildDocumentReadPage('client', selected, {
        attachmentId: 'doc',
        fileName: 'Long scanned file.pdf',
        contentType: 'application/pdf',
        contentHash: 'a'.repeat(64),
        source: 'pdf',
        section: 22,
        sectionCount: 22,
        ...repeated,
      });
      parts.push(page.records[0]!.payload.text);
      cursor = page.coverage.nextCursor;
    } while (cursor);
    expect(parts.join('')).toBe(expected);
    expect(parts.join('').indexOf('DECISIVE')).toBeGreaterThan(12000);
    expect(complete).toHaveBeenCalledTimes(1);
    // A cache hit never substitutes for fresh tenant credential policy checks.
    expect(input.resolveCredential.mock.calls.length).toBeGreaterThan(1);
  });

  it('does not leak cached extraction across tenant scopes or unavailable credentials', async () => {
    const { input, reader, complete } = await fixture();
    await reader.read(input);
    await reader.read({ ...input, cacheScope: 'tenant-2:document-1:hash' });
    expect(complete).toHaveBeenCalledTimes(2);
    const unavailable = await reader.read({ ...input, resolveCredential: async () => null });
    expect(unavailable.readability).toMatchObject({
      status: 'ocr_unavailable',
      reason: 'provider_not_configured',
    });
    expect(unavailable.text).toBe('');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('discloses partial text, refuses incomplete/malformed output, and never exposes provider errors', async () => {
    for (const response of [
      { text: '{}', truncated: false, stopReason: 'completed' },
      { text: '{', truncated: true, stopReason: 'incomplete' },
    ]) {
      const { input, reader, complete } = await fixture();
      complete.mockResolvedValue(response);
      expect((await reader.read(input)).readability.status).toBe('ocr_unavailable');
    }
    const { input, reader, complete } = await fixture();
    complete.mockResolvedValue({
      text: JSON.stringify({ text: 'Amount [illegible]', partial: true }),
      truncated: false,
      stopReason: 'completed',
    });
    expect((await reader.read(input)).readability.status).toBe('ocr_partial');
    complete.mockRejectedValue(new Error('Secret provider detail'));
    const failed = await reader.read({ ...input, cacheScope: 'uncached' });
    expect(JSON.stringify(failed)).not.toContain('Secret provider detail');
  });

  it('cancels before credentials/provider calls, and propagates an in-flight cancellation', async () => {
    const { input, reader, complete } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(reader.read({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(input.resolveCredential).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    const running = new AbortController();
    complete.mockImplementation(async () => {
      running.abort();
      throw running.signal.reason;
    });
    await expect(reader.read({ ...input, signal: running.signal })).rejects.toThrow();
  });
});
