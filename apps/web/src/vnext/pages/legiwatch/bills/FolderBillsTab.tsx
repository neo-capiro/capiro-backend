import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect, CapiroTextarea } from '../../../components/fields/index.js';
import { CapiroModal, CapiroDrawer } from '../../../components/overlays/index.js';
import {
  CapiroTable,
  CapiroTableWrap,
  CapiroTableHead,
  CapiroTableBody,
  CapiroTableHeaderCell as TH,
  CapiroTableCell as TD,
} from '../../../components/tables/index.js';
import { Bill360Drawer } from './Bill360Drawer.js';
import { FolderContextEditor, importanceOptions, positionOptions } from './FolderContextPanel.js';
import {
  FOLDER_BASE,
  folderError,
  folderKey,
  downloadFolderCsv,
  type Folder,
  type FolderBill,
  type FolderPage,
} from './folder-api.js';
import { FolderImportReview } from './FolderImportReview.js';
import './folder-tracker.css';
import { ReportWorkspace } from '../reports/ReportWorkspace.js';
import { useReportsFlag } from '../reports/report-api.js';

type Resolution = {
  token: string;
  status: string;
  bill: FolderBill | null;
  reason: string | null;
  alreadyIn?: string[];
};
const option = (value: string, label = value) => ({ value, label });
const optionalColumns = [
  'sponsor',
  'status',
  'lastAction',
  'priority',
  'position',
  'added',
] as const;
const columnLabels = [
  'Sponsor',
  'Public status',
  'Last action',
  'Priority / importance',
  'Position',
  'Date foldered',
];
const emptyContext = {
  topPriority: false,
  importance: 'normal',
  position: 'none',
  internalComments: '',
  externalComments: '',
  version: 0,
};

export function FolderBillsTab({ scope, clients }: { scope: string; clients: Client[] }) {
  const reportsFlag = useReportsFlag();
  const [reportsOpen, setReportsOpen] = useState(false);
  useEffect(() => { setReportsOpen(false); }, [reportsFlag.scope]);
  const api = useApi(),
    identity = useApiScope(),
    qc = useQueryClient(),
    navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const visibleColumns = new Set(
    (params.get('folderColumns') ?? optionalColumns.join(',')).split(','),
  );
  const displayComments = params.get('folderDisplayComments') ?? 'none';
  const [folderFilter, setFolderFilter] = useState(''),
    [railOpen, setRailOpen] = useState(false),
    [showArchived, setShowArchived] = useState(false);
  const [editFolder, setEditFolder] = useState<Folder | null | undefined>(),
    [contextRow, setContextRow] = useState<FolderBill | null>(null),
    [bill, setBill] = useState<FolderBill | null>(null);
  const [fastOpen, setFastOpen] = useState(false),
    [viewOpen, setViewOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]),
    [cursor, setCursor] = useState<string | undefined>(),
    [pages, setPages] = useState<Array<string | undefined>>([]);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [removeOpen, setRemoveOpen] = useState(false);
  const folders = useQuery({
    queryKey: [...folderKey(identity), 'list'],
    queryFn: async () => (await api.get<Folder[]>(FOLDER_BASE)).data,
    retry: false,
  });
  const folderId = params.get('folder') ?? '',
    allFolders = params.get('folderAll') === '1';
  const active = (folders.data ?? []).find(
    (f) => f.id === folderId && (!scope || f.clientId === scope),
  );
  const jurisdiction = params.get('jurisdiction') ?? active?.jurisdiction ?? 'FL';
  const sessions = useQuery({
    queryKey: [...folderKey(identity), 'sessions', jurisdiction],
    queryFn: async () =>
      (
        await api.get<Array<{ key: string; label: string }>>(
          `${FOLDER_BASE}/sessions/${jurisdiction}`,
        )
      ).data,
    retry: false,
  });
  const session =
    params.get('session') ??
    (active?.jurisdiction === jurisdiction && active.defaultSession !== 'current'
      ? active.defaultSession
      : undefined) ??
    sessions.data?.find((s) => /^\d+$/.test(s.key))?.key ??
    '';
  const search = params.get('folderSearch') === '1';
  const query = {
    ...(folderId ? { folderId } : {}),
    ...(!search && scope ? { clientId: scope } : {}),
    jurisdiction,
    sessionKey: session,
    q: params.get('folderQ') ?? '',
    sponsor: params.get('folderSponsor') ?? '',
    status: params.get('folderStatus') ?? '',
    ...(params.get('folderChamber') ? { chamber: params.get('folderChamber') } : {}),
    ...(params.get('folderComments') ? { comments: params.get('folderComments') } : {}),
    ...(params.get('folderPriority') ? { topPriority: params.get('folderPriority') } : {}),
    ...(params.get('folderImportance') ? { importance: params.get('folderImportance') } : {}),
    ...(params.get('folderPosition') ? { position: params.get('folderPosition') } : {}),
    sort: params.get('folderSort') ?? 'bill',
    direction: params.get('folderDirection') ?? 'asc',
  };
  const queryId = JSON.stringify(query) + search;
  const setFilters = (values: Record<string, string>) => {
    setCursor(undefined);
    setPages([]);
    setSelected([]);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(values)) {
        value ? next.set(key, value) : next.delete(key);
      }
      return next;
    });
  };
  const setFilter = (key: string, value: string) => setFilters({ [key]: value });
  useEffect(() => {
    setSelected([]);
    setCursor(undefined);
    setPages([]);
  }, [queryId]);
  useEffect(() => {
    if (!folderId && !allFolders && !search && folders.data?.length) {
      const first = folders.data.find((f) => !f.archived && (!scope || f.clientId === scope));
      if (first)
        setParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set('folder', first.id);
            return next;
          },
          { replace: true },
        );
    }
  }, [folderId, allFolders, search, folders.data, scope, setParams]);
  const board = useQuery({
    queryKey: [...folderKey(identity), 'board', query, search, cursor],
    queryFn: async () =>
      (
        await api.get<FolderPage>(`${FOLDER_BASE}/${search ? 'search' : 'board'}`, {
          params: { ...query, cursor, limit: 50 },
        })
      ).data,
    enabled: Boolean(session) && (!folderId || Boolean(active)),
    retry: false,
  });
  const rows = board.data?.rows ?? [];
  const chosen = rows.filter((r) => selected.includes(r.assignmentId ?? r.id));
  const refresh = () => qc.invalidateQueries({ queryKey: folderKey(identity) });
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(folderError(e));
    } finally {
      setBusy(false);
    }
  };
  const bulk = async (action: 'add' | 'remove') =>
    perform(async () => {
      const result = (
        await api.post<{ results: Array<{ billId: string; status: string }> }>(
          `${FOLDER_BASE}/${folderId}/bills`,
          { action, billIds: chosen.map((r) => r.id) },
        )
      ).data;
      setNotice(
        result.results
          .map(
            (r) =>
              `${rows.find((x) => x.id === r.billId)?.number ?? r.billId}: ${r.status.replaceAll('_', ' ')}`,
          )
          .join(' · '),
      );
      setSelected([]);
      setRemoveOpen(false);
    });
  const pick = (id: string) => {
    setFilters({ folder: id, folderAll: '', folderSearch: '', session: '' });
    setRailOpen(false);
  };
  const rail = (
    <nav aria-label="Working folders" className="lw-folder-rail">
      <div className="lw-folder-actions">
        <h2>Folders</h2>
        <CapiroButton size="compact" onClick={() => setEditFolder(null)}>
          New folder
        </CapiroButton>
      </div>
      <CapiroInput
        label="Find folder"
        value={folderFilter}
        onChange={(e) => setFolderFilter(e.target.value)}
      />
      <button
        className="lw-folder-choice"
        aria-current={allFolders ? 'page' : undefined}
        onClick={() => {
          setFilters({ folder: '', folderAll: '1', folderSearch: '' });
          setRailOpen(false);
        }}
      >
        All folder assignments
      </button>
      {(folders.data ?? [])
        .filter(
          (f) =>
            (showArchived || !f.archived) &&
            (!scope || f.clientId === scope) &&
            `${f.name} ${f.code ?? ''}`.toLowerCase().includes(folderFilter.toLowerCase()),
        )
        .map((f) => (
          <button
            key={f.id}
            className="lw-folder-choice"
            aria-current={f.id === folderId ? 'page' : undefined}
            onClick={() => pick(f.id)}
          >
            <span>
              {f.name}
              <small>
                {[
                  f.code,
                  f.archived
                    ? 'Archived'
                    : f.otherUserAccess === 'read_only'
                      ? 'Read only for others'
                      : 'Read and change',
                  f.ownerClerkId ?? 'Owner pending',
                  f.id.slice(0, 8),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </span>
            <span>{f.count}</span>
          </button>
        ))}
      {folders.isPending && <p role="status">Loading folders…</p>}
      <label className="lw-folder-check">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />{' '}
        Show archived folders
      </label>
      <CapiroButton size="compact" onClick={() => setImportOpen(true)}>
        Import review
      </CapiroButton>
    </nav>
  );
  return (
    <section className="lw-folders" aria-label="Bill folders">
      {reportsOpen && reportsFlag.enabled && <CapiroModal open title="Reports and updates" width={1280} onClose={() => setReportsOpen(false)}><ReportWorkspace initialFolderId={active?.id} /></CapiroModal>}
      <aside className="lw-folder-rail-desktop">{rail}</aside>
      <div className="lw-folder-main">
        <div className="lw-folder-heading">
          <div>
            <CapiroButton
              className="lw-folder-mobile"
              size="compact"
              onClick={() => setRailOpen(true)}
            >
              Folders
            </CapiroButton>
            <h2>
              {search
                ? 'Find bills'
                : (active?.name ?? (allFolders ? 'All folder assignments' : 'Bill folders'))}
            </h2>
            <p>
              {active?.archived
                ? 'Archived folder'
                : active && !active.ownerClerkId
                  ? 'Owner mapping pending'
                  : scope
                    ? 'Selected client lens'
                    : 'All clients'}{' '}
              · {board.data?.total ?? 0} {search ? 'bills' : 'assignments'}
            </p>
          </div>
          <div className="lw-folder-actions">
            {reportsFlag.enabled && <CapiroButton size="compact" onClick={() => setReportsOpen(true)}>Reports</CapiroButton>}
            {active && (
              <CapiroButton
                size="compact"
                onClick={() => setEditFolder(active)}
                disabled={!active.canManage && !active.canEdit}
              >
                Folder settings
              </CapiroButton>
            )}
            <CapiroButton
              size="compact"
              onClick={() => setFilter('folderSearch', search ? '' : '1')}
            >
              {search ? 'Back to folder' : 'Find bills'}
            </CapiroButton>
            <CapiroButton
              size="compact"
              variant="primary"
              disabled={!active?.canEdit}
              onClick={() => setFastOpen(true)}
            >
              FastTagger
            </CapiroButton>
            <CapiroButton
              size="compact"
              disabled={!board.data?.total || search}
              onClick={() => setExportOpen(true)}
            >
              Export
            </CapiroButton>
          </div>
        </div>
        <div className="lw-folder-filters">
          <CapiroSelect
            label="Jurisdiction"
            value={jurisdiction}
            options={[
              option('FL', 'Florida'),
              option('US', 'Federal'),
              option('CA', 'California'),
              option('TX', 'Texas'),
              option('NY', 'New York'),
              option('VA', 'Virginia'),
            ]}
            onChange={(e) => {
              setFilters({ jurisdiction: e.target.value, session: '' });
            }}
          />
          <CapiroSelect
            label="Session"
            value={session}
            options={
              sessions.data?.length
                ? sessions.data.map((s) => option(s.key, s.label))
                : [option('', 'No sessions available')]
            }
            onChange={(e) => setFilter('session', e.target.value)}
          />
          <CapiroInput
            label="Search bill or title"
            value={query.q}
            maxLength={200}
            onChange={(e) => setFilter('folderQ', e.target.value)}
            helpText="Searches bill metadata"
          />
          <CapiroInput
            label="Sponsor"
            value={query.sponsor}
            maxLength={100}
            onChange={(e) => setFilter('folderSponsor', e.target.value)}
          />
          <CapiroSelect
            label="Sort by"
            value={query.sort}
            options={[
              option('bill', 'Bill number'),
              option('title', 'Title'),
              option('sponsor', 'Sponsor'),
              option('lastAction', 'Last action'),
              option('added', 'Date foldered'),
            ]}
            onChange={(e) => setFilter('folderSort', e.target.value)}
          />
          <CapiroButton
            size="compact"
            onClick={() => setFilter('folderDirection', query.direction === 'asc' ? 'desc' : 'asc')}
          >
            {query.direction === 'asc' ? 'Ascending' : 'Descending'}
          </CapiroButton>
        </div>
        <div className="lw-folder-filters lw-folder-filters--context">
          <CapiroSelect
            label="Chamber"
            value={params.get('folderChamber') ?? ''}
            options={[
              option('', 'All chambers'),
              option('lower', 'House / Assembly'),
              option('upper', 'Senate'),
            ]}
            onChange={(e) => setFilter('folderChamber', e.target.value)}
          />
          <CapiroSelect
            label="Comments"
            value={params.get('folderComments') ?? ''}
            options={[
              option('', 'All comments'),
              option('internal', 'Has internal comments'),
              option('external', 'Has external comments'),
              option('any', 'Has any comments'),
              option('none', 'No comments'),
            ]}
            onChange={(e) => setFilter('folderComments', e.target.value)}
          />
          <CapiroSelect
            label="Priority"
            value={params.get('folderPriority') ?? ''}
            options={[
              option('', 'All priorities'),
              option('true', 'Top priority'),
              option('false', 'Standard'),
            ]}
            onChange={(e) => setFilter('folderPriority', e.target.value)}
          />
          <CapiroSelect
            label="Importance"
            value={params.get('folderImportance') ?? ''}
            options={[option('', 'All importance'), ...importanceOptions]}
            onChange={(e) => setFilter('folderImportance', e.target.value)}
          />
          <CapiroSelect
            label="Position"
            value={params.get('folderPosition') ?? ''}
            options={[option('', 'All positions'), ...positionOptions]}
            onChange={(e) => setFilter('folderPosition', e.target.value)}
          />
          <CapiroInput
            label="Public status"
            value={query.status}
            onChange={(e) => setFilter('folderStatus', e.target.value)}
            placeholder="Exact recorded status"
          />
          <p aria-live="polite">{selected.length} selected on this page</p>
          <CapiroButton size="compact" onClick={() => setViewOpen(true)}>
            View
          </CapiroButton>
          {search ? (
            <CapiroButton
              size="compact"
              disabled={!active?.canEdit || !selected.length || busy}
              onClick={() => void bulk('add')}
            >
              Add selected
            </CapiroButton>
          ) : (
            <CapiroButton
              size="compact"
              disabled={!active?.canEdit || !selected.length || busy}
              onClick={() => setRemoveOpen(true)}
            >
              Remove selected
            </CapiroButton>
          )}
        </div>
        {error && (
          <p role="alert" className="lw-folder-message">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="lw-folder-message">
            {notice}
          </p>
        )}
        {folderId && folders.isSuccess && !active ? (
          <p role="alert">
            The saved folder is unavailable in this workspace. Choose an accessible folder to
            continue.
          </p>
        ) : folders.isError || board.isError || sessions.isError ? (
          <div role="alert">
            <p>Bill folders could not be loaded.</p>
            <CapiroButton onClick={() => void refresh()}>Retry</CapiroButton>
          </div>
        ) : board.isPending && session ? (
          <p role="status">Loading bills…</p>
        ) : !session ? (
          <p>
            No canonical bills are available for this jurisdiction. Select another jurisdiction or
            review source ingestion.
          </p>
        ) : (
          <>
            <CapiroTableWrap className="lw-folder-table-wrap">
              <CapiroTable
                className={`lw-folder-table ${params.get('folderDensity') === 'comfortable' ? 'lw-folder-table--comfortable' : ''}`}
                aria-label="Folder bill table"
              >
                <CapiroTableHead>
                  <tr>
                    <TH>
                      <input
                        type="checkbox"
                        aria-label="Select this page"
                        checked={rows.length > 0 && selected.length === rows.length}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked ? rows.map((r) => r.assignmentId ?? r.id) : [],
                          )
                        }
                      />
                    </TH>
                    <TH
                      aria-sort={
                        query.sort === 'bill'
                          ? query.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      Bill
                    </TH>
                    <TH
                      aria-sort={
                        query.sort === 'title'
                          ? query.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      Title
                    </TH>
                    <TH
                      hidden={!visibleColumns.has('sponsor')}
                      aria-sort={
                        query.sort === 'sponsor'
                          ? query.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      Sponsor
                    </TH>
                    <TH hidden={!visibleColumns.has('status')}>Public status</TH>
                    <TH
                      hidden={!visibleColumns.has('lastAction')}
                      aria-sort={
                        query.sort === 'lastAction'
                          ? query.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      Last action
                    </TH>
                    <TH hidden={!visibleColumns.has('priority')}>Priority / importance</TH>
                    <TH hidden={!visibleColumns.has('position')}>Position</TH>
                    <TH hidden={!visibleColumns.has('added')}>Date foldered</TH>
                    <TH>Context</TH>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {rows.map((r) => (
                    <tr key={r.assignmentId ?? r.id}>
                      <TD>
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.number}`}
                          checked={selected.includes(r.assignmentId ?? r.id)}
                          onChange={(e) =>
                            setSelected((prev) =>
                              e.target.checked
                                ? [...prev, r.assignmentId ?? r.id]
                                : prev.filter((id) => id !== (r.assignmentId ?? r.id)),
                            )
                          }
                        />
                      </TD>
                      <TD>
                        <button className="lw-folder-bill-link" onClick={() => setBill(r)}>
                          {r.number}
                        </button>
                      </TD>
                      <TD>
                        <span className="lw-folder-title" title={r.title}>
                          {r.title}
                        </span>
                        {(displayComments === 'internal' || displayComments === 'all') &&
                          r.internalComments && (
                            <p className="lw-folder-inline-comment lw-folder-internal">
                              <strong>Internal: </strong>
                              {r.internalComments}
                            </p>
                          )}
                        {(displayComments === 'external' || displayComments === 'all') &&
                          r.externalComments && (
                            <p className="lw-folder-inline-comment">
                              <strong>External: </strong>
                              {r.externalComments}
                            </p>
                          )}
                      </TD>
                      <TD hidden={!visibleColumns.has('sponsor')}>{r.sponsor ?? 'Unresolved'}</TD>
                      <TD hidden={!visibleColumns.has('status')}>
                        {r.status?.replaceAll('_', ' ') ?? 'Unavailable'}
                      </TD>
                      <TD hidden={!visibleColumns.has('lastAction')}>
                        <span className="lw-folder-title" title={r.latestAction ?? undefined}>
                          {r.latestAction ?? 'Action unavailable'}
                        </span>
                        <small>{r.latestActionAt?.slice(0, 10) ?? 'Date unavailable'}</small>
                      </TD>
                      <TD hidden={!visibleColumns.has('priority')}>
                        {r.assignmentId ? (
                          <>
                            {r.topPriority && <strong>Top priority · </strong>}
                            {r.importance ?? 'normal'}
                          </>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD hidden={!visibleColumns.has('position')}>{r.position ?? '—'}</TD>
                      <TD hidden={!visibleColumns.has('added')}>
                        <span
                          title={r.addedDateRaw ? 'Source local time; timezone unknown' : undefined}
                        >
                          {r.addedDateRaw ?? r.addedAt?.slice(0, 10) ?? '—'}
                        </span>
                      </TD>
                      <TD>
                        {r.assignmentId ? (
                          <CapiroButton
                            size="compact"
                            variant="quiet"
                            disabled={!folders.data?.find((f) => f.id === r.folderId)?.canEdit}
                            onClick={() => setContextRow(r)}
                          >
                            Edit
                          </CapiroButton>
                        ) : (
                          'Not in folder'
                        )}
                      </TD>
                    </tr>
                  ))}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
            {!rows.length && (
              <p className="lw-folder-empty">
                {search
                  ? 'No bills match this jurisdiction, session and filters.'
                  : active?.count
                    ? 'No assignments match these filters.'
                    : 'This folder has no bills yet. Use Find bills or FastTagger to add bills.'}
              </p>
            )}
            <div className="lw-folder-pagination">
              <span>
                {board.data?.total ?? 0} results · page {pages.length + 1}
              </span>
              <CapiroButton
                size="compact"
                disabled={!pages.length}
                onClick={() => {
                  setCursor(pages[pages.length - 1]);
                  setPages(pages.slice(0, -1));
                  setSelected([]);
                }}
              >
                Previous
              </CapiroButton>
              <CapiroButton
                size="compact"
                disabled={!board.data?.nextCursor}
                onClick={() => {
                  setPages([...pages, cursor]);
                  setCursor(board.data?.nextCursor ?? undefined);
                  setSelected([]);
                }}
              >
                Next
              </CapiroButton>
            </div>
          </>
        )}
      </div>
      <CapiroModal
        open={viewOpen}
        title="Table view"
        onClose={() => setViewOpen(false)}
        width={480}
      >
        <div className="lw-folder-form">
          <CapiroSelect
            label="Density"
            value={params.get('folderDensity') ?? 'compact'}
            options={[option('compact', 'Compact'), option('comfortable', 'Comfortable')]}
            onChange={(e) => setFilter('folderDensity', e.target.value)}
          />
          <CapiroSelect
            label="Display comments"
            value={displayComments}
            options={[
              option('none', 'Hidden'),
              option('external', 'External'),
              option('internal', 'Internal'),
              option('all', 'All comments'),
            ]}
            onChange={(e) => setFilter('folderDisplayComments', e.target.value)}
          />
          <p>Columns</p>
          {optionalColumns.map((key, i) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={visibleColumns.has(key)}
                onChange={(e) => {
                  const next = new Set(visibleColumns);
                  e.target.checked ? next.add(key) : next.delete(key);
                  setFilter('folderColumns', [...next].join(',') || 'none');
                }}
              />
              {columnLabels[i]}
            </label>
          ))}
          <CapiroButton onClick={() => setViewOpen(false)}>Done</CapiroButton>
        </div>
      </CapiroModal>
      <CapiroDrawer
        open={railOpen}
        title="Working folders"
        onClose={() => setRailOpen(false)}
        width="min(320px, 100vw)"
      >
        {rail}
      </CapiroDrawer>
      {editFolder !== undefined && (
        <FolderForm
          key={editFolder ? `${editFolder.id}:${editFolder.version}` : 'new'}
          initial={editFolder}
          clients={clients}
          defaultClientId={scope}
          onReload={async () => {
            const current = (await api.get<Folder[]>(FOLDER_BASE)).data.find(
              (f) => f.id === editFolder?.id,
            );
            if (!current) throw new Error('Folder is no longer available');
            setEditFolder(current);
            await refresh();
          }}
          onClose={() => setEditFolder(undefined)}
          onSave={async (values) => {
            if (editFolder)
              await api.put(`${FOLDER_BASE}/${editFolder.id}`, {
                ...values,
                expectedVersion: editFolder.version,
              });
            else {
              const created = (await api.post<Folder>(FOLDER_BASE, values)).data;
              if (!scope || created.clientId === scope) pick(created.id);
              else
                setNotice(
                  'Folder created outside this client lens. Choose All clients to open it.',
                );
            }
            await refresh();
          }}
        />
      )}
      {contextRow && (
        <FolderContextEditor
          initial={{ ...emptyContext, ...contextRow }}
          label={`${contextRow.number} · ${folders.data?.find((f) => f.id === contextRow.folderId)?.name ?? 'Selected folder'}`}
          onReload={async () => {
            const result = (
              await api.get<{ assignment: FolderBill | null }>(
                `${FOLDER_BASE}/${contextRow.folderId}/bills/${encodeURIComponent(contextRow.id)}/context`,
              )
            ).data;
            if (!result.assignment) throw new Error('Assignment unavailable');
            return result.assignment;
          }}
          onClose={() => setContextRow(null)}
          onSave={async (values) => {
            await api.put(
              `${FOLDER_BASE}/${contextRow.folderId}/bills/${encodeURIComponent(contextRow.id)}/context`,
              values,
            );
            await refresh();
          }}
        />
      )}
      {fastOpen && active && (
        <FastTagger
          folder={active}
          folders={folders.data ?? []}
          jurisdiction={jurisdiction}
          session={session}
          onClose={() => setFastOpen(false)}
          onDone={refresh}
        />
      )}
      {exportOpen && (
        <FolderExport
          query={query}
          selectedIds={selected}
          total={board.data?.total ?? 0}
          onClose={() => setExportOpen(false)}
        />
      )}
      {importOpen && <FolderImportReview onClose={() => setImportOpen(false)} />}
      <CapiroModal
        open={removeOpen}
        title="Remove selected folder assignments"
        onClose={() => setRemoveOpen(false)}
      >
        <p>
          Remove {selected.length} selected assignments from {active?.name}? Their context in this
          folder will be removed. Other folders and client tracking are independent.
        </p>
        <CapiroButton onClick={() => setRemoveOpen(false)}>Cancel</CapiroButton>
        <CapiroButton loading={busy} onClick={() => void bulk('remove')}>
          Remove assignments
        </CapiroButton>
      </CapiroModal>
      {bill && (
        <Bill360Drawer
          billId={bill.id}
          clientId={
            folders.data?.find((f) => f.id === bill.folderId)?.clientId ?? active?.clientId ?? scope
          }
          folderId={bill.folderId ?? active?.id}
          onClose={() => setBill(null)}
          onOpenFull={() =>
            navigate(
              `/bills/${encodeURIComponent(bill.id)}?${new URLSearchParams({ ...((folders.data?.find((f) => f.id === bill.folderId)?.clientId ?? active?.clientId ?? scope) ? { client: (folders.data?.find((f) => f.id === bill.folderId)?.clientId ?? active?.clientId ?? scope)! } : {}), ...((bill.folderId ?? active?.id) ? { folder: (bill.folderId ?? active?.id)! } : {}) })}`,
            )
          }
        />
      )}
    </section>
  );
}

function FolderForm({
  initial,
  clients,
  defaultClientId,
  onSave,
  onClose,
  onReload,
}: {
  initial: Folder | null;
  clients: Client[];
  defaultClientId: string;
  onSave: (values: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const api = useApi(),
    identity = useApiScope();
  const members = useQuery({
    queryKey: [...folderKey(identity), 'members'],
    queryFn: async () =>
      (
        await api.get<{
          members: Array<{ id: string; name: string }>;
          currentActor: string;
          canAssignOwner: boolean;
        }>(`${FOLDER_BASE}/members`)
      ).data,
    retry: false,
  });
  const [owner, setOwner] = useState(initial?.ownerClerkId ?? ''),
    [jurisdiction, setJurisdiction] = useState(initial?.jurisdiction ?? 'FL'),
    [defaultSession, setDefaultSession] = useState(initial?.defaultSession ?? 'current');
  const sessions = useQuery({
    queryKey: [...folderKey(identity), 'sessions', jurisdiction],
    queryFn: async () =>
      (
        await api.get<Array<{ key: string; label: string }>>(
          `${FOLDER_BASE}/sessions/${jurisdiction}`,
        )
      ).data,
    retry: false,
  });
  const [name, setName] = useState(initial?.name ?? ''),
    [code, setCode] = useState(initial?.code ?? ''),
    [clientId, setClientId] = useState(initial ? (initial.clientId ?? '') : defaultClientId),
    [access, setAccess] = useState(initial?.otherUserAccess ?? 'read_change'),
    [archived, setArchived] = useState(initial?.archived ?? false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [discard, setDiscard] = useState(false);
  const [conflict, setConflict] = useState(false);
  const dirty =
    name !== (initial?.name ?? '') ||
    code !== (initial?.code ?? '') ||
    clientId !== (initial ? (initial.clientId ?? '') : defaultClientId) ||
    access !== (initial?.otherUserAccess ?? 'read_change') ||
    archived !== (initial?.archived ?? false) ||
    owner !== (initial?.ownerClerkId ?? '') ||
    jurisdiction !== (initial?.jurisdiction ?? 'FL') ||
    defaultSession !== (initial?.defaultSession ?? 'current');
  const close = () => (dirty ? setDiscard(true) : onClose());
  return (
    <CapiroModal open title={initial ? 'Folder settings' : 'Create folder'} onClose={close}>
      <form
        className="lw-folder-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onSave({
              name: name.trim(),
              code,
              clientId: clientId || null,
              otherUserAccess: access,
              archived,
              jurisdiction,
              defaultSession,
              ...(owner ? { ownerClerkId: owner } : {}),
            });
            onClose();
          } catch (err) {
            setError(folderError(err));
            setConflict((err as { response?: { status?: number } }).response?.status === 409);
          } finally {
            setBusy(false);
          }
        }}
      >
        <CapiroInput
          label="Folder name"
          required
          value={name}
          maxLength={160}
          onChange={(e) => setName(e.target.value)}
        />
        <CapiroInput
          label="Folder code"
          value={code}
          maxLength={40}
          onChange={(e) => setCode(e.target.value)}
        />
        <CapiroSelect
          label="Owner"
          value={owner || members.data?.currentActor || ''}
          disabled={initial ? !initial.canManage : !members.data?.canAssignOwner}
          options={members.data?.members.map((m) => option(m.id, m.name)) ?? []}
          onChange={(e) => setOwner(e.target.value)}
        />
        {members.isError && <p role="alert">Owner choices could not be loaded.</p>}
        <CapiroSelect
          label="Default jurisdiction"
          value={jurisdiction}
          options={[
            option('FL', 'Florida'),
            option('US', 'Federal'),
            option('CA', 'California'),
            option('TX', 'Texas'),
            option('NY', 'New York'),
            option('VA', 'Virginia'),
          ]}
          onChange={(e) => {
            setJurisdiction(e.target.value);
            setDefaultSession('current');
          }}
        />
        <CapiroSelect
          label="Default session"
          value={defaultSession}
          options={[
            option('current', 'Current regular session (dynamic)'),
            ...(sessions.data ?? []).map((s) => option(s.key, s.label)),
          ]}
          onChange={(e) => setDefaultSession(e.target.value)}
        />
        <CapiroSelect
          label="Client link"
          value={clientId}
          disabled={Boolean(initial && !initial.canManage)}
          options={[
            option('', 'Independent working folder'),
            ...clients.map((c) => option(c.id, c.name)),
          ]}
          onChange={(e) => setClientId(e.target.value)}
        />
        <CapiroSelect
          label="Other users"
          value={access}
          disabled={Boolean(initial && !initial.canManage)}
          options={[option('read_change', 'Read and change'), option('read_only', 'Read only')]}
          onChange={(e) => setAccess(e.target.value)}
        />
        {initial && (
          <label>
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />{' '}
            Archived
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        {discard ? (
          <div role="alert">
            <p>Discard unsaved folder changes?</p>
            <CapiroButton onClick={() => setDiscard(false)}>Keep editing</CapiroButton>
            <CapiroButton onClick={onClose}>Discard changes</CapiroButton>
          </div>
        ) : (
          <div className="lw-folder-actions">
            <CapiroButton onClick={close}>Cancel</CapiroButton>
            {conflict && (
              <CapiroButton
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onReload();
                  } catch (err) {
                    setError(folderError(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Reload latest and discard draft
              </CapiroButton>
            )}
            <CapiroButton
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!name.trim() || conflict}
            >
              Save folder
            </CapiroButton>
          </div>
        )}
      </form>
    </CapiroModal>
  );
}

function FastTagger({
  folder,
  folders,
  jurisdiction,
  session,
  onDone,
  onClose,
}: {
  folder: Folder;
  folders: Folder[];
  jurisdiction: string;
  session: string;
  onDone: () => Promise<unknown>;
  onClose: () => void;
}) {
  const api = useApi();
  const [targets, setTargets] = useState([folder.id]);
  const [text, setText] = useState(''),
    [rows, setRows] = useState<Resolution[]>([]),
    [checked, setChecked] = useState<string[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  return (
    <CapiroModal open title={`FastTagger · ${folder.name}`} onClose={onClose} width={680}>
      <p>
        {jurisdiction} · session {session}. Review resolved bills before adding them.
      </p>
      <fieldset>
        <legend>Target folders (up to 20)</legend>
        {folders
          .filter((f) => !f.archived)
          .map((f) => (
            <label key={f.id} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={targets.includes(f.id)}
                disabled={!f.canEdit || (!targets.includes(f.id) && targets.length >= 20)}
                onChange={(e) => {
                  setTargets((prev) =>
                    e.target.checked ? [...prev, f.id] : prev.filter((id) => id !== f.id),
                  );
                  setRows([]);
                  setChecked([]);
                }}
              />
              {f.name} · {f.code ?? f.id.slice(0, 8)}
              {!f.canEdit ? ' · Read only' : ''}
            </label>
          ))}
      </fieldset>
      <CapiroTextarea
        label="Bill numbers"
        rows={3}
        value={text}
        maxLength={4000}
        onChange={(e) => {
          setText(e.target.value);
          setRows([]);
          setChecked([]);
        }}
        help="Separate bill numbers with commas or newlines, for example HB 299, SB 354."
      />
      <CapiroButton
        disabled={!text.trim() || !session || !targets.length}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          setResult('');
          try {
            const data = (
              await api.post<Resolution[]>(`${FOLDER_BASE}/resolve`, {
                jurisdiction,
                sessionKey: session,
                billNumbers: text,
                folderIds: targets,
              })
            ).data;
            setRows(data);
            setChecked(
              data
                .filter(
                  (r) =>
                    r.status === 'resolved' && r.bill && r.alreadyIn?.length !== targets.length,
                )
                .map((r) => r.bill!.id),
            );
          } catch (e) {
            setError(folderError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Resolve bills
      </CapiroButton>
      {!!rows.length && (
        <ul className="lw-folder-resolution">
          {rows.map((r, i) => (
            <li key={i}>
              <label>
                <input
                  type="checkbox"
                  disabled={
                    !r.bill || r.status !== 'resolved' || r.alreadyIn?.length === targets.length
                  }
                  checked={!!r.bill && checked.includes(r.bill.id)}
                  onChange={(e) =>
                    setChecked((prev) =>
                      e.target.checked
                        ? [...prev, r.bill!.id]
                        : prev.filter((id) => id !== r.bill!.id),
                    )
                  }
                />
                <strong>{r.token}</strong> · {r.status}
                {!!r.alreadyIn?.length &&
                  ` · Already present in ${r.alreadyIn.length} selected folder(s)`}
                {r.bill ? ` · ${r.bill.title}` : ` · ${r.reason ?? 'Repeated input'}`}
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      {result && <p role="status">{result}</p>}
      <div className="lw-folder-actions">
        <CapiroButton onClick={onClose}>Close</CapiroButton>
        <CapiroButton
          variant="primary"
          loading={busy}
          disabled={!checked.length}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const outcomes: string[] = [];
              for (const target of targets) {
                const data = (
                  await api.post<{ results: Array<{ billId: string; status: string }> }>(
                    `${FOLDER_BASE}/${target}/bills`,
                    { action: 'add', billIds: checked },
                  )
                ).data;
                outcomes.push(
                  data.results
                    .map(
                      (r) =>
                        `${folders.find((f) => f.id === target)?.name} / ${rows.find((x) => x.bill?.id === r.billId)?.token}: ${r.status.replaceAll('_', ' ')}`,
                    )
                    .join(' · '),
                );
                setResult(outcomes.join(' · '));
              }
              setChecked([]);
              await onDone();
            } catch (e) {
              setError(folderError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Add {checked.length} selected bills
        </CapiroButton>
      </div>
    </CapiroModal>
  );
}

function FolderExport({
  query,
  selectedIds,
  total,
  onClose,
}: {
  query: Record<string, unknown>;
  selectedIds: string[];
  total: number;
  onClose: () => void;
}) {
  const api = useApi();
  const [scope, setScope] = useState(selectedIds.length ? 'selected' : 'filtered'),
    [internal, setInternal] = useState(false),
    [external, setExternal] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <CapiroModal open title="Export folder bills" onClose={onClose}>
      <div className="lw-folder-form">
        <CapiroSelect
          label="Export scope"
          value={scope}
          options={[
            {
              value: 'selected',
              label: `Selected rows (${selectedIds.length})`,
              disabled: !selectedIds.length,
            },
            option('filtered', `All filtered rows (${total})`),
          ]}
          onChange={(e) => setScope(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={internal}
            onChange={(e) => setInternal(e.target.checked)}
          />{' '}
          Include folder internal comments
        </label>
        <label>
          <input
            type="checkbox"
            checked={external}
            onChange={(e) => setExternal(e.target.checked)}
          />{' '}
          Include folder external comments
        </label>
        <p>
          The CSV contains the exact selected scope across all pages. Downloading does not send it
          to clients.
        </p>
        {error && <p role="alert">{error}</p>}
        <CapiroButton
          loading={busy}
          variant="primary"
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const data = (
                await api.post<{ csv: string; count: number }>(`${FOLDER_BASE}/export`, {
                  ...query,
                  scope,
                  selectedIds,
                  includeInternalComments: internal,
                  includeExternalComments: external,
                })
              ).data;
              downloadFolderCsv(data.csv);
              onClose();
            } catch (e) {
              setError(folderError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Download CSV
        </CapiroButton>
      </div>
    </CapiroModal>
  );
}
