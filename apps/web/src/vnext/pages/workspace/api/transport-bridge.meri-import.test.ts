import { describe, expect, test } from 'vitest';
import { normalizeWorkspaceTransportResponse } from './transport-bridge.js';

describe('Workspace transport bridge — Meri import routes', () => {
  test('preserves the names-only response from the authorized import list endpoint', () => {
    expect(
      normalizeWorkspaceTransportResponse(
        '/workspace-api/drafts/draft-1/documents/meri-import',
        'GET',
        [{ id: 'document-1', name: 'Board memo', body: { blocks: [{ content: 'must not leak' }] } }],
      ),
    ).toEqual([{ id: 'document-1', name: 'Board memo' }]);
  });

  test('preserves an authorized Meri-import body instead of converting it to editor HTML', () => {
    const body = { blocks: [{ content: 'Source text.' }] };
    expect(
      normalizeWorkspaceTransportResponse(
        '/workspace-api/drafts/draft-1/documents/document-1/meri-import',
        'GET',
        { id: 'document-1', name: 'Board memo', body },
      ),
    ).toEqual({ id: 'document-1', name: 'Board memo', body });
  });
});
