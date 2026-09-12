const MAX_WORKSPACE_IMPORT_CHARS = 12_000;

/** A delayed response may only mutate import state for its initiating identity. */
export function mayApplyWorkspaceImportResponse(
  requestIdentityKey: string,
  activeIdentityKey: string,
): boolean {
  return requestIdentityKey === activeIdentityKey;
}

export interface MeriWorkspaceImportDraft {
  id: string;
  docTitle: string;
  clientName: string | null;
}

/**
 * Accepts both direct Workspace controller arrays and the vNext transport
 * bridge's `{ drafts }` normalization. The browser selects only records the
 * authenticated Workspace API returned; it never supplies document bodies.
 */
export function workspaceImportDraftsResponse(value: unknown): MeriWorkspaceImportDraft[] {
  const drafts = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { drafts?: unknown }).drafts)
      ? (value as { drafts: unknown[] }).drafts
      : [];
  return drafts.flatMap((draft): MeriWorkspaceImportDraft[] => {
    if (!draft || typeof draft !== 'object') return [];
    const row = draft as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.docTitle !== 'string') return [];
    return [
      {
        id: row.id,
        docTitle: row.docTitle,
        clientName:
          typeof row.client === 'string'
            ? row.client
            : typeof row.clientName === 'string'
              ? row.clientName
              : null,
      },
    ];
  });
}

/** The import chooser exposes only authorized document names, never bodies. */
export function workspaceImportDocumentsResponse(value: unknown): Array<{ id: string; name: string }> {
  const documents = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { documents?: unknown }).documents)
      ? (value as { documents: unknown[] }).documents
      : [];
  return documents.flatMap((document): Array<{ id: string; name: string }> => {
    if (!document || typeof document !== 'object') return [];
    const row = document as Record<string, unknown>;
    return typeof row.id === 'string' && typeof row.name === 'string'
      ? [{ id: row.id, name: row.name }]
      : [];
  });
}

const BLOCK_BREAK = /<\/(?:p|div|h[1-6]|li|tr|blockquote|section)\s*>|<br\s*\/?>/gi;

/** Workspace stores block content as HTML; the composer takes text. */
function htmlToPlainText(html: string): string {
  return html
    .replace(BLOCK_BREAK, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[^\S\n]?\n[^\S\n]?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Fallback for a Workspace service that predates the server-side projection. */
function blocksPlainText(body: unknown): string {
  const blocks =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as { blocks?: unknown }).blocks
      : null;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { content?: unknown }).content === 'string'
        ? htmlToPlainText((block as { content: string }).content)
        : '',
    )
    .filter(Boolean)
    .join('\n');
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
  const text = typeof row.text === 'string' ? row.text.trim() : blocksPlainText(row.body);
  if (!text) return null;

  const bounded = text.length > MAX_WORKSPACE_IMPORT_CHARS
    ? `${text.slice(0, MAX_WORKSPACE_IMPORT_CHARS).trimEnd()}\n…[truncated]`
    : text;
  return `Workspace document for review: ${row.name.trim()}\n\n${bounded}\n\nReview this material before relying on it.`;
}

export { MAX_WORKSPACE_IMPORT_CHARS };
