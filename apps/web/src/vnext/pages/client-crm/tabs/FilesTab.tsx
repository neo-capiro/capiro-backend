import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type { Client, ClientAttachment } from '../../../../pages/clients/clientTypes.js';
import {
  GRADIENT_DARK,
  PfButton,
  Pill,
  TabPageHead,
  UIcon,
  type PillTone,
} from '../portfolio-primitives.js';
import { MoveToFolderModal, type FolderNode } from '../portfolio-overlays.js';
import { openMeriWorkspaceWithContext } from '../../../../components/chat/meri-window.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import {
  clientAccountOwnerLabel,
  type ClientAccountOwner,
} from '../useClientAccountOwner.js';
import { FILES, FOLDERS } from '../portfolio-fixtures.js';
import { CLIENT_STORAGE_QUOTA_BYTES, CLIENT_STORAGE_WARN_THRESHOLD } from '@capiro/shared';

/**
 * Files tab (spec §11, Figma geometry from `dom-tab-files.txt`).
 *
 * Data binding:
 *  - The file list reuses the canonical attachments query
 *    (`['client-attachments', client.id]` — same key as the profile, so
 *    uploads invalidate both surfaces). When the service returns rows they
 *    are mapped onto the design's row shape; while loading or on error, the
 *    design's FILES fixture renders so the surface stays pixel-reviewable
 *    (flagged UI-only). Once the query resolves and the client genuinely has
 *    no attachments, a real empty state renders instead — the fixture is a
 *    loading placeholder, never a stand-in for "no data".
 *  - Upload, move, and delete port the same presign → S3 → confirm and
 *    folder-PATCH pipeline the canonical `ClientCrmFiles` surface uses
 *    (same query key, so both invalidate together and no second copy of the
 *    stored object is ever created).
 *  - The folder tree and its counts are real (wire-audit "3 Compose extend"
 *    items 2-3): `GET /api/clients/:id/files/folders` groups the client's
 *    attachments by folder, so every row is a folder that genuinely holds
 *    files, plus Unfiled. Folders in this product are labels on attachments —
 *    there is no folder table and no nesting — so the tree renders one flat
 *    level under the client root rather than inventing a hierarchy. The
 *    FOLDERS fixture renders only while that query is loading or errored.
 *  - "New folder" therefore cannot create an empty folder server-side. It
 *    either files the current selection into the new label (a real move
 *    PATCH, which is what makes the folder exist) or opens a draft folder you
 *    can upload into — labelled as such until a file lands in it.
 *  - Client storage is REAL on both halves: used bytes are the sum of every
 *    attachment's stored `byteSize`, and the denominator is the product's
 *    per-client allowance (`CLIENT_STORAGE_QUOTA_BYTES`, @capiro/shared) so the
 *    API can enforce the same number. It is REPORTED, not enforced — nothing
 *    rejects an upload for exceeding the total today — so the meter warns at
 *    80% and states an overage rather than blocking.
 *  - The smart-link provenance copy is designed UI (§11).
 *  - "Create with Meri" opens the real Meri workspace scoped to this client;
 *    no skill generates a file directly into client files (wire-audit "4 New
 *    capability" row 4).
 *  - The design's `All source links healthy` pill is GONE: nothing checks
 *    whether a smart link still resolves, so it asserted a health it never
 *    measured (row 3).
 */

const MAX_BYTES = 25 * 1024 * 1024;

interface UploadState {
  name: string;
  status: 'uploading' | 'failed';
  message?: string;
}

/* ── view models ──────────────────────────────────────────────────────────── */

interface FileRowModel {
  id: string;
  ext: string;
  name: string;
  smart: boolean;
  /** True for Meri-generated artifacts (memo/generated sources). */
  generated: boolean;
  linked: string;
  modified: string;
  modifiedTs: number;
  owner: string;
  status: string;
  tone: PillTone;
  /** Fixture folder id, or the real folder label for attachments. */
  folder: string | null;
  /** Present only for real attachments — lets the row open/download the file. */
  downloadUrl: string | null;
  /** View ACL. Default 'all' = every team member. */
  viewerMode: 'all' | 'restricted';
  viewerUserIds: string[];
}

type FilterKey = 'all' | 'documents' | 'smart' | 'client' | 'meri';
type SortKey = 'modified' | 'name' | 'owner';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'documents', label: 'Documents' },
  { key: 'smart', label: 'Smart links' },
  { key: 'client', label: 'Client uploads' },
  { key: 'meri', label: 'Meri artifacts' },
];

const SORT_LABEL: Record<SortKey, string> = { modified: 'Modified', name: 'Name', owner: 'Owner' };
const SORT_NEXT: Record<SortKey, SortKey> = { modified: 'name', name: 'owner', owner: 'modified' };

const TONE_OF: Record<string, PillTone> = {
  gray: 'gray',
  brand: 'brand',
  blue: 'blue',
  error: 'error',
  warning: 'warning',
  success: 'success',
};
const toneOf = (ui: string): PillTone => TONE_OF[ui] ?? 'gray';

/** FOLDERS rows optionally carry kids/open — widen the union for access. */
type FolderFixture = (typeof FOLDERS)[number] & { kids?: boolean; open?: boolean };

/** What `GET /api/clients/:id/files/folders` returns (ClientFilesService.folders). */
interface FolderGroup {
  folder: string | null;
  count: number;
}

/** A row in the folder tree, real or fixture. */
interface FolderTreeNode {
  id: string;
  label: string;
  count: number;
  subs: number;
  depth: number;
  kids?: boolean;
  open?: boolean;
  crumb: string;
  /**
   * The attachment folder this row scopes to: a real label, or `null` for
   * Unfiled. `undefined` on the root row, which scopes to everything.
   */
  folder?: string | null;
  /** Named in this session but not yet persisted — no file carries the label. */
  draft?: boolean;
}

/** Folder labels are free text; the backend never case-folds, so neither do we
 *  when comparing — but a duplicate that differs only in case is still a
 *  duplicate to a human, so name checks use this. */
const sameFolder = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Cannot collide with a real label: the backend trims, so this is unreachable. */
const UNFILED_ID = '  unfiled  ';
/** Matches the `@MaxLength(120)` on the move DTO. */
const FOLDER_NAME_MAX = 120;

/** Binary units, matching how storage is quoted everywhere else in this app. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return '<1 MB';
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function fixtureTree(): FolderTreeNode[] {
  return (FOLDERS as FolderFixture[]).map((f) => ({
    id: f.id,
    label: f.label,
    count: f.count,
    subs: f.subs,
    depth: f.depth,
    ...(f.kids === undefined ? {} : { kids: f.kids }),
    ...(f.open === undefined ? {} : { open: f.open }),
    crumb: f.crumb,
    // Fixture rows below the root also scope real attachments by label, which
    // is what the tab did before the tree was real.
    ...(f.id === 'root' ? {} : { folder: f.label }),
  }));
}

/* ── fixture + real-row mapping ───────────────────────────────────────────── */

function fixtureRow(f: (typeof FILES)[number] & { smart?: boolean }): FileRowModel {
  return {
    id: f.id,
    ext: f.ext,
    name: f.name,
    smart: Boolean(f.smart),
    generated: f.owner === 'Meri',
    linked: f.linked,
    modified: f.modified,
    modifiedTs: 0,
    owner: f.owner,
    status: f.status,
    tone: toneOf(f.ui),
    folder: f.folder,
    downloadUrl: null,
    viewerMode: 'all',
    viewerUserIds: [],
  };
}

function extOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0 || idx === fileName.length - 1) return 'FILE';
  return fileName.slice(idx + 1).toUpperCase().slice(0, 5);
}

function baseOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(0, idx) : fileName;
}

/** A file surfaced from another record rather than uploaded here directly. */
function isSmartSource(source: string | null | undefined): boolean {
  const value = (source ?? '').toLowerCase();
  return (
    value.startsWith('capability:') ||
    value.includes('meeting') ||
    value.includes('hearing') ||
    value.includes('strategy') ||
    value.includes('workspace') ||
    value.includes('outreach')
  );
}

function sourceLabel(source: string | null | undefined): string {
  const value = (source ?? '').toLowerCase();
  if (value.startsWith('capability:')) return 'Capability';
  if (value.includes('hearing')) return 'Hearing recap';
  if (value.includes('meeting')) return 'Meeting';
  if (value.includes('strategy')) return 'Strategy';
  if (value.includes('workspace')) return 'Workspace';
  if (value.includes('outreach')) return 'Outreach';
  if (value.includes('memo') || value.includes('generated')) return 'Generated';
  if (value.includes('mail') || value.includes('email')) return 'Email';
  return 'Uploaded';
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function attachmentRow(file: ClientAttachment): FileRowModel {
  const smart = isSmartSource(file.source);
  const folder = file.folder?.trim() ? file.folder.trim() : null;
  const sourceValue = (file.source ?? '').toLowerCase();
  return {
    id: file.id,
    ext: extOf(file.fileName),
    name: baseOf(file.fileName),
    smart,
    // Meri-generated artifacts are the real discriminator behind the "Meri
    // artifacts" filter chip — owner names never carry this fact.
    generated: /memo|generated/.test(sourceValue),
    linked: smart ? sourceLabel(file.source) : (folder ?? 'Unfiled'),
    modified: shortDate(file.createdAt),
    modifiedTs: Date.parse(file.createdAt) || 0,
    owner: file.uploadedByName?.split(' ')[0] ?? '—',
    status: file.indexedAt ? 'Indexed' : 'Uploaded',
    tone: file.indexedAt ? 'success' : 'gray',
    folder,
    downloadUrl: file.downloadUrl,
    viewerMode: file.viewerMode === 'restricted' ? 'restricted' : 'all',
    viewerUserIds: Array.isArray(file.viewerUserIds) ? file.viewerUserIds : [],
  };
}

/* ── narrow flag (spec §1.6: narrow = w<1200; flips filesCols to one column) ─ */

function usePfNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1199px)');
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return narrow;
}

/* ── the tab ──────────────────────────────────────────────────────────────── */

export function ClientCrmFilesProto({ client }: { client: Client }) {
  const api = useApi();
  const qc = useQueryClient();
  const narrow = usePfNarrow();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uploadFolderRef = useRef<string | null>(null);

  const [folderId, setFolderId] = useState<string>('root');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>('modified');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [moving, setMoving] = useState<{ ids: string[]; count: number } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [menuRowId, setMenuRowId] = useState<string | null>(null);
  /** Open with the ids to file into the new folder; `[]` creates a draft. */
  const [creatingFolder, setCreatingFolder] = useState<{ ids: string[] } | null>(null);
  /** Folders named here but not yet holding a file — see the file docblock. */
  const [draftFolders, setDraftFolders] = useState<string[]>([]);
  /**
   * Manage-access target. `kind: 'file'` opens for one attachment; `kind: 'folder'`
   * rewrites every attachment currently carrying that folder label.
   */
  const [accessTarget, setAccessTarget] = useState<
    | { kind: 'file'; id: string; name: string; viewerMode: 'all' | 'restricted'; viewerUserIds: string[] }
    | { kind: 'folder'; folder: string | null; name: string }
    | null
  >(null);

  const attachmentsKey = ['client-attachments', client.id];
  const foldersKey = ['client-file-folders', client.id];

  // Same key as the canonical profile surface — one shared cache entry.
  const filesQuery = useQuery<ClientAttachment[]>({
    queryKey: attachmentsKey,
    queryFn: async () =>
      (
        await api.get<ClientAttachment[]>('/api/engagement/attachments', {
          params: { clientId: client.id },
        })
      ).data,
  });

  // Real folder tree (item 2). Grouped server-side, so the counts are the
  // client's whole file room, not just the page of attachments in hand.
  const foldersQuery = useQuery<FolderGroup[]>({
    queryKey: foldersKey,
    queryFn: async () => (await api.get<FolderGroup[]>(`/api/clients/${client.id}/files/folders`)).data,
  });

  // Candidate viewers = every active tenant member (same options the account-owner
  // picker uses). Default ACL is "all members", so this list is only needed when
  // someone opens Manage access.
  const membersQ = useQuery<ClientAccountOwner[]>({
    queryKey: ['client-account-owner-options'],
    queryFn: async () =>
      (await api.get<ClientAccountOwner[]>('/api/client-account-owners/options')).data,
    staleTime: 5 * 60_000,
  });

  const setAccess = useMutation({
    mutationFn: async (input: {
      kind: 'file' | 'folder';
      id?: string;
      folder?: string | null;
      viewerMode: 'all' | 'restricted';
      viewerUserIds: string[];
    }) => {
      if (input.kind === 'file') {
        return (
          await api.patch(`/api/clients/${client.id}/files/${encodeURIComponent(input.id!)}/access`, {
            viewerMode: input.viewerMode,
            viewerUserIds: input.viewerUserIds,
          })
        ).data;
      }
      return (
        await api.patch(`/api/clients/${client.id}/files/access/folder`, {
          folder: input.folder ?? null,
          viewerMode: input.viewerMode,
          viewerUserIds: input.viewerUserIds,
        })
      ).data;
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: attachmentsKey }),
        qc.invalidateQueries({ queryKey: foldersKey }),
      ]);
      setAccessTarget(null);
    },
  });

  const loaded = filesQuery.data !== undefined && !filesQuery.isError;
  const real = loaded && filesQuery.data!.length > 0;
  const genuinelyEmpty = loaded && filesQuery.data!.length === 0;
  const realTree = foldersQuery.data !== undefined && !foldersQuery.isError;

  const move = useMutation({
    mutationFn: async ({ ids, folder }: { ids: string[]; folder: string | null }) => {
      await Promise.all(ids.map((id) => api.patch(`/api/clients/${client.id}/files/${id}/folder`, { folder })));
      return folder;
    },
    onSuccess: (folder) => {
      setMoving(null);
      setSelected(new Set());
      // The label now exists on real rows, so it is no longer a draft.
      if (folder) setDraftFolders((prev) => prev.filter((name) => !sameFolder(name, folder)));
      void qc.invalidateQueries({ queryKey: attachmentsKey });
      void qc.invalidateQueries({ queryKey: foldersKey });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/engagement/attachments/${id}`);
      return id;
    },
    onSuccess: (id) => {
      setDeletingId(null);
      // Prune the deleted id from the selection — a stale selected id would
      // make the next bulk move PATCH a file that no longer exists.
      setSelected((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      void qc.invalidateQueries({ queryKey: attachmentsKey });
      void qc.invalidateQueries({ queryKey: foldersKey });
    },
  });

  /**
   * The tree. Folders are labels on attachments — there is no folder table and
   * no nesting anywhere in this product (`ClientFilesService.folders` groups by
   * a single `folder` column; the move DTO takes one flat string) — so real
   * folders render as one level under the client root rather than as the
   * design's invented three-deep hierarchy. Unfiled appears only when files
   * are actually unfiled.
   */
  const folders: FolderTreeNode[] = useMemo(() => {
    if (!realTree) return fixtureTree();
    const groups = foldersQuery.data ?? [];
    const named = groups
      .filter((group): group is { folder: string; count: number } => Boolean(group.folder?.trim()))
      .map((group) => ({ label: group.folder.trim(), count: group.count, draft: false }));
    const drafts = draftFolders
      .filter((name) => !named.some((entry) => sameFolder(entry.label, name)))
      .map((name) => ({ label: name, count: 0, draft: true }));
    const children = [...named, ...drafts].sort((a, b) => a.label.localeCompare(b.label));
    const unfiled = groups.find((group) => !group.folder?.trim())?.count ?? 0;
    const total = groups.reduce((sum, group) => sum + group.count, 0);

    const rows: FolderTreeNode[] = [
      {
        id: 'root',
        label: client.name,
        count: total,
        subs: children.length,
        depth: 0,
        kids: children.length > 0,
        open: true,
        crumb: client.name,
      },
      ...children.map((entry) => ({
        id: entry.label,
        label: entry.label,
        count: entry.count,
        subs: 0,
        depth: 1,
        crumb: `${client.name} / ${entry.label}`,
        folder: entry.label,
        draft: entry.draft,
      })),
    ];
    if (unfiled > 0) {
      rows.push({
        id: UNFILED_ID,
        label: 'Unfiled',
        count: unfiled,
        subs: 0,
        depth: 1,
        crumb: `${client.name} / Unfiled`,
        folder: null,
      });
    }
    return rows;
  }, [realTree, foldersQuery.data, draftFolders, client.name]);

  const current = folders.find((f) => f.id === folderId) ?? folders[0]!;
  const folderNodes: FolderNode[] = folders
    .filter((f) => f.id !== 'root' && f.id !== UNFILED_ID)
    .map((f) => ({ label: f.label, depth: f.depth, count: f.count }));

  /**
   * Does a row belong to the selected folder? Fixture file rows carry fixture
   * folder ids; real attachments carry the folder label the backend stored.
   */
  /**
   * Filing a set of files. With no destination folder yet — a real
   * possibility now that the tree is real, and impossible when it was a
   * ten-folder fixture — a "move" modal would offer an empty list, so naming
   * the folder and filing into it becomes one step instead of a dead end.
   */
  const requestMove = (ids: string[]) => {
    if (folderNodes.length === 0) setCreatingFolder({ ids });
    else setMoving({ ids, count: ids.length });
  };

  const inCurrentFolder = useCallback(
    (row: FileRowModel): boolean => {
      if (current.id === 'root') return true;
      if (!real) return row.folder === current.id;
      if (current.folder === null) return row.folder === null;
      return (row.folder ?? '').toLowerCase() === (current.folder ?? '').toLowerCase();
    },
    [current, real],
  );

  const allRows: FileRowModel[] = useMemo(
    // Loading and error render their own states below — the FILES design
    // fixture never stands in for a client's real file room.
    () => (loaded ? (filesQuery.data ?? []).map(attachmentRow) : []),
    [loaded, filesQuery.data],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Search spans every folder (prototype behaviour); otherwise scope to the
    // selected folder — fixtures match on folder id, real attachments on the
    // folder label (the fixture tree is designed UI, §11).
    let shown = needle
      ? allRows.filter((row) => `${row.name} ${row.linked}`.toLowerCase().includes(needle))
      : allRows.filter(inCurrentFolder);
    if (filter === 'documents') shown = shown.filter((row) => !row.smart);
    else if (filter === 'smart') shown = shown.filter((row) => row.smart);
    else if (filter === 'client') shown = shown.filter((row) => !row.smart && !row.generated);
    else if (filter === 'meri') shown = shown.filter((row) => row.generated);
    if (sort === 'name') shown = [...shown].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'owner') shown = [...shown].sort((a, b) => a.owner.localeCompare(b.owner));
    else if (real) shown = [...shown].sort((a, b) => b.modifiedTs - a.modifiedTs);
    return shown;
  }, [allRows, query, filter, sort, real, inCurrentFolder]);

  // Real ids currently in view for this folder, ignoring search/filter — the
  // scope "Manage" reorganizes, same membership test the main list applies.
  const currentFolderIds = useMemo(
    () => (real ? allRows.filter(inCurrentFolder).map((row) => row.id) : []),
    [allRows, real, inCurrentFolder],
  );

  const smartCount = rows.filter((row) => row.smart).length;
  // Sum of every stored attachment for this client. Rows with a null byteSize
  // (older uploads whose size was never captured) contribute nothing rather
  // than being guessed at, so this is a floor, not an estimate.
  const storedBytes = useMemo(
    () => (filesQuery.data ?? []).reduce((total, file) => total + (file.byteSize ?? 0), 0),
    [filesQuery.data],
  );
  const storagePct = (storedBytes / CLIENT_STORAGE_QUOTA_BYTES) * 100;
  const storageWarn = storedBytes >= CLIENT_STORAGE_QUOTA_BYTES * CLIENT_STORAGE_WARN_THRESHOLD;
  const storageOver = storedBytes > CLIENT_STORAGE_QUOTA_BYTES;
  const allChecked = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const deletingRow = deletingId ? allRows.find((row) => row.id === deletingId) : undefined;

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((row) => row.id)));
  const pickFolder = (id: string) => {
    setFolderId(id);
    setSelected(new Set());
  };

  function triggerUpload(folder: string | null) {
    uploadFolderRef.current = folder;
    inputRef.current?.click();
  }

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const folder = uploadFolderRef.current;
    for (const file of Array.from(list)) {
      if (file.size > MAX_BYTES) {
        setUploads((previous) => [
          ...previous,
          { name: file.name, status: 'failed', message: 'Larger than the 25 MB limit' },
        ]);
        continue;
      }
      setUploads((previous) => [...previous, { name: file.name, status: 'uploading' }]);
      try {
        const contentType = file.type || 'application/octet-stream';
        const presigned = (
          await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
            '/api/engagement/attachments/upload-url',
            { clientId: client.id, fileName: file.name, contentType, contentLength: file.size },
          )
        ).data;
        const form = new FormData();
        Object.entries(presigned.fields).forEach(([key, value]) => form.append(key, String(value)));
        form.append('file', file);
        const response = await fetch(presigned.url, { method: 'POST', body: form });
        if (!response.ok) throw new Error('Storage rejected the upload');
        const attachment = (
          await api.post<ClientAttachment>('/api/engagement/attachments/confirm', {
            clientId: client.id,
            fileName: file.name,
            contentType,
            s3Key: presigned.s3Key,
          })
        ).data;
        if (folder) {
          await api.patch(`/api/clients/${client.id}/files/${attachment.id}/folder`, { folder });
          // A draft folder becomes real the moment a file carries its label.
          setDraftFolders((previous) => previous.filter((name) => !sameFolder(name, folder)));
        }
        setUploads((previous) => previous.filter((entry) => entry.name !== file.name));
      } catch (caught) {
        setUploads((previous) =>
          previous.map((entry) =>
            entry.name === file.name
              ? {
                  ...entry,
                  status: 'failed',
                  message: caught instanceof Error ? caught.message : 'Upload failed',
                }
              : entry,
          ),
        );
      }
    }
    void qc.invalidateQueries({ queryKey: attachmentsKey });
    void qc.invalidateQueries({ queryKey: foldersKey });
  }

  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = '';
        }}
      />

      <TabPageHead
        title="Client files"
        sub="A folder-based client file room for uploads, Capiro artifacts, and provenance-preserving smart references."
        actions={
          <>
            <PfButton variant="secondary" onClick={() => setCreatingFolder({ ids: [...selected] })}>
              New folder
            </PfButton>
            <PfButton variant="secondary" onClick={() => triggerUpload(null)}>
              Upload
            </PfButton>
            {/* Row 4, wire-audit "4 New capability": no skill generates a file
                INTO client files, so this opens the real Meri workspace scoped
                to the client instead of pretending to produce one here. Same
                shape as the overflow menu's "Ask Meri about this client". The
                prompt is required — Meri drops a clientId that arrives
                without one. */}
            <PfButton
              variant="primary"
              onClick={() =>
                openMeriWorkspaceWithContext({
                  prompt: `Draft a document for ${client.name} and save it to the client's files.`,
                  clientId: client.id,
                })
              }
            >
              Create with Meri
            </PfButton>
          </>
        }
      />

      {uploads.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {uploads.map((entry) => (
            <div
              key={entry.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 16px',
                borderRadius: 8,
                background: entry.status === 'failed' ? '#FEF3F2' : '#FAF9F6',
                border: entry.status === 'failed' ? '1px solid #FECDCA' : '1px solid #E8E5DF',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.name}
              </span>
              <span style={{ flex: '0 0 auto', fontSize: 13, color: entry.status === 'failed' ? '#B42318' : '#667085' }}>
                {entry.status === 'uploading' ? 'Uploading…' : entry.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 40,
            padding: '0 12px',
            flex: 1,
            minWidth: 220,
            maxWidth: 360,
            borderRadius: 8,
            background: '#ffffff',
            border: '1px solid #E0DCD4',
            boxShadow: '0px 1px 2px rgba(16,24,40,.05)',
          }}
        >
          <UIcon name="SearchLg" size={18} color="#667085" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files"
            aria-label="Search files"
            style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', fontSize: 14, color: '#101828' }}
          />
        </div>
        {FILTERS.map((chip) => (
          <FilterChip key={chip.key} label={chip.label} active={filter === chip.key} onClick={() => setFilter(chip.key)} />
        ))}
        <span style={{ flex: 1 }} />
        <SortButton label={`Sort ${SORT_LABEL[sort]}`} onClick={() => setSort(SORT_NEXT[sort])} />
      </div>

      {/* selection bar */}
      {selected.size > 0 ? (
        <div
          className="cap-pf-anim-rise"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 18px',
            borderRadius: 10,
            background: '#F2F0EB',
            border: '1px solid #E0DCD4',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: '#101828' }}>{`${selected.size} selected`}</span>
          <span style={{ flex: 1 }} />
          <PfButton
            variant="primary"
            size="sm"
            onClick={() => requestMove([...selected])}
          >
            Move to folder
          </PfButton>
          <PfButton variant="link" onClick={() => setSelected(new Set())}>
            Clear
          </PfButton>
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? 'minmax(0,1fr)' : '300px minmax(0,1fr)',
          gap: 24,
          alignItems: 'start',
        }}
      >
        {/* folder tree card (FOLDERS fixture — designed UI, §11) */}
        <section
          style={{
            background: '#ffffff',
            borderRadius: 12,
            boxShadow: '0 0 0 1px #E8E5DF,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px rgba(16,24,40,.06)',
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px 14px' }}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '.04em',
                textTransform: 'uppercase',
                color: '#667085',
              }}
            >
              Folders
            </span>
            <PfButton
              variant="link"
              style={{ fontSize: 13 }}
              disabled={current.id === 'root' || current.folder === undefined}
              onClick={() => {
                if (current.id === 'root' || current.folder === undefined) return;
                setAccessTarget({
                  kind: 'folder',
                  folder: current.folder,
                  name: current.label,
                });
              }}
              title={
                current.id === 'root'
                  ? 'Pick a folder first — All files is not a single access scope'
                  : 'Choose who on the team can view files in this folder'
              }
            >
              Access
            </PfButton>
            <PfButton
              variant="link"
              style={{ fontSize: 13 }}
              disabled={currentFolderIds.length === 0}
              onClick={() => requestMove(currentFolderIds)}
            >
              Manage
            </PfButton>
          </div>
          <div style={{ padding: '0 10px 12px' }}>
            {folders.map((folder) => (
              <FolderTreeRow key={folder.id} folder={folder} active={folder.id === folderId} onPick={() => pickFolder(folder.id)} />
            ))}
          </div>
          <div style={{ padding: '16px 20px 20px', borderTop: '1px solid #E8E5DF' }}>
            <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
              Client storage
            </div>
{/* Both halves are now real. The numerator is the sum of every stored
                `byteSize` for this client — the list endpoint has no pagination,
                so it is the whole file room rather than a page, and rows whose
                size was never captured contribute nothing rather than being
                guessed at (so this is a floor, not an estimate). The
                denominator is the product's per-client allowance,
                `CLIENT_STORAGE_QUOTA_BYTES` in @capiro/shared, which the API can
                enforce against the same value when enforcement is wanted.

                Reported, not enforced: nothing today rejects an upload for
                exceeding the total (the per-FILE cap, MAX_ATTACHMENT_BYTES, IS
                enforced at presign). The meter therefore warns and can read
                over 100% rather than blocking.

                The fixture branch keeps the design's exact geometry — it is
                what the offline capture harness diffs against the Figma frame,
                and it is a loading placeholder, never a claim about a client. */}
            {loaded ? (
              <>
                <div style={{ marginTop: 6, fontSize: 16, fontWeight: 600, color: storageOver ? '#B54708' : '#101828' }}>
                  {`${formatBytes(storedBytes)} of ${formatBytes(CLIENT_STORAGE_QUOTA_BYTES)}`}
                </div>
                <span style={{ display: 'block', marginTop: 8, height: 6, borderRadius: 3, background: '#F2F0EB', overflow: 'hidden' }}>
                  <span
                    style={{
                      display: 'block',
                      height: 6,
                      // Clamped so an over-quota client cannot overflow the
                      // track — the copy below is what states the overage.
                      width: `${Math.min(100, storagePct)}%`,
                      borderRadius: 3,
                      background: storageOver ? '#F79009' : GRADIENT_DARK,
                    }}
                  />
                </span>
                <div style={{ marginTop: 6, fontSize: 13, color: storageWarn ? '#B54708' : '#667085' }}>
                  {storageOver
                    ? `Over the ${formatBytes(CLIENT_STORAGE_QUOTA_BYTES)} allowance · ${allRows.length} file${allRows.length === 1 ? '' : 's'}`
                    : `${storagePct < 1 ? '<1' : Math.round(storagePct)}% used · ${allRows.length} file${allRows.length === 1 ? '' : 's'}`}
                </div>
              </>
            ) : (
              <>
                {/* Loading/error: no invented "1.8 GB of 10 GB" — an empty track
                    until the real total is known. */}
                <div style={{ marginTop: 6, fontSize: 16, fontWeight: 600, color: '#98A2B3' }} aria-busy={filesQuery.isPending}>
                  {filesQuery.isPending ? 'Measuring…' : 'Storage unavailable'}
                </div>
                <span style={{ display: 'block', marginTop: 8, height: 6, borderRadius: 3, background: '#F2F0EB' }} />
              </>
            )}
            <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: '19px', color: '#667085', textWrap: 'pretty' }}>
              Smart links point to the original Strategy, meeting, Workspace, or Outreach object — no duplicate file is
              created.
            </p>
          </div>
        </section>

        {/* file table card */}
        <section
          style={{
            background: '#ffffff',
            borderRadius: 12,
            boxShadow: '0 0 0 1px #E8E5DF,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px rgba(16,24,40,.06)',
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 24px 16px' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: '.04em',
                  textTransform: 'uppercase',
                  color: '#667085',
                }}
              >
                {current.crumb}
              </span>
              <span style={{ display: 'block', marginTop: 6, fontSize: 20, fontWeight: 600, color: '#101828' }}>
                {current.label}
              </span>
              <span style={{ display: 'block', marginTop: 3, fontSize: 14, color: '#475467' }}>
                {/* Subfolder count only where there are subfolders — real
                    folders never nest, so "0 subfolders" on every row would be
                    noise about a hierarchy this product does not have. */}
                {current.draft
                  ? 'Draft folder · upload or move a file here to create it'
                  : `${current.count} file${current.count === 1 ? '' : 's'}${current.subs > 0 ? ` · ${current.subs} subfolders` : ''}`}
              </span>
            </span>
            <PfButton
              variant="secondary"
              size="sm"
              style={{ flex: '0 0 auto' }}
              // `current.folder` is undefined at the root and null on Unfiled —
              // both mean "file it nowhere", which is what the backend's null is.
              onClick={() => triggerUpload(current.folder ?? null)}
            >
              Upload here
            </PfButton>
          </div>

          <div style={{ width: '100%', overflowX: 'auto' }}>
            <div style={{ minWidth: 820 }}>
              {/* header row */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '10px 24px',
                  background: '#FAF9F6',
                  borderTop: '1px solid #E8E5DF',
                  borderBottom: '1px solid #E8E5DF',
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: '.04em',
                  textTransform: 'uppercase',
                  color: '#667085',
                }}
              >
                <Checkbox checked={allChecked} onToggle={toggleAll} ariaLabel="Select all files" />
                <span style={{ flex: 1, minWidth: 0 }}>Name</span>
                <span style={{ flex: '0 0 auto', width: 196 }}>Linked to / location</span>
                <span style={{ flex: '0 0 auto', width: 84 }}>Modified</span>
                <span style={{ flex: '0 0 auto', width: 84 }}>Owner</span>
                <span style={{ flex: '0 0 auto', width: 112 }}>Status</span>
                <span style={{ flex: '0 0 auto', width: 28 }} />
              </div>

              {filesQuery.isPending ? (
                <div style={{ padding: '24px', fontSize: 14, color: '#667085' }} aria-busy="true">
                  Loading files…
                </div>
              ) : filesQuery.isError ? (
                <div style={{ padding: '24px', fontSize: 14 }}>
                  <span style={{ color: '#B42318' }}>Files could not be loaded.</span>{' '}
                  <button
                    type="button"
                    onClick={() => void filesQuery.refetch()}
                    style={{ fontWeight: 600, color: '#101828', textDecoration: 'underline', cursor: 'pointer' }}
                  >
                    Retry
                  </button>
                </div>
              ) : rows.length === 0 ? (
                <div style={{ padding: '24px', fontSize: 14, color: '#667085' }}>
                  {allRows.length === 0 ? 'No files uploaded yet.' : 'No files match this view.'}
                </div>
              ) : (
                rows.map((row, i) => (
                  <FileRow
                    key={row.id}
                    row={row}
                    real={real}
                    checked={selected.has(row.id)}
                    bg={selected.has(row.id) ? '#F2F0EB' : i % 2 === 1 ? '#FAF9F6' : '#ffffff'}
                    menuOpen={menuRowId === row.id}
                    onToggle={() => toggleRow(row.id)}
                    onToggleMenu={() => setMenuRowId((prev) => (prev === row.id ? null : row.id))}
                    onCloseMenu={() => setMenuRowId(null)}
                    onRequestMove={() => {
                      setMenuRowId(null);
                      requestMove([row.id]);
                    }}
                    onRequestAccess={() => {
                      setMenuRowId(null);
                      setAccessTarget({
                        kind: 'file',
                        id: row.id,
                        name: row.name,
                        viewerMode: row.viewerMode,
                        viewerUserIds: row.viewerUserIds,
                      });
                    }}
                    onRequestDelete={() => {
                      setMenuRowId(null);
                      setDeletingId(row.id);
                    }}
                  />
                ))
              )}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 24px',
              background: '#FAF9F6',
              borderTop: '1px solid #E8E5DF',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 14, color: '#475467' }}>{`${rows.length} files · ${smartCount} smart links`}</span>
            <span style={{ flex: 1 }} />
            {/* Row 3, wire-audit "4 New capability": "All source links healthy"
                was a designed pill with NO link-health backend — nothing checks
                whether a smart link still resolves, so it asserted a health it
                never measured. Removed rather than left claiming green. */}
          </div>
        </section>
      </div>

      {moving ? (
        <MoveToFolderModal
          count={moving.count}
          folders={folderNodes}
          initial={current.folder !== undefined && current.id !== 'root' ? current.folder : undefined}
          pending={move.isPending}
          {...(move.isError
            ? {
                error:
                  move.error instanceof Error
                    ? `The move failed — nothing was changed. ${move.error.message}`
                    : 'The move failed — nothing was changed.',
              }
            : {})}
          onClose={() => {
            move.reset();
            setMoving(null);
          }}
          onMove={(dest) => move.mutate({ ids: moving.ids, folder: dest })}
        />
      ) : null}

      <NewFolderModal
        open={Boolean(creatingFolder)}
        existing={folderNodes.map((f) => f.label)}
        selectedCount={creatingFolder?.ids.length ?? 0}
        onClose={() => setCreatingFolder(null)}
        onCreate={async (name) => {
          // Filing files is what makes the folder exist server-side; with none
          // to file there is no write to make yet, so the folder is a draft
          // until something lands in it.
          const ids = creatingFolder?.ids ?? [];
          if (ids.length > 0) await move.mutateAsync({ ids, folder: name });
          else setDraftFolders((previous) => [...previous, name]);
          setFolderId(name);
          setCreatingFolder(null);
        }}
      />

      <CapiroModal open={Boolean(deletingId)} title="Delete file" onClose={() => setDeletingId(null)}>
        <p style={{ margin: 0, fontSize: 14, color: '#475467' }}>
          Delete <strong>{deletingRow?.name}</strong>? Anything linking to it loses the reference. This cannot be undone.
        </p>
        {remove.isError ? (
          <p style={{ margin: '8px 0 0', fontSize: 14, color: '#B42318' }}>
            {remove.error instanceof Error ? remove.error.message : 'Delete failed'}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <CapiroButton
            variant="primary"
            size="compact"
            loading={remove.isPending}
            onClick={() => deletingId && remove.mutate(deletingId)}
          >
            Delete
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={() => setDeletingId(null)}>
            Cancel
          </CapiroButton>
        </div>
      </CapiroModal>
      <ManageAccessModal
        open={Boolean(accessTarget)}
        target={accessTarget}
        members={membersQ.data ?? []}
        membersLoading={membersQ.isPending}
        pending={setAccess.isPending}
        error={
          setAccess.isError
            ? setAccess.error instanceof Error
              ? setAccess.error.message
              : 'Could not update access'
            : null
        }
        onClose={() => {
          setAccess.reset();
          setAccessTarget(null);
        }}
        onSave={(viewerMode, viewerUserIds) => {
          if (!accessTarget) return;
          if (accessTarget.kind === 'file') {
            setAccess.mutate({
              kind: 'file',
              id: accessTarget.id,
              viewerMode,
              viewerUserIds,
            });
          } else {
            setAccess.mutate({
              kind: 'folder',
              folder: accessTarget.folder,
              viewerMode,
              viewerUserIds,
            });
          }
        }}
      />

    </div>
  );
}

/* ── pieces ───────────────────────────────────────────────────────────────── */

/**
 * New folder (item 3).
 *
 * A folder in this product is a label on an attachment — `ClientFilesService`
 * has `folders` (a groupBy) and `move`, and nothing else. There is no create
 * endpoint to call because there is nothing to create: a folder exists exactly
 * as long as a file carries its name. So this either files the current
 * selection under the new name (a real move, after which the folder is real)
 * or opens it as a draft the next upload will make permanent. The copy says
 * which, rather than implying a folder was stored.
 */
function NewFolderModal({
  open,
  existing,
  selectedCount,
  onClose,
  onCreate,
}: {
  open: boolean;
  existing: string[];
  selectedCount: number;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const duplicate = existing.some((label) => sameFolder(label, trimmed));
  const invalid = trimmed.length === 0 || duplicate;

  const close = () => {
    setName('');
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (invalid || pending) return;
    setPending(true);
    setError(null);
    try {
      await onCreate(trimmed);
      setName('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create that folder');
    } finally {
      setPending(false);
    }
  };

  return (
    <CapiroModal open={open} title="New folder" onClose={close}>
      <p style={{ margin: 0, fontSize: 14, color: '#475467' }}>
        {selectedCount > 0
          ? `The ${selectedCount} selected file${selectedCount === 1 ? '' : 's'} will be filed here.`
          : 'Folders are created by filing a file into them. This one stays a draft until you upload or move a file into it.'}
      </p>
      <label style={{ display: 'block', marginTop: 16 }}>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
          Folder name
        </span>
        <input
          value={name}
          autoFocus
          maxLength={FOLDER_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
          placeholder="e.g. FY27 submissions"
          aria-label="Folder name"
          style={{
            display: 'block',
            width: '100%',
            marginTop: 6,
            height: 40,
            padding: '0 12px',
            borderRadius: 8,
            border: '1px solid #E0DCD4',
            outline: 'none',
            background: '#ffffff',
            boxShadow: '0px 1px 2px rgba(16,24,40,.05)',
            fontSize: 14,
            color: '#101828',
          }}
        />
      </label>
      {duplicate ? (
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#B42318' }}>That folder already exists.</p>
      ) : null}
      {error ? <p style={{ margin: '8px 0 0', fontSize: 14, color: '#B42318' }}>{error}</p> : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <CapiroButton variant="primary" size="compact" loading={pending} disabled={invalid} onClick={() => void submit()}>
          {selectedCount > 0 ? `Create and file ${selectedCount}` : 'Create folder'}
        </CapiroButton>
        <CapiroButton variant="secondary" size="compact" onClick={close}>
          Cancel
        </CapiroButton>
      </div>
    </CapiroModal>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 36,
        padding: '0 12px',
        borderRadius: 8,
        background: active ? '#F2F0EB' : hover ? '#FAF9F6' : '#ffffff',
        border: '1px solid #E0DCD4',
        color: active ? '#101828' : '#344054',
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function SortButton({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 32,
        padding: '0 10px',
        borderRadius: 8,
        background: hover ? '#F2F0EB' : 'transparent',
        border: '1px solid #E8E5DF',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        color: '#475467',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function FolderTreeRow({ folder, active, onPick }: { folder: FolderTreeNode; active: boolean; onPick: () => void }) {
  const [hover, setHover] = useState(false);
  const caret = folder.kids ? (folder.open ? '▾' : '▸') : '·';
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 8,
        padding: `8px 10px 8px ${12 + folder.depth * 16}px`,
        borderRadius: 8,
        marginBottom: 2,
        background: active ? '#F2F0EB' : hover ? '#FAF9F6' : 'transparent',
        border: active ? '1px solid #E0DCD4' : '1px solid transparent',
      }}
    >
      <span style={{ flex: '0 0 auto', width: 12, fontSize: 11, color: '#98A2B3' }}>{caret}</span>
      <span style={{ flex: '0 0 auto', width: 18, height: 14, borderRadius: 3, background: active ? '#101828' : '#475467' }} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          fontWeight: active || folder.depth === 0 ? 600 : 500,
          color: active ? '#101828' : '#344054',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {folder.label}
      </span>
      <span style={{ flex: '0 0 auto', fontSize: 13, color: '#667085' }}>
        {/* A draft folder holds nothing yet — say so rather than show a 0 that
            reads like an emptied folder. */}
        {folder.draft ? 'Draft' : folder.count}
      </span>
    </button>
  );
}

function Checkbox({
  checked,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onToggle}
      style={{ flex: '0 0 auto', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 4,
          background: checked ? GRADIENT_DARK : '#ffffff',
          border: checked ? '1px solid #101828' : '1px solid #E0DCD4',
          color: '#ffffff',
          fontSize: 10,
          fontWeight: 700,
        }}
      >
        {checked ? '✓' : ''}
      </span>
    </button>
  );
}

function FileRow({
  row,
  real,
  checked,
  bg,
  menuOpen,
  onToggle,
  onToggleMenu,
  onCloseMenu,
  onRequestMove,
  onRequestAccess,
  onRequestDelete,
}: {
  row: FileRowModel;
  real: boolean;
  checked: boolean;
  bg: string;
  menuOpen: boolean;
  onToggle: () => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onRequestMove: () => void;
  onRequestAccess: () => void;
  onRequestDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [menuHover, setMenuHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 24px',
        borderBottom: '1px solid #E8E5DF',
        background: hover && !checked ? '#FAF9F6' : bg,
      }}
    >
      <Checkbox checked={checked} onToggle={onToggle} ariaLabel={`Select ${row.name}`} />
      <button
        type="button"
        disabled={!row.downloadUrl}
        onClick={() => {
          if (row.downloadUrl) window.open(row.downloadUrl, '_blank', 'noopener,noreferrer');
        }}
        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <span
          aria-hidden
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: 6,
            background: '#FAF9F6',
            border: '1px solid #E8E5DF',
            color: '#475467',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '.04em',
          }}
        >
          {row.ext}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              fontSize: 14,
              fontWeight: 500,
              color: '#101828',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {row.name}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
            {row.smart ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  height: 20,
                  padding: '0 8px 0 6px',
                  borderRadius: 9999,
                  background: '#F2F0EB',
                  border: '1px solid #E0DCD4',
                  color: '#101828',
                  fontSize: 11,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: GRADIENT_DARK }} />
                Smart link
              </span>
            ) : null}
            <span style={{ fontSize: 12, color: '#667085' }}>{row.ext}</span>
          </span>
        </span>
      </button>
      <span
        style={{
          flex: '0 0 auto',
          width: 196,
          fontSize: 13,
          color: '#475467',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {row.linked}
      </span>
      <span style={{ flex: '0 0 auto', width: 84, fontSize: 13, color: '#475467' }}>{row.modified}</span>
      <span style={{ flex: '0 0 auto', width: 84, fontSize: 13, color: '#475467' }}>{row.owner}</span>
      <span style={{ flex: '0 0 auto', width: 112 }}>
        <Pill tone={row.tone}>{row.status}</Pill>
      </span>
      <span style={{ flex: '0 0 auto', width: 28, position: 'relative' }}>
        <button
          type="button"
          aria-label={`More actions for ${row.name}`}
          disabled={!real}
          onClick={onToggleMenu}
          onMouseEnter={() => setMenuHover(true)}
          onMouseLeave={() => setMenuHover(false)}
          style={{ width: 28, display: 'flex', justifyContent: 'center', color: menuHover ? '#101828' : '#667085' }}
        >
          <UIcon name="DotsHorizontal" size={18} />
        </button>
        {menuOpen ? (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 39 }} onClick={onCloseMenu} />
            <div
              role="menu"
              style={{
                position: 'absolute',
                top: 30,
                right: 0,
                zIndex: 40,
                minWidth: 160,
                padding: 6,
                borderRadius: 8,
                background: '#ffffff',
                boxShadow: '0px 12px 16px -4px rgba(16,24,40,.14),0px 0 0 1px #E8E5DF',
              }}
            >
              <MenuItem onClick={onRequestMove}>Move to folder</MenuItem>
              <MenuItem onClick={onRequestAccess}>Manage access</MenuItem>
              <MenuItem danger onClick={onRequestDelete}>
                Delete
              </MenuItem>
            </div>
          </>
        ) : null}
      </span>
    </div>
  );
}

function MenuItem({ children, danger = false, onClick }: { children: React.ReactNode; danger?: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        height: 34,
        padding: '0 10px',
        borderRadius: 6,
        background: hover ? (danger ? '#FEF3F2' : '#FAF9F6') : 'transparent',
        color: danger ? '#B42318' : '#101828',
        fontSize: 14,
        fontWeight: 500,
        textAlign: 'left',
      }}
    >
      {children}
    </button>
  );
}


/**
 * Who on the team can view a file or folder.
 *
 * Default is "All team members" (viewerMode='all') — every active tenant member
 * sees the file. "Specific people" switches to restricted and lets the caller
 * tick the members list; the server still always lets the uploader through.
 * Folder mode rewrites every attachment currently carrying that folder label
 * (folders are labels, not a table).
 */
function ManageAccessModal({
  open,
  target,
  members,
  membersLoading,
  pending,
  error,
  onClose,
  onSave,
}: {
  open: boolean;
  target:
    | { kind: 'file'; id: string; name: string; viewerMode: 'all' | 'restricted'; viewerUserIds: string[] }
    | { kind: 'folder'; folder: string | null; name: string }
    | null;
  members: ClientAccountOwner[];
  membersLoading: boolean;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (viewerMode: 'all' | 'restricted', viewerUserIds: string[]) => void;
}) {
  const initialMode = target && target.kind === 'file' ? target.viewerMode : 'all';
  const initialIds = target && target.kind === 'file' ? target.viewerUserIds : [];
  const [mode, setMode] = useState<'all' | 'restricted'>(initialMode);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialIds));

  // Reset local state whenever the target changes (modal re-opens).
  useEffect(() => {
    if (!open || !target) return;
    if (target.kind === 'file') {
      setMode(target.viewerMode);
      setSelected(new Set(target.viewerUserIds));
    } else {
      setMode('all');
      setSelected(new Set());
    }
  }, [open, target]);

  if (!target) {
    return <CapiroModal open={false} title="Manage access" onClose={onClose}>{null}</CapiroModal>;
  }

  const title = target.kind === 'file' ? `Access — ${target.name}` : `Folder access — ${target.name}`;
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <CapiroModal open={open} title={title} onClose={onClose}>
      <p style={{ margin: 0, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
        {target.kind === 'file'
          ? 'Choose who on your team can view this file. Everyone can view by default.'
          : 'Choose who on your team can view files in this folder. Applies to every file currently filed here. Everyone can view by default.'}
      </p>

      <div role="radiogroup" aria-label="Who can view" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: '#101828', cursor: 'pointer' }}>
          <input
            type="radio"
            name="viewer-mode"
            checked={mode === 'all'}
            onChange={() => setMode('all')}
          />
          All team members
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: '#101828', cursor: 'pointer' }}>
          <input
            type="radio"
            name="viewer-mode"
            checked={mode === 'restricted'}
            onChange={() => setMode('restricted')}
          />
          Specific people
        </label>
      </div>

      {mode === 'restricted' ? (
        <div
          style={{
            marginTop: 14,
            maxHeight: 260,
            overflowY: 'auto',
            border: '1px solid #E8E5DF',
            borderRadius: 8,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {membersLoading ? (
            <div style={{ padding: 8, fontSize: 14, color: '#667085' }} aria-busy="true">Loading team…</div>
          ) : members.length === 0 ? (
            <div style={{ padding: 8, fontSize: 14, color: '#667085' }}>No team members found.</div>
          ) : (
            members.map((m) => {
              const label = clientAccountOwnerLabel(m) ?? m.email;
              const on = selected.has(m.id);
              return (
                <label
                  key={m.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 6,
                    background: on ? '#FAF9F6' : 'transparent',
                    fontSize: 14,
                    color: '#101828',
                    cursor: 'pointer',
                  }}
                >
                  <input type="checkbox" checked={on} onChange={() => toggle(m.id)} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 500 }}>{label}</span>
                    <span style={{ display: 'block', fontSize: 12, color: '#667085' }}>{m.email}</span>
                  </span>
                </label>
              );
            })
          )}
        </div>
      ) : null}

      {error ? <p style={{ margin: '10px 0 0', fontSize: 14, color: '#B42318' }}>{error}</p> : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <CapiroButton
          variant="primary"
          size="compact"
          loading={pending}
          disabled={mode === 'restricted' && selected.size === 0}
          onClick={() => onSave(mode, mode === 'all' ? [] : [...selected])}
        >
          Save access
        </CapiroButton>
        <CapiroButton variant="secondary" size="compact" onClick={onClose}>
          Cancel
        </CapiroButton>
      </div>
    </CapiroModal>
  );
}

