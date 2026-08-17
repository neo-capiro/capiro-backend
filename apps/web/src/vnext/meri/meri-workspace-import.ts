const MAX_WORKSPACE_IMPORT_CHARS = 12_000;

export interface MeriWorkspaceImportDraft {
  id: string;
  docTitle: string;
  clientName: string | null;
}

/**
 * Accept only the list envelope returned by Workspace's authenticated draft
 * endpoint. The browser may select a listed item but cannot supply its body.
 */
export function workspaceImportDraftsResponse(value: unknown): MeriWorkspaceImportDraft[] {
  if (!value || typeof value !== 'object') return [];
  const drafts = (value as { drafts?: unknown }).drafts;
  if (!Array.isArray(drafts)) return [];
  return drafts.flatMap((draft): MeriWorkspaceImportDraft[] => {
    if (!draft || typeof draft !== 'object') return [];
    const row = draft as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.docTitle !== 'string') return [];
    return [
      {
        id: row.id,
        docTitle: row.docTitle,
        clientName: typeof row.client === 'string' ? row.client : null,
      },
    ];
  });
}

/**
 * Projects Workspace's document response into clearly editable composer text.
 * It is bounded, never auto-sent, and explicitly does not claim a durable
 * attachment or active context was created.
 */
export function workspaceDocumentComposerText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name.trim()) {
    return null;
  }
  const body = row.body;
  const blocks = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { blocks?: unknown }).blocks
    : null;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { content?: unknown }).content === 'string'
        ? (block as { content: string }).content.trim()
        : '',
    )
    .filter(Boolean)
    .join('\n');
  if (!text) return null;

  const bounded = text.length > MAX_WORKSPACE_IMPORT_CHARS
    ? `${text.slice(0, MAX_WORKSPACE_IMPORT_CHARS).trimEnd()}\n…[truncated]`
    : text;
  return `Workspace document for review: ${row.name.trim()}\n\n${bounded}\n\nReview this material before relying on it.`;
}

export { MAX_WORKSPACE_IMPORT_CHARS };
