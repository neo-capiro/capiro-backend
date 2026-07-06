import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  ExportOutlined,
  FileTextOutlined,
  MailOutlined,
  PlusOutlined,
  RobotOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMe } from '../../lib/me.js';
import { useApi } from '../../lib/use-api.js';
import { useClientFilter } from '../../state/client-filter.js';
import type { Client } from '../clients/clientTypes.js';
import { OverviewTab } from './OverviewTab.js';
import { OutreachView } from './OutreachView.js';

interface EngagementCapabilities {
  ai: { activeProvider: 'openai' | 'anthropic' | null };
  notes: { encryptedNotesConfigured: boolean };
  attachments: { s3Configured: boolean; maxBytes: number };
}

interface MeetingAttendee {
  id: string;
  email: string | null;
  name: string | null;
  role: string | null;
}

interface MeetingPrep {
  id: string;
  status: 'generated' | 'edited' | 'approved' | 'stale' | 'failed';
  agenda: string[];
  talkingPoints: string[];
  risks: string[];
  followUps: string[];
  emailEvidence: string[];
  summary: string | null;
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Meeting {
  id: string;
  subject: string;
  source: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  organizerEmail: string | null;
  organizerName: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  isInternal?: boolean;
  associationScore: number | null;
  associationReason: string | null;
  client: Pick<
    Client,
    'id' | 'name' | 'website' | 'primaryContactName' | 'primaryContactEmail'
  > | null;
  attendees: MeetingAttendee[];
  attachments: EngagementAttachment[];
  preps: MeetingPrep[];
  notes: MeetingNoteSummary[];
  debriefs: MeetingDebriefSummary[];
}

interface EngagementAttachment {
  id: string;
  meetingId: string | null;
  fileName: string;
  contentType: string;
  byteSize: number | null;
  source: string;
  createdAt: string;
  downloadUrl?: string | null;
}

interface DebriefSourceExtraction {
  attachmentId: string;
  fileName: string;
  contentType: string;
  source: 'text' | 'docx' | 'transcription';
  text: string;
}

interface MeetingNoteSummary {
  id: string;
  confidential: boolean;
  accessLevel?: string;
  authorUserId?: string | null;
  author?: NoteAuthor | null;
  createdAt: string;
}

interface MeetingDebriefSummary {
  id: string;
  confidential: boolean;
  accessLevel?: string;
  authorUserId?: string | null;
  author?: NoteAuthor | null;
  createdAt: string;
}

interface MeetingDebrief extends MeetingDebriefSummary {
  body: string | null;
  restricted: boolean;
  updatedAt: string;
}

interface MeetingDebriefDraft {
  recap: string;
  actionItems: string[];
  notes: string;
  provider: 'openai' | 'anthropic';
  model: string;
}

interface NoteAuthor {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

interface EngagementTask {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  status: 'todo' | 'in_progress' | 'done' | 'blocked' | 'canceled';
  client: Pick<Client, 'id' | 'name'> | null;
  meeting: { id: string; subject: string } | null;
}

interface MailThread {
  id: string;
  subject: string;
  source: string;
  snippet: string | null;
  lastMessageAt: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  client: Pick<Client, 'id' | 'name'> | null;
  messages: Array<{
    id: string;
    fromEmail: string | null;
    receivedAt: string | null;
    metadata: Record<string, unknown> | null;
  }>;
}

interface ClientContext {
  recentActivity: Array<{ type: string; id: string; title: string; date: string }>;
  keyStakeholders: Array<{
    id: string;
    email: string | null;
    fullName: string | null;
    title: string | null;
    organization: string | null;
  }>;
  openThreads: Array<{
    id: string;
    subject: string;
    snippet: string | null;
    lastMessageAt: string | null;
  }>;
  openTasks: EngagementTask[];
  summary: {
    meetings: number;
    mailThreads: number;
    contacts: number;
    openTasks: number;
    rag: string;
  };
}

type ReportPeriod = 'current' | 'previous' | 'all';
type ReportStatus = 'not_started' | 'in_progress' | 'complete';
type ReportStatusField = 'prepStatus' | 'outreachStatus' | 'submissionStatus';

const REPORT_STATUS_OPTIONS: Array<{ value: ReportStatus; label: ReactNode }> = [
  {
    value: 'complete',
    label: (
      <span className="engagement-report-status-option status-complete">
        <i />
        Complete
      </span>
    ),
  },
  {
    value: 'in_progress',
    label: (
      <span className="engagement-report-status-option status-in_progress">
        <i />
        In Progress
      </span>
    ),
  },
  {
    value: 'not_started',
    label: (
      <span className="engagement-report-status-option status-not_started">
        <i />
        Not Started
      </span>
    ),
  },
];

interface EngagementReportMeeting {
  id: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  externalUrl: string | null;
}

interface EngagementReportRow {
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
  meetings: EngagementReportMeeting[];
}

interface EngagementReport {
  cycle: {
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
  rows: EngagementReportRow[];
}

interface MeetingFormValues {
  clientId?: string;
  subject: string;
  date: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  description?: string;
  attendeesText?: string;
}

interface TaskFormValues {
  title: string;
  description?: string;
  dueDate?: string;
}

interface PrepFormValues {
  summary?: string;
  agendaText?: string;
  talkingPointsText?: string;
  risksText?: string;
  followUpsText?: string;
  emailEvidenceText?: string;
}

interface DebriefDraftState {
  recap: string;
  actionItems: string[];
  notes: string;
}

interface TargetOfficeFormValues {
  clientId?: string;
  memberPrincipal: string;
  committee?: string;
  staffer?: string;
  building?: string;
  leadOwner?: string;
}

export function EngagementPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { selectedClientId, setSelectedClientId } = useClientFilter();
  const defaultRange = useMemo(() => defaultMeetingRange(), []);
  const [rangeStart, setRangeStart] = useState(defaultRange.start);
  const [rangeEnd, setRangeEnd] = useState(defaultRange.end);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [meetingDetailTab, setMeetingDetailTab] = useState('prep');
  const [activeEngagementTab, setActiveEngagementTab] = useState<
    'overview' | 'meetings' | 'outreach' | 'reports'
  >('overview');
  const [meetingViewMode, setMeetingViewMode] = useState<'list' | 'calendar' | 'day'>('day');
  const [historyBatch, setHistoryBatch] = useState(0);
  // Day picked from the week-nav date picker, so the Day view can highlight it.
  const [meetingFocusDayKey, setMeetingFocusDayKey] = useState<string | null>(null);
  const [reportPeriod, setReportPeriod] = useState<ReportPeriod>('current');
  const [reportStatusFilter, setReportStatusFilter] = useState<'all' | ReportStatus>('all');
  const [reportSort, setReportSort] = useState('member-asc');
  const [meetingModalOpen, setMeetingModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [targetOfficeModalOpen, setTargetOfficeModalOpen] = useState(false);
  const [reportMeetingRow, setReportMeetingRow] = useState<EngagementReportRow | null>(null);
  const [editingPrep, setEditingPrep] = useState<{ meeting: Meeting; prep: MeetingPrep } | null>(
    null,
  );
  const [meetingForm] = Form.useForm<MeetingFormValues>();
  const [taskForm] = Form.useForm<TaskFormValues>();
  const [prepForm] = Form.useForm<PrepFormValues>();
  const [targetOfficeForm] = Form.useForm<TargetOfficeFormValues>();
  const syncingFromUrlRef = useRef(false);
  const lastProcessedUrlRef = useRef<string>('');

  useEffect(() => {
    // Only sync URL → state when the URL itself has changed since we last saw it.
    // Without this guard, this effect re-runs whenever activeEngagementTab (or any
    // other dep) updates from a user click, and because the URL hasn't caught up
    // yet, it would clobber the new state back to the URL's stale value before
    // the navigate effect below ever runs. Net result: tab clicks would revert.
    const urlKey = `${location.pathname}?${searchParams.toString()}`;
    if (lastProcessedUrlRef.current === urlKey) return;
    lastProcessedUrlRef.current = urlKey;

    const segments = location.pathname.split('/').filter(Boolean);
    const section = segments[0] === 'engagement' ? (segments[1] ?? 'overview') : null;
    const nextTab =
      section && ['overview', 'meetings', 'outreach', 'reports'].includes(section)
        ? (section as 'overview' | 'meetings' | 'outreach' | 'reports')
        : null;
    const nextMeetingId =
      nextTab === 'meetings' && segments[2] ? decodeURIComponent(segments[2]) : null;
    const nextDetail = searchParams.get('detail');
    const nextView = searchParams.get('view');
    const nextFrom = searchParams.get('from');
    const nextTo = searchParams.get('to');
    const nextPeriod = searchParams.get('period');

    const hasUrlStateChange =
      (nextTab && nextTab !== activeEngagementTab) ||
      (nextTab === 'meetings' && nextMeetingId !== selectedMeetingId) ||
      (nextTab === 'meetings' && nextDetail && nextDetail !== meetingDetailTab) ||
      (nextTab === 'meetings' &&
        (nextView === 'list' || nextView === 'calendar' || nextView === 'day') &&
        nextView !== meetingViewMode) ||
      (nextTab === 'meetings' && nextFrom && nextFrom !== rangeStart) ||
      (nextTab === 'meetings' && nextTo && nextTo !== rangeEnd) ||
      (nextTab === 'reports' &&
        ['current', 'previous', 'all'].includes(nextPeriod ?? '') &&
        nextPeriod !== reportPeriod);

    if (!hasUrlStateChange) return;
    syncingFromUrlRef.current = true;

    if (nextTab) {
      setActiveEngagementTab(nextTab);
    }
    if (nextTab === 'meetings') {
      setSelectedMeetingId(nextMeetingId);
      if (nextDetail) setMeetingDetailTab(nextDetail);
      if (nextView === 'list' || nextView === 'calendar' || nextView === 'day') {
        setMeetingViewMode(nextView);
      }
      if (nextFrom) setRangeStart(nextFrom);
      if (nextTo) setRangeEnd(nextTo);
    }
    if (nextTab === 'reports' && ['current', 'previous', 'all'].includes(nextPeriod ?? '')) {
      setReportPeriod(nextPeriod as ReportPeriod);
    }
  }, [
    activeEngagementTab,
    location.pathname,
    meetingDetailTab,
    meetingViewMode,
    rangeEnd,
    rangeStart,
    reportPeriod,
    searchParams,
    selectedMeetingId,
  ]);

  useEffect(() => {
    if (syncingFromUrlRef.current) {
      syncingFromUrlRef.current = false;
      return;
    }

    const nextParams = new URLSearchParams();
    let nextPath = '/engagement/overview';

    if (activeEngagementTab === 'meetings') {
      nextPath = selectedMeetingId
        ? `/engagement/meetings/${encodeURIComponent(selectedMeetingId)}`
        : '/engagement/meetings';
      if (meetingDetailTab && meetingDetailTab !== 'prep')
        nextParams.set('detail', meetingDetailTab);
      // Day is the default view, so only serialize the non-default views.
      if (meetingViewMode !== 'day') nextParams.set('view', meetingViewMode);
      if (rangeStart) nextParams.set('from', rangeStart);
      if (rangeEnd) nextParams.set('to', rangeEnd);
    } else if (activeEngagementTab === 'outreach') {
      nextPath = location.pathname.startsWith('/engagement/outreach')
        ? location.pathname
        : '/engagement/outreach';
    } else if (activeEngagementTab === 'reports') {
      nextPath = '/engagement/reports';
      if (reportPeriod !== 'current') nextParams.set('period', reportPeriod);
    }

    const nextSearch = nextParams.toString();
    const currentSearch = searchParams.toString();
    if (location.pathname === nextPath && currentSearch === nextSearch) return;

    // Pre-record the URL we're about to write so the URL→state effect skips it
    // when location updates (state already reflects the change).
    lastProcessedUrlRef.current = `${nextPath}?${nextSearch}`;

    navigate(
      {
        pathname: nextPath,
        search: nextSearch ? `?${nextSearch}` : '',
      },
      { replace: true },
    );
  }, [
    activeEngagementTab,
    location.pathname,
    meetingDetailTab,
    meetingViewMode,
    navigate,
    rangeEnd,
    rangeStart,
    reportPeriod,
    searchParams,
    selectedMeetingId,
  ]);

  const meetingWindow = useMemo(
    () => dateRangeWindow(rangeStart, rangeEnd, historyBatch),
    [historyBatch, rangeEnd, rangeStart],
  );
  const hasCustomMeetingRange =
    rangeStart !== defaultRange.start || rangeEnd !== defaultRange.end || historyBatch > 0;

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
  });
  const activeClients = useMemo(
    () =>
      (clients.data ?? [])
        .filter((client) => client.status !== 'archived')
        .sort((left, right) => left.name.localeCompare(right.name)),
    [clients.data],
  );
  const clientSelectOptions = useMemo(
    () => activeClients.map((client) => ({ value: client.id, label: client.name })),
    [activeClients],
  );

  const capabilities = useQuery<EngagementCapabilities>({
    queryKey: ['engagement-capabilities'],
    queryFn: async () =>
      (await api.get<EngagementCapabilities>('/api/engagement/capabilities')).data,
  });

  const meetings = useQuery<Meeting[]>({
    queryKey: ['engagement-meetings', selectedClientId, meetingWindow.from, meetingWindow.to],
    queryFn: async () =>
      (
        await api.get<Meeting[]>('/api/engagement/meetings', {
          params: {
            clientId: selectedClientId ?? undefined,
            from: meetingWindow.from,
            to: meetingWindow.to,
          },
        })
      ).data,
  });

  // ── Tenant-scoped mock meetings (only for "capiro" tenant when API returns nothing)
  const isCapiroTenant = me.data?.tenant?.slug === 'capiro';
  const meetingsWithMock = useMemo(() => {
    const realMeetings = meetings.data ?? [];
    if (isCapiroTenant && realMeetings.length === 0) {
      return MOCK_MEETINGS_FOR_CAPIRO;
    }
    return realMeetings;
  }, [meetings.data, isCapiroTenant]);

  const visibleMeetings = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayStart = startOfToday.getTime();
    return [...meetingsWithMock].sort((left, right) => {
      const leftTime = new Date(left.startsAt).getTime();
      const rightTime = new Date(right.startsAt).getTime();
      // Today + upcoming meetings come first (soonest first); past meetings
      // sink below them (most recent past first).
      const leftUpcoming = leftTime >= todayStart;
      const rightUpcoming = rightTime >= todayStart;
      if (leftUpcoming !== rightUpcoming) return leftUpcoming ? -1 : 1;
      return leftUpcoming ? leftTime - rightTime : rightTime - leftTime;
    });
  }, [meetingsWithMock]);
  const selectedMeetingFromVisible = useMemo(
    () => visibleMeetings.find((meeting) => meeting.id === selectedMeetingId) ?? null,
    [visibleMeetings, selectedMeetingId],
  );
  const selectedMeetingQuery = useQuery<Meeting>({
    queryKey: ['engagement-meeting', selectedMeetingId],
    queryFn: async () =>
      (await api.get<Meeting>(`/api/engagement/meetings/${selectedMeetingId}`)).data,
    enabled: Boolean(selectedMeetingId && !selectedMeetingFromVisible),
  });
  const selectedMeeting = selectedMeetingFromVisible ?? selectedMeetingQuery.data ?? null;
  const contextClientId = selectedClientId ?? selectedMeeting?.client?.id ?? null;

  const clientContext = useQuery<ClientContext>({
    queryKey: ['engagement-client-context', contextClientId],
    queryFn: async () =>
      (await api.get<ClientContext>(`/api/engagement/context/${contextClientId}`)).data,
    enabled: Boolean(contextClientId),
  });

  const meetingAttachments = useQuery<EngagementAttachment[]>({
    queryKey: ['engagement-meeting-attachments', selectedMeeting?.id],
    queryFn: async () =>
      (
        await api.get<EngagementAttachment[]>('/api/engagement/attachments', {
          params: { meetingId: selectedMeeting?.id },
        })
      ).data,
    enabled: Boolean(selectedMeeting?.id),
  });

  const meetingDebriefs = useQuery<MeetingDebrief[]>({
    queryKey: ['engagement-meeting-debriefs', selectedMeeting?.id],
    queryFn: async () =>
      (await api.get<MeetingDebrief[]>(`/api/engagement/meetings/${selectedMeeting?.id}/debriefs`))
        .data,
    enabled: Boolean(selectedMeeting?.id),
  });

  const tasks = useQuery<EngagementTask[]>({
    queryKey: ['engagement-tasks', selectedClientId],
    queryFn: async () =>
      (
        await api.get<EngagementTask[]>('/api/engagement/tasks', {
          params: { clientId: selectedClientId ?? undefined },
        })
      ).data,
  });

  const mailThreads = useQuery<MailThread[]>({
    queryKey: ['engagement-mail-threads', selectedClientId],
    queryFn: async () =>
      (
        await api.get<MailThread[]>('/api/engagement/mail-threads', {
          params: { clientId: selectedClientId ?? undefined },
        })
      ).data,
  });

  const report = useQuery<EngagementReport>({
    queryKey: ['engagement-report', selectedClientId, reportPeriod],
    queryFn: async () =>
      (
        await api.get<EngagementReport>('/api/engagement/reports/overview', {
          params: { clientId: selectedClientId ?? undefined, period: reportPeriod },
        })
      ).data,
  });

  const createMeeting = useMutation({
    mutationFn: async (values: MeetingFormValues) =>
      (
        await api.post('/api/engagement/meetings', {
          clientId: values.clientId || selectedClientId || undefined,
          subject: values.subject,
          description: optionalText(values.description),
          location: optionalText(values.location),
          startsAt: localDateTimeToIso(values.date, values.startsAt),
          endsAt: localDateTimeToIso(values.date, values.endsAt),
          attendees: parseAttendees(values.attendeesText),
        })
      ).data,
    onSuccess: () => {
      message.success('Meeting saved');
      setMeetingModalOpen(false);
      meetingForm.resetFields();
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-tasks'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const createTask = useMutation({
    mutationFn: async (values: TaskFormValues) =>
      (
        await api.post('/api/engagement/tasks', {
          clientId: selectedClientId ?? undefined,
          title: values.title,
          description: optionalText(values.description),
          dueDate: values.dueDate ? localDateTimeToIso(values.dueDate, '12:00') : undefined,
        })
      ).data,
    onSuccess: () => {
      message.success('Task saved');
      setTaskModalOpen(false);
      taskForm.resetFields();
      qc.invalidateQueries({ queryKey: ['engagement-tasks'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const createTargetOffice = useMutation({
    mutationFn: async (values: TargetOfficeFormValues) =>
      (
        await api.post('/api/engagement/reports/target-offices', {
          clientId: values.clientId || selectedClientId || undefined,
          memberPrincipal: values.memberPrincipal,
          committee: optionalText(values.committee),
          staffer: optionalText(values.staffer),
          building: optionalText(values.building),
          leadOwner: optionalText(values.leadOwner),
        })
      ).data,
    onSuccess: () => {
      message.success('Target office added');
      setTargetOfficeModalOpen(false);
      targetOfficeForm.resetFields();
      qc.invalidateQueries({ queryKey: ['engagement-report'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const updateReportTarget = useMutation({
    mutationFn: async ({
      row,
      field,
      status,
    }: {
      row: EngagementReportRow;
      field: ReportStatusField;
      status: ReportStatus;
    }) =>
      (
        await api.post('/api/engagement/reports/target-offices/overrides', {
          clientId:
            row.scopeKey === 'all' ? undefined : (row.clientId ?? selectedClientId ?? undefined),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engagement-report'] }),
    onError: (err) => message.error(errorMessage(err)),
  });

  const updateTaskStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: EngagementTask['status'] }) =>
      (await api.patch(`/api/engagement/tasks/${id}`, { status })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engagement-tasks'] }),
    onError: (err) => message.error(errorMessage(err)),
  });

  const generatePrep = useMutation({
    mutationFn: async ({
      meetingId,
      additionalContext,
    }: {
      meetingId: string;
      additionalContext?: string;
    }) =>
      (
        await api.post(`/api/engagement/meetings/${meetingId}/prep`, {
          additionalContext: additionalContext?.trim() || undefined,
        })
      ).data,
    onSuccess: (_prep, { meetingId }) => {
      message.success('Meeting prep generated');
      qc.invalidateQueries({ queryKey: ['engagement-meeting', meetingId] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-calendar-meetings'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const updatePrep = useMutation({
    mutationFn: async ({ prepId, values }: { prepId: string; values: PrepFormValues }) =>
      (
        await api.patch(`/api/engagement/meeting-preps/${prepId}`, {
          summary: optionalText(values.summary) ?? null,
          agenda: linesToArray(values.agendaText),
          talkingPoints: linesToArray(values.talkingPointsText),
          risks: linesToArray(values.risksText),
          followUps: linesToArray(values.followUpsText),
          emailEvidence: linesToArray(values.emailEvidenceText),
        })
      ).data,
    onSuccess: () => {
      message.success('Meeting prep saved');
      setEditingPrep(null);
      prepForm.resetFields();
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-calendar-meetings'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const approvePrep = useMutation({
    mutationFn: async (prepId: string) =>
      (await api.post(`/api/engagement/meeting-preps/${prepId}/approve`)).data,
    onSuccess: () => {
      message.success('Meeting prep approved');
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-calendar-meetings'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const saveDebrief = useMutation({
    mutationFn: async ({
      meetingId,
      debriefId,
      body,
    }: {
      meetingId: string;
      debriefId?: string;
      body: string;
    }) => {
      const payload = {
        body,
        confidential: true,
        accessLevel: 'tenant_members',
      };
      return debriefId
        ? (await api.patch(`/api/engagement/meetings/${meetingId}/debriefs/${debriefId}`, payload))
            .data
        : (await api.post(`/api/engagement/meetings/${meetingId}/debriefs`, payload)).data;
    },
    onSuccess: (data, variables) => {
      const savedDebrief = {
        ...(data as MeetingDebrief),
        body: variables.body,
        restricted: false,
      };
      qc.setQueryData<MeetingDebrief[]>(
        ['engagement-meeting-debriefs', variables.meetingId],
        (current = []) => {
          const withoutCurrent = current.filter((debrief) => debrief.id !== savedDebrief.id);
          return [savedDebrief, ...withoutCurrent];
        },
      );
      message.success('Debrief saved');
      qc.invalidateQueries({ queryKey: ['engagement-meeting', variables.meetingId] });
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-calendar-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-meeting-debriefs'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const generateDebriefDraft = useMutation({
    mutationFn: async ({
      meetingId,
      method,
      sourceText,
    }: {
      meetingId: string;
      method: 'upload' | 'manual' | 'voice';
      sourceText: string;
    }) =>
      (
        await api.post<MeetingDebriefDraft>(`/api/engagement/meetings/${meetingId}/debrief-draft`, {
          method,
          sourceText,
        })
      ).data,
    onError: (err) => message.error(errorMessage(err)),
  });

  const uploadTranscript = useMutation({
    mutationFn: async ({ meeting, file }: { meeting: Meeting; file: File }) => {
      const contentType = file.type || 'application/octet-stream';
      const upload = (
        await api.post<{
          url: string;
          fields: Record<string, string>;
          s3Key: string;
        }>('/api/engagement/attachments/upload-url', {
          meetingId: meeting.id,
          clientId: meeting.client?.id ?? undefined,
          fileName: file.name,
          contentType,
          contentLength: file.size,
        })
      ).data;
      const form = new FormData();
      Object.entries(upload.fields).forEach(([key, value]) => form.append(key, value));
      form.append('file', file);
      const result = await fetch(upload.url, { method: 'POST', body: form });
      if (!result.ok) throw new Error('Transcript upload failed');
      return (
        await api.post<EngagementAttachment>('/api/engagement/attachments/confirm', {
          meetingId: meeting.id,
          clientId: meeting.client?.id ?? undefined,
          fileName: file.name,
          contentType,
          s3Key: upload.s3Key,
        })
      ).data;
    },
    onSuccess: () => {
      message.success('Transcript uploaded');
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-calendar-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-meeting-attachments'] });
    },
  });

  const extractAttachmentText = useMutation({
    mutationFn: async (attachmentId: string) =>
      (
        await api.post<DebriefSourceExtraction>(
          `/api/engagement/attachments/${attachmentId}/extract-text`,
        )
      ).data,
  });

  const deleteAttachment = useMutation({
    mutationFn: async (attachmentId: string) =>
      (await api.delete(`/api/engagement/attachments/${attachmentId}`)).data,
    onSuccess: () => {
      message.success('Attachment removed');
      qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-calendar-meetings'] });
      qc.invalidateQueries({ queryKey: ['engagement-meeting-attachments'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  useEffect(() => {
    const handler = () => setActiveEngagementTab('outreach');
    window.addEventListener('capiro:open-outreach', handler);
    return () => window.removeEventListener('capiro:open-outreach', handler);
  }, []);

  const generatingPrepMeetingId = generatePrep.isPending
    ? (generatePrep.variables?.meetingId ?? null)
    : null;
  const detailTab = meetingDetailTab === 'notes' ? 'prep' : meetingDetailTab;

  const openMeetingModal = () => {
    meetingForm.setFieldsValue({
      date: todayInputValue(),
      startsAt: '09:00',
      endsAt: '09:30',
      clientId: selectedClientId ?? undefined,
    });
    setMeetingModalOpen(true);
  };

  const handleGeneratePrep = (meeting: Meeting, additionalContext?: string) => {
    setSelectedMeetingId(meeting.id);
    setMeetingDetailTab('prep');
    generatePrep.mutate({ meetingId: meeting.id, additionalContext });
  };

  const handleTabChange = (nextKey: string) => {
    if (
      nextKey === 'overview' ||
      nextKey === 'meetings' ||
      nextKey === 'outreach' ||
      nextKey === 'reports'
    ) {
      setActiveEngagementTab(nextKey);
    }
  };

  const visibleClients = (clients.data ?? []).filter((c) => c.status !== 'archived');
  const selectedClient = visibleClients.find((c) => c.id === selectedClientId) ?? null;

  return (
    <section className="engagement-page redesign">
      <header className="eng-head">
        <h1 className="eng-page-h1">Engagement</h1>
        <EngClientPicker
          clients={visibleClients}
          selectedClient={selectedClient}
          onSelect={setSelectedClientId}
        />
      </header>
      <Tabs
        className="engagement-tabs"
        activeKey={activeEngagementTab}
        onChange={handleTabChange}
        tabBarExtraContent={
          activeEngagementTab === 'meetings'
            ? {
                right: (
                  <Space size={10} className="engagement-tab-actions">
                    <Button icon={<PlusOutlined />} onClick={() => setTaskModalOpen(true)}>
                      Task
                    </Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={openMeetingModal}>
                      Meeting
                    </Button>
                  </Space>
                ),
              }
            : undefined
        }
        items={[
          {
            key: 'overview',
            label: 'Overview',
            children: (
              <OverviewTab
                onNavigate={(tab) => setActiveEngagementTab(tab)}
                stats={{
                  meetingsThisWeek: meetings.data?.length ?? 0,
                  debriefsPending: (meetings.data ?? []).filter((m) => m.debriefs.length === 0)
                    .length,
                  draftsOpen: 0,
                }}
              />
            ),
          },
          {
            key: 'meetings',
            label: 'Meetings',
            children: (
              <div className="engagement-meeting-shell">
                <div className="engagement-panel engagement-schedule-panel">
                  <div className="engagement-schedule-head">
                    <PanelTitle icon={<CalendarOutlined />} title="Meetings" />
                    <div className="engagement-view-toggle" aria-label="Meeting view">
                      <button
                        type="button"
                        className={meetingViewMode === 'list' ? 'active' : ''}
                        onClick={() => setMeetingViewMode('list')}
                      >
                        List
                      </button>
                      <button
                        type="button"
                        className={meetingViewMode === 'calendar' ? 'active' : ''}
                        onClick={() => setMeetingViewMode('calendar')}
                      >
                        Calendar
                      </button>
                      <button
                        type="button"
                        className={meetingViewMode === 'day' ? 'active' : ''}
                        onClick={() => setMeetingViewMode('day')}
                      >
                        Day
                      </button>
                    </div>
                  </div>

                  <MeetingWeekNav
                    rangeStart={rangeStart}
                    rangeEnd={rangeEnd}
                    onShiftWindow={(delta) => {
                      setHistoryBatch(0);
                      // Page by the CURRENT window's length so ‹ › works for any
                      // selected range, not just a fixed week.
                      const start = localDateFromInput(rangeStart);
                      const end = localDateFromInput(rangeEnd);
                      const spanDays =
                        Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
                      setRangeStart(inputValueFromDate(addLocalDays(start, delta * spanDays)));
                      setRangeEnd(inputValueFromDate(addLocalDays(end, delta * spanDays)));
                    }}
                    onRangeChange={(start, end) => {
                      setHistoryBatch(0);
                      setRangeStart(start);
                      setRangeEnd(end);
                      // Highlight the first day of the new range in the Day view.
                      setMeetingFocusDayKey(start);
                    }}
                  />

                  {meetings.isLoading ? (
                    <Empty description="Loading Outlook meetings..." />
                  ) : visibleMeetings.length ? (
                    meetingViewMode === 'list' ? (
                      <MeetingListView
                        meetings={visibleMeetings}
                        selectedId={selectedMeeting?.id ?? null}
                        historyBatch={historyBatch}
                        generatingMeetingId={generatingPrepMeetingId}
                        aiConfigured={Boolean(capabilities.data?.ai.activeProvider)}
                        onSelect={(meeting, tab) => {
                          setSelectedMeetingId(meeting.id);
                          setMeetingDetailTab(tab ?? 'prep');
                        }}
                        onGeneratePrep={(meeting) => {
                          handleGeneratePrep(meeting);
                        }}
                        onLoadMore={() => setHistoryBatch((value) => value + 1)}
                      />
                    ) : meetingViewMode === 'day' ? (
                      <MeetingDayTimeline
                        meetings={visibleMeetings}
                        selectedId={selectedMeeting?.id ?? null}
                        rangeStart={rangeStart}
                        rangeEnd={rangeEnd}
                        focusDayKey={meetingFocusDayKey}
                        onSelect={(meetingId) => {
                          setSelectedMeetingId(meetingId);
                          setMeetingDetailTab('prep');
                        }}
                        onAction={(meetingId, tab) => {
                          setSelectedMeetingId(meetingId);
                          setMeetingDetailTab(tab);
                        }}
                      />
                    ) : (
                      <MeetingCalendarList
                        meetings={visibleMeetings}
                        selectedId={selectedMeeting?.id ?? null}
                        rangeStart={rangeStart}
                        rangeEnd={rangeEnd}
                        onSelect={(meetingId) => {
                          setSelectedMeetingId(meetingId);
                          setMeetingDetailTab('prep');
                        }}
                        onAction={(meetingId, tab) => {
                          setSelectedMeetingId(meetingId);
                          setMeetingDetailTab(tab);
                        }}
                      />
                    )
                  ) : (
                    <MeetingListEmpty
                      hasAnySyncedMeetings={hasCustomMeetingRange}
                      onSync={() => window.dispatchEvent(new Event('capiro:sync-inbox'))}
                    />
                  )}
                </div>

                <MeetingDetailPanel
                  meeting={selectedMeeting}
                  context={clientContext.data}
                  contextLoading={clientContext.isLoading}
                  attachments={meetingAttachments.data ?? selectedMeeting?.attachments ?? []}
                  attachmentsLoading={meetingAttachments.isLoading}
                  debriefs={meetingDebriefs.data ?? []}
                  debriefsLoading={meetingDebriefs.isLoading}
                  activeTab={detailTab}
                  onTabChange={setMeetingDetailTab}
                  attachmentsConfigured={Boolean(capabilities.data?.attachments.s3Configured)}
                  aiConfigured={Boolean(capabilities.data?.ai.activeProvider)}
                  generating={generatingPrepMeetingId === selectedMeeting?.id}
                  uploadingTranscript={
                    uploadTranscript.isPending || extractAttachmentText.isPending
                  }
                  deletingAttachmentId={
                    typeof deleteAttachment.variables === 'string'
                      ? deleteAttachment.variables
                      : null
                  }
                  savingDebrief={saveDebrief.isPending}
                  generatingDebrief={generateDebriefDraft.isPending}
                  approving={approvePrep.isPending}
                  onGeneratePrep={handleGeneratePrep}
                  onUploadTranscript={(meeting, file) =>
                    uploadTranscript.mutateAsync({ meeting, file })
                  }
                  onExtractAttachmentText={(attachment) =>
                    extractAttachmentText.mutateAsync(attachment.id)
                  }
                  onRemoveAttachment={(attachmentId) => deleteAttachment.mutate(attachmentId)}
                  onSaveDebrief={(meeting, body, debriefId) =>
                    saveDebrief.mutateAsync({ meetingId: meeting.id, body, debriefId })
                  }
                  onGenerateDebrief={(meeting, method, sourceText) =>
                    generateDebriefDraft.mutateAsync({
                      meetingId: meeting.id,
                      method,
                      sourceText,
                    })
                  }
                  onEditPrep={(meeting, prep) => {
                    prepForm.setFieldsValue({
                      summary: prep.summary ?? '',
                      agendaText: prep.agenda.join('\n'),
                      talkingPointsText: prep.talkingPoints.join('\n'),
                      risksText: prep.risks.join('\n'),
                      followUpsText: prep.followUps.join('\n'),
                      emailEvidenceText: (prep.emailEvidence ?? []).join('\n'),
                    });
                    setEditingPrep({ meeting, prep });
                  }}
                  onApprovePrep={(prep) => approvePrep.mutate(prep.id)}
                  onExportPdf={(meeting) =>
                    exportMeetingPdf({
                      meeting,
                      debriefs: meetingDebriefs.data ?? [],
                      context: clientContext.data,
                    })
                  }
                />
              </div>
            ),
          },
          {
            key: 'outreach',
            label: 'Outreach',
            children: (
              <OutreachView
                clients={activeClients}
                selectedClientId={selectedClientId}
                aiConfigured={Boolean(capabilities.data?.ai.activeProvider)}
              />
            ),
          },
          {
            key: 'reports',
            label: 'Reports',
            children: (
              <ReportsView
                report={report.data}
                loading={report.isLoading}
                period={reportPeriod}
                onPeriodChange={setReportPeriod}
                statusFilter={reportStatusFilter}
                onStatusFilterChange={setReportStatusFilter}
                sort={reportSort}
                onSortChange={setReportSort}
                updatingCell={
                  updateReportTarget.isPending && updateReportTarget.variables
                    ? reportCellKey(
                        updateReportTarget.variables.row,
                        updateReportTarget.variables.field,
                      )
                    : null
                }
                onViewMeetings={setReportMeetingRow}
                onStatusChange={(row, field, status) =>
                  updateReportTarget.mutate({
                    row,
                    field,
                    status,
                  })
                }
              />
            ),
          },
        ]}
      />

      <Modal
        title="New meeting"
        open={meetingModalOpen}
        onCancel={() => setMeetingModalOpen(false)}
        onOk={() => meetingForm.submit()}
        confirmLoading={createMeeting.isPending}
        width={680}
      >
        <Form
          form={meetingForm}
          layout="vertical"
          onFinish={(values) => createMeeting.mutate(values)}
        >
          <Form.Item name="subject" label="Subject" rules={[{ required: true, min: 1 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="clientId" label="Client">
            <Select
              allowClear
              showSearch={clientSelectOptions.length > 10}
              optionFilterProp="label"
              options={clientSelectOptions}
            />
          </Form.Item>
          <div className="engagement-form-grid">
            <Form.Item name="date" label="Date" rules={[{ required: true }]}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="startsAt" label="Start" rules={[{ required: true }]}>
              <Input type="time" />
            </Form.Item>
            <Form.Item name="endsAt" label="End" rules={[{ required: true }]}>
              <Input type="time" />
            </Form.Item>
          </div>
          <Form.Item name="location" label="Location">
            <Input />
          </Form.Item>
          <Form.Item name="attendeesText" label="Attendees">
            <Input.TextArea rows={3} placeholder="Jane Smith <jane@example.com>" />
          </Form.Item>
          <Form.Item name="description" label="Details">
            <Input.TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="New task"
        open={taskModalOpen}
        onCancel={() => setTaskModalOpen(false)}
        onOk={() => taskForm.submit()}
        confirmLoading={createTask.isPending}
      >
        <Form form={taskForm} layout="vertical" onFinish={(values) => createTask.mutate(values)}>
          <Form.Item name="title" label="Title" rules={[{ required: true, min: 1 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="dueDate" label="Due date">
            <Input type="date" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Add target office"
        open={targetOfficeModalOpen}
        onCancel={() => setTargetOfficeModalOpen(false)}
        onOk={() => targetOfficeForm.submit()}
        confirmLoading={createTargetOffice.isPending}
        width={640}
      >
        <Form
          form={targetOfficeForm}
          layout="vertical"
          onFinish={(values) => createTargetOffice.mutate(values)}
        >
          <Form.Item name="clientId" label="Client">
            <Select
              allowClear
              showSearch={clientSelectOptions.length > 10}
              optionFilterProp="label"
              options={clientSelectOptions}
            />
          </Form.Item>
          <Form.Item
            name="memberPrincipal"
            label="Member / Principal"
            rules={[{ required: true, min: 1 }]}
          >
            <Input placeholder="Rep. Jane Smith (D-CA-12)" />
          </Form.Item>
          <div className="engagement-form-grid">
            <Form.Item name="committee" label="Committee">
              <Input placeholder="HASC" />
            </Form.Item>
            <Form.Item name="building" label="Building">
              <Input placeholder="Rayburn" />
            </Form.Item>
            <Form.Item name="leadOwner" label="Lead">
              <Input placeholder="Owner" />
            </Form.Item>
          </div>
          <Form.Item name="staffer" label="Staffer">
            <Input placeholder="Staffer name" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={reportMeetingRow ? `${reportMeetingRow.memberPrincipal} meetings` : 'Meetings'}
        open={Boolean(reportMeetingRow)}
        onCancel={() => setReportMeetingRow(null)}
        footer={null}
        width={720}
      >
        <div className="engagement-report-meeting-list">
          {reportMeetingRow?.meetings.length ? (
            reportMeetingRow.meetings.map((meeting) => (
              <div className="engagement-calendar-row" key={meeting.id}>
                <span>{formatDateTime(meeting.startsAt)}</span>
                <div>
                  <Typography.Text strong>{meeting.subject}</Typography.Text>
                  <Typography.Text type="secondary">
                    {[formatTimeRange(meeting.startsAt, meeting.endsAt), meeting.location]
                      .filter(Boolean)
                      .join(' | ')}
                  </Typography.Text>
                </div>
                <Button
                  size="small"
                  icon={<ExportOutlined />}
                  disabled={!meeting.externalUrl}
                  href={meeting.externalUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open
                </Button>
              </div>
            ))
          ) : (
            <Empty description="No meetings are linked to this target office yet." />
          )}
        </div>
      </Modal>

      <Modal
        title={editingPrep ? `Edit prep - ${editingPrep.meeting.subject}` : 'Edit prep'}
        open={Boolean(editingPrep)}
        onCancel={() => setEditingPrep(null)}
        onOk={() => prepForm.submit()}
        confirmLoading={updatePrep.isPending}
        width={760}
      >
        <Form
          form={prepForm}
          layout="vertical"
          onFinish={(values) => {
            if (editingPrep) updatePrep.mutate({ prepId: editingPrep.prep.id, values });
          }}
        >
          <Form.Item name="summary" label="Context summary">
            <Input.TextArea rows={3} maxLength={2000} showCount />
          </Form.Item>
          <Form.Item name="agendaText" label="Agenda">
            <Input.TextArea rows={5} placeholder="One agenda item per line" />
          </Form.Item>
          <Form.Item name="talkingPointsText" label="Talking points">
            <Input.TextArea rows={5} placeholder="One talking point per line" />
          </Form.Item>
          <Form.Item name="risksText" label="Risks">
            <Input.TextArea rows={3} placeholder="One risk per line" />
          </Form.Item>
          <Form.Item name="followUpsText" label="Follow-ups">
            <Input.TextArea rows={3} placeholder="One follow-up per line" />
          </Form.Item>
          <Form.Item name="emailEvidenceText" label="Email recap">
            <Input.TextArea rows={4} placeholder="One correspondence bullet per line" />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}

/**
 * Date-range navigation shared across List / Calendar / Day (spec §3.1). The
 * centred label is the single, canonical selected-range display for every view;
 * the ‹ › carets page by the current window's length; and the start→end date
 * pickers select an arbitrary range (not just one day). All paths set
 * rangeStart/rangeEnd, so the meetings query and the three views are driven
 * exactly as before.
 */
function MeetingWeekNav({
  rangeStart,
  rangeEnd,
  onShiftWindow,
  onRangeChange,
}: {
  rangeStart: string;
  rangeEnd: string;
  onShiftWindow: (delta: number) => void;
  onRangeChange: (start: string, end: string) => void;
}) {
  const label = formatCalendarRange(localDateFromInput(rangeStart), localDateFromInput(rangeEnd));
  // Keep start ≤ end: moving one endpoint past the other drags the other with it.
  const pickStart = (value: string) => {
    if (!value) return;
    onRangeChange(value, value > rangeEnd ? value : rangeEnd);
  };
  const pickEnd = (value: string) => {
    if (!value) return;
    onRangeChange(value < rangeStart ? value : rangeStart, value);
  };
  return (
    <div className="engagement-week-nav" aria-label="Date range navigation">
      <span className="engagement-week-nav-spacer" aria-hidden="true" />
      <div className="engagement-week-nav-center">
        <button
          type="button"
          className="engagement-week-nav-caret"
          aria-label="Previous range"
          onClick={() => onShiftWindow(-1)}
        >
          ‹
        </button>
        <span className="engagement-week-nav-label">{label}</span>
        <button
          type="button"
          className="engagement-week-nav-caret"
          aria-label="Next range"
          onClick={() => onShiftWindow(1)}
        >
          ›
        </button>
      </div>
      <div className="engagement-week-nav-range">
        <Input
          aria-label="Range start"
          className="engagement-week-nav-date"
          type="date"
          value={rangeStart}
          max={rangeEnd}
          onChange={(event) => pickStart(event.target.value)}
        />
        <span className="engagement-week-nav-range-sep">to</span>
        <Input
          aria-label="Range end"
          className="engagement-week-nav-date"
          type="date"
          value={rangeEnd}
          min={rangeStart}
          onChange={(event) => pickEnd(event.target.value)}
        />
      </div>
    </div>
  );
}

function MeetingListView({
  meetings,
  selectedId,
  historyBatch,
  aiConfigured,
  generatingMeetingId,
  onSelect,
  onGeneratePrep,
  onLoadMore,
}: {
  meetings: Meeting[];
  selectedId: string | null;
  historyBatch: number;
  aiConfigured: boolean;
  generatingMeetingId: string | null;
  onSelect: (meeting: Meeting, tab?: string) => void;
  onGeneratePrep: (meeting: Meeting) => void;
  onLoadMore: () => void;
}) {
  const weekGroups = groupMeetingsByLocalWeek(meetings);
  return (
    <div className="engagement-list-view">
      <div className="engagement-agenda-list">
        {weekGroups.map((weekGroup, index) => (
          <div className="engagement-date-group" key={weekGroup.key}>
            {weekGroup.isPastWeek && !weekGroups[index - 1]?.isPastWeek ? (
              <div className="engagement-earlier-divider">
                <span />
                <strong>Earlier</strong>
                <span />
              </div>
            ) : null}
            <div className="engagement-date-header">{weekGroup.label}</div>
            {weekGroup.days.map((group) => (
              <div className="engagement-date-subgroup" key={group.key}>
                <div className={`engagement-date-header${group.isToday ? ' today' : ''}`}>
                  {group.isToday
                    ? `Today - ${formatFullDay(group.date)}`
                    : formatFullDay(group.date)}
                </div>
                {group.meetings.map((meeting) => (
                  <MeetingListItem
                    key={meeting.id}
                    meeting={meeting}
                    selected={meeting.id === selectedId}
                    aiConfigured={aiConfigured}
                    generating={generatingMeetingId === meeting.id}
                    onSelect={(tab) => onSelect(meeting, tab)}
                    onGeneratePrep={() => onGeneratePrep(meeting)}
                  />
                ))}
              </div>
            ))}
          </div>
        ))}

        {historyBatch < 12 ? (
          <Button className="engagement-load-more" onClick={onLoadMore}>
            Load More Meetings
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function MeetingListItem({
  meeting,
  selected,
  aiConfigured,
  generating,
  onSelect,
  onGeneratePrep,
}: {
  meeting: Meeting;
  selected: boolean;
  aiConfigured: boolean;
  generating: boolean;
  onSelect: (tab?: string) => void;
  onGeneratePrep: () => void;
}) {
  const status = meetingStatus(meeting);
  return (
    <article
      className={`engagement-agenda-item engagement-agenda-item--${status.kind}${
        selected ? ' selected' : ''
      }`}
      style={{ borderLeftColor: meetingBorderColor(meeting) }}
      role="button"
      tabIndex={0}
      onClick={() => onSelect('prep')}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onSelect('prep');
      }}
    >
      <div className="engagement-agenda-time">{meetingListTime(meeting)}</div>
      <div className="engagement-agenda-body">
        <Typography.Text strong title={meeting.subject}>
          {meeting.subject}
        </Typography.Text>
        <Typography.Text type="secondary">
          {[meeting.client?.name, meeting.location || sourceLabel(meeting.source)]
            .filter(Boolean)
            .join(' | ')}
        </Typography.Text>
        <div className="engagement-agenda-tags">
          <DebriefBadge meeting={meeting} />
        </div>
      </div>
      <Button
        size="small"
        disabled={status.primaryAction === 'prep' && !aiConfigured}
        loading={generating}
        onClick={(event) => {
          event.stopPropagation();
          if (status.primaryAction === 'debrief') {
            onSelect('debrief');
            return;
          }
          if (status.primaryAction === 'prep') {
            onSelect('prep');
            onGeneratePrep();
            return;
          }
          onSelect('prep');
        }}
      >
        {status.actionLabel}
      </Button>
    </article>
  );
}

function MeetingListEmpty({
  hasAnySyncedMeetings,
  onSync,
}: {
  hasAnySyncedMeetings: boolean;
  onSync: () => void;
}) {
  return (
    <div className="engagement-list-empty">
      <Empty
        description={
          hasAnySyncedMeetings ? (
            <span>
              <strong>No meetings in this date range</strong>
              <br />
              Try expanding your date filter or syncing your calendar.
            </span>
          ) : (
            <span>
              <strong>No meetings yet</strong>
              <br />
              Connect your calendar to start seeing meetings here.
            </span>
          )
        }
      >
        {hasAnySyncedMeetings ? (
          <Button onClick={onSync}>Sync Calendar</Button>
        ) : (
          <Button href="/settings/integrations">Go to Settings</Button>
        )}
      </Empty>
    </div>
  );
}

function MeetingCalendarList({
  meetings,
  selectedId,
  rangeStart,
  rangeEnd,
  onSelect,
  onAction,
}: {
  meetings: Meeting[];
  selectedId: string | null;
  rangeStart: string;
  rangeEnd: string;
  onSelect: (id: string) => void;
  onAction: (id: string, tab: string) => void;
}) {
  const days = dateRangeDays(rangeStart, rangeEnd);
  const grouped = groupMeetingsByDate(meetings);
  const counts = meetingStatusCounts(meetings);

  return (
    <div className="engagement-week-calendar">
      {/* Range label lives once in the centred week-nav above; the toolbar keeps
          only the view-specific count so the date isn't shown twice. */}
      <div className="engagement-week-toolbar">
        <Typography.Text type="secondary">{days.length} days selected</Typography.Text>
      </div>
      <div
        className="engagement-week-grid"
        style={{ gridTemplateColumns: `repeat(${Math.max(days.length, 1)}, minmax(150px, 1fr))` }}
      >
        {days.map((day) => {
          const key = localDateKey(day);
          const dayMeetings = grouped.get(key) ?? [];
          return (
            <section className="engagement-week-day" key={key}>
              <div className="engagement-week-day-head">
                <Typography.Text>{weekdayShort(day)}</Typography.Text>
                <span className={localDateKey(new Date()) === key ? 'today' : ''}>
                  {day.getDate()}
                </span>
              </div>
              <div className="engagement-week-items">
                {dayMeetings.length ? (
                  dayMeetings.map((meeting) => {
                    const status = meetingStatus(meeting);
                    return (
                      <button
                        key={meeting.id}
                        type="button"
                        className={`engagement-week-event engagement-week-event--${status.kind} engagement-week-event--tone-${status.tone}${
                          meeting.id === selectedId ? ' selected' : ''
                        }`}
                        style={{ borderLeftColor: meetingBorderColor(meeting) }}
                        onClick={() => onSelect(meeting.id)}
                      >
                        <span>{formatTime(meeting.startsAt)}</span>
                        <strong>{meeting.subject}</strong>
                        <small>
                          {meeting.client?.name ?? meeting.location ?? sourceLabel(meeting.source)}
                        </small>
                        <DebriefBadge
                          meeting={meeting}
                          onAction={(tab) => onAction(meeting.id, tab)}
                        />
                      </button>
                    );
                  })
                ) : (
                  <Typography.Text type="secondary">No Meetings</Typography.Text>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <div className="engagement-week-legend">
        <span>
          <i className="missing" /> {counts.debriefMissing} Debrief Not Completed
        </span>
        <span>
          <i className="needs-prep" /> {counts.needsPrep} Need Prep
        </span>
        <span>
          <i className="prepped" /> {counts.prepped} Prepped
        </span>
      </div>
    </div>
  );
}

function MeetingDayTimeline({
  meetings,
  selectedId,
  rangeStart,
  rangeEnd,
  focusDayKey,
  onSelect,
  onAction,
}: {
  meetings: Meeting[];
  selectedId: string | null;
  rangeStart: string;
  rangeEnd: string;
  focusDayKey: string | null;
  onSelect: (id: string) => void;
  onAction: (id: string, tab: string) => void;
}) {
  const days = dateRangeDays(rangeStart, rangeEnd);
  const grouped = groupMeetingsByDate(meetings);
  const initialKey = localDateKey(new Date());
  const defaultDayKey = grouped.has(initialKey)
    ? initialKey
    : days.find((day) => (grouped.get(localDateKey(day)) ?? []).length > 0)
      ? localDateKey(days.find((day) => (grouped.get(localDateKey(day)) ?? []).length > 0) as Date)
      : localDateKey(days[0] ?? new Date());
  const [selectedDayKey, setSelectedDayKey] = useState(defaultDayKey);

  useEffect(() => {
    if (!days.length) return;
    const hasDay = days.some((day) => localDateKey(day) === selectedDayKey);
    if (!hasDay) setSelectedDayKey(localDateKey(days[0] ?? new Date()));
  }, [days, selectedDayKey]);

  // Picking a date in the week-nav highlights that day column (spec §3.1/§4.2).
  // Defined after the range-reset effect so it wins when both fire on a jump.
  useEffect(() => {
    if (focusDayKey) setSelectedDayKey(focusDayKey);
  }, [focusDayKey]);

  const todayKey = localDateKey(new Date());
  const dayMeetings = grouped.get(selectedDayKey) ?? [];
  const selectedDayDate =
    days.find((day) => localDateKey(day) === selectedDayKey) ??
    localDateFromInput(selectedDayKey || rangeStart);

  return (
    <div className="engagement-week-calendar">
      <div className="engagement-week-toolbar">
        <Typography.Text strong>{formatMeetingDay(selectedDayKey)}</Typography.Text>
        <Typography.Text type="secondary">{dayMeetings.length} meetings</Typography.Text>
      </div>

      <div className="engagement-day-calendar-scroller">
        <div className="engagement-day-calendar" role="tablist" aria-label="Select day">
          {days.map((day) => {
            const key = localDateKey(day);
            const items = grouped.get(key) ?? [];
            const selected = key === selectedDayKey;
            return (
              <button
                key={key}
                type="button"
                className={selected ? 'selected' : ''}
                onClick={() => setSelectedDayKey(key)}
                aria-pressed={selected}
              >
                <span>{weekdayShort(day)}</span>
                <strong className={key === todayKey ? 'today' : ''}>{day.getDate()}</strong>
                <small>
                  {items.length
                    ? `${items.length} meeting${items.length === 1 ? '' : 's'}`
                    : 'No meetings'}
                </small>
              </button>
            );
          })}
        </div>
      </div>

      <div className="engagement-day-timeline-scroll" role="region" aria-label="Day meetings">
        <div className="engagement-day-timeline">
          {dayMeetings.length ? (
            dayMeetings.map((meeting) => {
              const status = meetingStatus(meeting);
              return (
                <button
                  key={meeting.id}
                  type="button"
                  className={`engagement-week-event engagement-week-event--${status.kind} engagement-week-event--tone-${status.tone}${meeting.id === selectedId ? ' selected' : ''}`}
                  style={{ borderLeftColor: meetingBorderColor(meeting) }}
                  onClick={() => onSelect(meeting.id)}
                >
                  <span>{formatTime(meeting.startsAt)}</span>
                  <strong>{meeting.subject}</strong>
                  <small>
                    {meeting.client?.name ?? meeting.location ?? sourceLabel(meeting.source)}
                  </small>
                  <DebriefBadge
                    meeting={meeting}
                    onAction={(tab) => onAction(meeting.id, tab)}
                  />
                </button>
              );
            })
          ) : (
            <div className="engagement-list-empty">
              <Empty
                description={`No meetings on ${formatCalendarRange(selectedDayDate, selectedDayDate)}`}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MeetingDetailPanel({
  meeting,
  context,
  contextLoading,
  attachments,
  attachmentsLoading,
  debriefs,
  debriefsLoading,
  activeTab,
  onTabChange,
  attachmentsConfigured,
  aiConfigured,
  generating,
  uploadingTranscript,
  deletingAttachmentId,
  savingDebrief,
  generatingDebrief,
  approving,
  onGeneratePrep,
  onUploadTranscript,
  onExtractAttachmentText,
  onRemoveAttachment,
  onSaveDebrief,
  onGenerateDebrief,
  onEditPrep,
  onApprovePrep,
  onExportPdf,
}: {
  meeting: Meeting | null;
  context?: ClientContext;
  contextLoading: boolean;
  attachments: EngagementAttachment[];
  attachmentsLoading: boolean;
  debriefs: MeetingDebrief[];
  debriefsLoading: boolean;
  activeTab: string;
  onTabChange: (key: string) => void;
  attachmentsConfigured: boolean;
  aiConfigured: boolean;
  generating: boolean;
  uploadingTranscript: boolean;
  deletingAttachmentId: string | null;
  savingDebrief: boolean;
  generatingDebrief: boolean;
  approving: boolean;
  onGeneratePrep: (meeting: Meeting, additionalContext?: string) => void;
  onUploadTranscript: (meeting: Meeting, file: File) => Promise<EngagementAttachment>;
  onExtractAttachmentText: (attachment: EngagementAttachment) => Promise<DebriefSourceExtraction>;
  onRemoveAttachment: (attachmentId: string) => void;
  onSaveDebrief: (meeting: Meeting, body: string, debriefId?: string) => Promise<unknown>;
  onGenerateDebrief: (
    meeting: Meeting,
    method: 'upload' | 'manual' | 'voice',
    sourceText: string,
  ) => Promise<MeetingDebriefDraft>;
  onEditPrep: (meeting: Meeting, prep: MeetingPrep) => void;
  onApprovePrep: (prep: MeetingPrep) => void;
  onExportPdf: (meeting: Meeting) => void;
}) {
  // Optional free-form context the user can add to steer prep generation.
  const [prepContext, setPrepContext] = useState('');

  if (!meeting) {
    return (
      <div className="engagement-panel engagement-detail-panel">
        <div className="engagement-detail-empty">
          <CalendarOutlined />
          <Typography.Text strong>Select a meeting to view details</Typography.Text>
        </div>
      </div>
    );
  }

  const prep = meeting.preps[0];
  const participants = meetingParticipants(meeting);

  return (
    <aside className="engagement-panel engagement-detail-panel">
      <div className="engagement-detail-head">
        <div>
          <Typography.Title level={5}>{meeting.subject}</Typography.Title>
          <Typography.Text type="secondary">
            {[
              formatLongDate(meeting.startsAt),
              formatTimeRange(meeting.startsAt, meeting.endsAt),
              meeting.location,
              meeting.client?.name,
            ]
              .filter(Boolean)
              .join(' | ')}
          </Typography.Text>
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {meeting.isInternal ? 'Internal —' : meeting.client ? 'Client:' : 'No client —'}
            </Typography.Text>
            <AssignClientControl
              entityType="meeting"
              entityId={meeting.id}
              currentClientId={meeting.client?.id ?? null}
              isInternal={meeting.isInternal ?? false}
            />
          </div>
          <div className="engagement-detail-badge-row">
            <DebriefBadge meeting={meeting} />
          </div>
        </div>
        <Button
          size="small"
          icon={<ExportOutlined />}
          disabled={!openUrl(meeting)}
          href={openUrl(meeting)}
          target="_blank"
          rel="noreferrer"
        >
          Open
        </Button>
      </div>

      <div className="engagement-detail-scroll">
        <Tabs
          activeKey={activeTab}
          onChange={onTabChange}
          className="engagement-detail-tabs"
          items={[
            {
              key: 'prep',
              label: 'Prep',
              children: (
                <div className="engagement-detail-stack">
                  <ParticipantsList participants={participants} />
                  {prep ? (
                    <>
                      <DetailBlock title="Context">
                        <Typography.Paragraph>
                          {prep.summary || contextSummary(context, contextLoading)}
                        </Typography.Paragraph>
                      </DetailBlock>
                      <DetailBlock title="Agenda">
                        <BulletList items={prep.agenda} empty="No agenda generated yet." />
                      </DetailBlock>
                      <DetailBlock title="Talking Points">
                        <BulletList
                          items={prep.talkingPoints}
                          empty="No talking points generated yet."
                        />
                      </DetailBlock>
                      {prep.emailEvidence?.length ? (
                        <DetailBlock title="Email Recap">
                          <BulletList
                            items={prep.emailEvidence}
                            empty="No prior correspondence found."
                          />
                        </DetailBlock>
                      ) : null}
                    </>
                  ) : (
                    <div className="engagement-empty-prep">
                      <RobotOutlined />
                      <Typography.Text strong>No Prep Notes Yet</Typography.Text>
                      {!meeting.client ? (
                        <Typography.Text type="secondary">
                          Meri needs more context to generate prep.{' '}
                          <a href="/clients">Go to client profile</a>
                        </Typography.Text>
                      ) : (
                        <Typography.Text type="secondary">
                          Prep is grounded only in the client profile, participant profiles, prior
                          meetings, and synced emails. Add any extra context below to steer it.
                        </Typography.Text>
                      )}
                      <Input.TextArea
                        value={prepContext}
                        onChange={(e) => setPrepContext(e.target.value)}
                        placeholder="Optional: add context for this prep (goals, background, what you know going in). Meri uses only this plus your synced emails/meetings — it won't invent details."
                        autoSize={{ minRows: 3, maxRows: 8 }}
                        maxLength={4000}
                        style={{ maxWidth: 560, margin: '8px auto 0' }}
                      />
                      <Button
                        type="primary"
                        disabled={!aiConfigured || !meeting.client || !prepContext.trim()}
                        loading={generating}
                        onClick={() => onGeneratePrep(meeting, prepContext)}
                      >
                        {generating ? 'Meri Is Preparing Your Brief...' : 'Generate Prep'}
                      </Button>
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'debrief',
              label: 'Debrief',
              children: (
                <DebriefPanel
                  meeting={meeting}
                  participants={participants}
                  prep={prep}
                  debriefs={debriefs}
                  loading={debriefsLoading}
                  aiConfigured={aiConfigured}
                  attachmentsConfigured={attachmentsConfigured}
                  attachments={attachments}
                  attachmentsLoading={attachmentsLoading}
                  uploadingTranscript={uploadingTranscript}
                  deletingAttachmentId={deletingAttachmentId}
                  saving={savingDebrief}
                  generating={generatingDebrief}
                  onUpload={(file) => onUploadTranscript(meeting, file)}
                  onExtract={(attachment) => onExtractAttachmentText(attachment)}
                  onRemoveAttachment={onRemoveAttachment}
                  onGenerate={(method, sourceText) =>
                    onGenerateDebrief(meeting, method, sourceText)
                  }
                  onSave={(body, debriefId) => onSaveDebrief(meeting, body, debriefId)}
                />
              ),
            },
            {
              key: 'intel',
              label: 'Context',
              children: (
                <ClientIntelPanel context={context} loading={contextLoading} meeting={meeting} />
              ),
            },
          ]}
        />
      </div>
      {activeTab === 'prep' && prep ? (
        <div className="engagement-detail-actions" style={{ flexWrap: 'wrap' }}>
          <Input.TextArea
            value={prepContext}
            onChange={(e) => setPrepContext(e.target.value)}
            placeholder="Add context to refine this prep, then Regenerate. Meri uses only this plus your synced emails/meetings."
            autoSize={{ minRows: 1, maxRows: 4 }}
            maxLength={4000}
            style={{ flexBasis: '100%' }}
          />
          <Button
            icon={<RobotOutlined />}
            loading={generating}
            onClick={() => onGeneratePrep(meeting, prepContext)}
          >
            Regenerate
          </Button>
          <Button
            icon={<EditOutlined />}
            onClick={() => {
              onEditPrep(meeting, prep);
            }}
          >
            Edit
          </Button>
          <Button icon={<DownloadOutlined />} onClick={() => onExportPdf(meeting)}>
            Export PDF
          </Button>
          <Button
            type="primary"
            className={prep.status === 'approved' ? 'engagement-approved-button' : undefined}
            loading={approving}
            onClick={() => {
              if (prep.status !== 'approved') onApprovePrep(prep);
            }}
          >
            {prep.status === 'approved' ? 'Approved' : 'Approve'}
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="engagement-detail-block">
      <Typography.Text strong>{title}</Typography.Text>
      {children}
    </section>
  );
}

function BulletList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return (
    <ul className="engagement-bullet-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function ParticipantsList({ participants }: { participants: MeetingParticipant[] }) {
  return (
    <DetailBlock title="Participants">
      {participants.length ? (
        <div className="engagement-participant-list">
          {participants.map((participant) => (
            <div className="engagement-participant-row" key={participant.key}>
              <span className="engagement-participant-avatar">{initials(participant.name)}</span>
              <div>
                <Typography.Text strong>{participant.name}</Typography.Text>
                <Typography.Text type="secondary">
                  {[participant.role, participant.email].filter(Boolean).join(' | ')}
                </Typography.Text>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Typography.Text type="secondary">
          No participants were included in the invite.
        </Typography.Text>
      )}
    </DetailBlock>
  );
}

function DebriefPanel({
  meeting,
  participants,
  prep,
  debriefs,
  loading,
  aiConfigured,
  saving,
  attachmentsConfigured,
  attachments,
  attachmentsLoading,
  uploadingTranscript,
  deletingAttachmentId,
  generating,
  onUpload,
  onExtract,
  onRemoveAttachment,
  onGenerate,
  onSave,
}: {
  meeting: Meeting;
  participants: MeetingParticipant[];
  prep?: MeetingPrep;
  debriefs: MeetingDebrief[];
  loading: boolean;
  aiConfigured: boolean;
  saving: boolean;
  generating: boolean;
  attachmentsConfigured: boolean;
  attachments: EngagementAttachment[];
  attachmentsLoading: boolean;
  uploadingTranscript: boolean;
  deletingAttachmentId: string | null;
  onUpload: (file: File) => Promise<EngagementAttachment>;
  onExtract: (attachment: EngagementAttachment) => Promise<DebriefSourceExtraction>;
  onRemoveAttachment: (attachmentId: string) => void;
  onGenerate: (
    method: 'upload' | 'manual' | 'voice',
    sourceText: string,
  ) => Promise<MeetingDebriefDraft>;
  onSave: (body: string, debriefId?: string) => Promise<unknown>;
}) {
  const { message } = App.useApp();
  const meetingHasEnded = new Date(meeting.endsAt).getTime() < Date.now();
  const latestDebrief = debriefs[0];
  const initialDraft = useMemo(
    () => parseDebriefBody(latestDebrief?.body ?? ''),
    [latestDebrief?.body],
  );
  const [method, setMethod] = useState<'upload' | 'manual' | 'voice'>('manual');
  const [sourceText, setSourceText] = useState('');
  const [draft, setDraft] = useState(initialDraft);
  const [draftDirty, setDraftDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [uploadHint, setUploadHint] = useState('');
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const transcriptInputId = `debrief-transcript-${meeting.id}`;

  useEffect(() => {
    setMethod('manual');
    setSourceText('');
    setDraft(parseDebriefBody(latestDebrief?.body ?? ''));
    setDraftDirty(false);
    setEditing(false);
    setUploadHint('');
  }, [latestDebrief?.body, meeting.id]);

  const hasOutput = Boolean(draft.recap || draft.actionItems.length || draft.notes);
  const saved = Boolean(latestDebrief) && !draftDirty && !editing;

  const uploadAndExtract = async (file: File, nextMethod: 'upload' | 'voice') => {
    setMethod(nextMethod);
    setUploadHint('');
    try {
      setUploadHint('Uploading and extracting debrief source...');
      const attachment = await onUpload(file);
      const extracted = await onExtract(attachment);
      setSourceText(extracted.text);
      setUploadHint(
        extracted.source === 'transcription'
          ? `Transcription ready from ${extracted.fileName}.`
          : `Text extracted from ${extracted.fileName}.`,
      );
    } catch (error) {
      setUploadHint('');
      message.error(errorMessage(error));
    }
  };

  const handleUpload = async (file: File) => {
    await uploadAndExtract(file, 'upload');
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      message.error('Voice memo recording is not supported in this browser.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      message.error(errorMessage(error));
      return;
    }
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      const file = new File([blob], `${safeFileName(meeting.subject)}-voice-memo.webm`, {
        type: blob.type || 'audio/webm',
      });
      setRecording(false);
      void uploadAndExtract(file, 'voice');
    };
    setMethod('voice');
    setRecording(true);
    recorder.start();
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
  };

  const generate = async () => {
    const source = sourceText.trim() || formatDebriefBody(draft).trim();
    if (!source) {
      message.warning('Add meeting notes or transcript text before generating a debrief.');
      return;
    }
    const next = await onGenerate(method, source);
    setDraft({
      recap: next.recap,
      actionItems: next.actionItems,
      notes: next.notes,
    });
    setDraftDirty(true);
    setEditing(false);
  };

  if (!meetingHasEnded) {
    return (
      <div className="engagement-detail-stack">
        <ParticipantsList participants={participants} />
        <div className="engagement-empty-prep">
          <ClockCircleOutlined />
          <Typography.Text strong>This meeting hasn't taken place yet</Typography.Text>
          <Typography.Text type="secondary">
            Come back after the meeting to complete your debrief.
          </Typography.Text>
        </div>
      </div>
    );
  }

  return (
    <div className="engagement-debrief-panel">
      <div className="engagement-detail-stack engagement-debrief-scroll">
        <ParticipantsList participants={participants} />
        <Typography.Text type="secondary">
          Input notes from your completed meeting to generate a debrief.
        </Typography.Text>
        <div className="engagement-debrief-option-grid">
          <button
            type="button"
            className={method === 'upload' ? 'selected' : ''}
            onClick={() => {
              setMethod('upload');
              document.getElementById(transcriptInputId)?.click();
            }}
          >
            <strong>Upload Recording or Transcript</strong>
            <span>Accepts audio, video, .txt, or .docx files.</span>
          </button>
          <button
            type="button"
            className={method === 'voice' ? 'selected' : ''}
            onClick={recording ? stopRecording : startRecording}
          >
            <strong>Record Voice Memo</strong>
            <span>
              {recording ? 'Recording... click to stop.' : 'Capture audio directly in the browser.'}
            </span>
          </button>
          <button
            type="button"
            className={method === 'manual' ? 'selected' : ''}
            onClick={() => setMethod('manual')}
          >
            <strong>Type Notes Manually</strong>
            <span>Use written context for the generated debrief.</span>
          </button>
        </div>
        <input
          id={transcriptInputId}
          className="engagement-file-input"
          type="file"
          accept=".txt,.docx,audio/*,video/*"
          disabled={!attachmentsConfigured || uploadingTranscript}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void handleUpload(file);
          }}
        />
        {uploadHint ? <Typography.Text type="secondary">{uploadHint}</Typography.Text> : null}

        <Input.TextArea
          className="engagement-debrief-source"
          rows={8}
          value={sourceText}
          onChange={(event) => setSourceText(event.target.value)}
          placeholder="Capture outcomes, decisions, commitments, and next steps..."
        />

        <Button
          type="primary"
          block
          loading={generating}
          disabled={!aiConfigured || uploadingTranscript}
          onClick={generate}
        >
          Generate Debrief
        </Button>

        <div className="outreach-context-note">
          <RobotOutlined />
          <span>
            Already available to Meri: {prep ? 'approved or saved prep notes, ' : ''}
            {meeting.attendees.length} participant profiles,{' '}
            {meeting.client ? 'client profile, ' : ''}
            prior meeting history.
          </span>
        </div>

        <div className="engagement-attachment-list">
          {attachmentsLoading ? (
            <Typography.Text type="secondary">Loading uploaded files...</Typography.Text>
          ) : attachments.length ? (
            attachments.map((attachment) => (
              <article className="engagement-attachment-entry" key={attachment.id}>
                <FileTextOutlined />
                <div>
                  {attachment.downloadUrl ? (
                    <a href={attachment.downloadUrl} target="_blank" rel="noreferrer">
                      {attachment.fileName}
                    </a>
                  ) : (
                    <Typography.Text>{attachment.fileName}</Typography.Text>
                  )}
                  <Typography.Text type="secondary">
                    {[attachment.contentType, formatBytes(attachment.byteSize)]
                      .filter(Boolean)
                      .join(' | ')}
                  </Typography.Text>
                </div>
                <Button
                  type="link"
                  danger
                  loading={deletingAttachmentId === attachment.id}
                  onClick={() => onRemoveAttachment(attachment.id)}
                >
                  Remove
                </Button>
              </article>
            ))
          ) : null}
        </div>

        {loading ? <Typography.Text type="secondary">Loading Debrief...</Typography.Text> : null}
        {hasOutput ? (
          <div className="engagement-debrief-output">
            <DetailBlock title="Recap">
              {editing ? (
                <Input.TextArea
                  rows={4}
                  value={draft.recap}
                  onChange={(event) => {
                    setDraft({ ...draft, recap: event.target.value });
                    setDraftDirty(true);
                  }}
                />
              ) : (
                <Typography.Paragraph>{draft.recap || 'No recap saved.'}</Typography.Paragraph>
              )}
            </DetailBlock>
            <DetailBlock title="Action Items">
              {editing ? (
                <Input.TextArea
                  rows={5}
                  value={draft.actionItems.join('\n')}
                  onChange={(event) => {
                    setDraft({ ...draft, actionItems: linesToArray(event.target.value) });
                    setDraftDirty(true);
                  }}
                />
              ) : (
                <BulletList items={draft.actionItems} empty="No action items generated yet." />
              )}
            </DetailBlock>
            <DetailBlock title="Notes">
              {editing ? (
                <Input.TextArea
                  rows={5}
                  value={draft.notes}
                  onChange={(event) => {
                    setDraft({ ...draft, notes: event.target.value });
                    setDraftDirty(true);
                  }}
                />
              ) : (
                <Typography.Paragraph>{draft.notes || 'No notes saved.'}</Typography.Paragraph>
              )}
            </DetailBlock>
          </div>
        ) : null}
      </div>

      {hasOutput ? (
        <div className="engagement-detail-actions engagement-debrief-actions">
          <Button icon={<RobotOutlined />} loading={generating} onClick={generate}>
            Regenerate
          </Button>
          <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button icon={<DownloadOutlined />} onClick={() => exportDebriefPdf({ meeting, draft })}>
            Export PDF
          </Button>
          <Button
            type="primary"
            className={saved ? 'engagement-approved-button' : undefined}
            loading={saving}
            disabled={saving || saved}
            onClick={async () => {
              if (saved) return;
              try {
                await onSave(formatDebriefBody(draft), latestDebrief?.id);
                setDraftDirty(false);
                setEditing(false);
              } catch {
                // The mutation handler surfaces the exact API error.
              }
            }}
          >
            {saved ? 'Saved' : latestDebrief ? 'Save Changes' : 'Save Debrief'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ClientIntelPanel({
  context,
  loading,
  meeting,
}: {
  context?: ClientContext;
  loading: boolean;
  meeting: Meeting;
}) {
  if (!meeting.client) {
    return (
      <Empty description="Link this meeting to a client to gather client-specific mail, meeting, and stakeholder context." />
    );
  }
  if (loading) return <Typography.Text type="secondary">Loading client context...</Typography.Text>;
  if (!context) return <Empty description="No client context available yet." />;

  return (
    <div className="engagement-detail-stack">
      <div className="engagement-context-metrics">
        <MetricPill label="Meetings" value={context.summary.meetings} />
        <MetricPill label="Mail threads" value={context.summary.mailThreads} />
        <MetricPill label="Contacts" value={context.summary.contacts} />
        <MetricPill label="Open tasks" value={context.summary.openTasks} />
      </div>
      <DetailBlock title="Recent Activity">
        <div className="engagement-intel-list">
          {context.recentActivity.slice(0, 6).map((activity) => (
            <div key={`${activity.type}-${activity.id}`}>
              <Typography.Text>{activity.title}</Typography.Text>
              <Typography.Text type="secondary">
                {[activity.type.replace(/_/g, ' '), formatOptionalDate(activity.date)]
                  .filter(Boolean)
                  .join(' | ')}
              </Typography.Text>
            </div>
          ))}
        </div>
      </DetailBlock>
      <DetailBlock title="Key Stakeholders">
        <div className="engagement-intel-list">
          {context.keyStakeholders.slice(0, 6).map((stakeholder) => (
            <div key={stakeholder.id}>
              <Typography.Text>
                {stakeholder.fullName || stakeholder.email || 'Unknown contact'}
              </Typography.Text>
              <Typography.Text type="secondary">
                {[stakeholder.title, stakeholder.organization, stakeholder.email]
                  .filter(Boolean)
                  .join(' | ')}
              </Typography.Text>
            </div>
          ))}
        </div>
      </DetailBlock>
      <DetailBlock title="Open Threads">
        <div className="engagement-intel-list">
          {context.openThreads.slice(0, 5).map((thread) => (
            <div key={thread.id}>
              <Typography.Text>{thread.subject}</Typography.Text>
              <Typography.Text type="secondary">
                {formatOptionalDate(thread.lastMessageAt)}
              </Typography.Text>
            </div>
          ))}
        </div>
      </DetailBlock>
    </div>
  );
}

function MetricPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="engagement-context-pill">
      <Typography.Text strong>{value}</Typography.Text>
      <Typography.Text type="secondary">{label}</Typography.Text>
    </div>
  );
}

interface MeetingParticipant {
  key: string;
  name: string;
  email: string | null;
  role: string | null;
}

function meetingParticipants(meeting: Meeting): MeetingParticipant[] {
  const rows: MeetingParticipant[] = [];
  if (meeting.organizerName || meeting.organizerEmail) {
    rows.push({
      key: `organizer-${meeting.organizerEmail ?? meeting.organizerName}`,
      name: meeting.organizerName || meeting.organizerEmail || 'Organizer',
      email: meeting.organizerEmail,
      role: 'Organizer',
    });
  }
  for (const attendee of meeting.attendees) {
    rows.push({
      key: attendee.id,
      name: attendee.name || attendee.email || 'Unknown participant',
      email: attendee.email,
      role: attendee.role,
    });
  }
  return rows;
}

function MeetingCard({
  meeting,
  aiConfigured,
  notesConfigured,
  generating,
  onGeneratePrep,
  onAddNote,
}: {
  meeting: Meeting;
  aiConfigured: boolean;
  notesConfigured: boolean;
  generating: boolean;
  onGeneratePrep: () => void;
  onAddNote: () => void;
}) {
  const prep = meeting.preps[0];
  return (
    <article className="engagement-meeting-card">
      <div className="engagement-meeting-top">
        <div className="engagement-time-badge">
          <Typography.Text strong>{formatTime(meeting.startsAt)}</Typography.Text>
          <Typography.Text type="secondary">{formatTime(meeting.endsAt)}</Typography.Text>
        </div>
        <div>
          <Typography.Title level={5}>{meeting.subject}</Typography.Title>
          <Typography.Text type="secondary">
            {meeting.client?.name ?? 'Unlinked client'} · {meeting.location || 'No location'}
          </Typography.Text>
        </div>
        <Tag color={confidenceColor(meeting.associationScore)}>
          {meeting.associationScore == null
            ? 'Manual'
            : `${Math.round(meeting.associationScore * 100)}%`}
        </Tag>
      </div>

      <div className="engagement-card-meta">
        <span>
          <TeamOutlined /> {meeting.attendees.length} Attendees
        </span>
        <span>
          <FileTextOutlined /> {meeting.notes.length} Notes
        </span>
        <span>
          <RobotOutlined /> {prep ? 'Prep Ready' : 'Prep Pending'}
        </span>
      </div>

      {meeting.associationReason ? (
        <Typography.Paragraph className="engagement-reason">
          {meeting.associationReason}
        </Typography.Paragraph>
      ) : null}

      {prep ? (
        <div className="engagement-prep-box">
          <Typography.Text strong>{prep.summary || 'Meeting Prep'}</Typography.Text>
          <ul>
            {prep.talkingPoints.slice(0, 3).map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Space wrap>
        <Button
          icon={<ExportOutlined />}
          disabled={!openUrl(meeting)}
          href={openUrl(meeting)}
          target="_blank"
          rel="noreferrer"
        >
          Open in Outlook
        </Button>
        <Button
          icon={<RobotOutlined />}
          disabled={!aiConfigured}
          loading={generating}
          onClick={onGeneratePrep}
        >
          Generate Prep
        </Button>
        <Button icon={<FileTextOutlined />} disabled={!notesConfigured} onClick={onAddNote}>
          Add Note
        </Button>
      </Space>
    </article>
  );
}

function TaskPanel({
  tasks,
  updating,
  onDone,
}: {
  tasks: EngagementTask[];
  updating: boolean;
  onDone: (task: EngagementTask) => void;
}) {
  return (
    <div className="engagement-panel">
      <PanelTitle icon={<CheckCircleOutlined />} title="Follow-ups" />
      {tasks.length ? (
        <div className="engagement-task-list">
          {tasks.map((task) => (
            <div className="engagement-task-row" key={task.id}>
              <div>
                <Typography.Text strong>{task.title}</Typography.Text>
                <Typography.Text type="secondary">
                  {[task.client?.name, task.meeting?.subject, formatOptionalDate(task.dueDate)]
                    .filter(Boolean)
                    .join(' · ')}
                </Typography.Text>
              </div>
              <Button
                size="small"
                disabled={task.status === 'done' || updating}
                onClick={() => onDone(task)}
              >
                Done
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <Empty description="No open follow-ups." />
      )}
    </div>
  );
}

function CalendarView({ meetings }: { meetings: Meeting[] }) {
  return (
    <div className="engagement-panel">
      <PanelTitle icon={<ClockCircleOutlined />} title="Calendar" />
      {meetings.length ? (
        <div className="engagement-calendar-list">
          {meetings.map((meeting) => (
            <div className="engagement-calendar-row" key={meeting.id}>
              <span>{formatTime(meeting.startsAt)}</span>
              <div>
                <Typography.Text strong>{meeting.subject}</Typography.Text>
                <Typography.Text type="secondary">
                  {meeting.client?.name ?? 'Unlinked'} · {meeting.location || 'No location'}
                </Typography.Text>
              </div>
              <Button
                size="small"
                icon={<ExportOutlined />}
                disabled={!openUrl(meeting)}
                href={openUrl(meeting)}
                target="_blank"
                rel="noreferrer"
              >
                Open
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <Empty description="No calendar items for this date." />
      )}
    </div>
  );
}

// Self-contained control to (re)assign a meeting or mail thread to a client,
// wired to POST /api/engagement/associations/override. Drop it anywhere; it
// fetches clients itself and invalidates the relevant caches on success.
// Sentinel value used by the client dropdown to represent "this meeting is
// internal" (no client). Not a real client id; the backend treats it specially.
const INTERNAL_OPTION = '__internal__';

function AssignClientControl({
  entityType,
  entityId,
  currentClientId,
  isInternal = false,
  size = 'small',
}: {
  entityType: 'meeting' | 'mail_thread';
  entityId: string;
  currentClientId?: string | null;
  /** Meetings only: whether the entity is currently flagged internal. */
  isInternal?: boolean;
  size?: 'small' | 'middle';
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
  });
  const options = useMemo(() => {
    const clientOptions = (clients.data ?? [])
      .filter((c) => c.status !== 'archived' && c.name?.trim())
      .map((c) => ({ value: c.id, label: c.name }));
    // "Internal" is a meetings-only concept; offer it ahead of the client list.
    return entityType === 'meeting'
      ? [{ value: INTERNAL_OPTION, label: 'Internal' }, ...clientOptions]
      : clientOptions;
  }, [clients.data, entityType]);
  const assign = useMutation({
    mutationFn: async (value: string) => {
      const body =
        value === INTERNAL_OPTION
          ? { entityType, entityId, internal: true, reason: 'Marked internal from Engagement' }
          : { entityType, entityId, clientId: value, reason: 'Manual association from Engagement' };
      return (await api.post('/api/engagement/associations/override', body)).data;
    },
    onSuccess: (_data, value) => {
      message.success(value === INTERNAL_OPTION ? 'Marked internal' : 'Reassigned to client');
      for (const key of [
        ['engagement-meetings'],
        ['engagement-meeting'],
        ['engagement-mail-threads'],
        ['outreach-pool-mail'],
        ['outreach-pool-meetings'],
      ]) {
        qc.invalidateQueries({ queryKey: key });
      }
    },
    onError: (e) => message.error(errorMessage(e)),
  });
  const value = isInternal ? INTERNAL_OPTION : (currentClientId ?? undefined);
  return (
    <Select
      size={size}
      showSearch
      placeholder="Assign client…"
      style={{ minWidth: 170 }}
      value={value}
      options={options}
      optionFilterProp="label"
      loading={clients.isLoading || assign.isPending}
      onChange={(v) => v && assign.mutate(v)}
    />
  );
}

function MailView({ threads }: { threads: MailThread[] }) {
  return (
    <div className="engagement-panel">
      <PanelTitle icon={<MailOutlined />} title="Mail" />
      {threads.length ? (
        <div className="engagement-thread-list">
          {threads.map((thread) => (
            <div className="engagement-thread-row" key={thread.id}>
              <div>
                <Typography.Text strong>{thread.subject}</Typography.Text>
                <Typography.Text type="secondary">
                  {[thread.client?.name, formatOptionalDate(thread.lastMessageAt), thread.status]
                    .filter(Boolean)
                    .join(' · ')}
                </Typography.Text>
                {thread.snippet ? (
                  <Typography.Paragraph>{thread.snippet}</Typography.Paragraph>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <AssignClientControl
                  entityType="mail_thread"
                  entityId={thread.id}
                  currentClientId={thread.client?.id ?? null}
                />
                <Button
                  size="small"
                  icon={<ExportOutlined />}
                  disabled={!openUrl(thread)}
                  href={openUrl(thread)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty description="No synced email threads yet." />
      )}
    </div>
  );
}

function ReportsView({
  report,
  loading,
  period,
  onPeriodChange,
  statusFilter,
  onStatusFilterChange,
  sort,
  onSortChange,
  updatingCell,
  onViewMeetings,
  onStatusChange,
}: {
  report?: EngagementReport;
  loading: boolean;
  period: ReportPeriod;
  onPeriodChange: (period: ReportPeriod) => void;
  statusFilter: 'all' | ReportStatus;
  onStatusFilterChange: (status: 'all' | ReportStatus) => void;
  sort: string;
  onSortChange: (sort: string) => void;
  updatingCell: string | null;
  onViewMeetings: (row: EngagementReportRow) => void;
  onStatusChange: (
    row: EngagementReportRow,
    field: ReportStatusField,
    status: ReportStatus,
  ) => void;
}) {
  const rows = useMemo(() => {
    const base = report?.rows ?? [];
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
  }, [report?.rows, sort, statusFilter]);

  return (
    <div className="engagement-report-page">
      <div className="engagement-tab-heading">
        <Typography.Title level={3}>Reports</Typography.Title>
        <Typography.Text type="secondary">
          {report?.cycle.label ?? 'Current Cycle (2026)'} Engagement Activity Overview
        </Typography.Text>
      </div>

      <div className="engagement-panel engagement-report-tracker">
        <div className="engagement-report-tracker-head">
          <div>
            <Typography.Title level={5}>Office Engagement Tracker</Typography.Title>
            <div className="engagement-report-period-tabs" aria-label="Report period">
              {(['current', 'previous', 'all'] as ReportPeriod[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={period === item ? 'active' : ''}
                  onClick={() => onPeriodChange(item)}
                >
                  {item === 'current'
                    ? 'Current Cycle'
                    : item === 'previous'
                      ? 'Previous Cycle'
                      : 'All Time'}
                </button>
              ))}
            </div>
          </div>
          <Space wrap className="engagement-report-controls">
            <Select
              value={statusFilter}
              onChange={onStatusFilterChange}
              options={[
                { value: 'all', label: 'Filter: All Statuses' },
                { value: 'complete', label: 'Filter: Complete' },
                { value: 'in_progress', label: 'Filter: In Progress' },
                { value: 'not_started', label: 'Filter: Not Started' },
              ]}
            />
            <Select
              value={sort}
              onChange={onSortChange}
              options={[
                { value: 'member-asc', label: 'Sort: Member A-Z' },
                { value: 'member-desc', label: 'Sort: Member Z-A' },
                { value: 'meetings-desc', label: 'Sort: Meetings Held' },
                { value: 'outreach-desc', label: 'Sort: Outreach Sent' },
                { value: 'pending-desc', label: 'Sort: Pending Actions' },
              ]}
            />
            <Button
              icon={<DownloadOutlined />}
              disabled={!rows.length}
              onClick={() => exportEngagementReportCsv(rows, report?.cycle)}
            >
              Export CSV
            </Button>
          </Space>
        </div>

        {loading ? (
          <Empty description="Loading Report Activity..." />
        ) : rows.length ? (
          <>
            <div className="engagement-report-table-wrap">
              <table className="engagement-report-table">
                <thead>
                  <tr>
                    <th>Member / Principal</th>
                    <th>Committee</th>
                    <th>Staffer</th>
                    <th>Building</th>
                    <th>Lead</th>
                    <th>Meetings Held</th>
                    <th>Prep Done</th>
                    <th>Outreach Sent</th>
                    <th>Submission Filed</th>
                    <th>Pending Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.scopeKey}:${row.officeKey}`}>
                      <td>
                        <Typography.Text strong>{row.memberPrincipal}</Typography.Text>
                        <Typography.Text type="secondary">
                          {[row.clientName, row.committee, row.building]
                            .filter(Boolean)
                            .join(' | ')}
                        </Typography.Text>
                      </td>
                      <td>{row.committee || '-'}</td>
                      <td>{row.staffer || '-'}</td>
                      <td>{row.building || '-'}</td>
                      <td>{row.leadOwner || '-'}</td>
                      <td>
                        <button
                          type="button"
                          className="engagement-report-link"
                          onClick={() => onViewMeetings(row)}
                        >
                          {row.meetingsHeld} View
                        </button>
                      </td>
                      <td>
                        <ReportStatusSelect
                          status={row.prepStatus}
                          disabled={updatingCell === reportCellKey(row, 'prepStatus')}
                          onChange={(status) => onStatusChange(row, 'prepStatus', status)}
                        />
                      </td>
                      <td>
                        <ReportStatusSelect
                          status={row.outreachStatus}
                          disabled={updatingCell === reportCellKey(row, 'outreachStatus')}
                          onChange={(status) => onStatusChange(row, 'outreachStatus', status)}
                        />
                      </td>
                      <td>
                        <ReportStatusSelect
                          status={row.submissionStatus}
                          disabled={updatingCell === reportCellKey(row, 'submissionStatus')}
                          onChange={(status) => onStatusChange(row, 'submissionStatus', status)}
                        />
                      </td>
                      <td>{row.pendingActions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="engagement-report-legend">
              <span>
                <i className="complete" /> Complete
              </span>
              <span>
                <i className="in-progress" /> In Progress
              </span>
              <span>
                <i /> Not Started
              </span>
              <em>Auto-populated from Capiro. Use each status menu to override manually.</em>
            </div>
          </>
        ) : (
          <Empty description="No Target Offices Are Linked To This Reporting Period Yet." />
        )}
      </div>
    </div>
  );
}

function ReportStatusSelect({
  status,
  disabled,
  onChange,
}: {
  status: ReportStatus;
  disabled: boolean;
  onChange: (status: ReportStatus) => void;
}) {
  return (
    <Select<ReportStatus>
      size="small"
      popupMatchSelectWidth={false}
      className={`engagement-report-status-select engagement-report-status-select--${status}`}
      disabled={disabled}
      value={status}
      onChange={onChange}
      options={REPORT_STATUS_OPTIONS}
    />
  );
}

function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="engagement-panel-title">
      {icon}
      <Typography.Title level={5}>{title}</Typography.Title>
    </div>
  );
}

function linesToArray(value?: string): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80);
}

function formatMeetingDay(value: string): string {
  // value is a YYYY-MM-DD day key — parse as a LOCAL date (localDateFromInput)
  // so it doesn't shift back a day in timezones behind UTC.
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(localDateFromInput(value));
}

function formatCalendarRange(start: Date, end: Date): string {
  // Build the label explicitly. Month uses a safe single-field Intl format
  // ("Jul"); the day-of-month and year are plain numbers via getDate()/
  // getFullYear() — NOT Intl with { day: 'numeric' }, which renders as locale
  // garbage (e.g. "Jul (day: 28), 2026") in some ICU/locale combinations.
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
  const year = end.getFullYear();
  if (start.getTime() === end.getTime()) {
    return `${monthFmt.format(start)} ${start.getDate()}, ${year}`;
  }
  const sameMonth =
    start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `${monthFmt.format(start)} ${start.getDate()} – ${end.getDate()}, ${year}`;
  }
  return `${monthFmt.format(start)} ${start.getDate()} – ${monthFmt.format(end)} ${end.getDate()}, ${year}`;
}

function formatTimeRange(start: string, end: string): string {
  return `${formatTime(start)} - ${formatTime(end)}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function sourceLabel(source: string): string {
  if (source === 'outlook') return 'Outlook';
  if (source === 'google') return 'Google';
  if (source === 'manual') return 'Manual';
  return source.replace(/_/g, ' ');
}

function contextSummary(context: ClientContext | undefined, loading: boolean): string {
  if (loading) return 'Gathering client-specific Outlook context...';
  if (!context) return 'No synced client context is available yet.';
  return [
    `${context.summary.meetings} recent meetings`,
    `${context.summary.mailThreads} relevant mail threads`,
    `${context.summary.contacts} known stakeholders`,
    `${context.summary.openTasks} open follow-ups`,
  ].join(' | ');
}

function noteAuthor(note: MeetingNoteSummary | MeetingDebrief | MeetingDebriefSummary): string {
  const author = note.author;
  const name = [author?.firstName, author?.lastName].filter(Boolean).join(' ').trim();
  return name || author?.email || 'Unknown user';
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const text = parts.map((part) => part[0]?.toUpperCase()).join('');
  return text || '??';
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dateRangeDays(start: string, end: string): Date[] {
  const first = localDateFromInput(start);
  const last = localDateFromInput(end);
  if (last < first) return [first];

  const days: Date[] = [];
  for (let day = first; day <= last; day = addLocalDays(day, 1)) {
    days.push(day);
  }
  return days;
}

function localDateFromInput(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year ?? new Date().getFullYear(), (month ?? 1) - 1, day ?? 1);
}

function inputValueFromDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function localDateKey(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return inputValueFromDate(date);
}

function weekdayShort(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
}

function groupMeetingsByDate(meetings: Meeting[]): Map<string, Meeting[]> {
  const grouped = new Map<string, Meeting[]>();
  for (const meeting of meetings) {
    const key = localDateKey(meeting.startsAt);
    const rows = grouped.get(key) ?? [];
    rows.push(meeting);
    grouped.set(key, rows);
  }
  for (const rows of grouped.values()) {
    rows.sort(
      (left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime(),
    );
  }
  return grouped;
}

function groupMeetingsByLocalDate(meetings: Meeting[]): Array<{
  key: string;
  date: Date;
  isToday: boolean;
  isPast: boolean;
  meetings: Meeting[];
}> {
  const grouped = groupMeetingsByDate(meetings);
  const todayKey = localDateKey(new Date());
  return Array.from(grouped.entries())
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([key, rows]) => ({
      key,
      date: localDateFromInput(key),
      isToday: key === todayKey,
      isPast: key < todayKey,
      // Chronological within the day: soonest meeting first → latest last.
      meetings: [...rows].sort(
        (left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime(),
      ),
    }));
}

function startOfLocalWeek(date: Date): Date {
  const normalized = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = normalized.getDay();
  const sundayOffset = day;
  normalized.setDate(normalized.getDate() - sundayOffset);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function formatWeekRangeLabel(weekStart: Date): string {
  const weekEnd = addLocalDays(weekStart, 6);
  const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'short' });

  const startMonth = monthFormatter.format(weekStart);
  const endMonth = monthFormatter.format(weekEnd);
  // Plain numbers — Intl with { day: 'numeric' } / { year: 'numeric' } can
  // render as locale garbage (e.g. "(day: 28)"), which is what we're avoiding.
  const startDay = weekStart.getDate();
  const endDay = weekEnd.getDate();
  const startYear = weekStart.getFullYear();
  const endYear = weekEnd.getFullYear();

  if (startMonth === endMonth && startYear === endYear) {
    return `Week of ${startMonth} ${startDay}-${endDay}, ${startYear}`;
  }
  if (startYear === endYear) {
    return `Week of ${startMonth} ${startDay} - ${endMonth} ${endDay}, ${startYear}`;
  }
  return `Week of ${startMonth} ${startDay}, ${startYear} - ${endMonth} ${endDay}, ${endYear}`;
}

function groupMeetingsByLocalWeek(meetings: Meeting[]): Array<{
  key: string;
  weekStart: Date;
  label: string;
  isPastWeek: boolean;
  days: Array<{
    key: string;
    date: Date;
    isToday: boolean;
    isPast: boolean;
    meetings: Meeting[];
  }>;
}> {
  const days = groupMeetingsByLocalDate(meetings);
  const byWeek = new Map<
    string,
    {
      weekStart: Date;
      days: Array<{
        key: string;
        date: Date;
        isToday: boolean;
        isPast: boolean;
        meetings: Meeting[];
      }>;
    }
  >();

  for (const day of days) {
    const weekStart = startOfLocalWeek(day.date);
    const key = inputValueFromDate(weekStart);
    const existing = byWeek.get(key);
    if (existing) {
      existing.days.push(day);
      continue;
    }
    byWeek.set(key, { weekStart, days: [day] });
  }

  const currentWeekKey = inputValueFromDate(startOfLocalWeek(new Date()));

  return Array.from(byWeek.entries())
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([key, value]) => ({
      key,
      weekStart: value.weekStart,
      label: formatWeekRangeLabel(value.weekStart),
      isPastWeek: key < currentWeekKey,
      days: value.days.sort((left, right) => right.key.localeCompare(left.key)),
    }));
}

function meetingStatus(meeting: Meeting): {
  kind: 'missing' | 'needs-prep' | 'prepped' | 'complete' | 'active';
  // Completion signal for the calendar/day event color: 'success' (green) once
  // the meeting's prep/debrief is done, 'danger' (red) while it's still needed.
  tone: 'success' | 'danger';
  label: string;
  actionLabel: string;
  primaryAction: 'prep' | 'debrief' | 'open';
  chips: Array<{
    label: string;
    tone: 'default' | 'muted' | 'danger' | 'primary' | 'success';
    action?: 'prep' | 'debrief';
  }>;
} {
  const hasDebrief = meeting.debriefs.length > 0;
  const start = new Date(meeting.startsAt).getTime();
  const end = new Date(meeting.endsAt).getTime();
  const now = Date.now();
  const hasEnded = end < now;
  const isActive = start <= now && end >= now;
  const prep = meeting.preps[0];
  if (hasEnded && !hasDebrief) {
    return {
      kind: 'missing',
      tone: 'danger',
      label: 'Debrief Not Completed',
      actionLabel: 'Start Debrief',
      primaryAction: 'debrief',
      chips: [{ label: 'Debrief Not Completed', tone: 'danger', action: 'debrief' }],
    };
  }
  if (hasEnded && hasDebrief) {
    return {
      kind: 'complete',
      tone: 'success',
      label: 'Debrief Complete',
      actionLabel: 'View Recap',
      primaryAction: 'debrief',
      chips: [{ label: 'Debrief Complete', tone: 'success' }],
    };
  }
  if (isActive) {
    return {
      kind: 'active',
      tone: prep ? 'success' : 'danger',
      label: prep ? 'Prepped' : 'Generate Prep ->',
      actionLabel: prep ? 'View Prep' : 'Generate Prep',
      primaryAction: prep ? 'open' : 'prep',
      chips: prep
        ? [{ label: prep.status === 'approved' ? 'Approved' : 'Prepped', tone: 'success' }]
        : [{ label: 'Generate Prep ->', tone: 'danger', action: 'prep' }],
    };
  }
  if (prep) {
    return {
      kind: 'prepped',
      tone: 'success',
      label: prep.status === 'approved' ? 'Approved' : 'Prepped',
      actionLabel: 'View Prep',
      primaryAction: 'open',
      chips: [{ label: prep.status === 'approved' ? 'Approved' : 'Prepped', tone: 'success' }],
    };
  }
  return {
    kind: 'needs-prep',
    tone: 'danger',
    label: 'No Prep Yet',
    actionLabel: 'Generate Prep',
    primaryAction: 'prep',
    chips: [
      { label: 'No Prep Yet', tone: 'muted' },
      { label: 'Generate Prep ->', tone: 'danger', action: 'prep' },
    ],
  };
}

function meetingStatusCounts(meetings: Meeting[]) {
  return meetings.reduce(
    (counts, meeting) => {
      const status = meetingStatus(meeting).kind;
      if (status === 'missing') counts.debriefMissing += 1;
      if (status === 'needs-prep') counts.needsPrep += 1;
      if (status === 'prepped') counts.prepped += 1;
      return counts;
    },
    { debriefMissing: 0, needsPrep: 0, prepped: 0 },
  );
}

/**
 * Left-border colour coding, shared across List / Calendar / Day (spec §4.6):
 * red = debrief missing, green = debrief complete, neutral = upcoming / no status.
 * Derived from the existing meetingStatus() — no data-model change.
 */
function meetingBorderColor(meeting: Meeting): string {
  const kind = meetingStatus(meeting).kind;
  if (kind === 'missing') return '#f04438'; // red — debrief missing
  if (kind === 'complete') return '#12b76a'; // green — debrief complete
  return '#cfd8e6'; // neutral — upcoming / no status
}

/**
 * Single status badge used identically in List, Calendar, Day, and the detail
 * header (spec §4.5). Renders the existing meetingStatus() label so wording and
 * the upcoming→prep / past→debrief logic are unchanged. The 'missing' case is
 * the only actionable one (start debrief), preserving the prior click behaviour;
 * all other meetings still select via the surrounding row/card and act via the
 * row's action button.
 */
function DebriefBadge({
  meeting,
  onAction,
}: {
  meeting: Meeting;
  onAction?: (tab: 'prep' | 'debrief') => void;
}) {
  const status = meetingStatus(meeting);
  // "No Prep Yet" reads as muted (informational), everything else by tone.
  const tone = status.kind === 'needs-prep' ? 'muted' : status.tone;
  const cls = `engagement-debrief-badge engagement-debrief-badge--${tone}`;
  if (status.kind === 'missing' && onAction) {
    return (
      <button
        type="button"
        className={`${cls} engagement-debrief-badge--action`}
        onClick={(event) => {
          event.stopPropagation();
          onAction('debrief');
        }}
      >
        {status.label} →
      </button>
    );
  }
  return <span className={cls}>{status.label}</span>;
}

function dateWindow(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const from = new Date(year ?? new Date().getFullYear(), (month ?? 1) - 1, day ?? 1);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

function defaultMeetingRange(): { start: string; end: string } {
  // Default visible window is the CURRENT WEEK (Monday → Sunday in local time).
  // We still fetch a 30-day backstop of Outlook context so the timeline scrolls
  // back when the user explicitly widens the range or scrolls to history; that
  // wider fetch is driven by historyBatch in dateRangeWindow(), not by this
  // visible default.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay(); // 0=Sun, 1=Mon ... 6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon → 0, Sun → 6
  const monday = addLocalDays(today, -daysSinceMonday);
  const sunday = addLocalDays(monday, 6);
  return { start: inputValueFromDate(monday), end: inputValueFromDate(sunday) };
}

function dateRangeWindow(start: string, end: string, historyBatch: number) {
  const from = localDateFromInput(start);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - historyBatch * 30);
  const to = localDateFromInput(end);
  to.setHours(23, 59, 59, 999);
  if (to <= from) {
    const fallback = addLocalDays(from, 1);
    fallback.setHours(23, 59, 59, 999);
    return { from: from.toISOString(), to: fallback.toISOString() };
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function formatFullDay(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(value);
}

function meetingListTime(meeting: Meeting): string {
  const key = localDateKey(meeting.startsAt);
  const today = localDateKey(new Date());
  if (key === today || key < today) return formatTime(meeting.startsAt);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(meeting.startsAt));
}

function todayInputValue(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function localDateTimeToIso(date: string, time: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(
    year ?? new Date().getFullYear(),
    (month ?? 1) - 1,
    day ?? 1,
    hours ?? 0,
    minutes ?? 0,
  ).toISOString();
}

function parseAttendees(value?: string): Array<{ name?: string; email?: string }> {
  const text = optionalText(value);
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const angle = line.match(/^(.*)<([^>]+)>$/);
      if (angle) return { name: angle[1]?.trim(), email: angle[2]?.trim() };
      if (line.includes('@')) return { email: line };
      return { name: line };
    });
}

function optionalText(value?: string | null): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function reportCellKey(row: EngagementReportRow, field: ReportStatusField): string {
  return `${row.scopeKey}:${row.officeKey}:${field}`;
}

function reportStatusLabel(status: ReportStatus): string {
  if (status === 'complete') return 'Complete';
  if (status === 'in_progress') return 'In progress';
  return 'Not started';
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(value),
  );
}

function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function formatOptionalDate(value: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
}

function formatBytes(value: number | null): string {
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function openUrl(item: { metadata?: Record<string, unknown> | null }): string | undefined {
  const value = item.metadata?.webLink;
  return typeof value === 'string' && /^https:\/\//i.test(value) ? value : undefined;
}

function confidenceColor(value: number | null): string {
  if (value == null) return 'default';
  if (value >= 0.8) return 'green';
  if (value >= 0.5) return 'blue';
  return 'orange';
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}

function exportEngagementReportPdf(report: EngagementReport) {
  const lines = [
    'Capiro Engagement Report',
    '',
    report.cycle.label,
    '',
    'Overview',
    `Target offices: ${report.summary.targetOffices}`,
    `Meetings held: ${report.summary.meetingsHeld}`,
    `Outreach sent: ${report.summary.outreachSent}`,
    `Submissions filed: ${report.summary.submissionsFiled}`,
    `Pending actions: ${report.summary.pendingActions}`,
    '',
    'Office Engagement Tracker',
    ...report.rows.flatMap((row) => [
      `${row.memberPrincipal}${row.clientName ? ` | ${row.clientName}` : ''}`,
      `Committee: ${row.committee || '-'} | Staffer: ${row.staffer || '-'} | Building: ${
        row.building || '-'
      } | Lead: ${row.leadOwner || '-'}`,
      `Meetings: ${row.meetingsHeld} | Outreach: ${row.outreachSent} | Prep: ${reportStatusLabel(
        row.prepStatus,
      )} | Submission: ${reportStatusLabel(row.submissionStatus)} | Pending: ${row.pendingActions}`,
      '',
    ]),
  ];

  const pdf = buildSimplePdf(lines.flatMap((line) => wrapPdfLine(line)));
  const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `engagement-report-${report.cycle.period}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Export the Office Engagement Tracker as CSV, matching the visible table
 *  (rows arrive already filtered + sorted). */
function exportEngagementReportCsv(rows: EngagementReportRow[], cycle?: EngagementReport['cycle']) {
  const escape = (value: string | number | null | undefined): string => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
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
      row.clientName,
      row.committee,
      row.staffer,
      row.building,
      row.leadOwner,
      row.meetingsHeld,
      reportStatusLabel(row.prepStatus),
      reportStatusLabel(row.outreachStatus),
      reportStatusLabel(row.submissionStatus),
      row.pendingActions,
    ]
      .map(escape)
      .join(','),
  );
  const csv = [header.map(escape).join(','), ...lines].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `engagement-report-${cycle?.period ?? 'export'}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportMeetingPdf({
  meeting,
  debriefs,
  context,
}: {
  meeting: Meeting;
  debriefs: MeetingDebrief[];
  context?: ClientContext;
}) {
  const prep = meeting.preps[0];
  const lines = [
    'Capiro Meeting Prep',
    '',
    meeting.subject,
    `${formatLongDate(meeting.startsAt)} | ${formatTimeRange(meeting.startsAt, meeting.endsAt)}`,
    `Client: ${meeting.client?.name ?? 'Unlinked'}`,
    `Location: ${meeting.location || 'No location'}`,
    '',
    'Context',
    prep?.summary || contextSummary(context, false),
    '',
    'Agenda',
    ...(prep?.agenda.length ? prep.agenda.map((item) => `- ${item}`) : ['No agenda saved.']),
    '',
    'Talking Points',
    ...(prep?.talkingPoints.length
      ? prep.talkingPoints.map((item) => `- ${item}`)
      : ['No talking points saved.']),
    '',
    'Participants',
    ...meetingParticipants(meeting).map(
      (participant) =>
        `- ${participant.name}${participant.role ? `, ${participant.role}` : ''}${
          participant.email ? ` (${participant.email})` : ''
        }`,
    ),
    '',
    'Debriefs',
    ...(debriefs.filter((debrief) => !debrief.restricted && debrief.body).length
      ? debriefs
          .filter((debrief) => !debrief.restricted && debrief.body)
          .flatMap((debrief) => [
            `${formatDateTime(debrief.createdAt)} by ${noteAuthor(debrief)}`,
            debrief.body ?? '',
          ])
      : ['No debriefs saved.']),
  ];

  const pdf = buildSimplePdf(lines.flatMap((line) => wrapPdfLine(line)));
  const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeFileName(meeting.subject)}-prep.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportDebriefPdf({ meeting, draft }: { meeting: Meeting; draft: DebriefDraftState }) {
  const lines = [
    'Capiro Meeting Debrief',
    '',
    meeting.subject,
    `${formatLongDate(meeting.startsAt)} | ${formatTimeRange(meeting.startsAt, meeting.endsAt)}`,
    `Client: ${meeting.client?.name ?? 'Unlinked'}`,
    `Location: ${meeting.location || 'No location'}`,
    '',
    'Recap',
    draft.recap || 'No recap saved.',
    '',
    'Action Items',
    ...(draft.actionItems.length
      ? draft.actionItems.map((item) => `- ${item}`)
      : ['No action items saved.']),
    '',
    'Notes',
    draft.notes || 'No notes saved.',
  ];

  const pdf = buildSimplePdf(lines.flatMap((line) => wrapPdfLine(line)));
  const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeFileName(meeting.subject)}-debrief.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function parseDebriefBody(body: string): DebriefDraftState {
  const fallback = { recap: body.trim(), actionItems: [], notes: '' };
  if (!body.trim()) return { recap: '', actionItems: [], notes: '' };
  const recap = sectionText(body, 'Recap', 'Action Items');
  const actionItems = sectionText(body, 'Action Items', 'Notes');
  const notes = sectionText(body, 'Notes');
  if (!recap && !actionItems && !notes) return fallback;
  return {
    recap: recap || fallback.recap,
    actionItems: linesToArray(actionItems.replace(/^- /gm, '')),
    notes,
  };
}

function formatDebriefBody(draft: DebriefDraftState): string {
  return [
    'Recap',
    draft.recap.trim() || 'No recap saved.',
    '',
    'Action Items',
    ...(draft.actionItems.length
      ? draft.actionItems.map((item) => `- ${item}`)
      : ['No action items saved.']),
    '',
    'Notes',
    draft.notes.trim() || 'No notes saved.',
  ].join('\n');
}

function sectionText(body: string, start: string, end?: string): string {
  const startPattern = new RegExp(`(?:^|\\n)${escapeRegExp(start)}\\s*\\n`, 'i');
  const startMatch = body.match(startPattern);
  if (!startMatch || startMatch.index === undefined) return '';
  const contentStart = startMatch.index + startMatch[0].length;
  const rest = body.slice(contentStart);
  if (!end) return rest.trim();
  const endPattern = new RegExp(`\\n${escapeRegExp(end)}\\s*\\n`, 'i');
  const endMatch = rest.match(endPattern);
  return (endMatch?.index === undefined ? rest : rest.slice(0, endMatch.index)).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wrapPdfLine(line: string, max = 88): string[] {
  if (line.length <= max) return [line];
  const words = line.split(/\s+/);
  const rows: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > max && current) {
      rows.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) rows.push(current);
  return rows;
}

function buildSimplePdf(lines: string[]): string {
  const linesPerPage = 48;
  const pages = chunk(lines, linesPerPage);
  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageObjectIds: number[] = [];
  for (const [pageIndex, pageLines] of pages.entries()) {
    const pageObjectId = objects.length + 1;
    const contentObjectId = objects.length + 2;
    pageObjectIds.push(pageObjectId);
    const content = [
      'BT',
      '/F1 11 Tf',
      '54 738 Td',
      '14 TL',
      ...pageLines.map((line, index) =>
        index === 0 ? `(${escapePdfText(line)}) Tj` : `T* (${escapePdfText(line)}) Tj`,
      ),
      `T* (Page ${pageIndex + 1} of ${pages.length}) Tj`,
      'ET',
    ].join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjectIds
    .map((id) => `${id} 0 R`)
    .join(' ')}] /Count ${pageObjectIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}

function escapePdfText(value: string): string {
  return value
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function chunk<T>(values: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    rows.push(values.slice(index, index + size));
  }
  return rows.length ? rows : [[]];
}

function safeFileName(value: string): string {
  return (
    value
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'meeting'
  );
}

/**
 * Engagement page client filter. Drives the global useClientFilter() state
 *, same store that other pages and the chat drawer subscribe to. When a
 * client is picked, the meetings/outreach/reports views filter to that
 * client's records (the per-tab queries already read selectedClientId from
 * the shared store).
 */
function EngClientPicker({
  clients,
  selectedClient,
  onSelect,
}: {
  clients: Client[];
  selectedClient: Client | null;
  onSelect: (id: string | null) => void;
}) {
  const menu = {
    items: [
      {
        key: '__all',
        label: 'All Clients',
        onClick: () => onSelect(null),
      },
      { type: 'divider' as const },
      ...clients.map((c) => ({
        key: c.id,
        label: c.name,
        onClick: () => onSelect(c.id),
      })),
    ],
  };
  return (
    <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
      <button type="button" className="eng-client-pick" aria-label="Filter by client">
        <span>{selectedClient?.name ?? 'All Clients'}</span>
        <DownOutlined style={{ fontSize: 10, color: 'var(--ink-3)' }} />
      </button>
    </Dropdown>
  );
}

/**
 * Mock meeting data, only injected for the Capiro tenant when the API
 * returns zero meetings. Other tenants never see these records.
 */
const MOCK_MEETINGS_FOR_CAPIRO: Meeting[] = (() => {
  const now = new Date();
  const from = (d: number, h = 14, m = 0) => {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    date.setHours(h, m, 0, 0);
    return date.toISOString();
  };

  return [
    {
      id: 'mock-m1',
      subject: 'Capiro Platform Review',
      source: 'google',
      description: 'Review the Capiro platform capabilities and discuss partnership alignment.',
      location: 'Microsoft Teams Meeting',
      startsAt: from(2),
      endsAt: from(2, 14, 45),
      organizerEmail: 'jordan@capiro.ai',
      organizerName: 'Jordan Clayton',
      status: 'confirmed',
      metadata: null,
      associationScore: null,
      associationReason: null,
      client: {
        id: 'c1',
        name: 'Brightdefense',
        website: null,
        primaryContactName: null,
        primaryContactEmail: null,
      },
      attendees: [
        { id: 'a1', email: 'jordan@capiro.ai', name: 'Jordan Clayton', role: 'organizer' },
        { id: 'a2', email: 'neo@capiro.ai', name: 'Neo Martinez', role: 'required' },
        { id: 'a3', email: 'jham@mavenadvocacy.com', name: 'Justin Ham', role: 'required' },
      ],
      attachments: [],
      preps: [],
      notes: [],
      debriefs: [],
    },
    {
      id: 'mock-m2',
      subject: 'Intro meeting with Persues consultant',
      source: 'google',
      description: null,
      location: 'Room 16, 112 Main St Los Angeles CA',
      startsAt: from(1, 13),
      endsAt: from(1, 13, 30),
      organizerEmail: 'neo@capiro.ai',
      organizerName: 'Neo Martinez',
      status: 'confirmed',
      metadata: null,
      associationScore: null,
      associationReason: null,
      client: {
        id: 'c1',
        name: 'Brightdefense',
        website: null,
        primaryContactName: null,
        primaryContactEmail: null,
      },
      attendees: [],
      attachments: [],
      preps: [],
      notes: [],
      debriefs: [],
    },
    {
      id: 'mock-m3',
      subject: 'HASC Seapower PSM coffee, Rachel Kim',
      source: 'google',
      description: 'Discuss Jaia authorization language.',
      location: 'Rayburn HOB, Room 2118',
      startsAt: from(-3, 9),
      endsAt: from(-3, 9, 30),
      organizerEmail: 'neo@capiro.ai',
      organizerName: 'Neo Martinez',
      status: 'confirmed',
      metadata: null,
      associationScore: null,
      associationReason: null,
      client: {
        id: 'c2',
        name: 'SAGINT INC.',
        website: null,
        primaryContactName: null,
        primaryContactEmail: null,
      },
      attendees: [],
      attachments: [],
      preps: [],
      notes: [],
      debriefs: [],
    },
  ];
})();
