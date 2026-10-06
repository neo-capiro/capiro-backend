import {
  currentOwnerResultAuthorizesReplay,
  supportsDurableOwnerReauthorization,
} from './meri-research-replay-authorization';

function memory(version = 'v1', hash = 'hash-1') {
  return {
    tool: 'search_memory',
    contentStatus: 'available',
    results: [{ id: 'memory-1' }],
    records: [{
      recordId: 'memory-1',
      updatedAt: '2026-09-28T00:00:00.000Z',
      provenance: { sourceVersion: version, contentHash: hash },
      payload: { clientId: 'client-1', content: { hash } },
    }],
  };
}

function emptyMemory() {
  return {
    tool: 'search_memory',
    contentStatus: 'empty',
    results: [],
    records: [],
    coverage: {
      complete: true,
      paginationComplete: true,
      sources: [{
        domain: 'institutional_knowledge',
        sourceStatus: 'healthy',
        coverageComplete: true,
        paginationComplete: true,
        truncated: false,
      }],
    },
  };
}

function document(contentHash = 'a'.repeat(64)) {
  return {
    tool: 'read_client_documents',
    clientId: 'client-1',
    document: { id: 'document-1', contentHash },
    records: [{
      recordId: 'document-1:section',
      provenance: {
        sectionHash: 'b'.repeat(64), section: 1, characterStart: 0, characterEnd: 100,
      },
    }],
  };
}

function listing(
  generatedAt = '2026-10-06T17:31:17.000Z',
  documents: Array<Record<string, unknown>> = [
    {
      id: 'document-1',
      fileName: 'capabilities.pdf',
      contentType: 'application/pdf',
      byteSize: 1200,
      createdAt: '2026-09-28T00:00:00.000Z',
      extractionStatus: 'pending',
      extractionMetadata: null,
    },
    {
      id: 'document-2',
      fileName: 'supply-chain.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteSize: 800,
      createdAt: '2026-09-29T00:00:00.000Z',
      extractionStatus: 'pending',
      extractionMetadata: null,
    },
  ],
) {
  return {
    tool: 'read_client_documents',
    generatedAt,
    clientId: 'client-1',
    coverage: {
      total: documents.length,
      returned: documents.length,
      truncated: false,
      nextCursor: null,
      complete: true,
      paginationComplete: true,
      query: null,
      queryAppliesTo: 'fileName',
    },
    documents,
  };
}

describe('durable replay current-owner authorization adapters', () => {
  it('supports only finite canonical memory, document, debrief, and mail owners', () => {
    expect(supportsDurableOwnerReauthorization('search_memory')).toBe(true);
    expect(supportsDurableOwnerReauthorization('read_client_documents')).toBe(true);
    expect(supportsDurableOwnerReauthorization('query_debriefs')).toBe(true);
    expect(supportsDurableOwnerReauthorization('list_emails')).toBe(true);
    expect(supportsDurableOwnerReauthorization('search_emails')).toBe(true);
    expect(supportsDurableOwnerReauthorization('get_email_thread')).toBe(true);
    expect(supportsDurableOwnerReauthorization('provider_mail_read')).toBe(false);
  });

  it('requires every canonical memory identity and current version/hash to match', () => {
    expect(currentOwnerResultAuthorizesReplay('search_memory', memory(), memory())).toBe(true);
    expect(currentOwnerResultAuthorizesReplay('search_memory', memory(), memory('v2'))).toBe(false);
    expect(currentOwnerResultAuthorizesReplay('search_memory', memory(), memory('v1', 'hash-2'))).toBe(false);
  });

  it('compares a live in-process result in the JSON shape the producer saw', () => {
    // The saved result crossed HTTP (ISO string); the re-check runs in process (Date).
    const live = memory();
    live.records[0]!.updatedAt = new Date('2026-09-28T00:00:00.000Z') as never;
    expect(currentOwnerResultAuthorizesReplay('search_memory', memory(), live)).toBe(true);
    live.records[0]!.updatedAt = new Date('2026-09-29T00:00:00.000Z') as never;
    expect(currentOwnerResultAuthorizesReplay('search_memory', memory(), live)).toBe(false);
  });

  it('re-checks a file listing by the identity of the files it showed', () => {
    const saved = listing();
    // Live: a later read, Date upload times, and extraction state updated by reading a file.
    const live = listing('2026-10-06T17:39:24.000Z');
    for (const row of live.documents) {
      row.createdAt = new Date(String(row.createdAt));
      row.extractionStatus = 'extracted';
      row.extractionMetadata = { lastSectionRead: { extractedAt: '2026-10-06T17:32:00.000Z' } };
    }
    expect(currentOwnerResultAuthorizesReplay('read_client_documents', saved, live)).toBe(true);

    const renamed = listing();
    renamed.documents[1]!.fileName = 'renamed.docx';
    expect(currentOwnerResultAuthorizesReplay('read_client_documents', saved, renamed)).toBe(false);
    const revoked = listing(undefined, [listing().documents[0]!]);
    expect(currentOwnerResultAuthorizesReplay('read_client_documents', saved, revoked)).toBe(false);
    expect(currentOwnerResultAuthorizesReplay('read_client_documents', saved, document())).toBe(
      false,
    );
    const empty = listing(undefined, []);
    expect(currentOwnerResultAuthorizesReplay('read_client_documents', empty, empty)).toBe(true);
  });

  it('rejects unversioned projections while preserving owner-proven empty results', () => {
    expect(currentOwnerResultAuthorizesReplay(
      'search_memory',
      { tool: 'search_memory', results: [{ id: 'memory-1' }], records: [] },
      { tool: 'search_memory', results: [], records: [] },
    )).toBe(false);
    expect(currentOwnerResultAuthorizesReplay('search_memory', emptyMemory(), emptyMemory())).toBe(
      true,
    );
    expect(currentOwnerResultAuthorizesReplay(
      'search_memory',
      emptyMemory(),
      { ...emptyMemory(), coverage: { complete: false, sources: [] } },
    )).toBe(false);
  });

  it('requires the exact authorized document content and section version', () => {
    expect(currentOwnerResultAuthorizesReplay('read_client_documents', document(), document())).toBe(true);
    expect(currentOwnerResultAuthorizesReplay(
      'read_client_documents', document(), document('c'.repeat(64)),
    )).toBe(false);
    expect(currentOwnerResultAuthorizesReplay(
      'read_client_documents',
      { tool: 'read_client_documents', documents: [{ id: 'document-1' }], records: [] },
      { tool: 'read_client_documents', documents: [{ id: 'document-1' }], records: [] },
    )).toBe(false);
  });
});
