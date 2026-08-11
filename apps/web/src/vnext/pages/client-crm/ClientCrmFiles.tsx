import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import type { ClientAttachment } from '../../../pages/clients/clientTypes.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Files — Figma `907:2810`, plus the Move to Folder modal `907:3355`.
 *
 * The existing attachment/storage pipeline is preserved exactly: presign →
 * PUT/POST to storage → confirm, with the 25 MB cap. Folders are metadata on
 * the same row, so moving a file NEVER copies the stored object, and a document
 * referenced from a capability, strategy or meeting keeps one canonical copy
 * that shows up here alongside everything else.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const UNFILED = '__unfiled__';

interface UploadState {
  name: string;
  status: 'uploading' | 'failed';
  message?: string;
}

export function ClientCrmFiles({ client }: { client: Client }) {
  const api = useApi();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [folder, setFolder] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [moving, setMoving] = useState<ClientAttachment | null>(null);
  const [deleting, setDeleting] = useState<ClientAttachment | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);

  const files = useQuery<ClientAttachment[]>({
    // Same key as the canonical profile so uploads invalidate both surfaces.
    queryKey: ['client-attachments', client.id],
    queryFn: async () =>
      (await api.get<ClientAttachment[]>('/api/engagement/attachments', {
        params: { clientId: client.id },
      })).data,
  });

  const kb = useQuery<{ counts: Record<string, number>; lastIndexedAt: string | null }>({
    queryKey: ['client-kb-status', client.id],
    queryFn: async () =>
      (await api.get<{ counts: Record<string, number>; lastIndexedAt: string | null }>(
        `/api/clio/kb/${client.id}/status`,
      )).data,
    staleTime: 60_000,
  });

  const move = useMutation({
    mutationFn: async ({ id, folder: target }: { id: string; folder: string | null }) =>
      (await api.patch(`/api/clients/${client.id}/files/${id}/folder`, { folder: target })).data,
    onSuccess: () => {
      setMoving(null);
      void qc.invalidateQueries({ queryKey: ['client-attachments', client.id] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/engagement/attachments/${id}`)).data,
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['client-attachments', client.id] });
      void qc.invalidateQueries({ queryKey: ['client-kb-status', client.id] });
    },
  });

  const rows = files.data ?? [];

  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of rows) {
      const key = folderOf(file) ?? UNFILED;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = rows.filter((file) => {
      if (folder !== 'all') {
        const key = folderOf(file) ?? UNFILED;
        if (key !== folder) return false;
      }
      if (needle && !file.fileName.toLowerCase().includes(needle)) return false;
      return true;
    });
    return filtered.sort((a, b) =>
      sort === 'name'
        ? a.fileName.localeCompare(b.fileName)
        : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  }, [rows, folder, search, sort]);

  async function upload(list: FileList | null) {
    if (!list) return;
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
        await api.post('/api/engagement/attachments/confirm', {
          clientId: client.id,
          fileName: file.name,
          contentType,
          s3Key: presigned.s3Key,
        });
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
    void qc.invalidateQueries({ queryKey: ['client-attachments', client.id] });
    void qc.invalidateQueries({ queryKey: ['client-kb-status', client.id] });
  }

  return (
    <div className="capiro-crm__body">
      <div className="capiro-crm__page-head">
        <div>
          <h2 className="capiro-crm__page-title">Files</h2>
          <p className="capiro-crm__page-sub">
            Everything attached to this client, including documents linked from capabilities,
            strategies and meetings.
          </p>
        </div>
        <span className="capiro-crm__page-head-spacer" />
        <input
          ref={inputRef}
          type="file"
          multiple
          className="capiro-crm__sr-only"
          onChange={(event) => void upload(event.target.files)}
        />
        <CapiroButton variant="primary" size="compact" onClick={() => inputRef.current?.click()}>
          Upload
        </CapiroButton>
      </div>

      <div className="capiro-crm__grid capiro-crm__grid--files">
        <section className="capiro-crm__card capiro-elevation-widget">
          <div className="capiro-crm__card-head">
            <h3 className="capiro-crm__card-title">Folders</h3>
          </div>
          <ul className="capiro-crm__rows">
            <li>
              <button
                type="button"
                className="capiro-crm__row"
                aria-pressed={folder === 'all'}
                onClick={() => setFolder('all')}
              >
                <span className="capiro-crm__row-main">
                  <span className="capiro-crm__row-title">All files</span>
                </span>
                <span className="capiro-crm__meta">{rows.length}</span>
              </button>
            </li>
            {folders.map(([key, count]) => (
              <li key={key}>
                <button
                  type="button"
                  className="capiro-crm__row"
                  aria-pressed={folder === key}
                  onClick={() => setFolder(key)}
                >
                  <span className="capiro-crm__row-main">
                    <span className="capiro-crm__row-title">
                      {key === UNFILED ? 'Unfiled' : key}
                    </span>
                  </span>
                  <span className="capiro-crm__meta">{count}</span>
                </button>
              </li>
            ))}
          </ul>

          <p className="capiro-crm__meta capiro-crm__setting-head">Knowledge base</p>
          {kb.isError ? (
            <p className="capiro-crm__foot">Index status could not be read.</p>
          ) : (
            <p className="capiro-crm__foot">
              {kb.data?.lastIndexedAt
                ? `Last indexed ${new Date(kb.data.lastIndexedAt).toLocaleDateString()}`
                : 'Not indexed yet'}
            </p>
          )}
        </section>

        <section className="capiro-crm__card capiro-elevation-widget">
          <div className="capiro-crm__card-head">
            <h3 className="capiro-crm__card-title">
              {folder === 'all' ? 'All files' : folder === UNFILED ? 'Unfiled' : folder}
            </h3>
            <span className="capiro-crm__page-head-spacer" />
            <span className="capiro-crm__meta">{shown.length}</span>
          </div>

          <div className="capiro-crm__filters">
            <input
              className="capiro-crm-form__input capiro-crm__search"
              placeholder="Search files"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search files"
            />
            <select
              className="capiro-crm-form__input capiro-crm__review-select"
              value={sort}
              onChange={(event) => setSort(event.target.value as 'recent' | 'name')}
              aria-label="Sort files"
            >
              <option value="recent">Most recent</option>
              <option value="name">Name</option>
            </select>
            <CapiroButton
              variant="quiet"
              size="compact"
              onClick={() => setLayout(layout === 'list' ? 'grid' : 'list')}
            >
              {layout === 'list' ? 'Grid' : 'List'}
            </CapiroButton>
          </div>

          {uploads.length > 0 ? (
            <ul className="capiro-crm__rows">
              {uploads.map((entry) => (
                <li key={entry.name} className="capiro-crm__pinned">
                  <span className="capiro-crm__row-title">{entry.name}</span>
                  <span
                    className={`capiro-crm__meta capiro-crm__row-meta${entry.status === 'failed' ? ' capiro-crm__state--error' : ''}`}
                  >
                    {entry.status === 'uploading' ? 'Uploading…' : entry.message}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {files.isLoading ? (
            <div className="capiro-crm__skeleton" style={{ height: 280 }} aria-hidden />
          ) : files.isError ? (
            <div className="capiro-crm__state capiro-crm__state--error" role="status">
              <span>
                {files.error instanceof Error ? files.error.message : 'Could not load files'}
              </span>
              <CapiroButton variant="quiet" size="compact" onClick={() => void files.refetch()}>
                Retry
              </CapiroButton>
            </div>
          ) : shown.length === 0 ? (
            <div className="capiro-crm__state" role="status">
              {rows.length === 0
                ? 'No files attached to this client yet.'
                : 'No files match this folder or search.'}
            </div>
          ) : (
            <ul className={layout === 'grid' ? 'capiro-crm__file-grid' : 'capiro-crm__rows'}>
              {shown.map((file) => (
                <li key={file.id}>
                  <div className="capiro-crm__row capiro-crm__row--static">
                    <span className="capiro-crm__row-main">
                      <span className="capiro-crm__row-title">{file.fileName}</span>
                      <span className="capiro-crm__meta capiro-crm__row-meta">
                        {[
                          sourceLabel(file.source),
                          file.uploadedByName,
                          new Date(file.createdAt).toLocaleDateString(),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className="capiro-crm__row-side">
                      {/* A capability-linked document is the SAME object, shown
                          here with its provenance — not a second copy. */}
                      {isSmartLink(file) ? <CapiroBadge tone="info">LINKED</CapiroBadge> : null}
                      {file.indexedAt ? <CapiroBadge tone="success">INDEXED</CapiroBadge> : null}
                      <button
                        type="button"
                        className="capiro-crm__card-action"
                        onClick={() => setMoving(file)}
                      >
                        Move
                      </button>
                      <button
                        type="button"
                        className="capiro-crm__card-action"
                        onClick={() => setDeleting(file)}
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {moving ? (
        <MoveToFolderModal
          file={moving}
          folders={folders.map(([key]) => key).filter((key) => key !== UNFILED)}
          pending={move.isPending}
          error={move.error}
          onClose={() => setMoving(null)}
          onMove={(target) => move.mutate({ id: moving.id, folder: target })}
        />
      ) : null}

      <CapiroModal open={Boolean(deleting)} title="Delete file" onClose={() => setDeleting(null)}>
        <p className="capiro-crm__foot">
          Delete <strong>{deleting?.fileName}</strong>? Anything linking to it loses the
          reference. This cannot be undone.
        </p>
        <div className="capiro-crm-fill__actions">
          <CapiroButton
            variant="primary"
            size="compact"
            loading={remove.isPending}
            onClick={() => deleting && remove.mutate(deleting.id)}
          >
            Delete
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={() => setDeleting(null)}>
            Cancel
          </CapiroButton>
        </div>
      </CapiroModal>
    </div>
  );
}

/** Move to Folder — Figma `907:3355`. Metadata only; no object is copied. */
function MoveToFolderModal({
  file,
  folders,
  pending,
  error,
  onClose,
  onMove,
}: {
  file: ClientAttachment;
  folders: string[];
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onMove: (folder: string | null) => void;
}) {
  const [target, setTarget] = useState<string>(folderOf(file) ?? '');
  const [creating, setCreating] = useState('');

  return (
    <CapiroModal open title="Move to folder" onClose={onClose}>
      <div className="capiro-crm-form">
        <p className="capiro-crm__foot">
          Moving <strong>{file.fileName}</strong> changes only where it appears. The stored file
          itself is not copied, so every link to it keeps working.
        </p>

        <label className="capiro-crm-form__field">
          <span className="capiro-crm__meta">Folder</span>
          <select
            className="capiro-crm-form__input"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">Unfiled</option>
            {folders.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>

        <label className="capiro-crm-form__field">
          <span className="capiro-crm__meta">Or create a new folder</span>
          <input
            className="capiro-crm-form__input"
            value={creating}
            maxLength={120}
            onChange={(event) => setCreating(event.target.value)}
            placeholder="e.g. FY27 submissions"
          />
        </label>

        {error ? (
          <p className="capiro-crm__foot capiro-crm__state--error">
            {error instanceof Error ? error.message : 'Could not move that file'}
          </p>
        ) : null}

        <div className="capiro-crm-fill__actions">
          <CapiroButton
            variant="primary"
            size="compact"
            loading={pending}
            onClick={() => onMove(creating.trim() || target.trim() || null)}
          >
            Move
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={onClose}>
            Cancel
          </CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}

function folderOf(file: ClientAttachment): string | null {
  const value = (file as ClientAttachment & { folder?: string | null }).folder;
  return value?.trim() ? value : null;
}

/** A file surfaced from another record rather than uploaded here directly. */
function isSmartLink(file: ClientAttachment): boolean {
  const source = (file.source ?? '').toLowerCase();
  return source.startsWith('capability:') || source.includes('meeting') || source.includes('hearing');
}

function sourceLabel(source: string | null | undefined): string {
  const value = (source ?? '').toLowerCase();
  if (value.startsWith('capability:')) return 'Capability';
  if (value.includes('hearing')) return 'Hearing recap';
  if (value.includes('meeting')) return 'Meeting';
  if (value.includes('memo') || value.includes('generated')) return 'Generated';
  if (value.includes('mail') || value.includes('email')) return 'Email';
  return 'Uploaded';
}
