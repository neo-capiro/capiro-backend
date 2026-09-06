import { buildDocumentReadPage, parseDocumentReadInput } from './meri-document-read.helpers.js';
import { wrapToolResultForPrompt } from '@capiro/meriv2-core';

const clientId = 'client-1';
const base = {
  attachmentId: 'document-1',
  fileName: 'Capability statement.txt',
  contentType: 'text/plain',
  source: 'text',
  contentHash: 'a'.repeat(64),
  section: 1,
  sectionCount: 1,
  sectionKind: 'document',
  text: '',
};

describe('resumable client document evidence', () => {
  it('reconstructs evidence beyond the old 12000-character cutoff without gaps or duplicate characters', () => {
    const text = `${'Early content. '.repeat(1300)}The decisive limitation is in the last paragraph.`;
    let cursor: string | null = null;
    const pieces: string[] = [];
    do {
      const input = parseDocumentReadInput(
        { documentId: base.attachmentId, ...(cursor ? { cursor } : {}) },
        clientId,
      );
      const page = buildDocumentReadPage(clientId, input, { ...base, text });
      pieces.push(page.records[0]!.payload.text);
      cursor = page.coverage.nextCursor;
    } while (cursor);
    expect(pieces.join('')).toBe(text);
    expect(pieces.length).toBeGreaterThan(3);
  });

  it('keeps the next read and extractor disclosure visible with JSON-heavy evidence', () => {
    const input = parseDocumentReadInput({ documentId: base.attachmentId, limit: 6000 }, clientId);
    const result = buildDocumentReadPage(clientId, input, {
      ...base,
      text: '\\"\n\u0000'.repeat(3000),
      disclosure: 'This file was never scanned.',
      truncated: true,
      extractionMetadata: { truncated: true, timedOut: false, pageLimitHit: true },
    });
    expect(result.coverage).toMatchObject({
      extractionTruncated: true,
      disclosure: 'This file was never scanned.',
      extractionMetadata: { pageLimitHit: true },
    });
    const prompt = wrapToolResultForPrompt('read_client_documents', result, 12000);
    expect(prompt).toContain(result.coverage.nextCursor!);
    expect(prompt).not.toContain('[truncated tool result]');
  });

  it('advances through physical sections and preserves page/row provenance', () => {
    const first = buildDocumentReadPage(
      clientId,
      parseDocumentReadInput({ documentId: base.attachmentId }, clientId),
      { ...base, text: 'First page', source: 'pdf', sectionKind: 'page', sectionCount: 2 },
    );
    const input = parseDocumentReadInput(
      { documentId: base.attachmentId, cursor: first.coverage.nextCursor },
      clientId,
    );
    expect(input).toMatchObject({ section: 2, offset: 0 });
    const last = buildDocumentReadPage(clientId, input, {
      ...base,
      source: 'pdf',
      sectionKind: 'page',
      section: 2,
      sectionCount: 2,
      text: 'Second page',
    });
    expect(last.records[0]!.provenance).toMatchObject({
      section: 2,
      contentHash: base.contentHash,
    });
    expect(last.coverage).toMatchObject({
      nextCursor: null,
      complete: false,
      sectionComplete: true,
    });
  });

  it('searches late evidence without falsely treating the returned match as the whole document', () => {
    const result = buildDocumentReadPage(
      clientId,
      parseDocumentReadInput({ documentId: base.attachmentId, query: 'restriction' }, clientId),
      { ...base, text: `${'prefix '.repeat(2500)}A restriction applies.` },
    );
    expect(result.records[0]!.payload.text).toContain('restriction');
    expect(result.coverage).toMatchObject({ matched: true, complete: false });
    expect(result.coverage.characterStart).toBeGreaterThan(12000);
  });

  it('reports a no-match section and gives a cursor to search the next page', () => {
    const result = buildDocumentReadPage(
      clientId,
      parseDocumentReadInput({ documentId: base.attachmentId, query: 'grant' }, clientId),
      { ...base, text: 'No matching text.', sectionCount: 3 },
    );
    expect(result.coverage).toMatchObject({ matched: false, complete: false, truncated: true });
    expect(
      parseDocumentReadInput(
        { documentId: base.attachmentId, query: 'grant', cursor: result.coverage.nextCursor },
        clientId,
      ).section,
    ).toBe(2);
  });

  it('rejects changed bytes, changed extraction, cross-client cursors and changed search queries', () => {
    const result = buildDocumentReadPage(
      clientId,
      parseDocumentReadInput({ documentId: base.attachmentId }, clientId),
      { ...base, text: 'x'.repeat(9000) },
    );
    const raw = { documentId: base.attachmentId, cursor: result.coverage.nextCursor };
    const input = parseDocumentReadInput(raw, clientId);
    expect(() =>
      buildDocumentReadPage(clientId, input, {
        ...base,
        text: 'x'.repeat(9000),
        contentHash: 'b'.repeat(64),
      }),
    ).toThrow('changed');
    expect(() =>
      buildDocumentReadPage(clientId, input, { ...base, text: 'y'.repeat(9000) }),
    ).toThrow('changed');
    expect(() => parseDocumentReadInput(raw, 'another-client')).toThrow('does not match');
    expect(() => parseDocumentReadInput({ ...raw, query: 'changed' }, clientId)).toThrow(
      'does not match',
    );
  });

  it.each([{ section: 0 }, { characterOffset: -1 }, { limit: 6001 }, { cursor: 'broken' }])(
    'rejects invalid selection %j',
    (extra) => {
      expect(() =>
        parseDocumentReadInput({ documentId: base.attachmentId, ...extra }, clientId),
      ).toThrow();
    },
  );
});
