/**
 * vNext Reports — Engagement navy reskin (Reports phase, 2026-08-16).
 *
 * A genuinely new surface (design README §10 / `Capiro Engagement -
 * Untitled UI.dc.html`'s `isReports` block / screenshots/07-reports-tracker
 * .png), matching the pattern this reskin already established for Meetings
 * and Meeting Library: new markup on literal navy, reusing only the
 * canonical DATA layer, never canonical JSX. Reports had zero vNext
 * presence before this phase — same situation Outreach was in before v3.
 *
 * Reused as-is (real endpoints, not fabricated):
 *   - GET /api/engagement/reports/overview — clientId/period.
 *   - POST /api/engagement/reports/target-offices — Add target office.
 *   - POST /api/engagement/reports/target-offices/overrides — the per-cell
 *     status override.
 *   - useClientOptions (meetings-api.ts) — the same real client list Library
 *     and Assign already use, for the Add target office client select.
 *
 * Additive backend change this phase relies on: engagement.service.ts's
 * `reportOverview` used to collapse three independently-tracked override
 * booleans (storedPrepStatus/storedOutreachStatus/storedSubmissionStatus)
 * into a single `manuallyOverridden` flag before the response reached the
 * client — not enough to build the design's per-cell override-marker dot
 * (README §10.2), which needs to know WHICH cell was overridden. The service
 * now also returns `prepOverridden`/`outreachOverridden`/
 * `submissionOverridden` alongside the untouched `manuallyOverridden` (kept
 * for the canonical ReportsView's own single "Manual override" tag) — a
 * pure addition, nothing removed or renamed.
 *
 * Filter/Sort: real native `<select>`s dressed as `.uui-button` (see
 * engagement.css's `.uui-report-select` — each option's own label already
 * carries the "Filter: "/"Sort: " prefix, so the closed-state text is always
 * correct with no separate display label), wired to the exact same
 * client-side filter/sort logic the canonical ReportsView already runs
 * (EngagementPage.tsx) — real behavior, not the mockup's own decorative,
 * handler-less buttons (same "make it real since real data already backs
 * it" call the Library phase made for ITS three dropdown filters).
 *
 * URL contract: only `period` is URL-owned, matching the canonical
 * ReportsView exactly (EngagementPage.tsx's own URL-sync effect never
 * serializes status/sort either) — status filter and sort stay local state.
 *
 * Add target office / office drilldown are built as real `EngagementDialog`s
 * (not the mockup's own `addOffice`/`office` prototype modal shells) so they
 * pick up the navy retheme automatically via EngagementDialog's new
 * auto-detected portal target (see EngagementDialog.tsx). The drilldown
 * needs no separate endpoint — `report.rows[].meetings` already arrives
 * embedded per row from the real API.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Filter, ChevronsUpDown, Plus } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { useClientOptions } from '../../../pages/engagement/meetings/meetings-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { useEngagementToast } from './engagement-toast.js';

type ReportPeriod = 'current' | 'previous' | 'all';
type ReportStatus = 'not_started' | 'in_progress' | 'complete';
type ReportStatusField = 'prepStatus' | 'outreachStatus' | 'submissionStatus';
type SortKey = 'member-asc' | 'member-desc' | 'meetings-desc' | 'outreach-desc' | 'pending-desc';
type StatusFilter = 'all' | ReportStatus;

interface ReportMeeting {
  id: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  externalUrl: string | null;
}

interface ReportRow {
  targetId: string | null;
  clientId: string | null;
  clientName: string | null;
  scopeKey: string;
  officeKey: string;
  memberPrincipal: string;
  committee: string | null;
  staffer: string | null;
  building: string | null;
  leadOwner: string | null;
  meetingsHeld: number;
  outreachSent: number;
  pendingActions: number;
  prepStatus: ReportStatus;
  outreachStatus: ReportStatus;
  submissionStatus: ReportStatus;
  source: string;
  manuallyOverridden: boolean;
  prepOverridden?: boolean;
  outreachOverridden?: boolean;
  submissionOverridden?: boolean;
  meetings: ReportMeeting[];
}

interface Report {
  cycle: { period: ReportPeriod; label: string; from: string | null; to: string | null };
  summary: {
    targetOffices: number;
    meetingsHeld: number;
    outreachSent: number;
    submissionsFiled: number;
    pendingActions: number;
  };
  rows: ReportRow[];
}

const STATUS_LABEL: Record<ReportStatus, string> = {
  complete: 'Complete',
  in_progress: 'In progress',
  not_started: 'Not started',
};

const STATUS_OPTIONS: ReportStatus[] = ['complete', 'in_progress', 'not_started'];

const OVERRIDE_FIELD: Record<ReportStatusField, keyof ReportRow> = {
  prepStatus: 'prepOverridden',
  outreachStatus: 'outreachOverridden',
  submissionStatus: 'submissionOverridden',
};

function parsePeriod(raw: string | null): ReportPeriod {
  return raw === 'previous' || raw === 'all' ? raw : 'current';
}

function reportCellKey(row: ReportRow, field: ReportStatusField): string {
  return `${row.scopeKey}:${row.officeKey}:${field}`;
}

function csvEscape(value: string | number | null | undefined): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Real client-side export matching the visible (filtered + sorted) table —
 *  same column set the canonical ReportsView's own CSV export uses
 *  (EngagementPage.tsx's exportEngagementReportCsv), reimplemented locally
 *  rather than importing from that non-exporting, non-vNext file. */
function downloadReportCsv(rows: ReportRow[], period: ReportPeriod) {
  const header = [
    'Member / Principal',
    'Client',
    'Committee',
    'Staffer',
    'Building',
    'Lead',
    'Meetings Held',
    'Prep',
    'Outreach',
    'Submission',
    'Pending Actions',
  ];
  const lines = rows.map((row) =>
    [
      row.memberPrincipal,
      row.clientName,
      row.committee,
      row.staffer,
      row.building,
      row.leadOwner,
      row.meetingsHeld,
      STATUS_LABEL[row.prepStatus],
      STATUS_LABEL[row.outreachStatus],
      STATUS_LABEL[row.submissionStatus],
      row.pendingActions,
    ]
      .map(csvEscape)
      .join(','),
  );
  const csv = [header.map(csvEscape).join(','), ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `engagement-report-${period}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatMeetingWhen(startsAt: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(startsAt));
}

function StatusCell({
  row,
  field,
  disabled,
  open,
  onToggle,
  onPick,
}: {
  row: ReportRow;
  field: ReportStatusField;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onPick: (status: ReportStatus) => void;
}) {
  const status = row[field] as ReportStatus;
  const overridden = Boolean(row[OVERRIDE_FIELD[field]]);
  return (
    <span className="uui-report-status-cell">
      <button
        type="button"
        className="uui-report-status-trigger"
        data-state={status}
        disabled={disabled}
        onClick={onToggle}
      >
        <i />
        {STATUS_LABEL[status]}
        <ChevronsUpDown size={12} />
      </button>
      {overridden && <span className="uui-report-override-marker" aria-label="Manually overridden" />}
      {open && (
        <span className="uui-report-status-menu" role="menu">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitem"
              data-state={option}
              data-selected={option === status || undefined}
              onClick={() => onPick(option)}
            >
              <i />
              {STATUS_LABEL[option]}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

interface TargetOfficeFormValues {
  clientId: string;
  memberPrincipal: string;
  committee: string;
  building: string;
  leadOwner: string;
  staffer: string;
}

const EMPTY_OFFICE_FORM: TargetOfficeFormValues = {
  clientId: '',
  memberPrincipal: '',
  committee: '',
  building: '',
  leadOwner: '',
  staffer: '',
};

export function VNextReportsTracker({ clientId }: { clientId?: string | null }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useEngagementToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const [period, setPeriod] = useState<ReportPeriod>(() => parsePeriod(searchParams.get('period')));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('member-asc');
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [addOfficeOpen, setAddOfficeOpen] = useState(false);
  const [officeForm, setOfficeForm] = useState<TargetOfficeFormValues>(EMPTY_OFFICE_FORM);
  const [drilldownRow, setDrilldownRow] = useState<ReportRow | null>(null);

  // Same durable URL⇄state pattern VNextMeetingLibrary.tsx/VNextMeetingsWorkspace.tsx
  // established: two guarded effects, each skipping the other's own write via
  // a ref. Only `period` is URL-owned here, matching the canonical
  // ReportsView's own real URL contract exactly.
  const syncingFromUrlRef = useRef(false);
  const lastProcessedUrlRef = useRef('');

  useEffect(() => {
    const urlKey = searchParams.toString();
    if (lastProcessedUrlRef.current === urlKey) return;
    lastProcessedUrlRef.current = urlKey;
    const nextPeriod = parsePeriod(searchParams.get('period'));
    if (nextPeriod === period) return;
    syncingFromUrlRef.current = true;
    setPeriod(nextPeriod);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (syncingFromUrlRef.current) {
      syncingFromUrlRef.current = false;
      return;
    }
    if (!location.pathname.startsWith('/engagement/reports')) return;
    const params = new URLSearchParams();
    if (period !== 'current') params.set('period', period);
    const nextSearch = params.toString();
    if (nextSearch === searchParams.toString()) return;
    lastProcessedUrlRef.current = nextSearch;
    navigate(
      { pathname: '/engagement/reports', search: nextSearch ? `?${nextSearch}` : '' },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, navigate, location.pathname]);

  const report = useQuery<Report>({
    queryKey: ['vnext-engagement-report', clientId, period],
    queryFn: async () =>
      (await api.get<Report>('/api/engagement/reports/overview', { params: { clientId: clientId ?? undefined, period } })).data,
  });

  const clients = useClientOptions(addOfficeOpen);

  const createTargetOffice = useMutation({
    mutationFn: async (values: TargetOfficeFormValues) =>
      (
        await api.post('/api/engagement/reports/target-offices', {
          clientId: values.clientId || clientId || undefined,
          memberPrincipal: values.memberPrincipal,
          committee: values.committee || undefined,
          staffer: values.staffer || undefined,
          building: values.building || undefined,
          leadOwner: values.leadOwner || undefined,
        })
      ).data,
    onSuccess: () => {
      toast.show(`Target office added · ${officeForm.memberPrincipal}`);
      setAddOfficeOpen(false);
      setOfficeForm(EMPTY_OFFICE_FORM);
      void qc.invalidateQueries({ queryKey: ['vnext-engagement-report'] });
    },
  });

  const updateOverride = useMutation({
    mutationFn: async ({
      row,
      field,
      status,
    }: {
      row: ReportRow;
      field: ReportStatusField;
      status: ReportStatus;
    }) =>
      (
        await api.post('/api/engagement/reports/target-offices/overrides', {
          clientId: row.scopeKey === 'all' ? undefined : (row.clientId ?? clientId ?? undefined),
          officeKey: row.officeKey,
          memberPrincipal: row.memberPrincipal,
          committee: row.committee,
          staffer: row.staffer,
          building: row.building,
          leadOwner: row.leadOwner,
          [field]: status,
          source: row.source === 'manual' ? 'manual' : 'manual_override',
        })
      ).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['vnext-engagement-report'] }),
    onSettled: () => setOpenMenuKey(null),
  });

  // Close any open status menu on outside click / Escape — same convention
  // LibraryDropdown established, generalized to a single "which key is open"
  // piece of state since a table has many of these cells.
  useEffect(() => {
    if (!openMenuKey) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest('.uui-report-status-cell')) setOpenMenuKey(null);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpenMenuKey(null);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenuKey]);

  const rows = useMemo(() => {
    const base = report.data?.rows ?? [];
    const filtered =
      statusFilter === 'all'
        ? base
        : base.filter(
            (row) =>
              row.prepStatus === statusFilter ||
              row.outreachStatus === statusFilter ||
              row.submissionStatus === statusFilter,
          );
    return [...filtered].sort((left, right) => {
      if (sort === 'meetings-desc') return right.meetingsHeld - left.meetingsHeld;
      if (sort === 'outreach-desc') return right.outreachSent - left.outreachSent;
      if (sort === 'pending-desc') return right.pendingActions - left.pendingActions;
      if (sort === 'member-desc') return right.memberPrincipal.localeCompare(left.memberPrincipal);
      return left.memberPrincipal.localeCompare(right.memberPrincipal);
    });
  }, [report.data?.rows, sort, statusFilter]);

  const clientOptions = clients.data ?? [];

  const canSaveOffice = officeForm.memberPrincipal.trim().length > 0;

  return (
    <div className="uui-reports-page">
      <h2 className="uui-reports-heading">Reports</h2>
      <p className="uui-reports-subline">
        {report.data?.cycle.label ?? 'Current Cycle (2026)'} Engagement Activity Overview
      </p>

      <h3 className="uui-reports-tracker-heading">Office Engagement Tracker</h3>

      <div className="uui-report-toolbar-row">
        <div className="uui-report-periods">
          {(['current', 'previous', 'all'] as ReportPeriod[]).map((key) => (
            <button
              key={key}
              type="button"
              data-active={period === key || undefined}
              onClick={() => setPeriod(key)}
            >
              {key === 'current' ? 'Current Cycle' : key === 'previous' ? 'Previous Cycle' : 'All Time'}
            </button>
          ))}
        </div>
        <span className="uui-report-toolbar-spacer" />
        <button type="button" className="uui-button uui-button--primary" onClick={() => setAddOfficeOpen(true)}>
          <Plus size={16} />
          Add target office
        </button>
        <div className="uui-button uui-report-select">
          <Filter size={16} />
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          >
            <option value="all">Filter: All statuses</option>
            <option value="complete">Filter: Complete</option>
            <option value="in_progress">Filter: In progress</option>
            <option value="not_started">Filter: Not started</option>
          </select>
        </div>
        <div className="uui-button uui-report-select">
          <ChevronsUpDown size={16} />
          <select aria-label="Sort" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
            <option value="member-asc">Sort: Member A–Z</option>
            <option value="member-desc">Sort: Member Z–A</option>
            <option value="meetings-desc">Sort: Meetings held</option>
            <option value="outreach-desc">Sort: Outreach sent</option>
            <option value="pending-desc">Sort: Pending actions</option>
          </select>
        </div>
        <button
          type="button"
          className="uui-button"
          disabled={!rows.length}
          onClick={() => {
            downloadReportCsv(rows, period);
            toast.show(`CSV export queued · ${period === 'current' ? 'current cycle' : period === 'previous' ? 'previous cycle' : 'all time'} · ${rows.length} office${rows.length === 1 ? '' : 's'}`);
          }}
        >
          <Download size={16} />
          Export CSV
        </button>
      </div>

      <div className="uui-report-card">
        <div className="uui-report-scroll">
          <div className="uui-report-table">
            <div className="uui-report-table__head">
              <span>Member / principal</span>
              <span>Committee</span>
              <span>Staffer</span>
              <span>Building</span>
              <span>Lead</span>
              <span>Meetings</span>
              <span>Prep</span>
              <span>Outreach</span>
              <span>Submission</span>
              <span>Pending</span>
            </div>
            {report.isLoading ? (
              <div className="uui-report-empty">Loading report activity…</div>
            ) : report.isError ? (
              <div className="uui-report-empty">
                The Office Engagement Tracker could not be reached.{' '}
                <button type="button" className="uui-report-meetings-link" onClick={() => void report.refetch()}>
                  Retry
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="uui-report-empty">
                No target offices are linked to this reporting period yet.
              </div>
            ) : (
              rows.map((row) => (
                <div className="uui-report-table__row" key={`${row.scopeKey}:${row.officeKey}`}>
                  <span title={row.memberPrincipal}>{row.memberPrincipal}</span>
                  <span>{row.committee || '—'}</span>
                  <span>{row.staffer || '—'}</span>
                  <span>{row.building || '—'}</span>
                  <span>{row.leadOwner || '—'}</span>
                  <button type="button" className="uui-report-meetings-link" onClick={() => setDrilldownRow(row)}>
                    {row.meetingsHeld} View
                  </button>
                  {(['prepStatus', 'outreachStatus', 'submissionStatus'] as ReportStatusField[]).map((field) => {
                    const key = reportCellKey(row, field);
                    return (
                      <StatusCell
                        key={field}
                        row={row}
                        field={field}
                        disabled={updateOverride.isPending && updateOverride.variables?.row === row && updateOverride.variables?.field === field}
                        open={openMenuKey === key}
                        onToggle={() => setOpenMenuKey((current) => (current === key ? null : key))}
                        onPick={(status) => updateOverride.mutate({ row, field, status })}
                      />
                    );
                  })}
                  <span className="uui-report-pending" data-nonzero={row.pendingActions > 0 || undefined}>
                    {row.pendingActions}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="uui-report-legend">
        <span>
          <i className="complete" />
          Complete
        </span>
        <span>
          <i className="in-progress" />
          In progress
        </span>
        <span>
          <i className="not-started" />
          Not started
        </span>
        <p>
          Auto-populated from Capiro; use the status menu to override manually. An overridden cell
          keeps a marker.
        </p>
      </div>

      <EngagementDialog
        open={addOfficeOpen}
        eyebrow="Reports · creation"
        title="Add target office"
        width={620}
        busy={createTargetOffice.isPending}
        error={createTargetOffice.isError ? 'Could not add the target office. Try again.' : null}
        dirty={officeForm.memberPrincipal.trim().length > 0}
        onClose={() => setAddOfficeOpen(false)}
        footer={
          <>
            <button type="button" className="uui-button" disabled={createTargetOffice.isPending} onClick={() => setAddOfficeOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="uui-button uui-button--primary"
              disabled={createTargetOffice.isPending || !canSaveOffice}
              onClick={() => createTargetOffice.mutate(officeForm)}
            >
              {createTargetOffice.isPending ? 'Adding…' : 'Add office'}
            </button>
          </>
        }
      >
        <div className="engagement-dialog__field-grid">
          <label className="engagement-dialog__field">
            Client · optional
            <select
              value={officeForm.clientId}
              onChange={(event) => setOfficeForm((prev) => ({ ...prev, clientId: event.target.value }))}
            >
              <option value="">No client / firm-wide</option>
              {clientOptions.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label className="engagement-dialog__field is-full">
            Member / principal · required
            <input
              autoFocus
              value={officeForm.memberPrincipal}
              placeholder="Rep. Jane Smith (D-CA-12)"
              onChange={(event) => setOfficeForm((prev) => ({ ...prev, memberPrincipal: event.target.value }))}
            />
          </label>
          <label className="engagement-dialog__field">
            Committee
            <input
              value={officeForm.committee}
              placeholder="HASC"
              onChange={(event) => setOfficeForm((prev) => ({ ...prev, committee: event.target.value }))}
            />
          </label>
          <label className="engagement-dialog__field">
            Building
            <input
              value={officeForm.building}
              placeholder="Rayburn"
              onChange={(event) => setOfficeForm((prev) => ({ ...prev, building: event.target.value }))}
            />
          </label>
          <label className="engagement-dialog__field">
            Lead
            <input
              value={officeForm.leadOwner}
              placeholder="Owner"
              onChange={(event) => setOfficeForm((prev) => ({ ...prev, leadOwner: event.target.value }))}
            />
          </label>
          <label className="engagement-dialog__field">
            Staffer
            <input
              value={officeForm.staffer}
              placeholder="Staffer name"
              onChange={(event) => setOfficeForm((prev) => ({ ...prev, staffer: event.target.value }))}
            />
          </label>
        </div>
        <p className="uui-library-note">
          New offices enter the Office Engagement Tracker and can then be auto-populated by Capiro
          activity or manually overridden.
        </p>
      </EngagementDialog>

      <EngagementDialog
        open={Boolean(drilldownRow)}
        eyebrow="Reports · drilldown"
        title={drilldownRow ? `Target office · linked meetings — ${drilldownRow.memberPrincipal}` : 'Target office · linked meetings'}
        width={560}
        onClose={() => setDrilldownRow(null)}
      >
        <div className="engagement-dialog__list">
          {drilldownRow?.meetings.length ? (
            drilldownRow.meetings.map((meeting) => (
              <div className="engagement-dialog__list-row" key={meeting.id}>
                <span style={{ flex: '0 0 132px', fontFamily: 'var(--eng-font-mono)', fontSize: 11, color: 'var(--eng-ink-4)' }}>
                  {formatMeetingWhen(meeting.startsAt)}
                </span>
                <div style={{ flex: 1 }}>
                  <strong>{meeting.subject}</strong>
                  <span>{meeting.location || 'No location on file'}</span>
                </div>
                {meeting.externalUrl && (
                  <a href={meeting.externalUrl} target="_blank" rel="noreferrer" className="uui-report-meetings-link">
                    Open
                  </a>
                )}
              </div>
            ))
          ) : (
            <div className="uui-report-empty">No meetings are linked to this target office yet.</div>
          )}
        </div>
      </EngagementDialog>
    </div>
  );
}
