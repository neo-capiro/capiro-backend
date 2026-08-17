import { describe, expect, test } from 'vitest';
import {
  workspaceDocumentComposerText,
  workspaceImportDraftsResponse,
} from './meri-workspace-import.js';

describe('workspace import helpers', () => {
  test('normalizes only Workspace-authorized draft choices', () => {
    expect(
      workspaceImportDraftsResponse({
        drafts: [
          { id: 'draft-1', docTitle: 'Briefing', client: 'Acme' },
          { id: 'draft-2', docTitle: 'Untitled draft', client: null },
          { id: 'missing-title' },
        ],
      }),
    ).toEqual([
      { id: 'draft-1', docTitle: 'Briefing', clientName: 'Acme' },
      { id: 'draft-2', docTitle: 'Untitled draft', clientName: null },
    ]);
  });

  test('creates editable, bounded text and never implies a document is attached', () => {
    const text = workspaceDocumentComposerText({
      id: 'document-1',
      name: 'Board memo',
      body: { blocks: [{ content: 'First paragraph.' }, { content: 'Second paragraph.' }] },
    });

    expect(text).toContain('Workspace document for review: Board memo');
    expect(text).toContain('First paragraph.\nSecond paragraph.');
    expect(text).not.toContain('attached');
  });

  test('rejects unreadable Workspace document shapes', () => {
    expect(workspaceDocumentComposerText({ id: 'document-1', name: 'Empty', body: { blocks: [] } })).toBeNull();
    expect(workspaceDocumentComposerText({ id: 'document-1', body: { blocks: [{ content: 'text' }] } })).toBeNull();
  });
});
