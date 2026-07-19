/**
 * Folder selection for the widened Microsoft 365 mail sync.
 *
 * The sync used to cover only inbox + sentitems, which made every message a
 * user filed into a client subfolder (or Archive) invisible to Capiro — the
 * root cause of a real "Meri can't find my email" incident. The sync now
 * enumerates the mailbox's folder tree and syncs everything EXCEPT the noise
 * well-known folders (junk, deleted, drafts, outbox, conversation history)
 * and their descendants. This module is the pure, unit-testable selection
 * logic; the Graph fetching lives in MicrosoftGraphSyncService.
 */

export interface GraphMailFolder {
  id?: string | null;
  displayName?: string | null;
  parentFolderId?: string | null;
  childFolderCount?: number | null;
  totalItemCount?: number | null;
}

export interface SyncableMailFolder {
  /**
   * sync_state key. 'inbox' / 'sentitems' keep their legacy well-known-name
   * keys (so existing delta links survive the upgrade with no re-backfill);
   * every other folder is keyed by its Graph folder id.
   */
  key: string;
  /** Path segment for `/me/mailFolders('<segment>')/messages/delta` (URL-encoded). */
  pathSegment: string;
  /** Human-readable folder path ("Clients/Olivet") — stored in message metadata. */
  displayPath: string;
}

/** Ceiling on synced folders per mailbox — beyond this we keep the fullest. */
export const MAX_SYNCED_MAIL_FOLDERS = 100;

/**
 * Pick the dynamic (non-legacy) folders to sync from a full folder-tree
 * enumeration. Exclusions:
 *  - the noise roots (junk/deleted/drafts/outbox/conversation history) and
 *    every descendant of one;
 *  - the inbox and sentitems NODES themselves (legacy keys sync those two) —
 *    but NOT their descendants: an "Inbox/Clients/Olivet" subfolder is its own
 *    message collection with its own delta stream and must be included;
 *  - folders with zero direct items (they enter on a later enumeration once
 *    they hold mail — item counts are per-folder, not subtree).
 * Beyond `cap`, the fullest folders win and the drop count is reported so the
 * caller can log it (no silent truncation).
 */
export function selectSyncableFolders(input: {
  all: GraphMailFolder[];
  noiseRootIds: Array<string | null | undefined>;
  inboxId: string | null;
  sentItemsId: string | null;
  cap?: number;
}): { folders: SyncableMailFolder[]; dropped: number } {
  const cap = input.cap ?? MAX_SYNCED_MAIL_FOLDERS;
  const byId = new Map<string, GraphMailFolder>();
  for (const folder of input.all) {
    if (folder.id) byId.set(folder.id, folder);
  }
  const noise = new Set(input.noiseRootIds.filter((id): id is string => Boolean(id)));

  // A folder is noise if any ancestor (or itself) is a noise root. Walk the
  // parent chain with a visited guard (defensive against cyclic data).
  const underNoise = (folder: GraphMailFolder): boolean => {
    const seen = new Set<string>();
    let current: GraphMailFolder | undefined = folder;
    while (current?.id && !seen.has(current.id)) {
      if (noise.has(current.id)) return true;
      seen.add(current.id);
      current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
    }
    return false;
  };

  const displayPath = (folder: GraphMailFolder): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let current: GraphMailFolder | undefined = folder;
    while (current?.id && !seen.has(current.id)) {
      parts.unshift((current.displayName ?? '').trim() || '(unnamed)');
      seen.add(current.id);
      current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
    }
    return parts.join('/');
  };

  const eligible = input.all.filter((folder) => {
    if (!folder.id) return false;
    if (folder.id === input.inboxId || folder.id === input.sentItemsId) return false;
    if ((folder.totalItemCount ?? 0) === 0) return false;
    if (underNoise(folder)) return false;
    return true;
  });

  // Deterministic order; when the cap bites, the fullest folders survive.
  const sorted = [...eligible].sort(
    (a, b) =>
      (b.totalItemCount ?? 0) - (a.totalItemCount ?? 0) ||
      displayPath(a).localeCompare(displayPath(b)),
  );
  const kept = sorted.slice(0, cap);
  return {
    folders: kept.map((folder) => ({
      key: folder.id!,
      pathSegment: encodeURIComponent(folder.id!),
      displayPath: displayPath(folder),
    })),
    dropped: sorted.length - kept.length,
  };
}
