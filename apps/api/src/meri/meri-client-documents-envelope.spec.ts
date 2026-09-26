import { createHash } from 'node:crypto';
import { envelopeClientDocumentsResult, observeClientDocumentsCall } from './meri-client-documents-envelope';

const completeDocumentRead = () => {
  const text = 'Sample text.';
  const hash = 'a'.repeat(64);
  const sectionHash = createHash('sha256').update(text).digest('hex');
  return {
    tool: 'read_client_documents', generatedAt: '2026-01-01T00:00:00.000Z', clientId: 'client-1',
    document: { id: 'doc-1', fileName: 'Evidence.txt', contentType: 'text/plain', contentHash: hash },
    coverage: { contentScope: 'extractable_text_only', complete: true, truncated: false, nextCursor: null,
      section: 1, sectionCount: 1, sectionCharacters: text.length, characterStart: 0,
      characterEnd: text.length, sectionComplete: true, extractedSectionEmpty: false,
      extractionTruncated: false, query: null },
    records: [{ recordId: `doc-1:${hash.slice(0, 16)}:1:0-${text.length}`, payload: {
      id: `doc-1:${hash.slice(0, 16)}:1:0-${text.length}`, documentId: 'doc-1', title: 'Evidence.txt',
      fileName: 'Evidence.txt', contentType: 'text/plain',
      source: 'text', section: 1, sectionKind: 'document', sectionLabel: 'Document text',
      characterStart: 0, characterEnd: text.length, text,
    }, provenance: { sourceTable: 'engagement_attachment', sourceRecordId: 'doc-1', clientId: 'client-1',
      contentHash: hash, sectionHash, section: 1, characterStart: 0, characterEnd: text.length,
      trust: 'external_untrusted' } }],
  };
};

const listing = (overrides: Record<string, unknown> = {}) => ({
  tool: 'read_client_documents', generatedAt: '2026-01-01T00:00:00.000Z', clientId: 'client-1',
  coverage: { total: 0, returned: 0, truncated: false, nextCursor: null, complete: true,
    paginationComplete: true, query: null, queryAppliesTo: 'fileName' },
  note: 'A file listing is not evidence that its contents have been read.', documents: [], ...overrides,
});

describe('read_client_documents additive result envelope', () => {
  it('recognizes a complete empty listing as empty enumeration only', () => {
    const legacy = listing();
    const envelope = envelopeClientDocumentsResult(legacy, { clientId: 'client-1' });
    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope.outcome).toBe('not_found_within_scope');
    expect(envelope.sources[0]).toMatchObject({
      family: 'document', sourceId: 'engagement_attachment', availability: 'available',
      scope: { mode: 'listing', clientId: 'client-1' },
      coverage: { completeness: 'complete', returnedCount: 0, matchedCount: 0 }, provenance: [],
    });
    expect(envelope.sources[0]?.provenance).toEqual([]);
  });

  it('does not promote a terminal cursor page to whole-list completeness', () => {
    const legacy = listing({
      coverage: { total: 2, returned: 1, truncated: false, nextCursor: null, complete: false,
        paginationComplete: true, query: null, queryAppliesTo: 'fileName' },
      documents: [{ id: 'doc-b' }],
    });
    const envelope = envelopeClientDocumentsResult(legacy, { clientId: 'client-1', cursor: 'documents:doc-a' });
    expect(envelope.sources[0]?.coverage.completeness).toBe('partial');
    expect(envelope.outcome).toBe('partial');
  });

  it('does not call an empty listing not-found when its query does not match the request', () => {
    const legacy = listing();
    const envelope = envelopeClientDocumentsResult(legacy, { clientId: 'client-1', query: 'private-name' });
    expect(envelope.outcome).not.toBe('not_found_within_scope');
    expect(envelope.sources[0]?.coverage.completeness).not.toBe('complete');
  });

  it('keeps mismatched client identity unknown rather than trusting request scope', () => {
    const legacy = listing({ clientId: 'other-client' });
    const envelope = envelopeClientDocumentsResult(legacy, { clientId: 'client-1' });
    expect(envelope.sources[0]?.availability).toBe('unknown');
    expect(envelope.sources[0]?.scope.clientId).toBe('other-client');
    expect(envelope.legacyPayload).toBe(legacy);
  });

  it('preserves thrown errors by reference and emits no error observation', async () => {
    const denied = Object.assign(new Error('Client not found'), { status: 404 });
    const observe = jest.fn();
    await expect(observeClientDocumentsCall(() => Promise.reject(denied), { clientId: 'client-1' }, observe))
      .rejects.toBe(denied);
    expect(observe).not.toHaveBeenCalled();
  });

  it('keeps an observed listing unchanged through sync, rejected and pending callbacks', async () => {
    const legacy = listing();
    const request = { clientId: 'client-1' };

    await expect(observeClientDocumentsCall(async () => legacy, request, () => {
      throw new Error('observer threw');
    })).resolves.toBe(legacy);
    await expect(observeClientDocumentsCall(async () => legacy, request, () =>
      Promise.reject(new Error('observer rejected')))).resolves.toBe(legacy);

    const pending = new Promise<void>(() => undefined);
    await expect(observeClientDocumentsCall(async () => legacy, request, () => pending))
      .resolves.toBe(legacy);
  });

  it('does not declare missing content evidence complete', () => {
    const legacy = {
      tool: 'read_client_documents', clientId: 'client-1', document: { id: 'doc-1' },
      coverage: { complete: true, truncated: false, nextCursor: null }, records: [],
    };
    const envelope = envelopeClientDocumentsResult(legacy, { clientId: 'client-1', documentId: 'doc-1' });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
  });

  it('keeps a section query no-match scoped to that section, not document absence', () => {
    const legacy = {
      tool: 'read_client_documents', clientId: 'client-1', document: { id: 'doc-1' },
      coverage: { complete: false, truncated: false, nextCursor: null, section: 2, sectionCount: 4,
        query: 'needle', matched: false, extractedSectionEmpty: false, extractionTruncated: false },
      records: [],
    };
    const envelope = envelopeClientDocumentsResult(legacy, { clientId: 'client-1', documentId: 'doc-1', query: 'needle' });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.scope).toMatchObject({ mode: 'document_search', section: 2, sectionQuery: 'needle' });
    expect(envelope.sources[0]?.coverage).toMatchObject({ completeness: 'partial', matchedCount: 0 });
  });

  it('accepts only explicitly complete, identity-bound exact content as complete', () => {
    const legacy = completeDocumentRead();
    const hash = 'a'.repeat(64);
    const envelope = envelopeClientDocumentsResult(legacy, { clientId: 'client-1', documentId: 'doc-1' });
    expect(envelope.outcome).toBe('succeeded');
    expect(envelope.sources[0]?.coverage.completeness).toBe('complete');
    expect(envelope.sources[0]?.provenance[0]).toMatchObject({
      recordId: `doc-1:${hash.slice(0, 16)}:1:0-12`, sourceId: 'engagement_attachment', sourceVersion: hash,
      locator: 'section:1;chars:0-12',
    });
  });

  it.each([
    ['missing text', (payload: Record<string, any>) => { delete payload.records[0].payload.text; }],
    ['whitespace-only text', (payload: Record<string, any>) => { payload.records[0].payload.text = '   '; payload.records[0].provenance.sectionHash = createHash('sha256').update('   ').digest('hex'); }],
    ['record ID mismatch', (payload: Record<string, any>) => { payload.records[0].recordId = 'another-id'; }],
    ['payload ID alias mismatch', (payload: Record<string, any>) => { payload.records[0].payload.id = 'another-id'; }],
    ['readability section mismatch', (payload: Record<string, any>) => { payload.coverage.readability = {
      status: 'ocr_readable', method: 'openai_pdf', scope: 'section', section: 1, sectionCount: 2,
      chars: payload.coverage.sectionCharacters, note: 'page only',
    }; }],
    ['section mismatch', (payload: Record<string, any>) => { payload.records[0].payload.section = 2; }],
    ['range mismatch', (payload: Record<string, any>) => { payload.records[0].provenance.characterEnd -= 1; }],
    ['incorrect section hash', (payload: Record<string, any>) => { payload.records[0].provenance.sectionHash = 'b'.repeat(64); }],
    ['multiple records', (payload: Record<string, any>) => { payload.records.push(payload.records[0]); }],
  ])('does not accept malformed complete record proof: %s', (_name, mutate) => {
    const legacy = completeDocumentRead();
    mutate(legacy);
    const envelope = envelopeClientDocumentsResult(legacy, { clientId: 'client-1', documentId: 'doc-1' });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).not.toBe('complete');
  });

  it.each([
    ['different requested section', { section: 2 }],
    ['nonzero requested offset', { characterOffset: 4 }],
  ])('does not call a read complete when caller scope differs: %s', (_name, requestScope) => {
    const legacy = completeDocumentRead();
    const envelope = envelopeClientDocumentsResult(legacy, {
      clientId: 'client-1', documentId: 'doc-1', ...requestScope,
    });
    expect(envelope.outcome).not.toBe('succeeded');
    expect(envelope.sources[0]?.coverage.completeness).not.toBe('complete');
  });

  it('maps only the explicit sanitized OCR-unavailable status to unavailable', () => {
    const legacy = {
      tool: 'read_client_documents', clientId: 'client-1', document: { id: 'doc-1', contentHash: 'a'.repeat(64) },
      coverage: { complete: false, truncated: true, continuationBlocked: true, nextCursor: null,
        extractedSectionEmpty: true, readability: { status: 'ocr_unavailable', reason: 'provider_not_configured' } },
      records: [],
    };
    const envelope = envelopeClientDocumentsResult(legacy, { clientId: 'client-1', documentId: 'doc-1' });
    expect(envelope.outcome).toBe('unavailable');
    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope.sources[0]).toMatchObject({ availability: 'unavailable', failure: { code: 'document_section_unreadable' } });
    expect(envelope.errors).toEqual([{ code: 'document_section_unreadable' }]);
    expect(JSON.stringify(envelope.errors)).not.toContain('provider_not_configured');
  });
});
