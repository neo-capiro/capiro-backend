import { extractCitationsFromToolResult } from '@capiro/shared';
const id = '50000000-0000-4000-8000-000000000001';
const clientId = '30000000-0000-4000-8000-000000000001';
describe('source citations retain canonical read locators', () => {
  it('retains mail message/thread identity and observation time', () => {
    const generatedAt = '2026-09-02T12:00:00Z';
    expect(
      extractCitationsFromToolResult(
        'get_email_thread',
        {
          threadId: clientId,
          generatedAt,
          messages: [{ id, subject: 'Letter', bodyText: 'Full text' }],
        },
        1,
      )[0]?.source,
    ).toEqual({ kind: 'email', recordId: id, threadId: clientId, observedAt: generatedAt });
  });
  it('retains client parent and child section without deriving from titles', () => {
    expect(
      extractCitationsFromToolResult(
        'get_client_context',
        {
          client: { id: clientId, name: 'Sightline' },
          profile: {
            capabilities: [{ id, name: 'Sensors', updatedAt: '2026-09-03T00:00:00.000Z' }],
          },
        },
        1,
      )[1]?.source,
    ).toEqual({
      kind: 'client',
      recordId: id,
      clientId,
      section: 'capabilities',
      version: '2026-09-03T00:00:00.000Z',
      observedAt: undefined,
    });
  });
  it('prefers full governed records over thin result rows and binds version to approved body hash', () => {
    const payload = {
      results: [{ id, title: 'Thin metadata row' }],
      records: [
        {
          domain: 'institutional_knowledge',
          recordId: id,
          payload: {
            sourceKind: 'governed_memory',
            title: 'Actual fact',
            value: 'Approved sensor facts',
            clientId,
            content: { hash: 'approved-v1' },
          },
          provenance: { sourceVersion: 'same-evidence-version' },
        },
      ],
    };
    const citation = extractCitationsFromToolResult('search_memory', payload, 1)[0];
    expect(citation).toMatchObject({
      title: 'Actual fact',
      snippet: 'Approved sensor facts',
      source: { kind: 'memory', recordId: id, clientId, version: 'content:approved-v1' },
    });
    payload.records[0]!.payload.content.hash = 'approved-v2';
    expect(extractCitationsFromToolResult('search_memory', payload, 1)[0]?.source?.version).toBe(
      'content:approved-v2',
    );
  });
  it('retains the original document identity despite composite section evidence IDs', () => {
    const citation = extractCitationsFromToolResult(
      'read_client_documents',
      {
        clientId,
        document: { id, contentHash: 'original-bytes-hash' },
        coverage: {},
        records: [{ recordId: `${id}:section:1`, payload: { title: 'Page 1', text: 'Evidence' } }],
      },
      1,
    )[0];
    expect(citation?.source).toMatchObject({
      kind: 'document',
      recordId: id,
      clientId,
      version: 'original-bytes-hash',
    });
  });
});
