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
 * Filter/Sort: real dropdown-button-with-menu controls (`ReportsDropdown`,
 * below — NOT a native `<select>`, matching the phase brief's explicit
 * requirement), reusing the same `.uui-library-dropdown` class family
 * VNextMeetingLibrary.tsx's own `LibraryDropdown` already established for
 * this pattern. Each option's own label already carries the "Filter: "/
 * "Sort: " prefix, so the closed-state text is always correct with no
 * separate display label. Wired to the exact same client-side filter/sort
 * logic the canonical ReportsView already runs (EngagementPage.tsx) — real
 * behavior, not the mockup's own decorative, handler-less buttons (same
 * "make it real since real data already backs it" call the Library phase
 * made for ITS three dropdown filters).
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronsUpDown, Download, Filter, Plus } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { useClientOptions } from '../../../pages/engagement/meetings/meetings-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { useEngagementToast } from './engagement-toast.js';
import { buildReportTargetCreateBody } from '../../../pages/engagement/report-target-actions.js';
import {
  ReportTargetDirectory,
  directoryTargetDefaults,
  reportClientLabel,
  type DirectoryContactOption,
} from './ReportTargetDirectory.js';

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
  displayOverrides?: string[];
  archivedAt?: string | null;
  manualOnly?: boolean;
  requiresClientAssignment?: boolean;
  manuallyOverridden: boolean;
  prepOverridden?: boolean;
  outreachOverridden?: boolean;
  submissionOverridden?: boolean;
  meetings: ReportMeeting[];
}

interface Report {
  cycle: {
    reportYear: number | null;
    period: ReportPeriod;
    label: string;
    from: string | null;
    to: string | null;
  };
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
 *  same column set AND same column labels the canonical ReportsView's own
 *  CSV export uses (EngagementPage.tsx's exportEngagementReportCsv),
 *  reimplemented locally rather than importing from that non-exporting,
 *  non-vNext file. Deliberately NOT the shorter mockup table-header labels
 *  ("Prep"/"Outreach"/"Submission") the on-screen `<thead>` above uses: the
 *  CSV is a stable data-export contract a downstream spreadsheet may already
 *  depend on, independent of the visual reskin, so it keeps canonical's own
 *  "Prep Done"/"Outreach Sent"/"Submission Filed" wording verbatim. */
function downloadReportCsv(rows: ReportRow[], period: ReportPeriod) {
  const header = [
    'Member / Principal',
    'Client',
    'Committee',
    'Staffer',
    'Building',
    'Lead',
    'Meetings Held',
    'Prep Done',
    'Outreach Sent',
    'Submission Filed',
    'Pending Actions',
  ];
  const lines = rows.map((row) =>
    [
      row.memberPrincipal,
      reportClientLabel(row),
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
  onRestore,
}: {
  row: ReportRow;
  field: ReportStatusField;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onPick: (status: ReportStatus) => void;
  onRestore: () => void;
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
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <i />
        {STATUS_LABEL[status]}
        <ChevronDown size={12} />
      </button>
      {overridden && (
        <span className="uui-report-override-marker" aria-label="Manually overridden" />
      )}
      {open && (
        <span className="uui-report-status-menu" role="menu">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitem"
              disabled={disabled}
              data-state={option}
              data-selected={option === status || undefined}
              onClick={() => onPick(option)}
            >
              <i />
              {STATUS_LABEL[option]}
            </button>
          ))}
          {overridden && (
            <button type="button" role="menuitem" disabled={disabled} onClick={onRestore}>
              Restore automatic tracking
            </button>
          )}
        </span>
      )}
    </span>
  );
}

const FILTER_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'Filter: All statuses' },
  { value: 'complete', label: 'Filter: Complete' },
  { value: 'in_progress', label: 'Filter: In progress' },
  { value: 'not_started', label: 'Filter: Not started' },
];

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'member-asc', label: 'Sort: Member A–Z' },
  { value: 'member-desc', label: 'Sort: Member Z–A' },
  { value: 'meetings-desc', label: 'Sort: Meetings held' },
  { value: 'outreach-desc', label: 'Sort: Outreach sent' },
  { value: 'pending-desc', label: 'Sort: Pending actions' },
];

/**
 * A real dropdown-button + floating menu — explicitly NOT a native `<select>`
 * per the phase brief ("real dropdown-button-with-menu controls (not native
 * <select>)"). Reuses the exact `.uui-library-dropdown` class family
 * VNextMeetingLibrary.tsx's own `LibraryDropdown` already established for
 * this identical pattern (trigger button + absolute-positioned menu,
 * outside-click/Escape to close) rather than declaring a parallel Reports-
 * specific one. Simpler than `LibraryDropdown` in one respect: every option
 * here (including "All statuses") already carries its own full "Filter: "/
 * "Sort: " prefix — matching the canonical ReportsView's own AntD `Select`
 * options exactly — so the trigger always just shows the CURRENTLY selected
 * option's label, with no separate default-vs-selected label to track (every
 * one of these five sort keys, and all four status filters, is a real,
 * always-fully-labeled selection — unlike Library's filters, none of these
 * has a bare "no value chosen yet" state to special-case).
 */
function ReportsDropdown<T extends string>({
  ariaLabel,
  icon,
  options,
  value,
  onSelect,
}: {
  ariaLabel: string;
  icon: ReactNode;
  options: Array<{ value: T; label: string }>;
  value: T;
  onSelect: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const selectedLabel = options.find((option) => option.value === value)?.label ?? ariaLabel;

  return (
    <div className="uui-library-dropdown" ref={rootRef}>
      <button
        type="button"
        className="uui-library-dropdown__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        {icon}
        <span>{selectedLabel}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="uui-library-dropdown__menu">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              data-selected={option.value === value || undefined}
              onClick={() => {
                onSelect(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
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

const OFFICE_FIELDS = [
  ['memberPrincipal', 'Member / principal · required', 'Rep. Jane Smith (D-CA-12)'],
  ['committee', 'Committee', 'HASC'],
  ['building', 'Building', 'Rayburn'],
  ['leadOwner', 'Lead', 'Owner'],
  ['staffer', 'Staffer', 'Staffer name'],
] as const;

type OfficeField = (typeof OFFICE_FIELDS)[number][0];
function requestError(error: unknown, fallback: string): string {
  const message = (error as { response?: { data?: { message?: string | string[] } } })?.response
    ?.data?.message;
  return typeof message === 'string'
    ? message
    : Array.isArray(message)
      ? message.join('; ')
      : fallback;
}

function OfficeFields({
  values,
  clients,
  defaults,
  onChange,
  clientLocked = false,
  disabled = false,
}: {
  values: TargetOfficeFormValues;
  clients: Array<{ id: string; name: string }>;
  defaults?: Partial<Record<OfficeField, string>>;
  onChange: (field: keyof TargetOfficeFormValues, value: string) => void;
  clientLocked?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="engagement-dialog__field-grid">
      <label className="engagement-dialog__field">
        Client · required
        <select
          value={values.clientId}
          disabled={clientLocked || disabled}
          onChange={(event) => onChange('clientId', event.target.value)}
        >
          <option value="">Select a client</option>
          {values.clientId && !clients.some((client) => client.id === values.clientId) && (
            <option value={values.clientId}>Client {values.clientId}</option>
          )}
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </label>
      {OFFICE_FIELDS.map(([field, label, placeholder]) => (
        <label
          key={field}
          className={`engagement-dialog__field${field === 'memberPrincipal' ? ' is-full' : ''}`}
        >
          {label}
          {defaults && field in defaults && values[field] !== defaults[field] && (
            <span> · edited</span>
          )}
          <input
            value={values[field]}
            maxLength={field === 'memberPrincipal' ? 240 : field === 'staffer' ? 160 : 120}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => onChange(field, event.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

interface LinkConflict {
  field: string;
  manual: unknown;
  existing: unknown;
}

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
  const [directoryContact, setDirectoryContact] = useState<DirectoryContactOption | null>(null);
  const [officeDefaults, setOfficeDefaults] = useState<Partial<Record<OfficeField, string>>>({});
  const officeDirtyFields = useRef(new Set<string>());
  const [detailEditing, setDetailEditing] = useState(false);
  const [detailForm, setDetailForm] = useState<TargetOfficeFormValues>(EMPTY_OFFICE_FORM);
  const [linkRow, setLinkRow] = useState<ReportRow | null>(null);
  const [linkClientId, setLinkClientId] = useState('');
  const [linkContact, setLinkContact] = useState<DirectoryContactOption | null>(null);
  const [linkConflicts, setLinkConflicts] = useState<LinkConflict[]>([]);
  const [conflictResolutions, setConflictResolutions] = useState<
    Record<string, 'manual' | 'existing'>
  >({});

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
      (
        await api.get<Report>('/api/engagement/reports/overview', {
          params: { clientId: clientId ?? undefined, period },
        })
      ).data,
  });

  const reportYear = report.data?.cycle.reportYear ?? null;
  const clients = useClientOptions(addOfficeOpen || detailEditing || Boolean(linkRow));
  const refreshReport = () => qc.invalidateQueries({ queryKey: ['vnext-engagement-report'] });
  const detailRow =
    report.data?.rows.find((row) =>
      drilldownRow?.targetId
        ? row.targetId === drilldownRow.targetId
        : drilldownRow &&
          row.scopeKey === drilldownRow.scopeKey &&
          row.officeKey === drilldownRow.officeKey,
    ) ?? null;
  const statusEditable = (row: ReportRow) =>
    reportYear !== null && Boolean(row.clientId) && !row.archivedAt;
  const targetEditable = (row: ReportRow) => Boolean(row.targetId) && !row.archivedAt;

  const createTargetOffice = useMutation({
    mutationFn: async ({
      values,
      manualOnly,
    }: {
      values: TargetOfficeFormValues;
      manualOnly: boolean;
    }) => {
      if (!values.clientId || reportYear === null || (!manualOnly && !directoryContact))
        throw new Error('Select a client, reporting year and Directory member.');
      return (
        await api.post(
          '/api/engagement/reports/target-offices',
          buildReportTargetCreateBody({
            values: { ...values, manualOnly },
            reportYear,
            directoryContactId: directoryContact?.id,
            editedFields: officeDirtyFields.current,
          }),
        )
      ).data;
    },
    onSuccess: async () => {
      toast.show(`Target office added · ${officeForm.memberPrincipal}`);
      setAddOfficeOpen(false);
      await refreshReport();
    },
  });

  function overridePayload(row: ReportRow) {
    if (!statusEditable(row))
      throw new Error('Select a single reporting year and assign this target to a client first.');
    return {
      clientId: row.clientId,
      officeKey: row.officeKey,
      reportYear,
      source: row.source === 'manual' ? 'manual' : 'manual_override',
    };
  }
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
          ...overridePayload(row),
          [field]: status,
        })
      ).data,
    onSuccess: refreshReport,
    onSettled: () => setOpenMenuKey(null),
  });
  const restoreOverride = useMutation({
    mutationFn: async ({ row, field }: { row: ReportRow; field: ReportStatusField }) => {
      if (!statusEditable(row)) throw new Error('Select a single reporting year and client.');
      return (
        await api.delete('/api/engagement/reports/target-offices/overrides', {
          data: { clientId: row.clientId, officeKey: row.officeKey, reportYear, field },
        })
      ).data;
    },
    onSuccess: async () => {
      await refreshReport();
      toast.show('Automatic tracking restored for this status and reporting year');
    },
    onSettled: () => setOpenMenuKey(null),
  });
  const updateTargetOffice = useMutation({
    mutationFn: async ({ row, values }: { row: ReportRow; values: TargetOfficeFormValues }) => {
      if (!values.clientId || !row.targetId) throw new Error('A client is required.');
      const changed = Object.fromEntries(
        Object.entries(values).filter(
          ([field, value]) => value !== (row[field as keyof ReportRow] ?? ''),
        ),
      );
      return (await api.patch(`/api/engagement/reports/target-offices/${row.targetId}`, changed))
        .data;
    },
    onSuccess: async () => {
      await refreshReport();
      setDetailEditing(false);
      toast.show('Target office updated');
    },
  });
  const archiveTargetOffice = useMutation({
    mutationFn: async (row: ReportRow) =>
      (await api.delete(`/api/engagement/reports/target-offices/${row.targetId}`)).data,
    onSuccess: async () => {
      setDrilldownRow(null);
      await refreshReport();
      toast.show('Target office archived');
    },
  });
  const markRowComplete = useMutation({
    mutationFn: async (row: ReportRow) =>
      (
        await api.post('/api/engagement/reports/target-offices/overrides', {
          ...overridePayload(row),
          submissionStatus: 'complete',
        })
      ).data,
    onSuccess: async () => {
      await refreshReport();
      toast.show('Submission marked complete');
    },
  });
  const linkTargetOffice = useMutation({
    mutationFn: async () => {
      if (!linkRow || !linkClientId || !linkContact)
        throw new Error('Select a client and Directory member.');
      return (
        await api.post('/api/engagement/reports/target-offices/link', {
          targetId: linkRow.targetId,
          officeKey: linkRow.officeKey,
          clientId: linkClientId,
          directoryContactId: linkContact.id,
          conflictResolutions,
        })
      ).data;
    },
    onError: (error) => {
      const response = (
        error as { response?: { data?: { code?: string; conflicts?: LinkConflict[] } } }
      ).response?.data;
      if (response?.code === 'TARGET_LINK_CONFLICT') setLinkConflicts(response.conflicts ?? []);
    },
    onSuccess: async () => {
      setLinkRow(null);
      setDrilldownRow(null);
      await refreshReport();
      toast.show('Target linked to Directory');
    },
  });
  function openDetails(row: ReportRow) {
    setDrilldownRow(row);
    setDetailEditing(false);
    updateTargetOffice.reset();
    archiveTargetOffice.reset();
    markRowComplete.reset();
  }
  function openLink(row: ReportRow) {
    setLinkRow(row);
    setLinkClientId(row.clientId ?? '');
    setLinkContact(null);
    setLinkConflicts([]);
    setConflictResolutions({});
    linkTargetOffice.reset();
  }

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

  const canSaveOffice = Boolean(
    officeForm.clientId && officeForm.memberPrincipal.trim() && reportYear !== null,
  );
  const mutationBusy = updateOverride.isPending || restoreOverride.isPending;
  const detailBusy =
    updateTargetOffice.isPending || archiveTargetOffice.isPending || markRowComplete.isPending;
  const clientLoadFeedback = clients.isLoading ? (
    <p role="status">Loading clients…</p>
  ) : clients.isError ? (
    <p role="alert">
      Could not load clients.{' '}
      <button type="button" onClick={() => void clients.refetch()}>
        Retry clients
      </button>
    </p>
  ) : null;

  return (
    <div className="uui-reports-page">
      <h2 className="uui-reports-heading">Reports</h2>
      <p className="uui-reports-subline">
        {report.data?.cycle.label ?? 'Reporting cycle'} Engagement Activity Overview
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
              {key === 'current'
                ? 'Current Cycle'
                : key === 'previous'
                  ? 'Previous Cycle'
                  : 'All Time'}
            </button>
          ))}
        </div>
        <span className="uui-report-toolbar-spacer" />
        <button
          type="button"
          className="uui-button uui-button--primary"
          disabled={reportYear === null}
          title={reportYear === null ? 'Select a reporting year to add a target' : undefined}
          onClick={() => {
            setOfficeForm({ ...EMPTY_OFFICE_FORM, clientId: clientId ?? '' });
            setDirectoryContact(null);
            setOfficeDefaults({});
            officeDirtyFields.current.clear();
            createTargetOffice.reset();
            setAddOfficeOpen(true);
          }}
        >
          <Plus size={16} />
          Add target office
        </button>
        <ReportsDropdown<StatusFilter>
          ariaLabel="Filter by status"
          icon={<Filter size={16} />}
          options={FILTER_OPTIONS}
          value={statusFilter}
          onSelect={setStatusFilter}
        />
        <ReportsDropdown<SortKey>
          ariaLabel="Sort"
          icon={<ChevronsUpDown size={16} />}
          options={SORT_OPTIONS}
          value={sort}
          onSelect={setSort}
        />
        <button
          type="button"
          className="uui-button"
          disabled={!rows.length}
          onClick={() => {
            downloadReportCsv(rows, period);
            toast.show(
              `CSV export queued · ${period === 'current' ? 'current cycle' : period === 'previous' ? 'previous cycle' : 'all time'} · ${rows.length} office${rows.length === 1 ? '' : 's'}`,
            );
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
                <button
                  type="button"
                  className="uui-report-meetings-link"
                  onClick={() => void report.refetch()}
                >
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
                  <span title={row.memberPrincipal}>
                    <button
                      type="button"
                      className="uui-report-meetings-link"
                      onClick={() => openDetails(row)}
                    >
                      {row.memberPrincipal}
                    </button>
                    {row.displayOverrides?.includes('memberPrincipal') && (
                      <small title="Display wording was edited; Directory identity is unchanged">
                        edited
                      </small>
                    )}
                    {!clientId && (
                      <small className="uui-report-client-label">{reportClientLabel(row)}</small>
                    )}
                    {(row.manualOnly || row.officeKey.startsWith('manual:')) && (
                      <small>
                        Manual-only · won't auto-populate{' '}
                        {!row.archivedAt && (
                          <button type="button" onClick={() => openLink(row)}>
                            Link to Directory
                          </button>
                        )}
                      </small>
                    )}
                    {!row.clientId && (
                      <small>
                        {row.targetId
                          ? 'Assign a client in target details'
                          : 'No client assigned to source activity'}
                      </small>
                    )}
                    {row.archivedAt && <small>Archived</small>}
                  </span>
                  <span>
                    {row.committee || '—'}
                    {row.displayOverrides?.includes('committee') && (
                      <small title="Display wording was edited; Directory identity is unchanged">
                        {' '}
                        · edited
                      </small>
                    )}
                  </span>
                  <span>
                    {row.staffer || '—'}
                    {row.displayOverrides?.includes('staffer') && (
                      <small title="Display wording was edited; Directory identity is unchanged">
                        {' '}
                        · edited
                      </small>
                    )}
                  </span>
                  <span>
                    {row.building || '—'}
                    {row.displayOverrides?.includes('building') && (
                      <small title="Display wording was edited; Directory identity is unchanged">
                        {' '}
                        · edited
                      </small>
                    )}
                  </span>
                  <span>
                    {row.leadOwner || '—'}
                    {row.displayOverrides?.includes('leadOwner') && (
                      <small title="Display wording was edited; Directory identity is unchanged">
                        {' '}
                        · edited
                      </small>
                    )}
                  </span>
                  <button
                    type="button"
                    className="uui-report-meetings-link"
                    onClick={() => openDetails(row)}
                  >
                    {row.meetingsHeld} View
                  </button>
                  {(
                    ['prepStatus', 'outreachStatus', 'submissionStatus'] as ReportStatusField[]
                  ).map((field) => {
                    const key = reportCellKey(row, field);
                    return (
                      <StatusCell
                        key={field}
                        row={row}
                        field={field}
                        disabled={!statusEditable(row) || mutationBusy}
                        open={openMenuKey === key}
                        onToggle={() => setOpenMenuKey((current) => (current === key ? null : key))}
                        onPick={(status) => updateOverride.mutate({ row, field, status })}
                        onRestore={() => restoreOverride.mutate({ row, field })}
                      />
                    );
                  })}
                  <span
                    className="uui-report-pending"
                    data-nonzero={row.pendingActions > 0 || undefined}
                  >
                    {row.pendingActions}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {(updateOverride.isError || restoreOverride.isError) && (
        <p role="alert">
          {requestError(
            updateOverride.error ?? restoreOverride.error,
            'Could not update this status. Your saved settings were kept. Try again.',
          )}
        </p>
      )}
      {reportYear === null && (
        <p className="uui-library-note">
          All Time combines activity across years. Select Current Cycle or Previous Cycle to change
          statuses or add a target.
        </p>
      )}
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
        error={
          createTargetOffice.isError
            ? requestError(createTargetOffice.error, 'Could not add the target office. Try again.')
            : null
        }
        dirty={officeForm.memberPrincipal.trim().length > 0}
        onClose={() => setAddOfficeOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="uui-button"
              disabled={createTargetOffice.isPending}
              onClick={() => setAddOfficeOpen(false)}
            >
              Cancel
            </button>
            {!directoryContact && (
              <button
                type="button"
                className="uui-button"
                disabled={createTargetOffice.isPending || !canSaveOffice}
                onClick={() => createTargetOffice.mutate({ values: officeForm, manualOnly: true })}
              >
                Save as manual-only
              </button>
            )}
            <button
              type="button"
              className="uui-button uui-button--primary"
              disabled={createTargetOffice.isPending || !canSaveOffice || !directoryContact}
              onClick={() => createTargetOffice.mutate({ values: officeForm, manualOnly: false })}
            >
              {createTargetOffice.isPending ? 'Adding…' : 'Add office'}
            </button>
          </>
        }
      >
        {clientLoadFeedback}
        <ReportTargetDirectory
          value={directoryContact}
          disabled={createTargetOffice.isPending}
          onClear={() => setDirectoryContact(null)}
          onSelect={(contact) => {
            const defaults = directoryTargetDefaults(contact);
            setDirectoryContact(contact);
            setOfficeDefaults(defaults);
            setOfficeForm((previous) => ({
              ...previous,
              ...Object.fromEntries(
                Object.entries(defaults).filter(([field]) => !officeDirtyFields.current.has(field)),
              ),
            }));
          }}
        />
        <OfficeFields
          values={officeForm}
          clients={clientOptions}
          defaults={officeDefaults}
          disabled={createTargetOffice.isPending}
          onChange={(field, value) => {
            officeDirtyFields.current.add(field);
            setOfficeForm((previous) => ({ ...previous, [field]: value }));
          }}
        />
        <p className="uui-library-note">
          Directory-linked targets automatically receive activity for this client. Display edits
          keep the selected identity. Manual-only targets won't auto-populate until you link them to
          Directory. Targets remain planned across reporting years; status overrides apply only to
          the selected year.
        </p>
      </EngagementDialog>

      <EngagementDialog
        open={Boolean(detailRow)}
        eyebrow="Reports · target details"
        title={detailRow ? `Target office · ${detailRow.memberPrincipal}` : 'Target office'}
        width={620}
        busy={detailBusy}
        dirty={detailEditing}
        error={
          updateTargetOffice.isError || archiveTargetOffice.isError || markRowComplete.isError
            ? requestError(
                updateTargetOffice.error ?? archiveTargetOffice.error ?? markRowComplete.error,
                'Could not save this change. Your saved target was kept. Try again.',
              )
            : null
        }
        onClose={() => {
          setDrilldownRow(null);
          setDetailEditing(false);
        }}
        footer={
          detailRow ? (
            detailEditing ? (
              <>
                <button
                  type="button"
                  className="uui-button"
                  disabled={detailBusy}
                  onClick={() => setDetailEditing(false)}
                >
                  Cancel editing
                </button>
                <button
                  type="button"
                  className="uui-button uui-button--primary"
                  disabled={
                    detailBusy || !detailForm.clientId || !detailForm.memberPrincipal.trim()
                  }
                  onClick={() => updateTargetOffice.mutate({ row: detailRow, values: detailForm })}
                >
                  Save changes
                </button>
              </>
            ) : (
              <>
                {targetEditable(detailRow) && (
                  <>
                    <button
                      type="button"
                      className="uui-button"
                      disabled={detailBusy}
                      onClick={() => {
                        if (
                          window.confirm(
                            'Archive this target office? It will be removed from active planning. Earlier cycles and All Time retain its history.',
                          )
                        )
                          archiveTargetOffice.mutate(detailRow);
                      }}
                    >
                      Archive
                    </button>
                    <button
                      type="button"
                      className="uui-button"
                      disabled={detailBusy}
                      onClick={() => {
                        setDetailForm({
                          clientId: detailRow.clientId ?? '',
                          memberPrincipal: detailRow.memberPrincipal,
                          committee: detailRow.committee ?? '',
                          building: detailRow.building ?? '',
                          leadOwner: detailRow.leadOwner ?? '',
                          staffer: detailRow.staffer ?? '',
                        });
                        updateTargetOffice.reset();
                        setDetailEditing(true);
                      }}
                    >
                      Edit
                    </button>
                  </>
                )}
                {statusEditable(detailRow) && (
                  <button
                    type="button"
                    className="uui-button"
                    disabled={detailBusy || detailRow.submissionStatus === 'complete'}
                    onClick={() => markRowComplete.mutate(detailRow)}
                  >
                    Mark submission complete
                  </button>
                )}
                {(detailRow.manualOnly || detailRow.officeKey.startsWith('manual:')) &&
                  !detailRow.archivedAt && (
                    <button
                      type="button"
                      className="uui-button"
                      disabled={detailBusy}
                      onClick={() => {
                        openLink(detailRow);
                        setDrilldownRow(null);
                      }}
                    >
                      Link to Directory
                    </button>
                  )}
              </>
            )
          ) : null
        }
      >
        {detailRow && detailEditing ? (
          <>
            {clientLoadFeedback}
            <OfficeFields
              values={detailForm}
              clients={clientOptions}
              disabled={detailBusy}
              onChange={(field, value) =>
                setDetailForm((previous) => ({ ...previous, [field]: value }))
              }
            />
          </>
        ) : (
          detailRow && (
            <>
              <p>{reportClientLabel(detailRow)}</p>
              <dl>
                {OFFICE_FIELDS.map(([field, label]) => (
                  <div key={field}>
                    <dt>
                      {label.replace(' · required', '')}
                      {detailRow.displayOverrides?.includes(field) && ' · edited'}
                    </dt>
                    <dd>{detailRow[field] || '—'}</dd>
                  </div>
                ))}
              </dl>
              <p>
                Prep: {STATUS_LABEL[detailRow.prepStatus]} · Outreach:{' '}
                {STATUS_LABEL[detailRow.outreachStatus]} · Submission:{' '}
                {STATUS_LABEL[detailRow.submissionStatus]}
              </p>
              {detailRow.archivedAt && (
                <p>This archived target is retained for this historical reporting year.</p>
              )}
              <div className="engagement-dialog__list">
                {detailRow.meetings.length ? (
                  detailRow.meetings.map((meeting) => (
                    <div className="engagement-dialog__list-row" key={meeting.id}>
                      <span>{formatMeetingWhen(meeting.startsAt)}</span>
                      <div>
                        <strong>{meeting.subject}</strong>
                        <span>{meeting.location || 'No location on file'}</span>
                      </div>
                      {meeting.externalUrl && (
                        <a
                          href={meeting.externalUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="uui-report-meetings-link"
                        >
                          Open
                        </a>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="uui-report-empty">
                    No meetings are linked to this target office yet.
                  </div>
                )}
              </div>
            </>
          )
        )}
      </EngagementDialog>

      <EngagementDialog
        open={Boolean(linkRow)}
        eyebrow="Reports · reconcile target"
        title="Link target to Directory"
        width={620}
        busy={linkTargetOffice.isPending}
        dirty={Boolean(linkContact)}
        onClose={() => setLinkRow(null)}
        error={
          linkTargetOffice.isError &&
          (linkTargetOffice.error as { response?: { data?: { code?: string } } })?.response?.data
            ?.code !== 'TARGET_LINK_CONFLICT'
            ? requestError(
                linkTargetOffice.error,
                'Could not link this target. Your saved target was kept. Try again.',
              )
            : null
        }
        footer={
          <>
            <button
              type="button"
              className="uui-button"
              disabled={linkTargetOffice.isPending}
              onClick={() => setLinkRow(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="uui-button uui-button--primary"
              disabled={
                linkTargetOffice.isPending ||
                !linkClientId ||
                !linkContact ||
                linkConflicts.some((conflict) => !conflictResolutions[conflict.field])
              }
              onClick={() => linkTargetOffice.mutate()}
            >
              {linkConflicts.length ? 'Resolve and link' : 'Link target'}
            </button>
          </>
        }
      >
        {clientLoadFeedback}
        <p>{linkRow?.memberPrincipal}</p>
        <label className="engagement-dialog__field">
          Target client · required
          <select
            value={linkClientId}
            disabled={linkTargetOffice.isPending || Boolean(linkRow?.clientId)}
            onChange={(event) => {
              linkTargetOffice.reset();
              setLinkClientId(event.target.value);
              setLinkConflicts([]);
              setConflictResolutions({});
            }}
          >
            <option value="">Select a client</option>
            {linkClientId && !clientOptions.some((client) => client.id === linkClientId) && (
              <option value={linkClientId}>
                {linkRow ? reportClientLabel(linkRow) : linkClientId}
              </option>
            )}
            {clientOptions.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <ReportTargetDirectory
          value={linkContact}
          disabled={linkTargetOffice.isPending}
          onClear={() => {
            linkTargetOffice.reset();
            setLinkContact(null);
            setLinkConflicts([]);
            setConflictResolutions({});
          }}
          onSelect={(contact) => {
            linkTargetOffice.reset();
            setLinkContact(contact);
            setLinkConflicts([]);
            setConflictResolutions({});
          }}
        />
        <p>
          Choose the exact member. Compatible saved values are retained. Conflicting values require
          your choice before either target is changed.
        </p>
        {linkConflicts.length > 0 && (
          <div role="alert">
            <p>
              This client already has a target for that member. Choose which saved value to keep for
              each conflict.
            </p>
            {linkConflicts.map((conflict) => (
              <fieldset key={conflict.field}>
                <legend>{conflict.field}</legend>
                {(['manual', 'existing'] as const).map((source) => (
                  <label key={source}>
                    <input
                      type="radio"
                      disabled={linkTargetOffice.isPending}
                      name={`resolve-${conflict.field}`}
                      checked={conflictResolutions[conflict.field] === source}
                      onChange={() =>
                        setConflictResolutions((previous) => ({
                          ...previous,
                          [conflict.field]: source,
                        }))
                      }
                    />
                    {source === 'manual' ? 'This target' : 'Existing Directory target'}:{' '}
                    {String(conflict[source] ?? '(empty)')}
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        )}
      </EngagementDialog>
    </div>
  );
}
