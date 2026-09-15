import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import type { Client, ClientAttachment } from '../../../../pages/clients/clientTypes.js';
import {
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
import { CLIENT_STORAGE_QUOTA_BYTES, CLIENT_STORAGE_WARN_THRESHOLD } from '@capiro/shared';
import { attachmentContentType } from '../../../../lib/attachment-content-type.js';
import './files-tab.css';
import { fileReadability } from './file-readability.js';

/**
 * Files tab (spec §11, Figma geometry from `dom-tab-files.txt`).
 *
 * Data binding:
 *  - The file list reuses the canonical attachments query
 *    (`['client-attachments', client.id]` — same key as the profile, so
 *    uploads invalidate both surfaces). Confirmed rows are mapped onto the
 *    design's row shape, with explicit loading, error, and empty states.
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
 *    tree shows loading or a retryable error until folder data is available.
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
  /** The folder label stored on the attachment. */
  folder: string | null;
  /** Present only for real attachments — lets the row open/download the file. */
  downloadUrl: string | null;
  /** Inline-disposition URL for the preview modal; null when this file's
   *  content type isn't in the server's safe-to-render-inline allowlist
   *  (see createAttachmentPreviewUrl) — the modal falls back to a
   *  download-only state in that case. */
  previewUrl: string | null;
  contentType: string | null;
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

const SORT_LABEL: Record<SortKey, string> = { modified: 'Created', name: 'Name', owner: 'Owner' };
const FILE_COLUMNS = ['Document', 'Linked to', 'Created', 'Owner', 'Status'] as const;
const SORT_NEXT: Record<SortKey, SortKey> = { modified: 'name', name: 'owner', owner: 'modified' };

/** What `GET /api/clients/:id/files/folders` returns (ClientFilesService.folders). */
interface FolderGroup {
  folder: string | null;
  count: number;
}

/** A row in the folder tree. */
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
    ...fileReadability(file),
    folder,
    downloadUrl: file.downloadUrl,
    previewUrl: file.previewUrl ?? null,
    contentType: file.contentType ?? null,
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

export function ClientCrmFilesProto({ client, drawer = false }: { client: Client; drawer?: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedAttachmentId = searchParams.get('clientId') === client.id
    ? searchParams.get('attachmentId')
    : null;
  const openedAttachment = useRef<string | null>(null);
  const [attachmentUnavailable, setAttachmentUnavailable] = useState(false);
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
  /** The row currently open in the preview modal, if any. */
  const [previewRow, setPreviewRow] = useState<FileRowModel | null>(null);
  const [drawerView, setDrawerView] = useState<'folders' | 'files'>('folders');
  const [drawerGroup, setDrawerGroup] = useState<string | null>(null);
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

  useEffect(() => {
    openedAttachment.current = null;
    setPreviewRow(null);
    setSelected(new Set());
    setAttachmentUnavailable(false);
  }, [client.id, requestedAttachmentId]);

  useEffect(() => {
    if (!requestedAttachmentId || filesQuery.isFetching || !filesQuery.isSuccess) return;
    const key = `${client.id}:${requestedAttachmentId}`;
    if (openedAttachment.current === key) return;
    // Only resolve against the client's ACL-filtered attachment list. A
    // missing or inaccessible id never falls back to another client's file.
    const attachment = filesQuery.data.find((file) =>
      file.id === requestedAttachmentId && file.clientId === client.id,
    );
    setAttachmentUnavailable(!attachment);
    if (!attachment) return;
    openedAttachment.current = key;
    setFolderId('root');
    setQuery('');
    setFilter('all');
    setDrawerView('files');
    setDrawerGroup(null);
    setSelected(new Set([attachment.id]));
    setPreviewRow(attachmentRow(attachment));
  }, [client.id, requestedAttachmentId, filesQuery.data, filesQuery.isFetching, filesQuery.isSuccess]);

  const clearAttachmentRequest = () => {
    setAttachmentUnavailable(false);
    if (!requestedAttachmentId) return;
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('attachmentId');
      return next;
    }, { replace: true });
  };

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
    const groups = realTree ? foldersQuery.data ?? [] : [];
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
      if (current.folder === null) return row.folder === null;
      return (row.folder ?? '').toLowerCase() === (current.folder ?? '').toLowerCase();
    },
    [current],
  );

  const allRows: FileRowModel[] = useMemo(
    // Loading and error render their own states below — the FILES design
    // fixture never stands in for a client's real file room.
    () => (loaded ? (filesQuery.data ?? []).map(attachmentRow) : []),
    [loaded, filesQuery.data],
  );

  const drawerGroups = useMemo(() => {
    const grouped = new Map<string, FileRowModel[]>();
    for (const row of allRows) {
      const key = row.linked.split(/ · | \/ /)[0]?.trim() || 'Unfiled';
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    const real = [...grouped.entries()].map(([name, groupRows]) => ({
      name,
      rows: groupRows,
      exts: [...new Set(groupRows.map((row) => row.ext))],
      modified: [...groupRows].sort((a, b) => b.modifiedTs - a.modifiedTs)[0]?.modified ?? '—',
      draft: false,
    }));
    // Same client-only concept the full "Client files" tree (`folders` below)
    // already has: "New folder" cannot create an empty folder server-side, so
    // an empty selection opens one here instead, until a file is filed into
    // it. Without this the drawer's "Folders" tab derived groups from real
    // attachments alone, so a freshly created draft never appeared anywhere —
    // "New folder" looked like a no-op.
    const drafts = draftFolders
      .filter((name) => !real.some((entry) => sameFolder(entry.name, name)))
      .map((name) => ({ name, rows: [] as FileRowModel[], exts: [] as string[], modified: '—', draft: true }));
    return [...real, ...drafts].sort((a, b) => a.name.localeCompare(b.name));
  }, [allRows, draftFolders]);

  /** The drawer's "All files" list, scoped to `drawerGroup` when set. */
  const drawerShownRows = drawerGroup
    ? allRows.filter((row) => (row.linked.split(/ · | \/ /)[0]?.trim() || 'Unfiled') === drawerGroup)
    : allRows;

  /**
   * Where the drawer's "+ Upload" actually files the upload. The button used
   * to hardcode `triggerUpload(null)`, so a draft folder the user had just
   * created and opened could never receive a file — it stayed a draft until
   * something was MOVED into it, and the upload silently landed at the root
   * instead.
   *
   * The drawer has no folder tree; it scopes its "All files" list by
   * `drawerGroup`, which is keyed by the row's `linked` label — for a filed
   * file the folder label itself, for a smart link the source label
   * ("Capability", "Meeting", …), never a folder. So only a group that is a
   * REAL folder label (from the folders endpoint) or a live draft name is a
   * valid upload target; a smart-link group or nothing selected still files
   * at the root. Matches by label with the same case-folding the duplicate
   * check uses.
   */
  const drawerUploadFolder = useMemo(() => {
    if (!drawerGroup) return null;
    const named = folders.find(
      (f) => f.id !== 'root' && f.id !== UNFILED_ID && f.folder && sameFolder(f.folder, drawerGroup),
    );
    if (named) return named.folder ?? null;
    const draft = draftFolders.find((name) => sameFolder(name, drawerGroup));
    return draft ?? null;
  }, [drawerGroup, folders, draftFolders]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Search spans every folder; otherwise match the selected stored label.
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
        // See attachment-content-type.ts: an empty file.type (common for
        // .txt/.csv/.docx depending on the OS picker) must not fall back to
        // 'application/octet-stream' — the one content type the server's
        // allowlist rejects. Infer from the extension first; an unrecognized
        // extension still falls through and fails loudly server-side.
        const contentType = attachmentContentType(file);
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
    <div className={`cap-pf-anim-rise cap-pf-files${drawer ? ' cap-pf-files--drawer' : ''}`}>
      {attachmentUnavailable ? (
        <div role="alert" className="cap-pf-files__uploads">
          <p>This file is not available in this client's files. It may have been removed, replaced, or your access may have changed.</p>
          <PfButton variant="link" onClick={() => void filesQuery.refetch()}>Retry file</PfButton>
          <PfButton variant="link" onClick={clearAttachmentRequest}>Dismiss</PfButton>
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="cap-pf-files__hidden-input"
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {drawer ? (
        <>
          <div className="cap-pf-files-drawer__toolbar">
            <div className="cap-pf-files-drawer__tabs" role="tablist" aria-label="Files view">
              <button
                type="button"
                role="tab"
                aria-selected={drawerView === 'folders'}
                onClick={() => { setDrawerView('folders'); setDrawerGroup(null); }}
              >
                Folders
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={drawerView === 'files'}
                onClick={() => { setDrawerView('files'); setDrawerGroup(null); }}
              >
                All files
              </button>
            </div>
            <span className="cap-pf-files-drawer__count">{allRows.length} document{allRows.length === 1 ? '' : 's'}</span>
            {/* Files a real selection into the new folder, same as the full
                "Client files" page's button below — this was hardcoded to
                `ids: []` before, so selecting files and clicking "New folder"
                silently discarded the selection and only ever opened a draft. */}
            <button type="button" className="cap-pf-files-drawer__link" onClick={() => setCreatingFolder({ ids: [...selected] })}>
              New folder
            </button>
            {/* Files into the folder group the user is actually looking at —
                a real or draft folder. Was hardcoded to `null`, so an upload
                from inside a draft folder landed at the root and the draft
                never became real. */}
            <button type="button" className="cap-pf-files-drawer__upload" onClick={() => triggerUpload(drawerUploadFolder)}>
              + Upload
            </button>
          </div>

          {uploads.length > 0 ? (
            <div className="cap-pf-files__uploads cap-pf-files-drawer__uploads">
              {uploads.map((entry) => (
                <div key={entry.name} className={`cap-pf-files__upload-row${entry.status === 'failed' ? ' is-failed' : ''}`}>
                  <span className="cap-pf-files__upload-name">{entry.name}</span>
                  <span className={`cap-pf-files__upload-status${entry.status === 'failed' ? ' is-failed' : ''}`}>
                    {entry.status === 'uploading' ? 'Uploading…' : entry.message}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {drawerView === 'folders' ? (
            <>
              {filesQuery.isPending ? (
                <div className="cap-pf-files-drawer__state" aria-busy="true">Loading folders…</div>
              ) : filesQuery.isError ? (
                <div className="cap-pf-files-drawer__state cap-pf-files-drawer__state--error">
                  Files could not be loaded. <button type="button" onClick={() => void filesQuery.refetch()}>Retry</button>
                </div>
              ) : drawerGroups.length === 0 ? (
                <div className="cap-pf-files-drawer__state">No files uploaded yet.</div>
              ) : (
                <div className="cap-pf-files-drawer__folders">
                  {drawerGroups.map((group) => (
                    <button
                      key={group.name}
                      type="button"
                      className="cap-pf-files-drawer__folder"
                      onClick={() => { setDrawerGroup(group.name); setDrawerView('files'); }}
                    >
                      <span className="cap-pf-files-drawer__folder-top">
                        <span className="cap-pf-files-drawer__folder-icon" aria-hidden><UIcon name="File04" size={20} /></span>
                        <span>
                          <strong>{group.name}</strong>
                          {/* A draft folder holds nothing yet — say so rather
                              than show a 0 that reads as "empty and broken",
                              matching the full page's tree (folder.draft). */}
                          <small>{group.draft ? 'Draft' : `${group.rows.length} file${group.rows.length === 1 ? '' : 's'}`}</small>
                        </span>
                      </span>
                      <span className="cap-pf-files-drawer__folder-foot">
                        <span>{group.exts.map((ext) => <i key={ext}>{ext}</i>)}</span>
                        <small>{group.modified}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="cap-pf-files-drawer__note">
                <UIcon name="AlertCircle" size={15} />
                <span>Folders mirror what each file is linked to. A smart-linked file is a reference, never a copy — it stays in one folder and appears wherever it is used.</span>
              </div>
            </>
          ) : (
            <div className="cap-pf-files-drawer__list-scroll">
              <div className="cap-pf-files-drawer__list">
                <div className="cap-pf-files-drawer__head" aria-hidden>
                  {FILE_COLUMNS.map((label) => <span key={label}>{label}</span>)}<span />
                </div>
                {drawerGroup ? (
                  <div className="cap-pf-files-drawer__filter-note">
                    <button type="button" onClick={() => setDrawerGroup(null)}>← All files</button>
                    <span>{drawerGroup}</span>
                  </div>
                ) : null}
                {/* A failed read must not masquerade as an empty file room —
                    the Folders tab has its own error/retry branch, and this
                    list needs the same honesty. */}
                {filesQuery.isError ? (
                  <div className="cap-pf-files-drawer__state cap-pf-files-drawer__state--error">
                    Files could not be loaded.{' '}
                    <button type="button" onClick={() => void filesQuery.refetch()}>Retry</button>
                  </div>
                ) : (
                  drawerShownRows.map((row, index) => (
                  <FileRow
                    key={row.id}
                    row={row}
                    real={real}
                    checked={selected.has(row.id)}
                    bg={index % 2 === 1 ? '#FCFCFD' : '#FFFFFF'}
                    menuOpen={menuRowId === row.id}
                    onToggle={() => toggleRow(row.id)}
                    onToggleMenu={() => setMenuRowId((previous) => previous === row.id ? null : row.id)}
                    onCloseMenu={() => setMenuRowId(null)}
                    onPreview={() => setPreviewRow(row)}
                    onRequestMove={() => { setMenuRowId(null); requestMove([row.id]); }}
                    onRequestAccess={() => {
                      setMenuRowId(null);
                      setAccessTarget({
                        kind: 'file', id: row.id, name: row.name,
                        viewerMode: row.viewerMode, viewerUserIds: row.viewerUserIds,
                      });
                    }}
                    onRequestDelete={() => { setMenuRowId(null); setDeletingId(row.id); }}
                  />
                  ))
                )}
                {/* Scoped to what's actually shown, not the whole client's
                    row count — filtering into an empty real folder or a fresh
                    draft used to render a blank list with no explanation
                    (allRows.length only reflects the unfiltered total). Never
                    claim "no files" while the read itself failed. */}
                {!filesQuery.isPending && !filesQuery.isError && drawerShownRows.length === 0 ? (
                  <div className="cap-pf-files-drawer__state">
                    {drawerGroup && draftFolders.some((name) => sameFolder(name, drawerGroup))
                      ? 'Draft folder · upload or move a file here to create it'
                      : 'No files uploaded yet.'}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </>
      ) : (
        <>

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
        <div className="cap-pf-files__uploads">
          {uploads.map((entry) => (
            <div
              key={entry.name}
              className={`cap-pf-files__upload-row${entry.status === 'failed' ? ' is-failed' : ''}`}
            >
              <span className="cap-pf-files__upload-name">{entry.name}</span>
              <span className={`cap-pf-files__upload-status${entry.status === 'failed' ? ' is-failed' : ''}`}>
                {entry.status === 'uploading' ? 'Uploading…' : entry.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* toolbar */}
      <div className="cap-pf-files__toolbar">
        <div className="cap-pf-files__search-box">
          <UIcon name="SearchLg" size={18} color="var(--pf-muted)" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files"
            aria-label="Search files"
            className="cap-pf-files__search-input"
          />
        </div>
        {FILTERS.map((chip) => (
          <FilterChip key={chip.key} label={chip.label} active={filter === chip.key} onClick={() => setFilter(chip.key)} />
        ))}
        <span className="cap-pf-files__spacer" />
        <SortButton label={`Sort ${SORT_LABEL[sort]}`} onClick={() => setSort(SORT_NEXT[sort])} />
      </div>

      {/* selection bar */}
      {selected.size > 0 ? (
        <div className="cap-pf-anim-rise cap-pf-files__selection-bar">
          <span className="cap-pf-files__selection-count">{`${selected.size} selected`}</span>
          <span className="cap-pf-files__spacer" />
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

      <div className={`cap-pf-files__grid${narrow ? ' is-narrow' : ''}`}>
        {/* Folder tree from the client’s stored attachment labels. */}
        <section className="cap-pf-files__card">
          <div className="cap-pf-files__tree-head">
            <span className="cap-pf-files__eyebrow cap-pf-files__flex1">Folders</span>
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
          <div className="cap-pf-files__tree-list">
            {realTree ? folders.map((folder) => (
              <FolderTreeRow key={folder.id} folder={folder} active={folder.id === folderId} onPick={() => pickFolder(folder.id)} />
            )) : foldersQuery.isError ? (
              <div role="alert" style={{ padding: '12px 16px' }}>
                <p>Folders could not be loaded.</p>
                <PfButton variant="link" onClick={() => void foldersQuery.refetch()}>Retry folders</PfButton>
              </div>
            ) : (
              <p role="status" style={{ padding: '12px 16px' }}>Loading folders…</p>
            )}
          </div>
          <div className="cap-pf-files__storage">
            <div className="cap-pf-files__eyebrow">Client storage</div>
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
                over 100% rather than blocking. */}
            {loaded ? (
              <>
                <div className={`cap-pf-files__storage-value${storageOver ? ' is-over' : ''}`}>
                  {`${formatBytes(storedBytes)} of ${formatBytes(CLIENT_STORAGE_QUOTA_BYTES)}`}
                </div>
                <span className="cap-pf-files__storage-track">
                  <span
                    className={`cap-pf-files__storage-fill${storageOver ? ' is-over' : ''}`}
                    style={{
                      // Clamped so an over-quota client cannot overflow the
                      // track — the copy below is what states the overage.
                      width: `${Math.min(100, storagePct)}%`,
                    }}
                  />
                </span>
                <div className={`cap-pf-files__storage-sub${storageWarn ? ' is-warn' : ''}`}>
                  {storageOver
                    ? `Over the ${formatBytes(CLIENT_STORAGE_QUOTA_BYTES)} allowance · ${allRows.length} file${allRows.length === 1 ? '' : 's'}`
                    : `${storagePct < 1 ? '<1' : Math.round(storagePct)}% used · ${allRows.length} file${allRows.length === 1 ? '' : 's'}`}
                </div>
              </>
            ) : (
              <>
                {/* Loading/error: no invented "1.8 GB of 10 GB" — an empty track
                    until the real total is known. */}
                <div className="cap-pf-files__storage-value is-faint" aria-busy={filesQuery.isPending}>
                  {filesQuery.isPending ? 'Measuring…' : 'Storage unavailable'}
                </div>
                <span className="cap-pf-files__storage-track" />
              </>
            )}
            <p className="cap-pf-files__storage-note">
              Smart links point to the original Strategy, meeting, Workspace, or Outreach object — no duplicate file is
              created.
            </p>
          </div>
        </section>

        {/* file table card */}
        <section className="cap-pf-files__card">
          <div className="cap-pf-files__table-head">
            <span className="cap-pf-files__flex1">
              <span className="cap-pf-files__field-label">{current.crumb}</span>
              <span className="cap-pf-files__table-title">{current.label}</span>
              <span className="cap-pf-files__table-sub">
                {/* Subfolder count only where there are subfolders — real
                    folders never nest, so "0 subfolders" on every row would be
                    noise about a hierarchy this product does not have. */}
                {!realTree
                  ? foldersQuery.isError ? 'Folder counts unavailable' : 'Loading folder counts…'
                  : current.draft
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

          <div className="cap-pf-files__scroll">
            <div className="cap-pf-files__table-min">
              {/* header row */}
              <div className="cap-pf-files__col-head">
                <Checkbox checked={allChecked} onToggle={toggleAll} ariaLabel="Select all files" />
                <span className="cap-pf-files__flex1">Name</span>
                <span className="cap-pf-files__col-linked">Linked to / location</span>
                <span className="cap-pf-files__col-84">{FILE_COLUMNS[2]}</span>
                <span className="cap-pf-files__col-84">Owner</span>
                <span className="cap-pf-files__col-status">Status</span>
                <span className="cap-pf-files__col-menu" />
              </div>

              {filesQuery.isPending ? (
                <div className="cap-pf-files__panel-note" aria-busy="true">
                  Loading files…
                </div>
              ) : filesQuery.isError ? (
                <div className="cap-pf-files__panel-error">
                  <span className="cap-pf-files__error-text">Files could not be loaded.</span>{' '}
                  <button
                    type="button"
                    onClick={() => void filesQuery.refetch()}
                    className="cap-pf-files__retry-link"
                  >
                    Retry
                  </button>
                </div>
              ) : rows.length === 0 ? (
                <div className="cap-pf-files__panel-note">
                  {allRows.length === 0 ? 'No files uploaded yet.' : 'No files match this view.'}
                </div>
              ) : (
                rows.map((row, i) => (
                  <FileRow
                    key={row.id}
                    row={row}
                    real={real}
                    checked={selected.has(row.id)}
                    bg={selected.has(row.id) ? 'var(--pf-tint)' : i % 2 === 1 ? 'var(--pf-subtle-bg)' : 'var(--pf-surface)'}
                    menuOpen={menuRowId === row.id}
                    onToggle={() => toggleRow(row.id)}
                    onToggleMenu={() => setMenuRowId((prev) => (prev === row.id ? null : row.id))}
                    onCloseMenu={() => setMenuRowId(null)}
                    onPreview={() => setPreviewRow(row)}
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

          <div className="cap-pf-files__table-foot">
            <span className="cap-pf-files__table-foot-text">{`${rows.length} files · ${smartCount} smart links`}</span>
            <span className="cap-pf-files__spacer" />
            {/* Row 3, wire-audit "4 New capability": "All source links healthy"
                was a designed pill with NO link-health backend — nothing checks
                whether a smart link still resolves, so it asserted a health it
                never measured. Removed rather than left claiming green. */}
          </div>
        </section>
      </div>
        </>
      )}

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
          // The full page's file list is already scoped by `folderId`/`current`
          // (set above), so it shows the new folder immediately. The drawer's
          // "All files" list is scoped by `drawerGroup`/`drawerView` instead —
          // without setting those too, the drawer just closed the modal and
          // sat on whatever it was showing before, with the new folder visible
          // only if the user happened to go find it in the Folders tab.
          if (drawer) {
            setDrawerGroup(name);
            setDrawerView('files');
          }
          setCreatingFolder(null);
        }}
      />

      <CapiroModal open={Boolean(deletingId)} title="Delete file" onClose={() => setDeletingId(null)}>
        <p className="cap-pf-files__modal-text">
          Delete <strong>{deletingRow?.name}</strong>? Anything linking to it loses the reference. This cannot be undone.
        </p>
        {remove.isError ? (
          <p className="cap-pf-files__field-error">
            {remove.error instanceof Error ? remove.error.message : 'Delete failed'}
          </p>
        ) : null}
        <div className="cap-pf-files__modal-actions">
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

      <FilePreviewModal row={previewRow} onClose={() => { setPreviewRow(null); clearAttachmentRequest(); }} />
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
      <p className="cap-pf-files__modal-text">
        {selectedCount > 0
          ? `The ${selectedCount} selected file${selectedCount === 1 ? '' : 's'} will be filed here.`
          : 'Folders are created by filing a file into them. This one stays a draft until you upload or move a file into it.'}
      </p>
      <label className="cap-pf-files__field">
        <span className="cap-pf-files__field-label">Folder name</span>
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
          className="cap-pf-files__field-input"
        />
      </label>
      {duplicate ? (
        <p className="cap-pf-files__field-error">That folder already exists.</p>
      ) : null}
      {error ? <p className="cap-pf-files__field-error">{error}</p> : null}
      <div className="cap-pf-files__modal-actions">
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
      className={`cap-pf-files__filter-chip${hover ? ' is-hover' : ''}${active ? ' is-active' : ''}`}
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
      className={`cap-pf-files__sort-btn${hover ? ' is-hover' : ''}`}
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
      className={`cap-pf-files__tree-row${active ? ' is-active' : hover ? ' is-hover' : ''}`}
      style={{ paddingLeft: 12 + folder.depth * 16 }}
    >
      <span className="cap-pf-files__tree-caret">{caret}</span>
      <span className={`cap-pf-files__tree-icon${active ? ' is-active' : ''}`} />
      <span
        className={`cap-pf-files__tree-label${active ? ' is-active' : folder.depth === 0 ? ' is-root' : ''}`}
      >
        {folder.label}
      </span>
      <span className="cap-pf-files__tree-count">
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
    <button type="button" role="checkbox" aria-checked={checked} aria-label={ariaLabel} onClick={onToggle} className="cap-pf-files__checkbox-btn">
      <span className={`cap-pf-files__checkbox-box${checked ? ' is-checked' : ''}`}>
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
  onPreview,
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
  onPreview: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [menuHover, setMenuHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="cap-pf-files__row"
      style={{ background: hover && !checked ? 'var(--pf-subtle-bg)' : bg }}
    >
      <Checkbox checked={checked} onToggle={onToggle} ariaLabel={`Select ${row.name}`} />
      <button
        type="button"
        disabled={!row.downloadUrl}
        // Opens the preview modal instead of downloading — clicking a file
        // used to hand you a file-save prompt with no chance to look at it
        // first. The modal itself decides inline preview vs. download-only,
        // based on row.previewUrl (see FilePreviewModal).
        onClick={onPreview}
        className="cap-pf-files__row-name-btn"
      >
        <span aria-hidden className="cap-pf-files__ext-badge">
          {row.ext}
        </span>
        <span className="cap-pf-files__flex1">
          <span className="cap-pf-files__row-title">{row.name}</span>
          <span className="cap-pf-files__row-meta">
            {row.smart ? (
              <span className="cap-pf-files__smart-badge">
                <span className="cap-pf-files__smart-dot" />
                Smart link
              </span>
            ) : null}
            <span className="cap-pf-files__row-ext">{row.ext}</span>
          </span>
        </span>
      </button>
      <span className="cap-pf-files__row-linked">{row.linked}</span>
      <span className="cap-pf-files__row-84 cap-pf-files__row-created">{row.modified}</span>
      <span className="cap-pf-files__row-84 cap-pf-files__row-owner">{row.owner}</span>
      <span className="cap-pf-files__row-status">
        <Pill tone={row.tone} style={{ maxWidth: '100%', height: 'auto', minHeight: 22,
          whiteSpace: 'normal', padding: '3px 6px', borderRadius: 8 }}>
          {row.status}
        </Pill>
      </span>
      <span className="cap-pf-files__row-menu">
        <button
          type="button"
          aria-label={`More actions for ${row.name}`}
          disabled={!real}
          onClick={onToggleMenu}
          onMouseEnter={() => setMenuHover(true)}
          onMouseLeave={() => setMenuHover(false)}
          className={`cap-pf-files__menu-trigger${menuHover ? ' is-hover' : ''}`}
        >
          <UIcon name="DotsHorizontal" size={18} />
        </button>
        {menuOpen ? (
          <>
            <div className="cap-pf-files__menu-backdrop" onClick={onCloseMenu} />
            <div role="menu" className="cap-pf-files__menu-popover">
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
      className={`cap-pf-files__menu-item${danger ? ' is-danger' : ''}${hover ? ' is-hover' : ''}`}
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
      <p className="cap-pf-files__modal-text is-pretty">
        {target.kind === 'file'
          ? 'Choose who on your team can view this file. Everyone can view by default.'
          : 'Choose who on your team can view files in this folder. Applies to every file currently filed here. Everyone can view by default.'}
      </p>

      <div role="radiogroup" aria-label="Who can view" className="cap-pf-files__radio-group">
        <label className="cap-pf-files__radio-label">
          <input
            type="radio"
            name="viewer-mode"
            checked={mode === 'all'}
            onChange={() => setMode('all')}
          />
          All team members
        </label>
        <label className="cap-pf-files__radio-label">
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
        <div className="cap-pf-files__members-list">
          {membersLoading ? (
            <div className="cap-pf-files__members-note" aria-busy="true">Loading team…</div>
          ) : members.length === 0 ? (
            <div className="cap-pf-files__members-note">No team members found.</div>
          ) : (
            members.map((m) => {
              const label = clientAccountOwnerLabel(m) ?? m.email;
              const on = selected.has(m.id);
              return (
                <label key={m.id} className={`cap-pf-files__member-row${on ? ' is-on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(m.id)} />
                  <span className="cap-pf-files__flex1">
                    <span className="cap-pf-files__member-name">{label}</span>
                    <span className="cap-pf-files__member-email">{m.email}</span>
                  </span>
                </label>
              );
            })
          )}
        </div>
      ) : null}

      {error ? <p className="cap-pf-files__access-error">{error}</p> : null}

      <div className="cap-pf-files__modal-actions">
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

/**
 * Clicking a file used to hand you a browser file-save prompt with no chance
 * to look at it first (`ResponseContentDisposition: 'attachment'` on the
 * download URL — a deliberate anti-XSS control, see createAttachmentDownloadUrl
 * in engagement.service.ts). Images use the server's allowlisted preview URL.
 * PDFs offer a separate-tab viewer and Download because Chromium blocks its
 * PDF plugin in a sandboxed iframe. Download retains attachment disposition.
 */
function FilePreviewModal({ row, onClose }: { row: FileRowModel | null; onClose: () => void }) {
  if (!row) return null;
  const isImage = (row.contentType ?? '').toLowerCase().startsWith('image/');
  const isPdf = (row.contentType ?? '').toLowerCase() === 'application/pdf';
  return (
    <CapiroModal open title={row.name} onClose={onClose} width={860}>
      {row.previewUrl && isImage ? (
        <div className="cap-pf-files__preview-frame">
          <img src={row.previewUrl} alt={row.name} className="cap-pf-files__preview-image" />
        </div>
      ) : (
        <div className="cap-pf-files__preview-empty">
          <UIcon name="File04" size={28} />
          <p className="cap-pf-files__modal-text">
            {isPdf
              ? `PDF preview is unavailable in this view. ${row.previewUrl ? 'Open the PDF in a new tab or download it' : 'Download it'} to read the full contents.`
              : 'No preview available for this file type. Download it to view the full contents.'}
          </p>
        </div>
      )}
      <div className="cap-pf-files__modal-actions">
        {isPdf && row.previewUrl ? (
          <CapiroButton variant="secondary" size="compact" onClick={() => window.open(row.previewUrl!, '_blank', 'noopener,noreferrer')}>
            Open PDF in new tab
          </CapiroButton>
        ) : null}
        <CapiroButton
          variant="primary"
          size="compact"
          disabled={!row.downloadUrl}
          onClick={() => {
            if (row.downloadUrl) window.open(row.downloadUrl, '_blank', 'noopener,noreferrer');
          }}
        >
          Download
        </CapiroButton>
      </div>
    </CapiroModal>
  );
}
