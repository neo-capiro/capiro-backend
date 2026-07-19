import { selectSyncableFolders, type GraphMailFolder } from './microsoft-mail-folders.util.js';

/**
 * Unit tests for the widened M365 mail-folder selection: noise roots and their
 * descendants excluded, inbox/sentitems NODES excluded but their descendants
 * kept (client subfolders under Inbox were the whole point), empty folders
 * skipped, display paths built from the parent chain, ids URL-encoded, and the
 * cap keeping the fullest folders with an explicit dropped count.
 */

function f(id: string, displayName: string, opts: Partial<GraphMailFolder> = {}): GraphMailFolder {
  return { id, displayName, parentFolderId: null, childFolderCount: 0, totalItemCount: 5, ...opts };
}

const INBOX = f('id-inbox', 'Inbox', { childFolderCount: 2, totalItemCount: 900 });
const SENT = f('id-sent', 'Sent Items', { totalItemCount: 400 });
const JUNK = f('id-junk', 'Junk Email', { totalItemCount: 50 });
const DELETED = f('id-del', 'Deleted Items', { childFolderCount: 1, totalItemCount: 80 });

describe('selectSyncableFolders', () => {
  it('excludes noise roots and every descendant of one, but keeps inbox descendants', () => {
    const all: GraphMailFolder[] = [
      INBOX,
      SENT,
      JUNK,
      DELETED,
      f('id-del-sub', 'Old Stuff', { parentFolderId: 'id-del' }),
      f('id-clients', 'Clients', { parentFolderId: 'id-inbox', childFolderCount: 1 }),
      f('id-olivet', 'Olivet', { parentFolderId: 'id-clients' }),
      f('id-archive', 'Archive', { totalItemCount: 1200 }),
    ];
    const { folders, dropped } = selectSyncableFolders({
      all,
      noiseRootIds: ['id-junk', 'id-del'],
      inboxId: 'id-inbox',
      sentItemsId: 'id-sent',
    });
    const keys = folders.map((x) => x.key);
    expect(keys).toContain('id-archive');
    expect(keys).toContain('id-clients');
    expect(keys).toContain('id-olivet');
    expect(keys).not.toContain('id-inbox'); // legacy key covers it
    expect(keys).not.toContain('id-sent');
    expect(keys).not.toContain('id-junk');
    expect(keys).not.toContain('id-del-sub'); // descendant of a noise root
    expect(dropped).toBe(0);
  });

  it('builds human display paths from the parent chain and URL-encodes ids', () => {
    const all = [
      INBOX,
      f('id/clients', 'Clients', { parentFolderId: 'id-inbox', childFolderCount: 1 }),
      f('id+olivet=', 'Olivet', { parentFolderId: 'id/clients' }),
    ];
    const { folders } = selectSyncableFolders({
      all,
      noiseRootIds: [],
      inboxId: 'id-inbox',
      sentItemsId: null,
    });
    const olivet = folders.find((x) => x.key === 'id+olivet=');
    expect(olivet).toBeDefined();
    expect(olivet!.displayPath).toBe('Inbox/Clients/Olivet');
    expect(olivet!.pathSegment).toBe(encodeURIComponent('id+olivet='));
  });

  it('skips folders with zero direct items (they join once they hold mail)', () => {
    const all = [f('id-empty', 'Empty', { totalItemCount: 0 }), f('id-full', 'Full')];
    const { folders } = selectSyncableFolders({
      all,
      noiseRootIds: [],
      inboxId: null,
      sentItemsId: null,
    });
    expect(folders.map((x) => x.key)).toEqual(['id-full']);
  });

  it('keeps the fullest folders under the cap and reports the drop count', () => {
    const all = [
      f('id-a', 'A', { totalItemCount: 300 }),
      f('id-b', 'B', { totalItemCount: 200 }),
      f('id-c', 'C', { totalItemCount: 100 }),
    ];
    const { folders, dropped } = selectSyncableFolders({
      all,
      noiseRootIds: [],
      inboxId: null,
      sentItemsId: null,
      cap: 2,
    });
    expect(folders.map((x) => x.key)).toEqual(['id-a', 'id-b']);
    expect(dropped).toBe(1);
  });

  it('tolerates missing noise ids (404ed well-known folders) and cyclic parent data', () => {
    const cyclicA = f('id-x', 'X', { parentFolderId: 'id-y' });
    const cyclicB = f('id-y', 'Y', { parentFolderId: 'id-x' });
    const { folders } = selectSyncableFolders({
      all: [cyclicA, cyclicB],
      noiseRootIds: [null, undefined],
      inboxId: null,
      sentItemsId: null,
    });
    expect(folders).toHaveLength(2); // no infinite walk, nothing excluded
  });
});
