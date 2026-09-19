import { useEffect, useState } from 'react';
import { FolderResearchButton } from '../research/FolderResearchButton.js';
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
import { useBillAgendaPage } from '../hearings/BillAgenda.js';
import { FolderContextEditor, importanceOptions, positionOptions } from './FolderContextPanel.js';
import {
  FOLDER_BASE,
  folderError,
  folderKey,
  downloadFolderCsv,
  type ActivityPage,
  type ActivityRow,
  type Folder,
  type FolderBill,
  type FolderPage,
} from './folder-api.js';
import { FolderImportReview } from './FolderImportReview.js';
import './folder-tracker.css';
import { ReportWorkspace } from '../reports/ReportWorkspace.js';
import { KeywordReview, KEYWORD_FEATURE } from '../keywords/KeywordReview.js';
import { useReportsFlag } from '../reports/report-api.js';
import {
  STATE_CALENDAR_FEATURE,
  useIntelFeatureEnabled,
} from '../../../../lib/intel-feature-flags.js';

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
  const calendarEnabled = useIntelFeatureEnabled(STATE_CALENDAR_FEATURE);
  const keywordsEnabled = useIntelFeatureEnabled(KEYWORD_FEATURE);
  const workflowsEnabled = useIntelFeatureEnabled('legiwatch_internal_workflows_v1');
  const reportsFlag = useReportsFlag();
  const [reportsOpen, setReportsOpen] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  useEffect(() => {
    setReportsOpen(false);
  }, [reportsFlag.scope]);
  const api = useApi(),
    identity = useApiScope(),
    qc = useQueryClient(),
    navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.has('reportView')) setReportsOpen(true);
  }, [params]);
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
    [copyBills, setCopyBills] = useState<FolderBill[] | null>(null),
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
  // Resolve raw owner ids to member display names (existing /members contract);
  // fall back to the raw id when the member list is unavailable.
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
  const ownerName = (clerkId: string | null) =>
    clerkId ? (members.data?.members.find((m) => m.id === clerkId)?.name ?? clerkId) : null;
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
  // Global corpus search is the default whenever a query or an explicit
  // search-scope filter is present — there is no hidden mode to discover.
  // `folderSearch=1` keeps the corpus table visible after the query clears.
  const search =
    params.get('folderSearch') === '1' ||
    params.get('folderJurisdiction') === 'all' ||
    Boolean(params.get('folderSessionSearch'));
  const corpus = useQuery<{
    jurisdictions: Array<{ key: string; count: number }>;
    sessions: Array<{ jurisdiction: string; key: string; label: string; count: number }>;
  }>({
    queryKey: [...folderKey(identity), 'corpus-metadata'],
    queryFn: async () => (await api.get('/intel-api/legiwatch/bills/corpus-metadata')).data,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const activity = params.get('folderActivity') === '1';
  const summaryIncluded = params.get('folderSummaryView') === '1';
  // In search mode the corpus defaults to ALL available jurisdictions/sessions;
  // an explicit dropdown choice narrows it. The folder board keeps its
  // jurisdiction/session-scoped contract untouched.
  const effectiveJurisdiction = search
    ? params.get('folderJurisdiction') === 'all'
      ? undefined
      : params.get('folderJurisdiction') || undefined
    : jurisdiction;
  const effectiveSession = search ? params.get('folderSessionSearch') || undefined : session;
  const rawSort = params.get('folderSort') ?? 'bill';
  const query = {
    // Public corpus search: no folderId/clientId/private-context fields.
    ...(!search && folderId ? { folderId } : {}),
    ...(!search && scope ? { clientId: scope } : {}),
    ...(effectiveJurisdiction ? { jurisdiction: effectiveJurisdiction } : {}),
    ...(effectiveSession ? { sessionKey: effectiveSession } : {}),
    q: params.get('folderQ') ?? '',
    sponsor: params.get('folderSponsor') ?? '',
    status: params.get('folderStatus') ?? '',
    ...(params.get('folderChamber') ? { chamber: params.get('folderChamber') } : {}),
    ...(!search && params.get('folderComments') ? { comments: params.get('folderComments') } : {}),
    ...(!search && params.get('folderPriority')
      ? { topPriority: params.get('folderPriority') }
      : {}),
    ...(!search && params.get('folderImportance')
      ? { importance: params.get('folderImportance') }
      : {}),
    ...(!search && params.get('folderPosition') ? { position: params.get('folderPosition') } : {}),
    ...(params.get('folderSummary') ? { summary: params.get('folderSummary') } : {}),
    ...(params.get('folderActionText') ? { actionText: params.get('folderActionText') } : {}),
    ...(params.get('folderClassification')
      ? { classification: params.get('folderClassification') }
      : {}),
    ...(params.get('folderSubject') ? { subject: params.get('folderSubject') } : {}),
    ...(params.get('folderCommittee') ? { committee: params.get('folderCommittee') } : {}),
    ...(summaryIncluded ? { summaryIncluded: 'true' } : {}),
    sort: search && rawSort === 'added' ? 'bill' : rawSort,
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
        await api.get<FolderPage>(
          search ? '/intel-api/legiwatch/bills/search' : `${FOLDER_BASE}/board`,
          { params: { ...query, cursor, limit: 50 } },
        )
      ).data,
    // The daily-activity view owns its own query — never fetch a hidden board.
    enabled: (search || Boolean(session)) && (search || !folderId || Boolean(active)) && !activity,
    retry: false,
  });
  const rows = board.data?.rows ?? [];
  const billAgendas = useBillAgendaPage(
    rows.map((row) => row.id),
    calendarEnabled,
  );
  const agendaCounts = new Map<string, number>();
  for (const event of billAgendas.data?.items ?? []) {
    for (const id of new Set(
      (event.agenda ?? []).flatMap((item) => (item.bill ? [item.bill.id] : [])),
    ))
      agendaCounts.set(id, (agendaCounts.get(id) ?? 0) + 1);
  }
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
    setFilters({
      folder: id,
      folderAll: '',
      folderSearch: '',
      folderQ: '',
      folderJurisdiction: '',
      folderSessionSearch: '',
      session: '',
    });
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
          setFilters({
            folder: '',
            folderAll: '1',
            folderSearch: '',
            folderQ: '',
            folderJurisdiction: '',
            folderSessionSearch: '',
          });
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
                  ownerName(f.ownerClerkId) ?? 'Owner pending',
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
    // The folder branch mounts the module's standard padded body (24px gutters,
    // 20px top spacing, centered 1560 canvas) — same chrome as every other
    // LegiWatch page. The stage-board branch returns its own .lw-body.
    <div className="lw-body">
      <section className="lw-folders" aria-label="Bill folders">
        {reportsOpen && reportsFlag.enabled && (
          <CapiroModal
            open
            title="Reports and updates"
            width={720}
            onClose={() => {
              setReportsOpen(false);
              const next = new URLSearchParams(params);
              next.delete('reportView');
              setParams(next);
            }}
          >
            <div className="lw-reports-modal">
              <ReportWorkspace
                initialFolderId={active?.id}
                onClose={() => {
                  // The reference footer Close is the same existing close action
                  // as the dialog header X — relocated, not duplicated.
                  setReportsOpen(false);
                  const next = new URLSearchParams(params);
                  next.delete('reportView');
                  setParams(next);
                }}
              />
            </div>
          </CapiroModal>
        )}
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
                  ? 'All available bills'
                  : (active?.name ?? (allFolders ? 'All folder assignments' : 'Bill folders'))}
              </h2>
              <p>
                {activity ? (
                  <>
                    Daily original-record activity ·{' '}
                    {folderId
                      ? (active?.name ?? 'Selected folder')
                      : allFolders
                        ? 'All tracked assignments'
                        : 'Selected client'}
                  </>
                ) : search ? (
                  <>
                    {effectiveJurisdiction || effectiveSession
                      ? 'Filtered corpus'
                      : 'Every available federal and state bill'}{' '}
                    · {board.data?.total ?? 0} bills
                  </>
                ) : (
                  <>
                    {active?.archived
                      ? 'Archived folder'
                      : active && !active.ownerClerkId
                        ? 'Owner mapping pending'
                        : scope
                          ? 'Selected client'
                          : 'All clients'}{' '}
                    · {board.data?.total ?? 0} assignments
                  </>
                )}
              </p>
            </div>
            <div className="lw-folder-actions">
              {keywordsEnabled && active ? (
                <CapiroButton
                  size="compact"
                  aria-pressed={params.get('keywordReview') === '1'}
                  onClick={() =>
                    setFilter('keywordReview', params.get('keywordReview') === '1' ? '' : '1')
                  }
                >
                  Suggested bills
                </CapiroButton>
              ) : null}
              {active && reportsFlag.enabled && workflowsEnabled ? (
                <CapiroButton
                  size="compact"
                  onClick={() => {
                    setFilter('reportView', 'workflows');
                    setReportsOpen(true);
                  }}
                >
                  Follow-up workflows
                </CapiroButton>
              ) : null}
              {active ? (
                <FolderResearchButton
                  folderId={active.id}
                  clientId={active.clientId}
                  jurisdiction={jurisdiction}
                  sessionKey={session}
                  onOpen={() => {
                    const next = new URLSearchParams(params);
                    next.set('tab', 'research');
                    next.set('researchView', 'statutes');
                    next.set('folder', active.id);
                    setParams(next);
                  }}
                />
              ) : null}
              {reportsFlag.enabled && (
                <CapiroButton size="compact" onClick={() => setReportsOpen(true)}>
                  Reports
                </CapiroButton>
              )}
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
                onClick={() =>
                  setFilters({
                    folderSearch: search ? '' : '1',
                    folderActivity: '',
                    ...(search
                      ? { folderJurisdiction: '', folderSessionSearch: '', folderQ: '' }
                      : {}),
                  })
                }
              >
                {search ? 'Back to folder' : 'Search all bills'}
              </CapiroButton>
              {!activity && (
                <CapiroButton
                  size="compact"
                  variant="primary"
                  disabled={!active?.canEdit}
                  onClick={() => setFastOpen(true)}
                >
                  Add bills by number
                </CapiroButton>
              )}
              {!activity && (
                <CapiroButton
                  size="compact"
                  disabled={!board.data?.total || search}
                  onClick={() => setExportOpen(true)}
                >
                  Export
                </CapiroButton>
              )}
              {calendarEnabled && active ? (
                <CapiroButton
                  size="compact"
                  onClick={() => {
                    const calendar = new URLSearchParams({
                      tab: 'hearings',
                      jurisdiction: active.jurisdiction,
                      calendarFolder: active.id,
                      session,
                    });
                    if (scope) calendar.set('client', scope);
                    navigate(`/legiwatch?${calendar}`);
                  }}
                >
                  Folder calendar
                </CapiroButton>
              ) : null}
            </div>
          </div>
          {keywordsEnabled && active && params.get('keywordReview') === '1' ? (
            <KeywordReview folderId={active.id} jurisdiction={jurisdiction} sessionKey={session} />
          ) : null}
          {/* v4: ONE white filter card — every filter section lives inside this
            explicit wrapper (radius 12 hairline card, #F2F4F7 internal rules).
            The previous :first-of-type/:last-of-type approach never matched
            because the heading/actionbar/table cards are sibling divs. */}
          <div className="lw-folder-filtercard">
            <div className="lw-folder-filters">
              {search ? (
                <>
                  <CapiroSelect
                    label="Jurisdiction"
                    value={params.get('folderJurisdiction') ?? 'all'}
                    options={[
                      option('all', 'All available jurisdictions'),
                      ...(corpus.data?.jurisdictions ?? []).map((j) =>
                        option(
                          j.key,
                          j.key === 'US' ? `Federal (${j.count})` : `${j.key} (${j.count})`,
                        ),
                      ),
                    ]}
                    onChange={(e) => {
                      setFilters({
                        folderJurisdiction: e.target.value === 'all' ? '' : e.target.value,
                        folderSessionSearch: '',
                      });
                    }}
                  />
                  {(() => {
                    const juri = params.get('folderJurisdiction');
                    const narrowed = juri && juri !== 'all' ? juri : '';
                    return (
                      <CapiroSelect
                        label="Session"
                        value={narrowed ? (params.get('folderSessionSearch') ?? '') : ''}
                        disabled={!narrowed}
                        options={
                          narrowed
                            ? [
                                option('', 'All sessions'),
                                ...(
                                  corpus.data?.sessions.filter(
                                    (s) => s.jurisdiction === narrowed,
                                  ) ?? []
                                ).map((s) => option(s.key, `${s.label} (${s.count})`)),
                              ]
                            : [option('', 'All sessions (pick a jurisdiction to narrow)')]
                        }
                        onChange={(e) => setFilter('folderSessionSearch', e.target.value)}
                      />
                    );
                  })()}
                </>
              ) : (
                <>
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
                </>
              )}
              {!activity && (
                <>
                  <CapiroInput
                    label="Search bill or title"
                    value={query.q}
                    maxLength={200}
                    onChange={(e) => setFilter('folderQ', e.target.value)}
                    helpText="Searches bill metadata"
                  />
                  <div className="lw-folder-filter-summary" aria-live="polite">
                    Active filters are preserved in the URL
                  </div>
                  <CapiroButton
                    size="compact"
                    onClick={() =>
                      setFilters({
                        folderQ: '',
                        folderSponsor: '',
                        folderStatus: '',
                        folderChamber: '',
                        folderComments: '',
                        folderPriority: '',
                        folderImportance: '',
                        folderPosition: '',
                        folderSummary: '',
                        folderActionText: '',
                        folderClassification: '',
                        folderSubject: '',
                        folderCommittee: '',
                        folderSort: '',
                        folderDirection: '',
                        folderSummaryView: '',
                        folderColumns: '',
                        folderJurisdiction: '',
                        folderSessionSearch: '',
                      })
                    }
                  >
                    Clear filters
                  </CapiroButton>
                  <CapiroButton
                    size="compact"
                    aria-expanded={moreFiltersOpen}
                    onClick={() => setMoreFiltersOpen((open) => !open)}
                  >
                    {moreFiltersOpen ? 'Hide more filters/details' : 'More filters/details'}
                  </CapiroButton>
                  {moreFiltersOpen && (
                    <>
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
                          ...(!search ? [option('added', 'Date foldered')] : []),
                        ]}
                        onChange={(e) => setFilter('folderSort', e.target.value)}
                      />
                      <CapiroButton
                        size="compact"
                        onClick={() =>
                          setFilter('folderDirection', query.direction === 'asc' ? 'desc' : 'asc')
                        }
                      >
                        {query.direction === 'asc' ? 'Ascending' : 'Descending'}
                      </CapiroButton>
                    </>
                  )}
                </>
              )}
              {activity && (
                <CapiroButton
                  size="compact"
                  aria-expanded={moreFiltersOpen}
                  onClick={() => setMoreFiltersOpen((open) => !open)}
                >
                  {moreFiltersOpen ? 'Hide more filters/details' : 'More filters/details'}
                </CapiroButton>
              )}
            </div>
            {moreFiltersOpen && (
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
                {!activity && !search && (
                  <>
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
                    <CapiroButton
                      size="compact"
                      onClick={() =>
                        setFilters({
                          folderQ: '',
                          folderSponsor: '',
                          folderStatus: '',
                          folderChamber: '',
                          folderComments: '',
                          folderPriority: '',
                          folderImportance: '',
                          folderPosition: '',
                          folderSummary: '',
                          folderActionText: '',
                          folderClassification: '',
                          folderSubject: '',
                          folderCommittee: '',
                          folderSort: '',
                          folderDirection: '',
                        })
                      }
                    >
                      Reset
                    </CapiroButton>
                  </>
                )}
                {!activity && search && (
                  <CapiroButton
                    size="compact"
                    onClick={() =>
                      setFilters({
                        folderQ: '',
                        folderSponsor: '',
                        folderStatus: '',
                        folderChamber: '',
                        folderSummary: '',
                        folderActionText: '',
                        folderClassification: '',
                        folderSubject: '',
                        folderCommittee: '',
                        folderSort: '',
                        folderDirection: '',
                        folderJurisdiction: '',
                        folderSessionSearch: '',
                      })
                    }
                  >
                    Reset
                  </CapiroButton>
                )}
              </div>
            )}
            {!activity && moreFiltersOpen && (
              <div className="lw-folder-filters lw-folder-filters--context">
                <CapiroInput
                  label="Summary text"
                  value={params.get('folderSummary') ?? ''}
                  maxLength={200}
                  onChange={(e) => setFilter('folderSummary', e.target.value)}
                  helpText="Matches the official bill summary"
                />
                <CapiroInput
                  label="Latest action text"
                  value={params.get('folderActionText') ?? ''}
                  maxLength={200}
                  onChange={(e) => setFilter('folderActionText', e.target.value)}
                />
                <CapiroInput
                  label="Bill type"
                  value={params.get('folderClassification') ?? ''}
                  maxLength={40}
                  onChange={(e) => setFilter('folderClassification', e.target.value)}
                  helpText="Exact provider bill-type code (for example B)"
                />
                <CapiroInput
                  label="Subject"
                  value={params.get('folderSubject') ?? ''}
                  maxLength={100}
                  onChange={(e) => setFilter('folderSubject', e.target.value)}
                  helpText="Provider subject tags"
                />
                <CapiroInput
                  label="Current committee"
                  value={params.get('folderCommittee') ?? ''}
                  maxLength={160}
                  onChange={(e) => setFilter('folderCommittee', e.target.value)}
                  helpText="Exact committee referral name (state bills)"
                />
                <CapiroButton
                  size="compact"
                  aria-pressed={summaryIncluded}
                  onClick={() => setFilter('folderSummaryView', summaryIncluded ? '' : '1')}
                >
                  {summaryIncluded ? 'Hide summaries' : 'Show summaries'}
                </CapiroButton>
              </div>
            )}
            <div className="lw-folder-filters lw-folder-filters--context">
              <CapiroButton
                size="compact"
                aria-pressed={activity}
                onClick={() => setFilter('folderActivity', activity ? '' : '1')}
              >
                {activity ? 'Back to bills' : 'Daily activity'}
              </CapiroButton>
            </div>
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
          ) : folders.isError || sessions.isError ? (
            <div role="alert">
              <p>Bill folders could not be loaded.</p>
              <CapiroButton onClick={() => void refresh()}>Retry</CapiroButton>
            </div>
          ) : activity ? (
            <FolderActivityView
              jurisdiction={jurisdiction}
              session={session}
              folderId={search ? '' : folderId}
              allFolders={search ? false : allFolders}
              scope={scope}
              folderName={active?.name ?? null}
              clientName={clients.find((c) => c.id === scope)?.name ?? null}
              chamber={params.get('folderChamber') ?? ''}
              onOpenBill={(row) => setBill(row)}
            />
          ) : board.isError ? (
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
              {/* v4 action bar — selection count and bulk/view actions live on
                their own row between the filter card and the table card. */}
              <div className="lw-folder-actionbar">
                <p aria-live="polite" className="lw-folder-actionbar__count">
                  {selected.length} selected on this page
                </p>
                <div className="lw-folder-actionbar__actions">
                  {/* Density and comment display stay in the View dialog — no
                    inline duplicates (reference shows a single View button). */}
                  <CapiroButton size="compact" onClick={() => setViewOpen(true)}>
                    View
                  </CapiroButton>
                  {!activity &&
                    (search ? (
                      <CapiroButton
                        size="compact"
                        disabled={!active?.canEdit || !selected.length || busy}
                        onClick={() => void bulk('add')}
                      >
                        Add selected
                      </CapiroButton>
                    ) : (
                      <>
                        <CapiroButton
                          size="compact"
                          disabled={!selected.length || busy}
                          onClick={() => setCopyBills(chosen)}
                        >
                          Copy selected
                        </CapiroButton>
                        <CapiroButton
                          size="compact"
                          disabled={!active?.canEdit || !selected.length || busy}
                          onClick={() => setRemoveOpen(true)}
                        >
                          Remove selected
                        </CapiroButton>
                      </>
                    ))}
                </div>
              </div>
              <div className="lw-folder-tablecard">
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
                        {search ? <TH>Jurisdiction</TH> : null}
                        {search ? <TH>Session</TH> : null}
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
                        <TH hidden={search || !visibleColumns.has('priority')}>
                          Priority / importance
                        </TH>
                        <TH hidden={search || !visibleColumns.has('position')}>Position</TH>
                        <TH hidden={search || !visibleColumns.has('added')}>Date foldered</TH>
                        {calendarEnabled ? <TH>Upcoming agenda</TH> : null}
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
                            {summaryIncluded && r.summary ? (
                              <p className="lw-folder-inline-comment">{r.summary}</p>
                            ) : null}
                            {summaryIncluded && (r.currentCommittee || r.subjects?.length) ? (
                              <small className="lw-folder-inline-comment">
                                {[
                                  r.currentCommittee ? `Committee: ${r.currentCommittee}` : null,
                                  r.subjects?.length ? `Subjects: ${r.subjects.join(', ')}` : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </small>
                            ) : null}
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
                          {search ? (
                            <TD>{r.jurisdiction === 'US' ? 'Federal' : r.jurisdiction}</TD>
                          ) : null}
                          {search ? <TD>{r.sessionKey}</TD> : null}
                          <TD hidden={!visibleColumns.has('sponsor')}>
                            {r.sponsor ?? 'Unresolved'}
                          </TD>
                          <TD hidden={!visibleColumns.has('status')}>
                            {r.status?.replaceAll('_', ' ') ?? 'Unavailable'}
                          </TD>
                          <TD hidden={!visibleColumns.has('lastAction')}>
                            <span className="lw-folder-title" title={r.latestAction ?? undefined}>
                              {r.latestAction ?? 'Action unavailable'}
                            </span>
                            <small>{r.latestActionAt?.slice(0, 10) ?? 'Date unavailable'}</small>
                          </TD>
                          <TD hidden={search || !visibleColumns.has('priority')}>
                            {r.assignmentId ? (
                              <>
                                {r.topPriority && <strong>Top priority · </strong>}
                                {r.importance ?? 'normal'}
                              </>
                            ) : (
                              '—'
                            )}
                          </TD>
                          <TD hidden={search || !visibleColumns.has('position')}>
                            {r.position ?? '—'}
                          </TD>
                          <TD hidden={search || !visibleColumns.has('added')}>
                            <span
                              title={
                                r.addedDateRaw ? 'Source local time; timezone unknown' : undefined
                              }
                            >
                              {r.addedDateRaw ?? r.addedAt?.slice(0, 10) ?? '—'}
                            </span>
                          </TD>
                          {calendarEnabled ? (
                            <TD>
                              {billAgendas.isError ? (
                                <button onClick={() => void billAgendas.refetch()}>
                                  Retry agenda check
                                </button>
                              ) : billAgendas.isPending ? (
                                'Checking…'
                              ) : agendaCounts.get(r.id) ? (
                                <button className="lw-folder-bill-link" onClick={() => setBill(r)}>
                                  {agendaCounts.get(r.id)} linked event
                                  {agendaCounts.get(r.id) === 1 ? '' : 's'}
                                </button>
                              ) : billAgendas.data &&
                                billAgendas.data.total > billAgendas.data.items.length ? (
                                <button onClick={() => setBill(r)}>Check appearances</button>
                              ) : (
                                <span title="No upcoming link in checked calendar sources">
                                  None linked
                                </span>
                              )}
                            </TD>
                          ) : null}
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
                        : active
                          ? 'This folder has no bills yet. Search all bills or add bills by number.'
                          : 'No bills are in your folders yet. Create or select a folder, then search all bills.'}
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
                    'Folder created outside the selected client. Choose All clients to open it.',
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
        {copyBills?.length ? (
          <FastTagger
            copyOf={copyBills}
            folders={folders.data ?? []}
            jurisdiction={jurisdiction}
            session={session}
            onClose={() => setCopyBills(null)}
            onDone={refresh}
          />
        ) : null}
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
            folder will be removed. Automatic rules will not add these bills to this folder again
            until you manually add them. Decision history is retained. Other folders are
            independent.
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
              folders.data?.find((f) => f.id === bill.folderId)?.clientId ??
              active?.clientId ??
              scope
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
    </div>
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
  copyOf,
  folders,
  jurisdiction,
  session,
  onDone,
  onClose,
}: {
  folder?: Folder;
  /** Copy mode: add these exact canonical bills to chosen targets; originals stay. */
  copyOf?: FolderBill[];
  folders: Folder[];
  jurisdiction: string;
  session: string;
  onDone: () => Promise<unknown>;
  onClose: () => void;
}) {
  const api = useApi();
  const copying = Boolean(copyOf?.length);
  // Dedupe by canonical bill id — the same bill can be selected once per
  // folder in All assignments, so list/count/post must agree.
  const dedupedCopy = copyOf?.length ? [...new Map(copyOf.map((b) => [b.id, b])).values()] : [];
  const [targets, setTargets] = useState<string[]>(folder ? [folder.id] : []);
  const [text, setText] = useState(''),
    [rows, setRows] = useState<Resolution[]>([]),
    [checked, setChecked] = useState<string[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  const title = copying
    ? `Copy ${dedupedCopy.length} selected bill${dedupedCopy.length === 1 ? '' : 's'}`
    : `Add bills by number · ${folder?.name ?? ''}`;
  return (
    <CapiroModal open title={title} onClose={onClose} width={680}>
      <p>
        {jurisdiction} · session {session}.{' '}
        {copying
          ? 'Choose target folders. The originals stay in their folder; duplicates already in a target are reported unchanged.'
          : 'Review resolved bills before adding them.'}
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
      {copying ? (
        <ul className="lw-folder-resolution" aria-label="Selected bills">
          {dedupedCopy.map((b) => (
            <li key={b.id}>
              <strong>{b.number}</strong> · {b.title}
            </li>
          ))}
        </ul>
      ) : (
        <>
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
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {result && <p role="status">{result}</p>}
      <div className="lw-folder-actions">
        <CapiroButton onClick={onClose}>Close</CapiroButton>
        <CapiroButton
          variant="primary"
          loading={busy}
          disabled={busy || (copying ? !targets.length : !checked.length)}
          onClick={async () => {
            // Copy mode: exact canonical ids of the chosen rows, deduped —
            // the same bill can appear once per folder in All assignments.
            const billIds = copying ? dedupedCopy.map((b) => b.id) : checked;
            setBusy(true);
            setError('');
            let completed = false;
            try {
              for (const target of targets) {
                try {
                  const data = (
                    await api.post<{ results: Array<{ billId: string; status: string }> }>(
                      `${FOLDER_BASE}/${target}/bills`,
                      { action: 'add', billIds },
                    )
                  ).data;
                  completed = true;
                  // Preserve each successful target's outcome as it completes,
                  // so a later failure never hides completed mutations.
                  setResult((prev) =>
                    [
                      prev,
                      data.results
                        .map((r) => {
                          const label = copying
                            ? (dedupedCopy.find((b) => b.id === r.billId)?.number ?? r.billId)
                            : (rows.find((x) => x.bill?.id === r.billId)?.token ?? r.billId);
                          return `${folders.find((f) => f.id === target)?.name} / ${label}: ${r.status.replaceAll('_', ' ')}`;
                        })
                        .join(' · '),
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  );
                } catch (e) {
                  // Accumulate every failed target — never overwrite an earlier failure.
                  setError((prev) =>
                    [
                      prev,
                      `${folders.find((f) => f.id === target)?.name ?? target}: ${folderError(e)}`,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  );
                }
              }
              setChecked([]);
              // Refresh even when some targets failed — completed mutations happened.
              if (completed) await onDone();
            } finally {
              setBusy(false);
            }
          }}
        >
          {copying
            ? `Copy ${dedupedCopy.length} bill${dedupedCopy.length === 1 ? '' : 's'} to ${targets.length} folder${targets.length === 1 ? '' : 's'}`
            : `Add ${checked.length} selected bills`}
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

const ACTIVITY_KINDS = ['action', 'text', 'amendment'] as const;
const activityKindLabels: Record<(typeof ACTIVITY_KINDS)[number], string> = {
  action: 'Actions',
  text: 'Texts filed',
  amendment: 'Amendments',
};
const activityKindSingular: Record<(typeof ACTIVITY_KINDS)[number], string> = {
  action: 'action',
  text: 'text filed',
  amendment: 'amendment',
};
/** Chamber comes from source data as house/senate or raw lower/upper codes. */
function chamberLabel(chamber: string): string {
  const c = chamber.toLowerCase();
  if (c === 'lower') return 'House / Assembly';
  if (c === 'upper') return 'Senate';
  return chamber;
}

/**
 * Daily original-record activity for the current jurisdiction + session,
 * scoped to the open folder, all assignments (onlyTracked), or the whole
 * session corpus — the same scope semantics as the folder board. The selected
 * date defaults to local today with explicit Previous/Next day navigation;
 * clearing the date searches the whole session. Source links are preserved
 * and rows open the real Bill 360 drawer.
 */
function FolderActivityView({
  jurisdiction,
  session,
  folderId,
  allFolders,
  scope,
  folderName,
  clientName,
  chamber,
  onOpenBill,
}: {
  jurisdiction: string;
  session: string;
  folderId: string;
  allFolders: boolean;
  scope: string;
  folderName: string | null;
  clientName: string | null;
  chamber: string;
  onOpenBill: (row: FolderBill) => void;
}) {
  const api = useApi(),
    identity = useApiScope();
  // Kind/day live in the URL so deep links (pathname+query)
  // restore them on apply. `folderActivityDate=all` is the explicit all-dates
  // state; an absent date param means the dynamic local-today default.
  const [params, setParams] = useSearchParams();
  const localDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const shiftDay = (day: string, delta: number) => {
    const d = new Date(`${day}T00:00:00`);
    d.setDate(d.getDate() + delta);
    return localDay(d);
  };
  const kindParam = params.get('folderActivityKind') ?? '';
  const kind: (typeof ACTIVITY_KINDS)[number] = (ACTIVITY_KINDS as readonly string[]).includes(
    kindParam,
  )
    ? (kindParam as (typeof ACTIVITY_KINDS)[number])
    : 'action';
  const dateParam = params.get('folderActivityDate');
  const allDates = dateParam === 'all';
  const day = allDates ? '' : (dateParam ?? localDay(new Date()));
  const setActivityParams = (values: Record<string, string>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  const setKind = (next: (typeof ACTIVITY_KINDS)[number]) =>
    setActivityParams({ folderActivityKind: next === 'action' ? '' : next });
  const setDay = (next: string) => setActivityParams({ folderActivityDate: next ? next : 'all' });
  const [cursor, setCursor] = useState<string | undefined>(),
    [pages, setPages] = useState<Array<string | undefined>>([]);
  const query = {
    jurisdiction,
    sessionKey: session,
    kind,
    ...(folderId ? { folderId } : {}),
    ...(!folderId && allFolders ? { onlyTracked: 'true' } : {}),
    ...(!folderId && allFolders && scope ? { clientId: scope } : {}),
    ...(chamber ? { chamber } : {}),
    ...(day ? { from: day, to: day } : {}),
  };
  const queryId = JSON.stringify(query);
  useEffect(() => {
    setCursor(undefined);
    setPages([]);
  }, [queryId]);
  const activities = useQuery({
    queryKey: [...folderKey(identity), 'activities', query, cursor],
    queryFn: async () =>
      (
        await api.get<ActivityPage>(`${FOLDER_BASE}/activities`, {
          params: { ...query, cursor, limit: 50 },
        })
      ).data,
    enabled: Boolean(session),
    retry: false,
  });
  const scopeLabel = folderId
    ? (folderName ?? 'Selected folder')
    : allFolders
      ? scope
        ? (clientName ?? 'Selected client') + ' · tracked assignments'
        : 'All tracked assignments'
      : 'Whole session';
  const openBill = (row: ActivityRow) =>
    onOpenBill({
      ...emptyContext,
      id: row.billId,
      assignmentId: null,
      folderId: folderId || null,
      number: row.number,
      title: row.title,
      sponsor: null,
      status: null,
      jurisdiction: row.jurisdiction,
      sessionKey: row.sessionKey,
      latestAction: row.text,
      latestActionAt: row.date,
      sourceUrl: row.url,
      addedAt: null,
      addedDateRaw: null,
      addedDatePrecision: null,
    });
  return (
    <section aria-label="Daily activity">
      <div className="lw-folder-filters">
        <CapiroSelect
          label="Record type"
          value={kind}
          options={ACTIVITY_KINDS.map((k) => option(k, activityKindLabels[k]))}
          onChange={(e) => setKind(e.target.value as (typeof ACTIVITY_KINDS)[number])}
        />
        <CapiroButton size="compact" disabled={!day} onClick={() => setDay(shiftDay(day, -1))}>
          Previous day
        </CapiroButton>
        <CapiroInput
          type="date"
          label="Selected date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          helpText="Clear to show all dates"
        />
        <CapiroButton size="compact" disabled={!day} onClick={() => setDay(shiftDay(day, 1))}>
          Next day
        </CapiroButton>
        {day !== localDay(new Date()) ? (
          <CapiroButton size="compact" onClick={() => setDay(localDay(new Date()))}>
            Today
          </CapiroButton>
        ) : null}
      </div>
      {activities.isPending ? (
        <p role="status">Loading activity…</p>
      ) : activities.isError ? (
        <div role="alert">
          <p>Daily activity could not be loaded.</p>
          <CapiroButton onClick={() => void activities.refetch()}>Retry</CapiroButton>
        </div>
      ) : activities.data.availability === 'unavailable' ? (
        // The retained activity sources do not cover this jurisdiction+kind at
        // all (federal texts/amendments). State that truthfully instead of
        // claiming zero events occurred; keep every control selectable.
        <>
          <p className="lw-folder-empty" role="status">
            {activities.data.reason ??
              `This activity source is not available from the retained activity sources.`}{' '}
            Choose Actions to view retained federal action history.
          </p>
        </>
      ) : (
        <>
          <p>
            {activities.data.total}{' '}
            {activities.data.total === 1
              ? activityKindSingular[kind]
              : activityKindLabels[kind].toLowerCase()}{' '}
            · {scopeLabel}
            {day ? ` · ${day}` : ' · all dates'}
          </p>
          {!activities.data.rows.length ? (
            <p className="lw-folder-empty">
              No recorded {activityKindLabels[kind].toLowerCase()} for {scopeLabel.toLowerCase()}
              {day ? ` on ${day}` : ' on any date'}.
            </p>
          ) : (
            <ol className="lw-folder-resolution">
              {activities.data.rows.map((row) => (
                <li key={row.id}>
                  <button className="lw-folder-bill-link" onClick={() => openBill(row)}>
                    {row.number}
                  </button>{' '}
                  · <time>{row.date?.slice(0, 10) ?? 'Date unavailable'}</time>
                  {row.text ? ` · ${row.text}` : ''}
                  {row.chamber ? ` · ${chamberLabel(row.chamber)}` : ''}
                  {row.url && /^https?:\/\//.test(row.url) ? (
                    <>
                      {' '}
                      ·{' '}
                      <a href={row.url} target="_blank" rel="noreferrer">
                        Original source
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          <div className="lw-folder-pagination">
            <span>
              {activities.data.total} results · page {pages.length + 1}
            </span>
            <CapiroButton
              size="compact"
              disabled={!pages.length}
              onClick={() => {
                setCursor(pages[pages.length - 1]);
                setPages(pages.slice(0, -1));
              }}
            >
              Previous
            </CapiroButton>
            <CapiroButton
              size="compact"
              disabled={!activities.data.nextCursor}
              onClick={() => {
                setPages([...pages, cursor]);
                setCursor(activities.data.nextCursor ?? undefined);
              }}
            >
              Next
            </CapiroButton>
          </div>
        </>
      )}
    </section>
  );
}
