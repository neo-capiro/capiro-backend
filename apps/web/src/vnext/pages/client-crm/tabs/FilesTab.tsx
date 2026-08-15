import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { FILES, FOLDERS } from '../portfolio-fixtures.js';

/**
 * Files tab (spec §11, Figma geometry from `dom-tab-files.txt`).
 *
 * Data binding:
 *  - The file list reuses the canonical attachments query
 *    (`['client-attachments', client.id]` — same key as the profile, so
 *    uploads invalidate both surfaces). When the service returns rows they
 *    are mapped onto the design's row shape; while loading, on error, or
 *    when the client has no attachments, the design's FILES fixture renders
 *    so the surface stays pixel-reviewable (flagged UI-only).
 *  - The folder tree, folder counts, the storage meter and the smart-link
 *    provenance copy are designed UI (§11) with no per-client backend — they
 *    render the FOLDERS fixture in every mode.
 *  - `All source links healthy` is a designed status pill (UI-only).
 */

/* ── view models ──────────────────────────────────────────────────────────── */

interface FileRowModel {
  id: string;
  ext: string;
  name: string;
  smart: boolean;
  linked: string;
  modified: string;
  modifiedTs: number;
  owner: string;
  status: string;
  tone: PillTone;
  /** Fixture folder id, or the real folder label for attachments. */
  folder: string | null;
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
const FALLBACK_FOLDER: FolderFixture = {
  id: 'root',
  label: 'Overland AI',
  count: 28,
  subs: 7,
  depth: 0,
  kids: true,
  open: true,
  crumb: 'Overland AI',
};

/* ── fixture + real-row mapping ───────────────────────────────────────────── */

function fixtureRow(f: (typeof FILES)[number] & { smart?: boolean }): FileRowModel {
  return {
    id: f.id,
    ext: f.ext,
    name: f.name,
    smart: Boolean(f.smart),
    linked: f.linked,
    modified: f.modified,
    modifiedTs: 0,
    owner: f.owner,
    status: f.status,
    tone: toneOf(f.ui),
    folder: f.folder,
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
  return {
    id: file.id,
    ext: extOf(file.fileName),
    name: baseOf(file.fileName),
    smart,
    linked: smart ? sourceLabel(file.source) : (folder ?? 'Unfiled'),
    modified: shortDate(file.createdAt),
    modifiedTs: Date.parse(file.createdAt) || 0,
    owner: file.uploadedByName?.split(' ')[0] ?? '—',
    status: file.indexedAt ? 'Indexed' : 'Uploaded',
    tone: file.indexedAt ? 'success' : 'gray',
    folder,
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
  const narrow = usePfNarrow();

  const [folderId, setFolderId] = useState<string>('fy27');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>('modified');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // Same key as the canonical profile surface — one shared cache entry.
  const filesQuery = useQuery<ClientAttachment[]>({
    queryKey: ['client-attachments', client.id],
    queryFn: async () =>
      (
        await api.get<ClientAttachment[]>('/api/engagement/attachments', {
          params: { clientId: client.id },
        })
      ).data,
  });

  const real = filesQuery.data !== undefined && !filesQuery.isError && filesQuery.data.length > 0;

  const folders = FOLDERS as FolderFixture[];
  const current = folders.find((f) => f.id === folderId) ?? FALLBACK_FOLDER;

  const allRows: FileRowModel[] = useMemo(
    () => (real ? (filesQuery.data ?? []).map(attachmentRow) : FILES.map(fixtureRow)),
    [real, filesQuery.data],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Search spans every folder (prototype behaviour); otherwise scope to the
    // selected folder — fixtures match on folder id, real attachments on the
    // folder label (the fixture tree is designed UI, §11).
    let shown = needle
      ? allRows.filter((row) => `${row.name} ${row.linked}`.toLowerCase().includes(needle))
      : allRows.filter((row) => {
          if (folderId === 'root') return true;
          return real ? (row.folder ?? '').toLowerCase() === current.label.toLowerCase() : row.folder === folderId;
        });
    if (filter === 'documents') shown = shown.filter((row) => !row.smart);
    else if (filter === 'smart') shown = shown.filter((row) => row.smart);
    else if (filter === 'client') shown = shown.filter((row) => row.owner === 'Client');
    else if (filter === 'meri') shown = shown.filter((row) => row.owner === 'Meri');
    if (sort === 'name') shown = [...shown].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'owner') shown = [...shown].sort((a, b) => a.owner.localeCompare(b.owner));
    else if (real) shown = [...shown].sort((a, b) => b.modifiedTs - a.modifiedTs);
    return shown;
  }, [allRows, query, folderId, filter, sort, real, current.label]);

  const smartCount = rows.filter((row) => row.smart).length;
  const allChecked = rows.length > 0 && rows.every((row) => selected.has(row.id));

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

  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TabPageHead
        title="Client files"
        sub="A folder-based client file room for uploads, Capiro artifacts, and provenance-preserving smart references."
        actions={
          <>
            <PfButton variant="secondary">New folder</PfButton>
            <PfButton variant="secondary">Upload</PfButton>
            <PfButton variant="primary">Create with Meri</PfButton>
          </>
        }
      />

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
            boxShadow: 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)',
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
            background: '#F2F4F7',
            boxShadow: 'inset 0 0 0 1px #D0D5DD',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: '#101828' }}>{`${selected.size} selected`}</span>
          <span style={{ flex: 1 }} />
          <PfButton variant="primary" size="sm">
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
            boxShadow: '0 0 0 1px #EAECF0,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px rgba(16,24,40,.06)',
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
            <PfButton variant="link" style={{ fontSize: 13 }}>
              Manage
            </PfButton>
          </div>
          <div style={{ padding: '0 10px 12px' }}>
            {folders.map((folder) => (
              <FolderTreeRow key={folder.id} folder={folder} active={folder.id === folderId} onPick={() => pickFolder(folder.id)} />
            ))}
          </div>
          <div style={{ padding: '16px 20px 20px', borderTop: '1px solid #EAECF0' }}>
            <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
              Client storage
            </div>
            <div style={{ marginTop: 6, fontSize: 16, fontWeight: 600, color: '#101828' }}>1.8 GB of 10 GB</div>
            <span style={{ display: 'block', marginTop: 8, height: 6, borderRadius: 3, background: '#F2F4F7', overflow: 'hidden' }}>
              <span style={{ display: 'block', height: 6, width: '18%', borderRadius: 3, background: GRADIENT_DARK }} />
            </span>
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
            boxShadow: '0 0 0 1px #EAECF0,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px rgba(16,24,40,.06)',
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
                {`${current.count} files · ${current.subs} subfolders`}
              </span>
            </span>
            <PfButton variant="secondary" size="sm" style={{ flex: '0 0 auto' }}>
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
                  background: '#F9FAFB',
                  borderTop: '1px solid #EAECF0',
                  borderBottom: '1px solid #EAECF0',
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

              {rows.length === 0 ? (
                <div style={{ padding: '24px', fontSize: 14, color: '#667085' }}>No files match this view.</div>
              ) : (
                rows.map((row, i) => (
                  <FileRow
                    key={row.id}
                    row={row}
                    checked={selected.has(row.id)}
                    bg={selected.has(row.id) ? '#F2F4F7' : i % 2 === 1 ? '#FCFCFD' : '#ffffff'}
                    onToggle={() => toggleRow(row.id)}
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
              background: '#FCFCFD',
              borderTop: '1px solid #EAECF0',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 14, color: '#475467' }}>{`${rows.length} files · ${smartCount} smart links`}</span>
            <span style={{ flex: 1 }} />
            {/* Designed status — no link-health backend (UI-only). */}
            <Pill tone="success" size="lg">
              All source links healthy
            </Pill>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ── pieces ───────────────────────────────────────────────────────────────── */

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
        background: active ? '#F2F4F7' : hover ? '#F9FAFB' : '#ffffff',
        boxShadow: 'inset 0 0 0 1px #D0D5DD',
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
        background: hover ? '#F2F4F7' : 'transparent',
        boxShadow: 'inset 0 0 0 1px #EAECF0',
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

function FolderTreeRow({ folder, active, onPick }: { folder: FolderFixture; active: boolean; onPick: () => void }) {
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
        background: active ? '#F2F4F7' : hover ? '#F9FAFB' : 'transparent',
        boxShadow: active ? 'inset 0 0 0 1px #D0D5DD' : 'none',
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
      <span style={{ flex: '0 0 auto', fontSize: 13, color: '#667085' }}>{folder.count}</span>
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
          boxShadow: checked ? 'inset 0 0 0 1px #101828' : 'inset 0 0 0 1px #D0D5DD',
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
  checked,
  bg,
  onToggle,
}: {
  row: FileRowModel;
  checked: boolean;
  bg: string;
  onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [menuHover, setMenuHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 24px',
        borderBottom: '1px solid #EAECF0',
        background: hover && !checked ? '#F9FAFB' : bg,
      }}
    >
      <Checkbox checked={checked} onToggle={onToggle} ariaLabel={`Select ${row.name}`} />
      <button type="button" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
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
            background: '#F9FAFB',
            boxShadow: 'inset 0 0 0 1px #EAECF0',
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
                  background: '#F2F4F7',
                  boxShadow: 'inset 0 0 0 1px #D0D5DD',
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
      <button
        type="button"
        aria-label={`More actions for ${row.name}`}
        onMouseEnter={() => setMenuHover(true)}
        onMouseLeave={() => setMenuHover(false)}
        style={{ flex: '0 0 auto', width: 28, display: 'flex', justifyContent: 'center', color: menuHover ? '#101828' : '#667085' }}
      >
        <UIcon name="DotsHorizontal" size={18} />
      </button>
    </div>
  );
}
