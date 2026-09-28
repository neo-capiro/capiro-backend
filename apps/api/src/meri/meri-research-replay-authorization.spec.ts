import {
  currentOwnerResultAuthorizesReplay,
  supportsDurableOwnerReauthorization,
} from './meri-research-replay-authorization';

function memory(version = 'v1', hash = 'hash-1') {
  return {
    tool: 'search_memory',
    records: [{
      recordId: 'memory-1',
      updatedAt: '2026-09-28T00:00:00.000Z',
      provenance: { sourceVersion: version, contentHash: hash },
      payload: { clientId: 'client-1', content: { hash } },
    }],
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

describe('durable replay current-owner authorization adapters', () => {
  it('supports canonical memory and exact document owners only', () => {
    expect(supportsDurableOwnerReauthorization('search_memory')).toBe(true);
    expect(supportsDurableOwnerReauthorization('read_client_documents')).toBe(true);
    expect(supportsDurableOwnerReauthorization('search_emails')).toBe(false);
  });

  it('requires every canonical memory identity and current version/hash to match', () => {
    expect(currentOwnerResultAuthorizesReplay('search_memory', memory(), memory())).toBe(true);
    expect(currentOwnerResultAuthorizesReplay('search_memory', memory(), memory('v2'))).toBe(false);
    expect(currentOwnerResultAuthorizesReplay('search_memory', memory(), memory('v1', 'hash-2'))).toBe(false);
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
