import { describe, expect, test } from 'vitest';
import {
  mayApplyWorkspaceImportResponse,
  workspaceDocumentComposerText,
  workspaceImportDocumentsResponse,
  workspaceImportDraftsResponse,
} from './meri-workspace-import.js';

describe('workspace import helpers', () => {
  test('only accepts an import response for the active tenant/user identity', () => {
    expect(mayApplyWorkspaceImportResponse('tenant-a:user-a', 'tenant-a:user-a')).toBe(true);
    expect(mayApplyWorkspaceImportResponse('tenant-a:user-a', 'tenant-b:user-a')).toBe(false);
    expect(mayApplyWorkspaceImportResponse('tenant-a:user-a', 'tenant-a:user-b')).toBe(false);
  });

  test('normalizes authorized draft choices from either the direct Workspace array or bridge envelope', () => {
    const drafts = [
      { id: 'draft-1', docTitle: 'Briefing', client: 'Acme' },
      { id: 'draft-2', docTitle: 'Untitled draft', client: null },
      { id: 'missing-title' },
    ];
    const expected = [
      { id: 'draft-1', docTitle: 'Briefing', clientName: 'Acme' },
      { id: 'draft-2', docTitle: 'Untitled draft', clientName: null },
    ];

    expect(workspaceImportDraftsResponse(drafts)).toEqual(expected);
    expect(workspaceImportDraftsResponse({ drafts })).toEqual(expected);
  });

  test('normalizes the authorized names-only document list', () => {
    expect(
      workspaceImportDocumentsResponse([
        { id: 'document-1', name: 'Board memo' },
        { id: 'missing-name' },
      ]),
    ).toEqual([{ id: 'document-1', name: 'Board memo' }]);
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
