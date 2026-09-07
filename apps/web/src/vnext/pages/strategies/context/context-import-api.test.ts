import { describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import {
  CONTEXT_IMPORT_MAX_BYTES, analyzeContextImport, contextFileProblem, contextFileWithMimeType,
  contextImportError, contextImportNeedsRefresh, contextSourceLabel, resolveContextImport, saveContextImport,
} from './context-import-api.js';

describe('Context import boundaries', () => {
  it('infers Office and image MIME types for files without a browser type', () => {
    expect(contextFileWithMimeType(new File(['x'], 'briefing.DOCX')).type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(contextFileWithMimeType(new File(['x'], 'slides.pptx', { type: 'application/octet-stream' })).type).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const pdf = new File(['x'], 'briefing.pdf', { type: 'application/pdf' });
    expect(contextFileWithMimeType(pdf)).toBe(pdf);
  });
  it('rejects empty, oversized, and unknown files before upload while allowing readable types', () => {
    expect(contextFileProblem(new File([], 'empty.txt'))).toMatch(/empty/);
    expect(contextFileProblem({ name: 'large.pdf', size: CONTEXT_IMPORT_MAX_BYTES + 1 } as File)).toMatch(/larger than 25 MB/);
    expect(contextFileProblem(new File(['x'], 'archive.zip'))).toMatch(/Export it as PDF/);
    for (const extension of ['pdf', 'doc', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'md', 'json', 'png', 'jpg']) {
      expect(contextFileProblem(new File(['x'], `source.${extension}`))).toBeNull();
    }
  });
  it('passes exact source scope to resolve and only server tokens and selections to analysis/save', async () => {
    const post = vi.fn().mockResolvedValue({ data: { documents: [] } });
    const api = { post } as unknown as AxiosInstance;
    await resolveContextImport(api, { clientId: 'client', strategyId: 'strategy', attachmentId: 'attachment' });
    await analyzeContextImport(api, 'server-chunk-token');
    await saveContextImport(api, 'server-preview-token', ['document']);
    expect(post.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['/strategy-api/context/imports/resolve', { clientId: 'client', strategyId: 'strategy', attachmentId: 'attachment' }],
      ['/strategy-api/context/imports/analyze', { token: 'server-chunk-token' }],
      ['/strategy-api/context/imports/save', { token: 'server-preview-token', selectedDocumentIds: ['document'] }],
    ]);
  });
  it('makes source locations and permission failures understandable', () => {
    expect(contextSourceLabel('page:2')).toBe('Page 2');
    expect(contextSourceLabel('slide:7')).toBe('Slide 7');
    expect(contextSourceLabel('sheet:1:rows:1-1000')).toBe('Sheet 1, rows 1–1000');
    expect(contextSourceLabel('page:1#part1')).toBe('Page 1, part 1');
    expect(contextSourceLabel('sheet:1:rows:1-1000#part3')).toBe('Sheet 1, rows 1–1000, part 3');
    expect(contextImportError({ response: { status: 403 } })).toMatch(/Choose a strategy you can edit/);
    expect(contextImportError({ response: { data: { message: ['Needs a clearer scan.', 'Try again.'] } } })).toBe('Needs a clearer scan. Try again.');
    expect(contextImportNeedsRefresh({ response: { status: 409, data: { code: 'CONTEXT_IMPORT_EXPIRED' } } })).toBe(true);
    expect(contextImportNeedsRefresh(new Error('Temporary outage'))).toBe(false);
  });
});
