import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { setActiveDraft } from '../../components/chat/chat-store.js';
import { useLocation, useNavigate } from 'react-router-dom';
// v2 wizard, replaces the older OutreachWizard. The old file at
// ./outreach/OutreachWizard.tsx is preserved for reference / quick rollback;
// import { OutreachWizard } from './outreach/OutreachWizard.js';
import { NewOutreachWizard as OutreachWizard } from './outreach/v2/index.js';
import {
  CheckOutlined,
  DeleteOutlined,
  PaperClipOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import { useApi } from '../../lib/use-api.js';
import type { Client } from '../clients/clientTypes.js';
import type {
  DirectoryApiResponse,
  DirectoryContactNote,
  DirectoryEntry,
} from '../directory/directoryData.js';

type OutreachType = 'all' | 'campaign' | 'follow_up' | 'prep' | 'outbound_campaign';
type WorkflowType = 'campaign' | 'follow_up' | 'prep' | 'outbound_campaign';
type OutreachStatus = 'draft' | 'sent' | 'opened_in_email' | 'failed';
type PromptTemplate =
  | 'custom'
  | 'thank_you'
  | 'follow_up'
  | 'memo'
  | 'post_meeting_memo'
  | 'introduction'
  | 'meeting_request'
  | 'status_update';
type CampaignRecipientTab = 'directory' | 'clients';

const PROMPT_TEMPLATES: Array<{ value: PromptTemplate; label: string; hint: string }> = [
  {
    value: 'custom',
    label: 'Custom (no template)',
    hint: 'Free-form draft based on objective and context.',
  },
  {
    value: 'thank_you',
    label: 'Thank you',
    hint: 'Warm thank-you note acknowledging support or a recent action.',
  },
  {
    value: 'follow_up',
    label: 'Follow-up',
    hint: 'Polite follow-up referencing a prior touchpoint and a clear ask.',
  },
  {
    value: 'memo',
    label: 'Memo / position paper',
    hint: 'Concise position memo with background, ask, and supporting points.',
  },
  {
    value: 'post_meeting_memo',
    label: 'Post Meeting Memo',
    hint: 'Internal post-meeting memo built from client, meeting, debrief, and directory context.',
  },
  {
    value: 'introduction',
    label: 'Introduction',
    hint: 'Introductory outreach explaining the client and reason for engaging.',
  },
  {
    value: 'meeting_request',
    label: 'Meeting request',
    hint: 'Request a meeting; offer scheduling options and brief context.',
  },
  {
    value: 'status_update',
    label: 'Status update',
    hint: 'Share a brief progress or activity update on the client matter.',
  },
];

export interface OutreachRecipient {
  id?: string;
  clientId?: string;
  direction?: 'on-behalf' | 'to-clients';
  name?: string;
  email?: string;
  office?: string;
  title?: string;
  chamber?: string;
  state?: string;
  district?: string;
  party?: string;
  directoryContactId?: string;
  directoryContactName?: string;
  committee?: string;
  address?: string;
  relevanceReason?: string;
  sourceLabel?: string;
  personalNote?: string;
  /** Additional Cc / Bcc addresses copied on this recipient's email. */
  cc?: string[];
  bcc?: string[];
  /**
   * Group representative ONLY: every member to place in the To field — a group
   * is one shared email to all members, not one email each. Absent for
   * individuals and list members.
   */
  groupMembers?: Array<{ email: string; name?: string }>;
  meetingId?: string;
  meetingSubject?: string;
  meetingDateTime?: string;
  attendeeNames?: string;
  attendeeEmails?: string;
  prepSummary?: string;
  debriefSummary?: string;
  meetingLocation?: string;
}

export interface OutreachRecord {
  id: string;
  clientId: string | null;
  meetingId: string | null;
  type: WorkflowType;
  status: OutreachStatus;
  title: string;
  subject: string | null;
  body: string | null;
  recipients: OutreachRecipient[];
  recipientCount: number;
  stats: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  lastStep: number;
  sentAt: string | null;
  openedInEmailAt: string | null;
  createdAt: string;
  updatedAt: string;
  client: Pick<Client, 'id' | 'name' | 'website' | 'intakeData'> | null;
  meeting: OutreachMeeting | null;
}

interface OutreachMeeting {
  id: string;
  clientId: string | null;
  subject: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  organizerEmail: string | null;
  organizerName: string | null;
  metadata: Record<string, unknown> | null;
  client: Pick<Client, 'id' | 'name' | 'website' | 'intakeData'> | null;
  attendees: Array<{ id: string; email: string | null; name: string | null; role: string | null }>;
  preps: Array<{
    id: string;
    status: string;
    summary: string | null;
    agenda: string[];
    talkingPoints: string[];
    risks: string[];
    followUps: string[];
  }>;
  debriefs: Array<{ id: string; createdAt: string }>;
}

interface IntegrationConnection {
  id: string;
  provider: string;
  status: string;
  accountEmail?: string | null;
  displayName?: string | null;
}

interface ClientContext {
  recentActivity: Array<{ type: string; id: string; title: string; date: string }>;
  keyStakeholders: Array<{
    id: string;
    email: string | null;
    fullName: string | null;
    title: string | null;
    organization: string | null;
    source?: string | null;
  }>;
  openThreads: Array<{
    id: string;
    subject: string;
    snippet: string | null;
    lastMessageAt: string | null;
  }>;
  summary: {
    meetings: number;
    mailThreads: number;
    contacts: number;
    openTasks: number;
  };
}

export interface OutreachWorkflowState {
  record: OutreachRecord | null;
  step: number;
  campaignName: string;
  objective: string;
  clientId: string | null;
  meetingId: string | null;
  recipients: OutreachRecipient[];
  subject: string;
  body: string;
  selectedPreviewIndex: number;
  recipientInput: string;
  promptTemplate: PromptTemplate;
  campaignRecipientTab: CampaignRecipientTab;
  selectedContactIds: string[];
  templateId: string | null;
  templateMode: 'existing' | 'custom';
  customTemplateName: string;
  outboundTone: 'professional' | 'friendly' | 'formal' | 'concise';
  sendTiming: 'now' | 'later';
  scheduledFor: string;
  sentRecipientCount: number;
  fieldFallbacks: Record<string, string>;
  personalNotesSaved: boolean;
  // EngagementAttachment ids to send with every email (files uploaded from the
  // user's computer or picked from stored client documents).
  attachmentIds: string[];
}

interface OutboundContactRecord {
  id: string;
  meetingId: string;
  meetingSubject: string;
  meetingDateTime: string;
  meetingStartsAt: string;
  clientId: string | null;
  clientName: string | null;
  attendeeName: string;
  attendeeEmail: string | null;
  attendeeNames: string;
  attendeeEmails: string;
  prepSummary: string;
  debriefSummary: string;
  meetingLocation: string;
  directoryContactId: string | null;
  directoryContactName: string | null;
  office: string | null;
  title: string | null;
  committee: string | null;
  relevanceReason: string | null;
}

interface OutboundContactDataResponse {
  generatedAt: string;
  from: string;
  to: string;
  contacts: OutboundContactRecord[];
}

interface OutreachTemplate {
  id: string;
  source: 'system' | 'user';
  type: 'outbound_campaign';
  name: string;
  subject: string | null;
  body: string;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface TemplateOption {
  id: string | null;
  name: string;
  description: string;
  source: OutreachTemplate['source'] | 'custom';
  subject: string;
  body: string;
  isCustom?: boolean;
}

type DirectionFilter = 'all' | 'to-clients' | 'on-behalf';

// Filter outreach by who it's going to: "Client" = direct to your own clients,
// "External" = sent to congressional offices on behalf of a client.
const DIRECTION_FILTERS: Array<{ value: DirectionFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'to-clients', label: 'Client' },
  { value: 'on-behalf', label: 'External' },
];

const WORKFLOW_LABELS: Record<WorkflowType, string> = {
  campaign: 'Campaign',
  outbound_campaign: 'Outbound Campaign',
  follow_up: 'Meeting follow-up',
  prep: 'Prep distribution',
};

const OUTBOUND_VARIABLES = [
  '{current_date_time}',
  '{attendee_names}',
  '{attendee_emails}',
  '{prep_summary}',
  '{debrief_summary}',
  '{meeting_location}',
  '{meeting_subject}',
  '{meeting_date_time}',
] as const;

const OUTBOUND_VARIABLE_DESCRIPTIONS: Record<(typeof OUTBOUND_VARIABLES)[number], string> = {
  '{current_date_time}': 'Current date and time when the draft is generated or sent.',
  '{attendee_names}': 'Names from the synced meeting attendee list.',
  '{attendee_emails}': 'Email addresses from the synced meeting attendee list.',
  '{prep_summary}': 'Saved meeting prep notes for that recipient context.',
  '{debrief_summary}': 'Saved meeting debrief notes for that recipient context.',
  '{meeting_location}': 'Meeting location or matched office location.',
  '{meeting_subject}': 'Subject of the synced meeting.',
  '{meeting_date_time}': 'Date and time of the synced meeting.',
};

const CAMPAIGN_DYNAMIC_FIELDS = [
  '{district}',
  '{committee}',
  '{address}',
  '{personal_note}',
] as const;
type CampaignDynamicField = (typeof CAMPAIGN_DYNAMIC_FIELDS)[number];

const CAMPAIGN_TEMPLATE_OPTIONS: Array<{
  value: PromptTemplate;
  label: string;
  description: string;
  disabled?: boolean;
}> = [
  {
    value: 'post_meeting_memo',
    label: 'Post Meeting Memo',
    description: 'Internal memo from meeting, debrief, client, and directory context.',
  },
  {
    value: 'meeting_request',
    label: 'Meeting request',
    description: 'Short request for a meeting with a clear ask.',
    disabled: true,
  },
  {
    value: 'status_update',
    label: 'Policy update',
    description: 'Brief update on policy or program activity.',
    disabled: true,
  },
  {
    value: 'thank_you',
    label: 'Thank you',
    description: 'Warm thank-you note after a touchpoint.',
    disabled: true,
  },
  {
    value: 'introduction',
    label: 'Intro note',
    description: 'Introductory outreach on behalf of a client.',
    disabled: true,
  },
];

const OUTBOUND_TONES: Array<{
  value: OutreachWorkflowState['outboundTone'];
  label: string;
}> = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'formal', label: 'Formal' },
  { value: 'concise', label: 'Concise' },
];

const EMPTY_WORKFLOW: OutreachWorkflowState = {
  record: null,
  step: 1,
  campaignName: '',
  objective: '',
  clientId: null,
  meetingId: null,
  recipients: [],
  subject: '',
  body: '',
  selectedPreviewIndex: 0,
  recipientInput: '',
  promptTemplate: 'custom',
  campaignRecipientTab: 'directory',
  selectedContactIds: [],
  templateId: null,
  templateMode: 'existing',
  customTemplateName: '',
  outboundTone: 'professional',
  sendTiming: 'now',
  scheduledFor: '',
  sentRecipientCount: 0,
  fieldFallbacks: {},
  personalNotesSaved: true,
  attachmentIds: [],
};

export function OutreachView({
  clients,
  selectedClientId,
  aiConfigured,
}: {
  clients: Client[];
  selectedClientId: string | null;
  aiConfigured: boolean;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const today = todayInputValue();
  const [from, setFrom] = useState(inputValueFromDate(addLocalDays(new Date(), -365)));
  const [to, setTo] = useState(today);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [outreachLimit, setOutreachLimit] = useState(50);
  // "Show deleted" — when on, the list shows the soft-deleted (trashed) records
  // with a Restore action instead of the normal live list. Lets users recover
  // outreach removed from Capiro without admin/DB intervention.
  const [showDeleted, setShowDeleted] = useState(false);
  // 'selector' (the meeting-follow-up / prep / campaign type picker) was
  // removed: clicking "New Outreach" now jumps straight to the campaign
  // wizard. The 'follow_up' and 'prep' modes still exist for callers that
  // open them directly (e.g. from a meeting's debrief), they just aren't
  // entry-pointed from the outreach landing page anymore.
  const [mode, setMode] = useState<'landing' | WorkflowType | 'readonly'>('landing');
  const [workflow, setWorkflow] = useState<OutreachWorkflowState>(() => ({
    ...EMPTY_WORKFLOW,
    clientId: selectedClientId,
  }));
  const [readonlyRecord, setReadonlyRecord] = useState<OutreachRecord | null>(null);
  const [directoryQuery, setDirectoryQuery] = useState('');
  const syncingFromUrlRef = useRef(false);
  const lastProcessedUrlRef = useRef<string>('');
  const draftRecordIdFromPath = useMemo(() => {
    if (!location.pathname.startsWith('/engagement/outreach/draft/')) return null;
    const value = location.pathname.replace('/engagement/outreach/draft/', '').split('/')[0];
    return value ? decodeURIComponent(value) : null;
  }, [location.pathname]);

  useEffect(() => {
    if (mode !== 'campaign') {
      setActiveDraft(null);
      return;
    }

    const engagementId = workflow.record?.id ?? draftRecordIdFromPath ?? '';
    setActiveDraft({
      engagementId,
      recipientId: workflow.recipients[workflow.selectedPreviewIndex]?.id,
      subject: workflow.subject,
      body: workflow.body,
    });
  }, [
    mode,
    workflow.record?.id,
    workflow.recipients,
    workflow.selectedPreviewIndex,
    workflow.subject,
    workflow.body,
    draftRecordIdFromPath,
  ]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        target?: string;
        engagementId?: string;
        recipientId?: string;
        subject?: string;
        body?: string;
      }>).detail;
      if (!detail) return;
      if (detail.target !== 'outreach_draft') return;
      if (mode !== 'campaign') return;

      const currentEngagementId = workflow.record?.id ?? draftRecordIdFromPath ?? '';
      if (detail.engagementId && currentEngagementId && detail.engagementId !== currentEngagementId) return;

      setWorkflow((current) => {
        const nextSubject = typeof detail.subject === 'string' ? detail.subject : current.subject;
        const nextBody = typeof detail.body === 'string' ? detail.body : current.body;
        if (nextSubject === current.subject && nextBody === current.body) return current;
        return {
          ...current,
          subject: nextSubject,
          body: nextBody,
        };
      });
    };

    window.addEventListener('capiro:page-write', handler as EventListener);
    return () => window.removeEventListener('capiro:page-write', handler as EventListener);
  }, [mode, workflow.record?.id, draftRecordIdFromPath]);

  useEffect(() => {
    // URL → mode sync. Only run when the URL itself actually changed
    // since we last saw it. Without this guard, this effect re-runs
    // whenever `mode` changes from a user click (because mode is in
    // the deps via the comparison below), and because the URL hasn't
    // caught up yet, the effect would compute nextMode from the stale
    // path and clobber the new mode back to 'landing'. Net result:
    // clicking "New Outreach" silently does nothing.
    const path = location.pathname;
    if (!path.startsWith('/engagement/outreach')) return;
    if (lastProcessedUrlRef.current === path) return;
    lastProcessedUrlRef.current = path;

    const rest = path.replace('/engagement/outreach', '');
    let nextMode: 'landing' | WorkflowType | 'readonly' = 'landing';
    // Legacy URL /engagement/outreach/new used to render the type-selector;
    // it now redirects straight into the campaign wizard via the mode→URL
    // effect below so the user never lands on an empty intermediate page.
    if (rest === '/new' || rest === '/new/wizard') nextMode = 'campaign';
    else if (rest.startsWith('/draft/')) nextMode = 'campaign';

    if (mode !== nextMode) {
      syncingFromUrlRef.current = true;
      setMode(nextMode);
    }
  }, [location.pathname, mode]);

  useEffect(() => {
    if (!location.pathname.startsWith('/engagement/outreach')) return;
    if (syncingFromUrlRef.current) {
      syncingFromUrlRef.current = false;
      return;
    }

    let nextPath = '/engagement/outreach';
    if (mode === 'campaign') {
      nextPath = workflow.record?.id
        ? `/engagement/outreach/draft/${encodeURIComponent(workflow.record.id)}`
        : '/engagement/outreach/new/wizard';
    }

    if (location.pathname !== nextPath) {
      // Pre-record the URL we're about to write so the URL→mode effect
      // skips it when location updates (mode already reflects the change).
      lastProcessedUrlRef.current = nextPath;
      navigate({ pathname: nextPath }, { replace: true });
    }
  }, [location.pathname, mode, navigate, workflow.record?.id]);

  useEffect(() => {
    const locked = mode !== 'landing';
    window.dispatchEvent(new CustomEvent('capiro:workflow-lock', { detail: { locked } }));
    return () => {
      window.dispatchEvent(new CustomEvent('capiro:workflow-lock', { detail: { locked: false } }));
    };
  }, [mode]);

  useEffect(() => {
    setOutreachLimit(50);
  }, [selectedClientId, from, to]);

  const activeClients = useMemo(
    () =>
      clients
        .filter((client) => client.status !== 'archived')
        .sort((left, right) => left.name.localeCompare(right.name)),
    [clients],
  );
  const selectedClient = activeClients.find((client) => client.id === selectedClientId) ?? null;

  const outreach = useQuery<OutreachRecord[]>({
    queryKey: ['engagement-outreach', selectedClientId, from, to, outreachLimit, showDeleted],
    queryFn: async () =>
      (
        await api.get<OutreachRecord[]>('/api/engagement/outreach', {
          params: {
            clientId: selectedClientId ?? undefined,
            from: localDateStartIso(from),
            to: localDateEndIso(to),
            limit: outreachLimit,
            deleted: showDeleted ? 'true' : undefined,
          },
        })
      ).data,
  });

  const draftRecord = useQuery<OutreachRecord>({
    queryKey: ['engagement-outreach-record', draftRecordIdFromPath],
    queryFn: async () =>
      (await api.get<OutreachRecord>(`/api/engagement/outreach/${draftRecordIdFromPath}`)).data,
    enabled: Boolean(draftRecordIdFromPath),
  });

  useEffect(() => {
    if (!draftRecordIdFromPath || mode !== 'campaign') return;
    if (workflow.record?.id === draftRecordIdFromPath) return;
    if (draftRecord.isLoading || !draftRecord.data) return;

    syncingFromUrlRef.current = true;
    setWorkflow(hydrateWorkflowFromRecord(draftRecord.data, EMPTY_WORKFLOW));
  }, [draftRecord.data, draftRecord.isLoading, draftRecordIdFromPath, mode, workflow.record?.id]);

  const integrations = useQuery<IntegrationConnection[]>({
    queryKey: ['engagement-integrations'],
    queryFn: async () =>
      (await api.get<IntegrationConnection[]>('/api/engagement/integrations')).data,
  });
  const emailConnected = (integrations.data ?? []).some(
    (connection) =>
      connection.status === 'connected' &&
      (connection.provider === 'microsoft_365' || connection.provider === 'google_workspace'),
  );

  const pastMeetings = useQuery<OutreachMeeting[]>({
    queryKey: ['engagement-outreach-past-meetings', selectedClientId],
    queryFn: async () =>
      (
        await api.get<OutreachMeeting[]>('/api/engagement/meetings', {
          params: {
            clientId: selectedClientId ?? undefined,
            from: addLocalDays(new Date(), -365).toISOString(),
            to: new Date().toISOString(),
          },
        })
      ).data,
    enabled: mode === 'follow_up',
  });

  const upcomingMeetings = useQuery<OutreachMeeting[]>({
    queryKey: ['engagement-outreach-upcoming-meetings', selectedClientId],
    queryFn: async () =>
      (
        await api.get<OutreachMeeting[]>('/api/engagement/meetings', {
          params: {
            clientId: selectedClientId ?? undefined,
            from: new Date().toISOString(),
            to: addLocalDays(new Date(), 90).toISOString(),
          },
        })
      ).data,
    enabled: mode === 'prep',
  });

  const outboundContactData = useQuery<OutboundContactDataResponse>({
    queryKey: ['engagement-outbound-contact-data', selectedClientId],
    queryFn: async () =>
      (
        await api.get<OutboundContactDataResponse>(
          '/api/engagement/outreach/outbound/contact-data',
          {
            params: { clientId: selectedClientId ?? undefined },
          },
        )
      ).data,
    enabled: mode === 'outbound_campaign',
  });

  const outreachTemplates = useQuery<OutreachTemplate[]>({
    queryKey: ['engagement-outreach-templates', 'outbound_campaign'],
    queryFn: async () =>
      (
        await api.get<OutreachTemplate[]>('/api/engagement/outreach/templates', {
          params: { type: 'outbound_campaign' },
        })
      ).data,
    enabled: mode === 'outbound_campaign',
  });

  const directory = useQuery<DirectoryApiResponse>({
    queryKey: ['engagement-outreach-directory', directoryQuery],
    queryFn: async () =>
      (
        await api.get<DirectoryApiResponse>('/api/directory/contacts', {
          params: {
            q: directoryQuery,
            pageSize: 20,
            // With no query, show the directory A–Z by default so the panel
            // isn't empty and it's obvious you can search/add from here.
            sort: directoryQuery.trim().length >= 2 ? undefined : 'name-asc',
          },
        })
      ).data,
    enabled: mode === 'campaign' || mode === 'outbound_campaign',
  });

  const clientContext = useQuery<ClientContext>({
    queryKey: ['engagement-outreach-client-context', workflow.clientId],
    queryFn: async () =>
      (await api.get<ClientContext>(`/api/engagement/context/${workflow.clientId}`)).data,
    enabled: mode === 'campaign' && Boolean(workflow.clientId),
  });

  const createRecord = useMutation({
    mutationFn: async (payload: Partial<OutreachRecord> & { type: WorkflowType; title: string }) =>
      (await api.post<OutreachRecord>('/api/engagement/outreach', payload)).data,
    onSuccess: (record) => {
      setWorkflow((current) => hydrateWorkflowFromRecord(record, current));
      qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const updateRecord = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      (await api.patch<OutreachRecord>(`/api/engagement/outreach/${id}`, payload)).data,
    onSuccess: (record) => {
      setWorkflow((current) => hydrateWorkflowFromRecord(record, current));
      qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const generateDraft = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      (await api.post<OutreachRecord>(`/api/engagement/outreach/${id}/generate-draft`, payload))
        .data,
    onSuccess: (record) => {
      message.success('Meri draft ready');
      setWorkflow((current) => hydrateWorkflowFromRecord(record, current));
      qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const openEmail = useMutation({
    mutationFn: async (id: string) =>
      (
        await api.post<{ record: OutreachRecord; mailtoUrl: string }>(
          `/api/engagement/outreach/${id}/open-email`,
        )
      ).data,
    onSuccess: (result) => {
      window.location.href = result.mailtoUrl;
      message.success('Opened in connected email');
      qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
      setMode('landing');
      setWorkflow({ ...EMPTY_WORKFLOW, clientId: selectedClientId });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const sendCampaign = useMutation({
    mutationFn: async (id: string) =>
      (await api.post<OutreachRecord>(`/api/engagement/outreach/${id}/send-campaign`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const deleteRecord = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/engagement/outreach/${id}`)).data,
    onSuccess: (_result, id) => {
      message.success('Outreach removed from Capiro');
      if (readonlyRecord?.id === id) {
        setReadonlyRecord(null);
        setMode('landing');
      }
      if (workflow.record?.id === id) {
        setWorkflow({ ...EMPTY_WORKFLOW, clientId: selectedClientId });
        setMode('landing');
      }
      qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const restoreRecord = useMutation({
    mutationFn: async (id: string) =>
      (await api.post<OutreachRecord>(`/api/engagement/outreach/${id}/restore`)).data,
    onSuccess: () => {
      message.success('Outreach restored');
      qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const createTemplate = useMutation({
    mutationFn: async (payload: { name: string; subject?: string | null; body: string }) =>
      (await api.post<OutreachTemplate>('/api/engagement/outreach/templates', payload)).data,
    onSuccess: (template) => {
      message.success('Template saved');
      qc.invalidateQueries({ queryKey: ['engagement-outreach-templates'] });
      setWorkflow((current) => ({
        ...current,
        templateId: template.id,
        templateMode: 'existing',
        subject: template.subject ?? current.subject,
        body: template.body,
      }));
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const confirmDeleteRecord = (record: OutreachRecord) => {
    modal.confirm({
      title: 'Delete outreach from Capiro?',
      content:
        'This removes the draft or sent record from Capiro only. It will not delete, recall, or change anything in Outlook.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: () => deleteRecord.mutateAsync(record.id),
    });
  };

  const saveCurrent = async (patch: Partial<OutreachWorkflowState>, step?: number) => {
    const next = { ...workflow, ...patch, step: step ?? workflow.step };
    setWorkflow(next);
    const payload = workflowPayload(next);
    if (next.record) {
      await updateRecord.mutateAsync({ id: next.record.id, payload });
      return;
    }
    const type = mode as WorkflowType;
    if (!['campaign', 'follow_up', 'prep', 'outbound_campaign'].includes(type)) return;
    await createRecord.mutateAsync({
      type,
      title: payload.title as string,
      clientId: (payload.clientId as string | null) ?? undefined,
      meetingId: (payload.meetingId as string | null) ?? undefined,
      subject: (payload.subject as string | null) ?? undefined,
      body: (payload.body as string | null) ?? undefined,
      recipients: payload.recipients as OutreachRecipient[],
      metadata: payload.metadata as Record<string, unknown>,
      lastStep: payload.lastStep as number,
    });
  };

  const startWorkflow = (type: WorkflowType) => {
    setMode(type);
    setWorkflow({
      ...EMPTY_WORKFLOW,
      clientId: selectedClientId,
      step: 1,
    });
    if (type === 'campaign') {
      setWorkflow((current) => ({
        ...current,
        clientId: null,
        campaignName: '',
        objective: '',
        recipients: [],
        subject: '',
        body: '',
        selectedPreviewIndex: 0,
        recipientInput: '',
        fieldFallbacks: {},
        personalNotesSaved: true,
      }));
      setDirectoryQuery('');
    } else if (type === 'outbound_campaign') {
      setWorkflow((current) => ({
        ...current,
        campaignName: `Outbound campaign - ${formatOptionalDate(new Date().toISOString())}`,
        templateMode: 'existing',
      }));
      setDirectoryQuery('');
    }
  };

  const openDraft = (record: OutreachRecord) => {
    setWorkflow(hydrateWorkflowFromRecord(record, EMPTY_WORKFLOW));
    setMode(record.type);
  };

  const openReadonly = (record: OutreachRecord) => {
    setReadonlyRecord(record);
    setMode('readonly');
  };

  const cancelWorkflow = () => {
    modal.confirm({
      title: 'Cancel outreach workflow?',
      content:
        'Cancelling returns to Outreach. Unsaved field edits on this step will be discarded.',
      okText: 'Cancel workflow',
      cancelText: 'Keep editing',
      onOk: () => {
        setMode('landing');
        setWorkflow({ ...EMPTY_WORKFLOW, clientId: selectedClientId });
        setReadonlyRecord(null);
      },
    });
  };

  if (mode === 'readonly' && readonlyRecord) {
    return (
      <OutreachReadonly
        record={readonlyRecord}
        deleting={deleteRecord.isPending && deleteRecord.variables === readonlyRecord.id}
        onClose={() => setMode('landing')}
        onDelete={confirmDeleteRecord}
      />
    );
  }

  if (mode === 'campaign') {
    // When resuming a saved draft, hand the v2 wizard the record we already
    // fetched (the same data feeding hydrateWorkflowFromRecord) plus its id,
    // so the wizard reopens on the saved step with subject/body/recipients/
    // context restored instead of starting fresh at step 1. The id is taken
    // from the URL when present, falling back to the workflow record (set by
    // openDraft) so both entry paths into a draft resume correctly.
    const resumeRecord = draftRecordIdFromPath ? (draftRecord.data ?? null) : workflow.record;
    const resumeDraftId = draftRecordIdFromPath ?? workflow.record?.id ?? null;
    return (
      <OutreachWizard
        clients={activeClients}
        selectedClientId={selectedClientId}
        aiConfigured={aiConfigured}
        emailConnected={emailConnected}
        initialRecord={resumeRecord}
        initialDraftId={resumeDraftId}
        sendFrom={
          (integrations.data ?? []).find(
            (connection) =>
              connection.status === 'connected' &&
              (connection.provider === 'microsoft_365' ||
                connection.provider === 'google_workspace') &&
              connection.accountEmail,
          )?.accountEmail ?? null
        }
        onCancel={cancelWorkflow}
        onComplete={() => {
          qc.invalidateQueries({ queryKey: ['engagement-outreach'] });
          setMode('landing');
          setWorkflow({ ...EMPTY_WORKFLOW, clientId: selectedClientId });
        }}
      />
    );
  }

  if (mode === 'outbound_campaign') {
    return (
      <OutboundCampaignWorkflow
        clients={activeClients}
        workflow={workflow}
        contacts={outboundContactData.data?.contacts ?? []}
        contactsLoading={outboundContactData.isLoading}
        templates={outreachTemplates.data ?? []}
        templatesLoading={outreachTemplates.isLoading}
        directoryRows={directory.data?.contacts ?? []}
        directoryLoading={directory.isLoading}
        directoryQuery={directoryQuery}
        emailConnected={emailConnected}
        saving={createRecord.isPending || updateRecord.isPending}
        savingTemplate={createTemplate.isPending}
        generating={generateDraft.isPending}
        sending={sendCampaign.isPending}
        onDirectoryQuery={setDirectoryQuery}
        onWorkflowChange={setWorkflow}
        onCancel={cancelWorkflow}
        onSaveStep={saveCurrent}
        onSaveTemplate={(payload) => createTemplate.mutateAsync(payload)}
        onGenerate={async () => {
          const templates = outreachTemplates.data ?? [];
          const fallbackTemplate =
            templates.find((template) => template.id === workflow.templateId) ??
            templates[0] ??
            null;
          const nextWorkflow = {
            ...workflow,
            templateId: workflow.templateId ?? fallbackTemplate?.id ?? null,
            subject: workflow.subject || fallbackTemplate?.subject || 'Outbound campaign',
            body: workflow.body || fallbackTemplate?.body || outboundGenerationBrief(),
          };
          const payload = workflowPayload(nextWorkflow);
          const record =
            nextWorkflow.record ??
            (await createRecord.mutateAsync({
              type: 'outbound_campaign',
              title: payload.title as string,
              clientId: (payload.clientId as string | null) ?? undefined,
              meetingId: (payload.meetingId as string | null) ?? undefined,
              subject: (payload.subject as string | null) ?? undefined,
              body: (payload.body as string | null) ?? undefined,
              recipients: payload.recipients as OutreachRecipient[],
              metadata: payload.metadata as Record<string, unknown>,
              lastStep: payload.lastStep as number,
            }));
          if (nextWorkflow.record) {
            await updateRecord.mutateAsync({ id: record.id, payload });
          }
          const generatedRecord = await generateDraft.mutateAsync({
            id: record.id,
            payload: {
              recipients: nextWorkflow.recipients,
              promptTemplate: 'custom',
              metadata: {
                ...((payload.metadata as Record<string, unknown>) ?? {}),
                outboundTone: nextWorkflow.outboundTone,
                outboundCurrentDateTime: new Date().toISOString(),
                outboundTemplate: {
                  subject: nextWorkflow.subject,
                  body: nextWorkflow.body,
                },
              },
            },
          });
          setWorkflow((current) => ({
            ...hydrateWorkflowFromRecord(generatedRecord, current),
            step: 3,
          }));
        }}
        onSend={() => {
          if (!workflow.record) return;
          void sendCampaign
            .mutateAsync(workflow.record.id)
            .then(() => {
              message.success(`Campaign sent to ${workflow.recipients.length} recipients`);
              setMode('landing');
              setWorkflow({ ...EMPTY_WORKFLOW, clientId: selectedClientId });
            })
            .catch(() => {
              // Mutation handlers surface the API error to the user.
            });
        }}
      />
    );
  }

  if (mode === 'follow_up') {
    return (
      <FollowUpWorkflow
        workflow={workflow}
        meetings={(pastMeetings.data ?? []).slice().reverse()}
        loading={pastMeetings.isLoading}
        emailConnected={emailConnected}
        aiConfigured={aiConfigured}
        saving={createRecord.isPending || updateRecord.isPending}
        generating={generateDraft.isPending}
        opening={openEmail.isPending}
        onWorkflowChange={setWorkflow}
        onCancel={cancelWorkflow}
        onSaveStep={saveCurrent}
        onGenerate={() => {
          if (!workflow.record) return;
          void generateDraft.mutateAsync({
            id: workflow.record.id,
            payload: { recipients: workflow.recipients },
          });
        }}
        onOpenEmail={() => {
          if (workflow.record) openEmail.mutate(workflow.record.id);
        }}
      />
    );
  }

  if (mode === 'prep') {
    return (
      <PrepDistributionWorkflow
        workflow={workflow}
        meetings={upcomingMeetings.data ?? []}
        loading={upcomingMeetings.isLoading}
        emailConnected={emailConnected}
        aiConfigured={aiConfigured}
        saving={createRecord.isPending || updateRecord.isPending}
        generating={generateDraft.isPending}
        opening={openEmail.isPending}
        onWorkflowChange={setWorkflow}
        onCancel={cancelWorkflow}
        onSaveStep={saveCurrent}
        onGenerate={() => {
          if (!workflow.record) return;
          void generateDraft.mutateAsync({
            id: workflow.record.id,
            payload: { recipients: workflow.recipients },
          });
        }}
        onOpenEmail={() => {
          if (workflow.record) openEmail.mutate(workflow.record.id);
        }}
      />
    );
  }

  const rows = (outreach.data ?? [])
    // The outbound-campaign creation flow is de-entry-pointed, so hide its
    // stale drafts — but anything that actually went out (sent / failed /
    // opened) must stay visible in the Sent section regardless of type.
    .filter((record) => record.type !== 'outbound_campaign' || record.status !== 'draft')
    .filter((record) => directionFilter === 'all' || recordDirection(record) === directionFilter)
    .sort((left, right) => outreachRecordTimestamp(right) - outreachRecordTimestamp(left));
  const drafts = rows.filter((record) => record.status === 'draft');
  const sent = rows.filter((record) => record.status !== 'draft');

  return (
    <div className="outreach-page">
      <div className="outreach-filter-bar">
        <span>Date range</span>
        <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        <span>-</span>
        <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        <div className="outreach-type-pills">
          {DIRECTION_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={directionFilter === filter.value ? 'active' : ''}
              onClick={() => setDirectionFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => startWorkflow('campaign')}>
          New Outreach
        </Button>
        <Button
          type={showDeleted ? 'primary' : 'default'}
          danger={showDeleted}
          onClick={() => setShowDeleted((value) => !value)}
          title="Show outreach that was deleted from Capiro, with the option to restore it."
        >
          {showDeleted ? 'Viewing deleted' : 'Show deleted'}
        </Button>
      </div>

      {outreach.isLoading ? (
        <div className="outreach-card-list">
          <Empty description="Loading outreach..." />
        </div>
      ) : rows.length ? (
        <>
          {drafts.length ? (
            <section className="outreach-section">
              <Typography.Title level={5}>Drafts in Progress</Typography.Title>
              <div className="outreach-card-list">
                {drafts.map((record) => (
                  <OutreachRecordCard
                    key={record.id}
                    record={record}
                    deleting={deleteRecord.isPending && deleteRecord.variables === record.id}
                    onClick={showDeleted ? () => undefined : openDraft}
                    onDelete={confirmDeleteRecord}
                    onRestore={showDeleted ? (rec) => restoreRecord.mutate(rec.id) : undefined}
                    restoring={restoreRecord.isPending && restoreRecord.variables === record.id}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <div className="outreach-sent-divider">
            <span />
            <strong>Sent</strong>
            <span />
          </div>

          {sent.length ? (
            <div className="outreach-card-list">
              {sent.map((record) => (
                <OutreachRecordCard
                  key={record.id}
                  record={record}
                  deleting={deleteRecord.isPending && deleteRecord.variables === record.id}
                  onClick={showDeleted ? () => undefined : openReadonly}
                  onDelete={confirmDeleteRecord}
                  onRestore={showDeleted ? (rec) => restoreRecord.mutate(rec.id) : undefined}
                  restoring={restoreRecord.isPending && restoreRecord.variables === record.id}
                />
              ))}
            </div>
          ) : (
            <Empty description="No sent or opened outreach in this date range." />
          )}
          {rows.length >= outreachLimit ? (
            <Button block onClick={() => setOutreachLimit((current) => current + 50)}>
              Load more
            </Button>
          ) : null}
        </>
      ) : (
        <div className="outreach-empty">
          <Empty
            description={
              <span>
                <strong>No outreach yet</strong>
                <br />
                Use New Outreach above, Meri drafts from your context
              </span>
            }
          />
        </div>
      )}
    </div>
  );
}

// OutreachTypeSelector + OutreachTypeCard removed: the New Outreach button
// now jumps straight into the campaign wizard. Meeting-follow-up and
// prep-distribution workflows still exist but are reached from a meeting's
// debrief / prep flow, not from a top-level type picker.

function CampaignWorkflow({
  clients,
  workflow,
  clientContext,
  contextLoading,
  directoryRows,
  directoryTotal,
  directoryLoading,
  directoryQuery,
  emailConnected,
  sendFrom,
  aiConfigured,
  saving,
  generating,
  sending,
  onDirectoryQuery,
  onWorkflowChange,
  onCancel,
  onSaveStep,
  onGenerate,
  onSend,
}: {
  clients: Client[];
  workflow: OutreachWorkflowState;
  clientContext?: ClientContext;
  contextLoading: boolean;
  directoryRows: DirectoryEntry[];
  directoryTotal: number | null;
  directoryLoading: boolean;
  directoryQuery: string;
  emailConnected: boolean;
  sendFrom: string | null;
  aiConfigured: boolean;
  saving: boolean;
  generating: boolean;
  sending: boolean;
  onDirectoryQuery: (value: string) => void;
  onWorkflowChange: (value: OutreachWorkflowState) => void;
  onCancel: () => void;
  onSaveStep: (patch: Partial<OutreachWorkflowState>, step?: number) => Promise<void>;
  onGenerate: () => Promise<void>;
  onSend: () => void;
}) {
  const { message, modal } = App.useApp();
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [officeFilter, setOfficeFilter] = useState<string>('all');
  const [fallbackField, setFallbackField] = useState<CampaignDynamicField | null>(null);
  const [manualFirst, setManualFirst] = useState('');
  const [manualLast, setManualLast] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const manualRecipientValid =
    manualFirst.trim().length > 0 &&
    manualLast.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(manualEmail.trim());
  const selectedClient = clients.find((client) => client.id === workflow.clientId) ?? null;
  const selectedRecipient = workflow.recipients[workflow.selectedPreviewIndex] ?? null;
  const contextSuggestions = useMemo(
    () => campaignContextSuggestions(clientContext),
    [clientContext],
  );
  const officeOptions = useMemo(
    () =>
      Array.from(new Set(directoryRows.map((entry) => entry.office).filter(Boolean))).sort(
        (left, right) => left.localeCompare(right),
      ),
    [directoryRows],
  );
  const filteredDirectoryRows = useMemo(
    () =>
      officeFilter === 'all'
        ? directoryRows
        : directoryRows.filter((entry) => entry.office === officeFilter),
    [directoryRows, officeFilter],
  );
  const draftReady = Boolean(workflow.subject.trim() || workflow.body.trim());
  const dynamicFields = campaignDynamicFieldsIn(workflow.subject, workflow.body);
  const exceptionRows = campaignExceptionRows(
    workflow.recipients,
    dynamicFields,
    workflow.fieldFallbacks,
  );
  const missingFallbacks = exceptionRows.filter((row) => !row.fallback.trim());
  const hasPersonalNotes = workflow.recipients.some((recipient) => recipient.personalNote?.trim());
  const personalNotesBlocked = hasPersonalNotes && !workflow.personalNotesSaved;
  const missingEmailRecipients = workflow.recipients.filter((recipient) => !recipient.email);

  const selectedFallbackValue = fallbackField ? (workflow.fieldFallbacks[fallbackField] ?? '') : '';

  const addRecipient = (recipient: OutreachRecipient) => {
    onWorkflowChange({
      ...workflow,
      recipients: addUniqueRecipient(workflow.recipients, recipient),
    });
  };

  const removeSelectedRecipient = (recipient: OutreachRecipient) => {
    onWorkflowChange({
      ...workflow,
      recipients: removeRecipient(workflow.recipients, recipient),
    });
  };

  const addManualRecipient = () => {
    if (!manualRecipientValid) return;
    onWorkflowChange({
      ...workflow,
      recipients: addUniqueRecipient(workflow.recipients, {
        name: `${manualFirst.trim()} ${manualLast.trim()}`,
        email: manualEmail.trim(),
        relevanceReason: 'Manually added',
      }),
    });
    setManualFirst('');
    setManualLast('');
    setManualEmail('');
  };

  const updateRecipient = (index: number, patch: Partial<OutreachRecipient>) => {
    const recipient = workflow.recipients[index];
    if (!recipient) return;
    const recipients = workflow.recipients.slice();
    recipients[index] = { ...recipient, ...patch };
    onWorkflowChange({ ...workflow, recipients, personalNotesSaved: false });
  };

  const insertDynamicField = (field: CampaignDynamicField) => {
    const separator = workflow.body.endsWith(' ') || !workflow.body ? '' : ' ';
    onWorkflowChange({ ...workflow, body: `${workflow.body}${separator}${field}` });
    if (field !== '{personal_note}') setFallbackField(field);
  };

  const saveFallback = () => {
    setFallbackField(null);
  };

  const savePersonalNotes = () => {
    const next = { ...workflow, personalNotesSaved: true };
    onWorkflowChange(next);
    void onSaveStep(next, 3);
  };

  const generateDraft = () => {
    void onGenerate();
  };

  const regenerateDraft = () => {
    modal.confirm({
      title: 'Replace current draft?',
      content: 'This will replace your current draft. Continue?',
      okText: 'Continue',
      onOk: () => void onGenerate(),
    });
  };

  const sendTestEmail = () => {
    if (!sendFrom) {
      message.warning('Connect your email before sending a test email.');
      return;
    }
    const subject = assembleCampaignBody(workflow.subject, selectedRecipient, {
      fieldFallbacks: workflow.fieldFallbacks,
    });
    const body = assembleCampaignBody(workflow.body, selectedRecipient, {
      fieldFallbacks: workflow.fieldFallbacks,
    });
    const params = new URLSearchParams({ subject, body });
    window.location.href = `mailto:${encodeURIComponent(sendFrom)}?${params.toString()}`;
  };

  const footerDisabled =
    (workflow.step === 1 && !workflow.clientId) ||
    (workflow.step === 2 && workflow.recipients.length < 1) ||
    (workflow.step === 3 && (!draftReady || missingFallbacks.length > 0 || personalNotesBlocked)) ||
    (workflow.step === 4 && !draftReady);

  const next = () => {
    if (workflow.step === 1) {
      const hiddenName = selectedClient ? `${selectedClient.name} campaign` : 'Campaign';
      void onSaveStep(
        {
          ...workflow,
          campaignName: workflow.campaignName || hiddenName,
        },
        2,
      );
      return;
    }
    if (workflow.step === 2) {
      void onSaveStep(workflow, 3);
      return;
    }
    if (workflow.step === 3) {
      void onSaveStep(workflow, 4);
      return;
    }
    if (workflow.step === 4) {
      void onSaveStep(workflow, 5);
    }
  };

  return (
    <div className="outreach-workflow outreach-campaign-wizard">
      <WorkflowHeader title="New Campaign" onCancel={onCancel} />
      <div className="outreach-flow-body">
        <WorkflowSteps
          steps={[
            ['Select client', ''],
            ['Add recipients', ''],
            ['Draft campaign', ''],
            ['Preview', ''],
            ['Confirm & send', ''],
          ]}
          current={workflow.step}
        />
        <main className="outreach-flow-panel">
          {workflow.step === 1 ? (
            <div className="outreach-flow-stack outreach-campaign-select-client">
              {clients.length ? (
                <>
                  <Typography.Title level={4}>
                    Which client is associated to this campaign?
                  </Typography.Title>
                  <Select
                    value={workflow.clientId ?? undefined}
                    showSearch={clients.length > 10}
                    optionFilterProp="label"
                    placeholder="Select a client..."
                    options={clients.map((client) => ({ value: client.id, label: client.name }))}
                    onChange={(clientId) =>
                      onWorkflowChange({
                        ...workflow,
                        clientId,
                        campaignName: '',
                        objective: '',
                        recipients: [],
                        subject: '',
                        body: '',
                        selectedPreviewIndex: 0,
                        fieldFallbacks: {},
                        personalNotesSaved: true,
                      })
                    }
                  />
                </>
              ) : (
                <Empty description="Add recipients before creating a campaign.">
                  <Button href="/clients">Go to Clients</Button>
                </Empty>
              )}
            </div>
          ) : null}

          {workflow.step === 2 ? (
            <div className="outreach-flow-stack">
              <section>
                <Typography.Title level={5}>Added recipients</Typography.Title>
                <div className="outreach-added-recipient-box">
                  <RecipientTags
                    recipients={workflow.recipients}
                    onRemove={removeSelectedRecipient}
                  />
                </div>
              </section>

              <section className="outreach-suggestion-panel">
                <Typography.Title level={5}>Suggested recipients</Typography.Title>
                <Typography.Text type="secondary">
                  Based on previous meeting invites and email threads for this client.
                </Typography.Text>
                <div className="outreach-suggested-scroll">
                  {contextLoading ? (
                    <Typography.Text type="secondary">
                      Loading suggested recipients...
                    </Typography.Text>
                  ) : contextSuggestions.length ? (
                    contextSuggestions.map((recipient) => (
                      <ContextSuggestionRow
                        key={recipientKey(recipient)}
                        recipient={recipient}
                        selected={workflow.recipients.some(
                          (row) => recipientKey(row) === recipientKey(recipient),
                        )}
                        onAdd={addRecipient}
                      />
                    ))
                  ) : (
                    <Empty description="No suggested recipients from synced email or meeting context yet." />
                  )}
                </div>
              </section>

              <section className="outreach-suggestion-panel">
                <Typography.Title level={5}>Search member directory</Typography.Title>
                <Typography.Text type="secondary">
                  Search and add congressional members and staffers. Filter by office.
                </Typography.Text>
                <div className="outreach-directory-search-trigger">
                  <Input
                    prefix={<SearchOutlined />}
                    readOnly
                    value={directoryQuery}
                    placeholder="Search members and staffers..."
                    onClick={() => setDirectoryOpen(true)}
                  />
                  <Button onClick={() => setDirectoryOpen(true)}>Filter by office</Button>
                </div>
              </section>

              <section>
                <Typography.Title level={5}>Add a recipient manually</Typography.Title>
                <Typography.Text type="secondary">
                  First name, last name, and email are all required.
                </Typography.Text>
                <div className="outreach-manual-email" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  <Input
                    style={{ flex: '1 1 130px' }}
                    value={manualFirst}
                    placeholder="First name"
                    onChange={(event) => setManualFirst(event.target.value)}
                    onPressEnter={addManualRecipient}
                  />
                  <Input
                    style={{ flex: '1 1 130px' }}
                    value={manualLast}
                    placeholder="Last name"
                    onChange={(event) => setManualLast(event.target.value)}
                    onPressEnter={addManualRecipient}
                  />
                  <Input
                    style={{ flex: '2 1 200px' }}
                    type="email"
                    value={manualEmail}
                    placeholder="Email address"
                    onChange={(event) => setManualEmail(event.target.value)}
                    onPressEnter={addManualRecipient}
                  />
                  <Button type="primary" disabled={!manualRecipientValid} onClick={addManualRecipient}>
                    Add
                  </Button>
                </div>
              </section>
            </div>
          ) : null}

          {workflow.step === 3 && !draftReady ? (
            <div className="outreach-flow-stack outreach-campaign-meri-prompt">
              <Typography.Title level={4}>Tell Meri what to write</Typography.Title>
              <Typography.Paragraph type="secondary">
                Describe your goal, the tone and voice of the email, or any other relevant details.
                Meri will use your client context and recipient data to generate a personalized
                draft.
              </Typography.Paragraph>
              <Input.TextArea
                rows={5}
                value={workflow.objective}
                placeholder='e.g. "Request a meeting to discuss FY27 NDAA Section 1294. Professional but warm tone. Reference the client&apos;s work in autonomous systems."'
                onChange={(event) =>
                  onWorkflowChange({ ...workflow, objective: event.target.value })
                }
              />
              <div className="outreach-template-buttons">
                {CAMPAIGN_TEMPLATE_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    disabled={option.disabled}
                    type={workflow.promptTemplate === option.value ? 'primary' : 'default'}
                    className="outreach-template-button"
                    onClick={() => onWorkflowChange({ ...workflow, promptTemplate: option.value })}
                  >
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </Button>
                ))}
              </div>
              <Button
                type="primary"
                icon={<RobotOutlined />}
                disabled={!aiConfigured || !workflow.record}
                loading={generating}
                onClick={generateDraft}
              >
                Generate draft
              </Button>
            </div>
          ) : null}

          {workflow.step === 3 && draftReady ? (
            <div className="outreach-flow-stack">
              <label>
                Subject line
                <Input
                  value={workflow.subject}
                  onChange={(event) =>
                    onWorkflowChange({ ...workflow, subject: event.target.value })
                  }
                />
              </label>
              <div className="outreach-editor">
                <div className="outreach-editor-heading">
                  <div>
                    <Typography.Text strong>Email body</Typography.Text>
                    <Typography.Text type="secondary">
                      Edit directly. Insert field chips to personalize per recipient.
                    </Typography.Text>
                  </div>
                  <Button
                    size="small"
                    icon={<RobotOutlined />}
                    disabled={!aiConfigured || !workflow.record}
                    loading={generating}
                    onClick={regenerateDraft}
                  >
                    Regenerate
                  </Button>
                </div>
                <FormattedTextArea
                  rows={12}
                  value={workflow.body}
                  chips={[]}
                  onChange={(body) => onWorkflowChange({ ...workflow, body })}
                />
                <div className="outreach-editor-footer-note">
                  Drafted from {selectedClient?.name ?? 'selected client'} -{' '}
                  {workflow.recipients.length} recipients
                </div>
              </div>

              <section className="outreach-dynamic-fields-panel">
                <Typography.Text strong>Dynamic fields</Typography.Text>
                <div>
                  {CAMPAIGN_DYNAMIC_FIELDS.map((field) => (
                    <Button key={field} onClick={() => insertDynamicField(field)}>
                      {field}
                    </Button>
                  ))}
                </div>
              </section>

              <section className="outreach-fallback-panel">
                <div>
                  <Typography.Text strong>Dynamic field fallbacks</Typography.Text>
                  <Typography.Text type="secondary">
                    Set the text that appears in place of a dynamic field when recipient data is not
                    available. Required for any recipient without directory data.
                  </Typography.Text>
                </div>
                {CAMPAIGN_DYNAMIC_FIELDS.filter((field) => field !== '{personal_note}').map(
                  (field) => (
                    <div className="outreach-fallback-row" key={field}>
                      <Tag>{field}</Tag>
                      <span>{'->'}</span>
                      <Input
                        value={workflow.fieldFallbacks[field] ?? ''}
                        placeholder={
                          field === '{district}'
                            ? 'your district'
                            : field === '{address}'
                              ? 'office address'
                              : 'e.g. your committee'
                        }
                        onChange={(event) =>
                          onWorkflowChange({
                            ...workflow,
                            fieldFallbacks: {
                              ...workflow.fieldFallbacks,
                              [field]: event.target.value,
                            },
                          })
                        }
                      />
                    </div>
                  ),
                )}
              </section>

              <CampaignExceptionsList rows={exceptionRows} />

              <section className="outreach-personal-note-panel">
                <div className="outreach-personal-note-head">
                  <Typography.Text strong>Personal notes</Typography.Text>
                  <Typography.Text type="secondary">
                    Add a unique note for each recipient. Notes are saved and woven into the email
                    at the position of {'{personal_note}'} in the body. All fields are optional.
                  </Typography.Text>
                </div>
                <div className="outreach-personal-note-table">
                  {workflow.recipients.map((recipient, index) => (
                    <div className="outreach-personal-note-row" key={recipientKey(recipient)}>
                      <span>
                        <strong>{recipient.name || recipient.email}</strong>
                        <small>
                          {recipient.committee || recipient.office || 'No directory data'}
                        </small>
                      </span>
                      <Input
                        value={recipient.personalNote}
                        placeholder="Add a personal note..."
                        onChange={(event) =>
                          updateRecipient(index, { personalNote: event.target.value })
                        }
                      />
                    </div>
                  ))}
                </div>
                <Button
                  type="primary"
                  disabled={!hasPersonalNotes}
                  loading={saving}
                  onClick={savePersonalNotes}
                >
                  Save personal notes
                </Button>
              </section>
            </div>
          ) : null}

          {workflow.step === 4 ? (
            <div className="outreach-flow-stack">
              <Typography.Text strong>
                Select a recipient to preview their version of the email. Preview updates live as
                you switch between recipients.
              </Typography.Text>
              <div className="outreach-preview-layout">
                <div className="outreach-preview-list">
                  <Typography.Text strong>Recipients</Typography.Text>
                  {workflow.recipients.map((recipient, index) => (
                    <button
                      key={recipientKey(recipient)}
                      type="button"
                      className={workflow.selectedPreviewIndex === index ? 'active' : ''}
                      onClick={() => onWorkflowChange({ ...workflow, selectedPreviewIndex: index })}
                    >
                      <span>{initials(recipient.name || recipient.email || '-')}</span>
                      <strong>{recipient.name || recipient.email}</strong>
                      <small>
                        {recipient.committee || recipient.office || 'No directory data'}
                      </small>
                    </button>
                  ))}
                </div>
                <EmailPreview
                  to={selectedRecipient?.email || selectedRecipient?.name || 'Recipient'}
                  subject={assembleCampaignBody(workflow.subject, selectedRecipient, {
                    fieldFallbacks: workflow.fieldFallbacks,
                  })}
                  body={assembleCampaignBody(workflow.body, selectedRecipient, {
                    fieldFallbacks: workflow.fieldFallbacks,
                  })}
                  actions={<Button onClick={sendTestEmail}>Send test email to myself</Button>}
                />
              </div>
            </div>
          ) : null}

          {workflow.step === 5 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Review before sending</Typography.Title>
              <section className="outreach-confirm-card">
                <div>
                  <strong>Client</strong>
                  <span>{selectedClient?.name ?? 'No client selected'}</span>
                </div>
                <div>
                  <strong>Recipients</strong>
                  <span className="outreach-confirm-tags">
                    {workflow.recipients.map((recipient) => (
                      <Tag key={recipientKey(recipient)}>{recipient.name || recipient.email}</Tag>
                    ))}
                  </span>
                </div>
                <div>
                  <strong>Subject</strong>
                  <span>{workflow.subject || 'No subject'}</span>
                </div>
                <div>
                  <strong>Exceptions</strong>
                  <span>{campaignExceptionsSummary(exceptionRows)}</span>
                </div>
              </section>
              {!emailConnected ? (
                <div className="outreach-send-warning">
                  Connect your email in Settings before sending campaigns from Capiro.
                </div>
              ) : null}
              {missingEmailRecipients.length ? (
                <div className="outreach-send-warning">
                  Every recipient must have an email address before sending. Missing:{' '}
                  {missingEmailRecipients
                    .map((recipient) => recipient.name || recipient.office || 'Unnamed recipient')
                    .join(', ')}
                </div>
              ) : null}
              <Button
                type="primary"
                size="large"
                className="outreach-confirm-send-button"
                loading={sending}
                disabled={!emailConnected || missingEmailRecipients.length > 0}
                onClick={onSend}
              >
                Send campaign
              </Button>
            </div>
          ) : null}
        </main>
      </div>

      <WorkflowFooter
        step={workflow.step}
        total={5}
        saving={saving}
        nextLabel="Continue"
        nextLoading={saving}
        nextDisabled={footerDisabled}
        hideNext={(workflow.step === 3 && !draftReady) || workflow.step === 5}
        onBack={() => onWorkflowChange({ ...workflow, step: Math.max(1, workflow.step - 1) })}
        onNext={next}
      />

      <Modal
        title="Search member directory"
        open={directoryOpen}
        footer={null}
        width={820}
        destroyOnClose
        maskClosable
        onCancel={() => setDirectoryOpen(false)}
      >
        <div className="outreach-directory-modal">
          <div className="outreach-directory-modal-tools">
            <Input
              prefix={<SearchOutlined />}
              value={directoryQuery}
              placeholder="Search members and staffers..."
              autoFocus
              onChange={(event) => onDirectoryQuery(event.target.value)}
            />
            <Select
              value={officeFilter}
              options={[
                { value: 'all', label: 'All offices' },
                ...officeOptions.map((office) => ({ value: office, label: office })),
              ]}
              onChange={setOfficeFilter}
            />
          </div>
          <div className="outreach-recipient-results">
            {directoryLoading ? (
              <Typography.Text type="secondary">Loading Directory...</Typography.Text>
            ) : filteredDirectoryRows.length ? (
              <>
                {directoryQuery.trim().length < 2 ? (
                  <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                    Showing the directory A–Z. Search by name, office, or committee to narrow,
                    then add a member or any of their staffers.
                  </Typography.Text>
                ) : null}
                {filteredDirectoryRows.map((entry) => (
                  <DirectoryRecipientRow
                    key={entry.id}
                    entry={entry}
                    recipients={workflow.recipients}
                    onAdd={(recipient) => addRecipient(recipient)}
                  />
                ))}
              </>
            ) : directoryTotal === 0 ? (
              <Empty description="No contacts in your Directory yet. Add members and staffers in the Directory section.">
                <Button href="/directory">Go to Directory</Button>
              </Empty>
            ) : (
              <Empty description="No Directory contacts matched that search." />
            )}
          </div>
        </div>
      </Modal>

      <Modal
        title={fallbackField ? `Set fallback for ${fallbackField}` : 'Set fallback'}
        open={Boolean(fallbackField)}
        okText="Save fallback"
        onOk={saveFallback}
        onCancel={() => setFallbackField(null)}
      >
        {fallbackField ? (
          <label className="outreach-flow-stack">
            Fallback text
            <Input
              value={selectedFallbackValue}
              placeholder={fallbackField === '{district}' ? 'your district' : 'e.g. your committee'}
              onChange={(event) =>
                onWorkflowChange({
                  ...workflow,
                  fieldFallbacks: {
                    ...workflow.fieldFallbacks,
                    [fallbackField]: event.target.value,
                  },
                })
              }
            />
          </label>
        ) : null}
      </Modal>
    </div>
  );
}

function PortfolioCampaignWorkflow({
  clients,
  workflow,
  suggestedRows,
  suggestionsLoading,
  directoryRows,
  directoryLoading,
  directoryQuery,
  directoryTotal,
  emailConnected,
  sendFrom,
  aiConfigured,
  saving,
  generating,
  sending,
  onDirectoryQuery,
  onWorkflowChange,
  onCancel,
  onSaveStep,
  onGenerate,
  onSend,
  onReturnToLanding,
}: {
  clients: Client[];
  workflow: OutreachWorkflowState;
  suggestedRows: DirectoryEntry[];
  suggestionsLoading: boolean;
  directoryRows: DirectoryEntry[];
  directoryLoading: boolean;
  directoryQuery: string;
  directoryTotal: number | null;
  emailConnected: boolean;
  sendFrom: string | null;
  aiConfigured: boolean;
  saving: boolean;
  generating: boolean;
  sending: boolean;
  onDirectoryQuery: (value: string) => void;
  onWorkflowChange: (value: OutreachWorkflowState) => void;
  onCancel: () => void;
  onSaveStep: (patch: Partial<OutreachWorkflowState>, step?: number) => Promise<void>;
  onGenerate: () => void;
  onSend: () => void;
  onReturnToLanding: () => void;
}) {
  const { modal } = App.useApp();
  const selectedClient = clients.find((client) => client.id === workflow.clientId) ?? null;
  const selectedRecipient = workflow.recipients[workflow.selectedPreviewIndex] ?? null;
  const hasDraft = Boolean(workflow.subject.trim() || workflow.body.trim());
  const missingEmailRecipients = workflow.recipients.filter((recipient) => !recipient.email);
  const directoryEmpty = directoryTotal === 0;

  const updateRecipient = (index: number, patch: Partial<OutreachRecipient>) => {
    const recipients = workflow.recipients.slice();
    const recipient = recipients[index];
    if (!recipient) return;
    recipients[index] = { ...recipient, ...patch };
    onWorkflowChange({ ...workflow, recipients });
  };

  const handleGenerate = () => {
    if (!hasDraft) {
      onGenerate();
      return;
    }
    modal.confirm({
      title: 'Replace current draft?',
      content: 'This will replace your current draft. Continue?',
      okText: 'Continue',
      onOk: onGenerate,
    });
  };

  const setSuggestionSelected = (entry: DirectoryEntry, checked: boolean) => {
    const recipient = directoryRecipientFromEntry(
      entry,
      campaignRelevanceReason(entry, workflow.objective, selectedClient),
    );
    onWorkflowChange({
      ...workflow,
      recipients: checked
        ? addUniqueRecipient(workflow.recipients, recipient)
        : removeRecipient(workflow.recipients, recipient),
    });
  };

  return (
    <div className="outreach-workflow">
      <WorkflowHeader title="New Campaign" onCancel={onCancel} />
      <div className="outreach-flow-body">
        <WorkflowSteps
          steps={[
            ['Setup', 'Client and objective'],
            ['Recipients', 'Suggestions and search'],
            ['Draft', "Edit Meri's draft"],
            ['Preview & send', 'Final review'],
            ['Confirmation', 'Sent campaign'],
          ]}
          current={workflow.step}
        />
        <main className="outreach-flow-panel">
          {workflow.step === 1 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Setup</Typography.Title>
              {clients.length ? (
                <>
                  <label>
                    Client
                    <Select
                      value={workflow.clientId ?? undefined}
                      showSearch={clients.length > 10}
                      optionFilterProp="label"
                      placeholder="Select a client"
                      options={clients.map((client) => ({ value: client.id, label: client.name }))}
                      onChange={(clientId) =>
                        onWorkflowChange({
                          ...workflow,
                          clientId,
                          campaignName:
                            workflow.campaignName ||
                            `${clients.find((client) => client.id === clientId)?.name} outreach`,
                        })
                      }
                    />
                    <Typography.Text type="secondary">
                      This campaign is being sent with or on behalf of the client.
                    </Typography.Text>
                  </label>
                  <label>
                    Campaign name
                    <Input
                      value={workflow.campaignName}
                      placeholder="Campaign name"
                      onChange={(event) =>
                        onWorkflowChange({ ...workflow, campaignName: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Objective
                    <Input.TextArea
                      rows={5}
                      value={workflow.objective}
                      placeholder="What do you want recipients to do or know?"
                      onChange={(event) =>
                        onWorkflowChange({ ...workflow, objective: event.target.value })
                      }
                    />
                  </label>
                </>
              ) : (
                <Empty description="Add recipients before creating a campaign.">
                  <Button href="/clients">Go to Clients</Button>
                </Empty>
              )}
            </div>
          ) : null}

          {workflow.step === 2 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Who are you reaching out to?</Typography.Title>
              <div className="outreach-context-note">
                <RobotOutlined />
                <span>
                  Meri suggests Directory contacts by comparing the client portfolio and objective
                  to member offices, committees, caucuses, focus areas, and staff context.
                </span>
              </div>
              {directoryEmpty ? (
                <Empty description="No contacts in your Directory yet. Add members and staffers in the Directory section.">
                  <Button href="/directory">Go to Directory</Button>
                </Empty>
              ) : (
                <>
                  <section className="outreach-suggestion-panel">
                    <Typography.Text strong>Meri suggestions</Typography.Text>
                    {suggestionsLoading ? (
                      <Typography.Text type="secondary">
                        Finding relevant contacts...
                      </Typography.Text>
                    ) : suggestedRows.length ? (
                      <div className="outreach-recipient-results">
                        {suggestedRows.map((entry) => (
                          <CampaignSuggestionRow
                            key={entry.id}
                            entry={entry}
                            relevanceReason={campaignRelevanceReason(
                              entry,
                              workflow.objective,
                              selectedClient,
                            )}
                            selected={workflow.recipients.some(
                              (recipient) => recipient.directoryContactId === entry.id,
                            )}
                            onToggle={(checked) => setSuggestionSelected(entry, checked)}
                          />
                        ))}
                      </div>
                    ) : (
                      <Empty description="No suggestions yet. Try a broader objective or search the Directory manually." />
                    )}
                  </section>

                  <section className="outreach-suggestion-panel">
                    <Typography.Text strong>Search Directory</Typography.Text>
                    <Input
                      prefix={<SearchOutlined />}
                      value={directoryQuery}
                      placeholder="Search Directory"
                      onChange={(event) => onDirectoryQuery(event.target.value)}
                    />
                    <div className="outreach-recipient-results">
                      {directoryQuery.trim().length < 2 ? (
                        <Typography.Text type="secondary">
                          Search members and staffers by name, office, or committee.
                        </Typography.Text>
                      ) : directoryLoading ? (
                        <Typography.Text type="secondary">Searching Directory...</Typography.Text>
                      ) : directoryRows.length ? (
                        directoryRows.map((entry) => (
                          <DirectoryRecipientRow
                            key={entry.id}
                            entry={entry}
                            recipients={workflow.recipients}
                            onAdd={(recipient) =>
                              onWorkflowChange({
                                ...workflow,
                                recipients: addUniqueRecipient(workflow.recipients, recipient),
                              })
                            }
                          />
                        ))
                      ) : (
                        <Empty description="No Directory contacts matched that search." />
                      )}
                    </div>
                  </section>
                </>
              )}

              <SelectedRecipientNotesPanel
                recipients={workflow.recipients}
                onRemove={(recipient) =>
                  onWorkflowChange({
                    ...workflow,
                    recipients: removeRecipient(workflow.recipients, recipient),
                  })
                }
              />
            </div>
          ) : null}

          {workflow.step === 3 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Review and edit Meri's draft</Typography.Title>
              <div className="outreach-context-note">
                <RobotOutlined />
                <span>
                  {readString(workflow.record?.metadata?.clioContextNote) ||
                    `Meri drafts from the client portfolio, objective, and auto-personalization fields for ${workflow.recipients.length} selected recipients.`}
                </span>
              </div>
              <label>
                Subject line
                <Input
                  value={workflow.subject}
                  placeholder="Generate a subject line with Meri, then edit as needed."
                  onChange={(event) =>
                    onWorkflowChange({ ...workflow, subject: event.target.value })
                  }
                />
              </label>
              <div className="outreach-editor">
                <FormattedTextArea
                  rows={14}
                  value={workflow.body}
                  placeholder={
                    aiConfigured
                      ? 'Generate a Meri draft, then edit the email here.'
                      : 'AI drafting is not configured. Set an OpenAI or Anthropic key to generate drafts.'
                  }
                  chips={['{committee}', '{personal_note}', '{address}']}
                  chipDescriptions={{
                    '{committee}': 'Committee assignment from the member profile.',
                    '{personal_note}': 'Optional note from this campaign workflow.',
                    '{address}': 'Main office full address from the member profile.',
                  }}
                  chipHelp="Dynamic fields resolve per recipient during preview and send."
                  actions={
                    <Button
                      size="small"
                      icon={<RobotOutlined />}
                      disabled={!aiConfigured || !workflow.record}
                      loading={generating}
                      onClick={handleGenerate}
                    >
                      {hasDraft ? 'Regenerate' : 'Generate'}
                    </Button>
                  }
                  onChange={(body) => onWorkflowChange({ ...workflow, body })}
                />
              </div>
              <PersonalNotePrompts
                client={selectedClient}
                objective={workflow.objective}
                recipients={workflow.recipients}
                onChange={updateRecipient}
              />
            </div>
          ) : null}

          {workflow.step === 4 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Review each email before sending</Typography.Title>
              <div className="outreach-preview-layout">
                <div className="outreach-preview-list">
                  {workflow.recipients.map((recipient, index) => (
                    <button
                      key={recipientKey(recipient)}
                      type="button"
                      className={workflow.selectedPreviewIndex === index ? 'active' : ''}
                      onClick={() => onWorkflowChange({ ...workflow, selectedPreviewIndex: index })}
                    >
                      {recipient.name || recipient.email}
                    </button>
                  ))}
                </div>
                <EmailPreview
                  to={selectedRecipient?.email || selectedRecipient?.name || 'Recipient'}
                  from={sendFrom ?? 'Connected email'}
                  subject={assembleCampaignBody(workflow.subject, selectedRecipient)}
                  body={assembleCampaignBody(workflow.body, selectedRecipient)}
                />
              </div>
              <div className="outreach-send-controls">
                <Typography.Text strong>Schedule</Typography.Text>
                <Segmented
                  value={workflow.sendTiming}
                  options={[
                    { label: 'Send now', value: 'now' },
                    { label: 'Schedule for later', value: 'later' },
                  ]}
                  onChange={(value) =>
                    onWorkflowChange({
                      ...workflow,
                      sendTiming: value as OutreachWorkflowState['sendTiming'],
                    })
                  }
                />
                {workflow.sendTiming === 'later' ? (
                  <Input
                    type="datetime-local"
                    value={workflow.scheduledFor}
                    onChange={(event) =>
                      onWorkflowChange({ ...workflow, scheduledFor: event.target.value })
                    }
                  />
                ) : null}
              </div>
              {!emailConnected ? (
                <div className="outreach-send-warning">
                  Connect your email in Settings before sending campaigns from Capiro.
                </div>
              ) : null}
              {missingEmailRecipients.length ? (
                <div className="outreach-send-warning">
                  Every recipient must have an email address before sending. Missing:{' '}
                  {missingEmailRecipients
                    .map((recipient) => recipient.name || recipient.office || 'Unnamed recipient')
                    .join(', ')}
                </div>
              ) : null}
            </div>
          ) : null}

          {workflow.step === 5 ? (
            <div className="outreach-flow-stack outreach-campaign-confirmation">
              <CheckOutlined />
              <Typography.Title level={4}>Campaign sent</Typography.Title>
              <Typography.Paragraph type="secondary">
                Sent to {workflow.sentRecipientCount || workflow.recipients.length} recipients. Open
                rate and reply tracking are active in the sent list.
              </Typography.Paragraph>
              <Button type="primary" onClick={onReturnToLanding}>
                Return to Outreach
              </Button>
            </div>
          ) : null}
        </main>
      </div>
      {workflow.step < 5 ? (
        <WorkflowFooter
          step={workflow.step}
          total={5}
          saving={saving}
          nextLabel={workflow.step === 4 ? 'Send campaign' : 'Continue'}
          nextLoading={sending}
          nextDisabled={
            (workflow.step === 1 &&
              (!workflow.clientId ||
                !workflow.campaignName.trim() ||
                !workflow.objective.trim())) ||
            (workflow.step === 2 && workflow.recipients.length < 1) ||
            (workflow.step === 3 && (!workflow.subject.trim() || !workflow.body.trim())) ||
            (workflow.step === 4 &&
              (!emailConnected ||
                missingEmailRecipients.length > 0 ||
                (workflow.sendTiming === 'later' && !workflow.scheduledFor)))
          }
          onBack={() => onWorkflowChange({ ...workflow, step: Math.max(1, workflow.step - 1) })}
          onNext={() => {
            if (workflow.step === 4) {
              onSend();
              return;
            }
            void onSaveStep(workflow, workflow.step + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function LegacyCampaignWorkflow({
  clients,
  workflow,
  directoryRows,
  directoryLoading,
  directoryQuery,
  pastMeetings,
  pastMeetingsLoading,
  aiConfigured,
  saving,
  generating,
  sending,
  onDirectoryQuery,
  onWorkflowChange,
  onCancel,
  onSaveStep,
  onGenerate,
  onSend,
}: {
  clients: Client[];
  workflow: OutreachWorkflowState;
  directoryRows: DirectoryEntry[];
  directoryLoading: boolean;
  directoryQuery: string;
  pastMeetings: OutreachMeeting[];
  pastMeetingsLoading: boolean;
  aiConfigured: boolean;
  saving: boolean;
  generating: boolean;
  sending: boolean;
  onDirectoryQuery: (value: string) => void;
  onWorkflowChange: (value: OutreachWorkflowState) => void;
  onCancel: () => void;
  onSaveStep: (patch: Partial<OutreachWorkflowState>, step?: number) => Promise<void>;
  onGenerate: () => void;
  onSend: () => void;
}) {
  const selectedClient = clients.find((client) => client.id === workflow.clientId) ?? null;
  const selectedRecipient = workflow.recipients[workflow.selectedPreviewIndex] ?? null;
  const filteredPastMeetings = useMemo(
    () =>
      pastMeetings.filter(
        (meeting) =>
          new Date(meeting.endsAt).getTime() <= Date.now() &&
          (!workflow.clientId || meeting.clientId === workflow.clientId),
      ),
    [pastMeetings, workflow.clientId],
  );
  const selectedPastMeeting =
    filteredPastMeetings.find((meeting) => meeting.id === workflow.meetingId) ?? null;
  const recipientTab = workflow.campaignRecipientTab;
  const clientsAvailableAsRecipients = useMemo(
    () =>
      clients.filter(
        (client) => client.primaryContactEmail || client.primaryContactName || client.name,
      ),
    [clients],
  );

  return (
    <div className="outreach-workflow">
      <WorkflowHeader title="New Campaign" onCancel={onCancel} />
      <div className="outreach-flow-body">
        <WorkflowSteps
          steps={[
            ['Setup', 'Client and objective'],
            ['Recipients', 'Directory targets'],
            ['Draft', 'Edit body, place {personal_note}'],
            ['Personal notes', 'Optional per recipient'],
            ['Preview & send', 'Final review'],
          ]}
          current={workflow.step}
        />
        <main className="outreach-flow-panel">
          {workflow.step === 1 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Campaign setup</Typography.Title>
              {clients.length ? (
                <>
                  <label>
                    Client
                    <Select
                      value={workflow.clientId ?? undefined}
                      showSearch={clients.length > 10}
                      optionFilterProp="label"
                      options={clients.map((client) => ({ value: client.id, label: client.name }))}
                      onChange={(clientId) =>
                        onWorkflowChange({
                          ...workflow,
                          clientId,
                          meetingId: null,
                          campaignName:
                            workflow.campaignName ||
                            `${clients.find((client) => client.id === clientId)?.name} outreach`,
                        })
                      }
                    />
                  </label>
                  <label>
                    Campaign name
                    <Input
                      value={workflow.campaignName}
                      onChange={(event) =>
                        onWorkflowChange({ ...workflow, campaignName: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Objective
                    <Input.TextArea
                      rows={5}
                      value={workflow.objective}
                      placeholder="What do you want recipients to do or know?"
                      onChange={(event) =>
                        onWorkflowChange({ ...workflow, objective: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Reference a past meeting (optional)
                    <Select
                      allowClear
                      value={workflow.meetingId ?? undefined}
                      placeholder={
                        pastMeetingsLoading
                          ? 'Loading meetings...'
                          : filteredPastMeetings.length
                            ? 'Pick a past meeting to ground the draft'
                            : 'No past meetings available for this client'
                      }
                      disabled={!filteredPastMeetings.length && !pastMeetingsLoading}
                      loading={pastMeetingsLoading}
                      showSearch
                      optionFilterProp="label"
                      options={filteredPastMeetings.map((meeting) => ({
                        value: meeting.id,
                        label: `${meeting.subject} - ${formatOptionalDate(meeting.startsAt)}${meeting.client?.name ? ` | ${meeting.client.name}` : ''}`,
                      }))}
                      onChange={(meetingId) =>
                        onWorkflowChange({
                          ...workflow,
                          meetingId: meetingId ?? null,
                        })
                      }
                    />
                  </label>
                  {selectedPastMeeting ? (
                    <div className="outreach-context-note">
                      <RobotOutlined />
                      <span>
                        Meri will draft using saved notes and debriefs from "
                        {selectedPastMeeting.subject}" alongside the campaign objective.
                      </span>
                    </div>
                  ) : null}
                </>
              ) : (
                <Empty description="Add a client before creating a campaign.">
                  <Button href="/clients">Go to Clients</Button>
                </Empty>
              )}
            </div>
          ) : null}

          {workflow.step === 2 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Who are you reaching out to?</Typography.Title>
              <Segmented
                value={recipientTab}
                onChange={(value) =>
                  onWorkflowChange({
                    ...workflow,
                    campaignRecipientTab: value as CampaignRecipientTab,
                  })
                }
                options={[
                  { label: 'Directory (members & staff)', value: 'directory' },
                  { label: 'Clients', value: 'clients' },
                ]}
              />
              {recipientTab === 'directory' ? (
                <>
                  <div className="outreach-context-note">
                    <RobotOutlined />
                    <span>
                      Directory suggestions below are searched from the live Directory using this
                      campaign objective and any query you type.
                    </span>
                  </div>
                  <Input
                    prefix={<SearchOutlined />}
                    value={directoryQuery}
                    placeholder="Search Directory"
                    onChange={(event) => onDirectoryQuery(event.target.value)}
                  />
                  <div className="outreach-recipient-results">
                    {directoryLoading ? (
                      <Typography.Text type="secondary">Searching Directory...</Typography.Text>
                    ) : directoryRows.length ? (
                      directoryRows.map((entry) => (
                        <DirectoryRecipientRow
                          key={entry.id}
                          entry={entry}
                          recipients={workflow.recipients}
                          onAdd={(recipient) =>
                            onWorkflowChange({
                              ...workflow,
                              recipients: addUniqueRecipient(workflow.recipients, recipient),
                            })
                          }
                        />
                      ))
                    ) : (
                      <Empty description="Search the Directory to add members or staffers." />
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="outreach-context-note">
                    <RobotOutlined />
                    <span>
                      Add clients from your roster as recipients. Their primary contact is used when
                      available.
                    </span>
                  </div>
                  <div className="outreach-recipient-results">
                    {clientsAvailableAsRecipients.length ? (
                      clientsAvailableAsRecipients.map((client) => (
                        <ClientRecipientRow
                          key={client.id}
                          client={client}
                          selected={workflow.recipients.some(
                            (recipient) => recipientKey(recipient) === clientRecipientKey(client),
                          )}
                          onAdd={(recipient) =>
                            onWorkflowChange({
                              ...workflow,
                              recipients: addUniqueRecipient(workflow.recipients, recipient),
                            })
                          }
                        />
                      ))
                    ) : (
                      <Empty description="No clients available. Add clients in the Clients tab to use them here." />
                    )}
                  </div>
                </>
              )}
              <RecipientTags
                recipients={workflow.recipients}
                onRemove={(recipient) =>
                  onWorkflowChange({
                    ...workflow,
                    recipients: removeRecipient(workflow.recipients, recipient),
                  })
                }
              />
            </div>
          ) : null}

          {workflow.step === 3 ? (
            <DraftStep
              heading="Review and edit Meri's draft"
              contextNote={`Drafting from ${selectedClient?.name ?? 'selected client'} context, objective${selectedPastMeeting ? `, past meeting "${selectedPastMeeting.subject}"` : ''}, and ${workflow.recipients.length} selected recipients.`}
              aiConfigured={aiConfigured}
              generating={generating}
              subject={workflow.subject}
              body={workflow.body}
              promptTemplate={workflow.promptTemplate}
              onPromptTemplate={(promptTemplate) =>
                onWorkflowChange({ ...workflow, promptTemplate })
              }
              onGenerate={onGenerate}
              onSubject={(subject) => onWorkflowChange({ ...workflow, subject })}
              onBody={(body) => onWorkflowChange({ ...workflow, body })}
            />
          ) : null}

          {workflow.step === 4 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Add a personal note per recipient</Typography.Title>
              <Typography.Paragraph type="secondary">
                Optional. Meri will weave your note into the position you set in the draft.
              </Typography.Paragraph>
              <div className="outreach-notes-table">
                <div className="outreach-notes-head">
                  <span>Recipient</span>
                  <span>Auto-personalized preview</span>
                  <span>Personal note (optional)</span>
                </div>
                {workflow.recipients.map((recipient, index) => (
                  <div className="outreach-notes-row" key={recipientKey(recipient)}>
                    <div>
                      <strong>{recipient.name}</strong>
                      <span>{recipient.office || recipient.email}</span>
                    </div>
                    <span>{personalizedPreview(recipient)}</span>
                    <Input
                      value={recipient.personalNote}
                      placeholder="Add a personal note..."
                      onChange={(event) => {
                        const recipients = workflow.recipients.slice();
                        recipients[index] = { ...recipient, personalNote: event.target.value };
                        onWorkflowChange({ ...workflow, recipients });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {workflow.step === 5 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Review each email before sending</Typography.Title>
              <div className="outreach-preview-layout">
                <div className="outreach-preview-list">
                  {workflow.recipients.map((recipient, index) => (
                    <button
                      key={recipientKey(recipient)}
                      type="button"
                      className={workflow.selectedPreviewIndex === index ? 'active' : ''}
                      onClick={() => onWorkflowChange({ ...workflow, selectedPreviewIndex: index })}
                    >
                      {recipient.name || recipient.email}
                    </button>
                  ))}
                </div>
                <EmailPreview
                  to={selectedRecipient?.email || selectedRecipient?.name || 'Recipient'}
                  subject={workflow.subject}
                  body={assembleCampaignBody(workflow.body, selectedRecipient)}
                />
              </div>
              <div className="outreach-send-warning">
                Campaigns send from Capiro using your connected email. Every recipient must have an
                email address.
              </div>
            </div>
          ) : null}
        </main>
      </div>
      <WorkflowFooter
        step={workflow.step}
        total={5}
        saving={saving}
        nextLabel={workflow.step === 5 ? 'Send campaign' : 'Continue'}
        nextLoading={sending}
        nextDisabled={
          (workflow.step === 1 &&
            (!workflow.clientId || !workflow.campaignName.trim() || !workflow.objective.trim())) ||
          (workflow.step === 2 && workflow.recipients.length < 1) ||
          (workflow.step === 3 && (!workflow.subject.trim() || !workflow.body.trim()))
        }
        onBack={() => onWorkflowChange({ ...workflow, step: Math.max(1, workflow.step - 1) })}
        onNext={() => {
          if (workflow.step === 5) {
            onSend();
            return;
          }
          const nextStep = workflow.step + 1;
          void onSaveStep(workflow, nextStep);
        }}
      />
    </div>
  );
}

function OutboundCampaignWorkflow({
  clients,
  workflow,
  contacts,
  contactsLoading,
  templates,
  templatesLoading,
  directoryRows,
  directoryLoading,
  directoryQuery,
  emailConnected,
  saving,
  savingTemplate,
  generating,
  sending,
  onDirectoryQuery,
  onWorkflowChange,
  onCancel,
  onSaveStep,
  onSaveTemplate,
  onGenerate,
  onSend,
}: {
  clients: Client[];
  workflow: OutreachWorkflowState;
  contacts: OutboundContactRecord[];
  contactsLoading: boolean;
  templates: OutreachTemplate[];
  templatesLoading: boolean;
  directoryRows: DirectoryEntry[];
  directoryLoading: boolean;
  directoryQuery: string;
  emailConnected: boolean;
  saving: boolean;
  savingTemplate: boolean;
  generating: boolean;
  sending: boolean;
  onDirectoryQuery: (value: string) => void;
  onWorkflowChange: (value: OutreachWorkflowState) => void;
  onCancel: () => void;
  onSaveStep: (patch: Partial<OutreachWorkflowState>, step?: number) => Promise<void>;
  onSaveTemplate: (payload: {
    name: string;
    subject?: string | null;
    body: string;
  }) => Promise<OutreachTemplate>;
  onGenerate: () => Promise<void>;
  onSend: () => void;
}) {
  const emailContacts = contacts.filter((contact) => contact.attendeeEmail);
  const selectedRecipient = workflow.recipients[workflow.selectedPreviewIndex] ?? null;
  const recipientTab = workflow.campaignRecipientTab;
  const clientsAvailableAsRecipients = clients.filter(
    (client) => client.primaryContactEmail || client.primaryContactName || client.name,
  );
  const templateOptions = templates.map(templateOptionFromRecord);
  const generatedContextNote = readString(workflow.record?.metadata?.clioContextNote);
  const hasGeneratedDraft = Boolean(workflow.record?.metadata?.ai && workflow.body.trim());
  const emailContactIds = new Set(emailContacts.map((contact) => contact.id));
  const selectedEmailContactCount = emailContacts.filter((contact) =>
    workflow.selectedContactIds.includes(contact.id),
  ).length;

  // ---- Attachments (files sent with every email on send) ----
  // Files can be uploaded from the user's computer or picked from the client's
  // stored documents. Both resolve to EngagementAttachment ids persisted on
  // metadata.attachmentIds; the backend attaches them to each sent email.
  const api = useApi();
  const { message: attachMessage } = App.useApp();
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const docsQuery = useQuery<Array<{ id: string; fileName: string; contentType: string | null }>>({
    enabled: workflow.step === 4 && Boolean(workflow.clientId),
    queryKey: ['outbound-attachments', workflow.clientId],
    queryFn: async () =>
      (
        await api.get<Array<{ id: string; fileName: string; contentType: string | null }>>(
          '/api/engagement/attachments',
          { params: { clientId: workflow.clientId } },
        )
      ).data,
    retry: false,
  });
  const storedDocs = docsQuery.data ?? [];
  // Attached ids that aren't in the stored-docs list (e.g. just-uploaded files
  // before the query refetches, or docs from another scope) still need a label.
  const docNameById = new Map(storedDocs.map((d) => [d.id, d.fileName]));

  const persistAttachmentIds = (ids: string[]) => {
    onWorkflowChange({ ...workflow, attachmentIds: ids });
    // Persist to the record's metadata so send-campaign can read the ids.
    if (workflow.record) void onSaveStep({ attachmentIds: ids }, workflow.step);
  };

  const toggleAttachment = (id: string) => {
    const ids = workflow.attachmentIds.includes(id)
      ? workflow.attachmentIds.filter((a) => a !== id)
      : [...workflow.attachmentIds, id];
    persistAttachmentIds(ids);
  };

  const uploadAttachment = async (file: File) => {
    if (!workflow.clientId) {
      attachMessage.error('Select a client before uploading attachments');
      return;
    }
    setUploadingAttachment(true);
    try {
      const contentType = file.type || 'application/octet-stream';
      const { data: presigned } = await api.post<{
        url: string;
        fields: Record<string, string>;
        s3Key: string;
      }>('/api/engagement/attachments/upload-url', {
        clientId: workflow.clientId,
        fileName: file.name,
        contentType,
        contentLength: file.size,
      });
      const form = new FormData();
      Object.entries(presigned.fields).forEach(([k, v]) => form.append(k, v));
      form.append('file', file); // file must be last for the S3 POST policy
      const s3Res = await fetch(presigned.url, { method: 'POST', body: form });
      if (!s3Res.ok) throw new Error(`S3 upload failed (${s3Res.status})`);
      const { data: created } = await api.post<{ id: string }>(
        '/api/engagement/attachments/confirm',
        { clientId: workflow.clientId, fileName: file.name, contentType, s3Key: presigned.s3Key },
      );
      persistAttachmentIds(Array.from(new Set([...workflow.attachmentIds, created.id])));
      await docsQuery.refetch();
      attachMessage.success(`Attached ${file.name}`);
    } catch (err) {
      attachMessage.error(errorMessage(err) || 'Could not upload attachment');
    } finally {
      setUploadingAttachment(false);
    }
  };

  const selectAllEmailContacts = () => {
    const recipients = emailContacts.reduce(
      (rows, contact) => addUniqueRecipient(rows, outboundRecipientFromContact(contact)),
      workflow.recipients,
    );
    onWorkflowChange({
      ...workflow,
      selectedContactIds: [
        ...new Set([...workflow.selectedContactIds, ...emailContacts.map((contact) => contact.id)]),
      ],
      recipients,
    });
  };

  const clearEmailContacts = () => {
    const contactRecipientKeys = new Set(
      emailContacts.map((contact) => recipientKey(outboundRecipientFromContact(contact))),
    );
    onWorkflowChange({
      ...workflow,
      selectedContactIds: workflow.selectedContactIds.filter((id) => !emailContactIds.has(id)),
      recipients: workflow.recipients.filter(
        (recipient) => !contactRecipientKeys.has(recipientKey(recipient)),
      ),
    });
  };

  useEffect(() => {
    if (workflow.step !== 3 || workflow.templateId || workflow.body.trim() || !templates.length) {
      return;
    }
    const template = templates[0];
    if (!template) return;
    onWorkflowChange({
      ...workflow,
      templateId: template.id,
      subject: workflow.subject || template.subject || '',
      body: template.body,
    });
  }, [onWorkflowChange, templates, workflow]);

  return (
    <div className="outreach-workflow">
      <WorkflowHeader title="Outbound Campaign" onCancel={onCancel} />
      <div className="outreach-flow-body">
        <WorkflowSteps
          current={workflow.step}
          steps={[
            ['Contact data', 'Last 7 days'],
            ['Recipients', 'Meeting attendees + added contacts'],
            ['Template', 'Saved or custom'],
            ['Review & send', 'Final review'],
          ]}
        />
        <main className="outreach-flow-panel">
          {workflow.step === 1 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Contact Data Loaded</Typography.Title>
              <Typography.Paragraph type="secondary">
                Synced meeting attendees from the last 7 days. Expand a contact to inspect the prep,
                debrief, and directory location context.
              </Typography.Paragraph>
              {contactsLoading ? (
                <Empty description="Loading synced meeting contacts..." />
              ) : contacts.length ? (
                <div className="outbound-contact-list">
                  {contacts.map((contact) => (
                    <OutboundContactCard key={contact.id} contact={contact} />
                  ))}
                </div>
              ) : (
                <Empty description="No synced meetings with attendees were found in the last 7 days." />
              )}
            </div>
          ) : null}

          {workflow.step === 2 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Configure Recipients</Typography.Title>
              <Typography.Paragraph type="secondary">
                Choose attendees from the preloaded meeting list, then add congressional Directory
                contacts or client contacts if needed.
              </Typography.Paragraph>
              <div className="outbound-recipient-actions">
                <Typography.Text type="secondary">
                  {selectedEmailContactCount} of {emailContacts.length} meeting attendees selected
                </Typography.Text>
                <Space>
                  <Button
                    size="small"
                    disabled={
                      !emailContacts.length || selectedEmailContactCount === emailContacts.length
                    }
                    onClick={selectAllEmailContacts}
                  >
                    Select all
                  </Button>
                  <Button
                    size="small"
                    disabled={!selectedEmailContactCount}
                    onClick={clearEmailContacts}
                  >
                    Unselect all
                  </Button>
                </Space>
              </div>
              <div className="outbound-recipient-source">
                {contacts.length ? (
                  contacts.map((contact) => {
                    const selected = workflow.selectedContactIds.includes(contact.id);
                    return (
                      <label key={contact.id} className={!contact.attendeeEmail ? 'disabled' : ''}>
                        <Checkbox
                          disabled={!contact.attendeeEmail}
                          checked={selected}
                          onChange={(event) => {
                            const recipient = outboundRecipientFromContact(contact);
                            const selectedContactIds = event.target.checked
                              ? [...new Set([...workflow.selectedContactIds, contact.id])]
                              : workflow.selectedContactIds.filter((id) => id !== contact.id);
                            onWorkflowChange({
                              ...workflow,
                              selectedContactIds,
                              recipients: event.target.checked
                                ? addUniqueRecipient(workflow.recipients, recipient)
                                : removeRecipient(workflow.recipients, recipient),
                            });
                          }}
                        />
                        <span>
                          <strong>{contact.attendeeName || contact.attendeeEmail}</strong>
                          <small>
                            {[contact.attendeeEmail, contact.meetingSubject, contact.clientName]
                              .filter(Boolean)
                              .join(' | ')}
                          </small>
                        </span>
                      </label>
                    );
                  })
                ) : (
                  <Empty description="No attendee contacts are available from synced meetings." />
                )}
              </div>

              <Segmented
                value={recipientTab}
                onChange={(value) =>
                  onWorkflowChange({
                    ...workflow,
                    campaignRecipientTab: value as CampaignRecipientTab,
                  })
                }
                options={[
                  { label: 'Directory', value: 'directory' },
                  { label: 'Clients', value: 'clients' },
                ]}
              />
              {recipientTab === 'directory' ? (
                <>
                  <Input
                    prefix={<SearchOutlined />}
                    value={directoryQuery}
                    placeholder="Search Directory"
                    onChange={(event) => onDirectoryQuery(event.target.value)}
                  />
                  <div className="outreach-recipient-results">
                    {directoryLoading ? (
                      <Typography.Text type="secondary">Searching Directory...</Typography.Text>
                    ) : directoryRows.length ? (
                      directoryRows.map((entry) => (
                        <DirectoryRecipientRow
                          key={entry.id}
                          entry={entry}
                          recipients={workflow.recipients}
                          onAdd={(recipient) =>
                            onWorkflowChange({
                              ...workflow,
                              recipients: addUniqueRecipient(workflow.recipients, recipient),
                            })
                          }
                        />
                      ))
                    ) : (
                      <Empty description="Search the Directory to add members or staffers." />
                    )}
                  </div>
                </>
              ) : (
                <div className="outreach-recipient-results">
                  {clientsAvailableAsRecipients.length ? (
                    clientsAvailableAsRecipients.map((client) => (
                      <ClientRecipientRow
                        key={client.id}
                        client={client}
                        selected={workflow.recipients.some(
                          (recipient) => recipientKey(recipient) === clientRecipientKey(client),
                        )}
                        onAdd={(recipient) =>
                          onWorkflowChange({
                            ...workflow,
                            recipients: addUniqueRecipient(workflow.recipients, recipient),
                          })
                        }
                      />
                    ))
                  ) : (
                    <Empty description="No client contacts are available." />
                  )}
                </div>
              )}

              <RecipientTags
                recipients={workflow.recipients}
                onRemove={(recipient) =>
                  onWorkflowChange({
                    ...workflow,
                    recipients: removeRecipient(workflow.recipients, recipient),
                    selectedContactIds: workflow.selectedContactIds.filter((id) => {
                      const contact = contacts.find((row) => row.id === id);
                      return contact
                        ? recipientKey(outboundRecipientFromContact(contact)) !==
                            recipientKey(recipient)
                        : true;
                    }),
                  })
                }
              />
            </div>
          ) : null}

          {workflow.step === 3 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Build Email Template</Typography.Title>
              <Typography.Paragraph type="secondary">
                Select a saved template or create a custom template. Custom templates are visible
                only to your user account.
              </Typography.Paragraph>
              <div className="outbound-template-strip" aria-label="Template options">
                {templatesLoading && !templateOptions.length ? (
                  <Typography.Text type="secondary">Loading templates...</Typography.Text>
                ) : null}
                {templateOptions.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={
                      workflow.templateMode === 'existing' && workflow.templateId === template.id
                        ? 'selected'
                        : ''
                    }
                    onClick={() =>
                      onWorkflowChange({
                        ...workflow,
                        templateMode: 'existing',
                        templateId: template.id,
                        subject: template.subject,
                        body: template.body,
                      })
                    }
                  >
                    <strong>{template.name}</strong>
                    <span>{template.description}</span>
                    {template.source === 'user' ? <em>Mine</em> : null}
                  </button>
                ))}
                <button
                  type="button"
                  className={workflow.templateMode === 'custom' ? 'selected' : ''}
                  onClick={() =>
                    onWorkflowChange({
                      ...workflow,
                      templateMode: 'custom',
                      templateId: null,
                    })
                  }
                >
                  <strong>Custom Template</strong>
                  <span>
                    Start from your own structure and save it for future outbound campaigns.
                  </span>
                  <em>Custom</em>
                </button>
              </div>
              {workflow.templateMode === 'custom' ? (
                <>
                  <label>
                    Template name
                    <Input
                      value={workflow.customTemplateName}
                      onChange={(event) =>
                        onWorkflowChange({ ...workflow, customTemplateName: event.target.value })
                      }
                    />
                  </label>
                  <Button
                    disabled={!workflow.customTemplateName.trim() || !workflow.body.trim()}
                    loading={savingTemplate}
                    onClick={() =>
                      void onSaveTemplate({
                        name: workflow.customTemplateName,
                        subject: workflow.subject || null,
                        body: workflow.body,
                      })
                    }
                  >
                    Save Template
                  </Button>
                </>
              ) : null}

              <label>
                Tone
                <Select
                  value={workflow.outboundTone}
                  options={OUTBOUND_TONES}
                  onChange={(outboundTone) =>
                    onWorkflowChange({
                      ...workflow,
                      outboundTone,
                    })
                  }
                />
              </label>

              <label>
                Subject line
                <Input
                  value={workflow.subject}
                  onChange={(event) =>
                    onWorkflowChange({ ...workflow, subject: event.target.value })
                  }
                />
              </label>
              <div className="outreach-context-note outbound-generate-note">
                <RobotOutlined />
                <span>
                  Meri will use the selected template, tone, recipient list, and each recipient's
                  loaded meeting context. Missing facts are omitted rather than invented.
                </span>
                <Button
                  icon={<RobotOutlined />}
                  disabled={workflow.recipients.filter((recipient) => recipient.email).length < 1}
                  loading={generating}
                  onClick={() => void onGenerate()}
                >
                  Generate
                </Button>
              </div>
              <div className="outreach-editor">
                <div className="outreach-editor-heading">
                  <div>
                    <Typography.Text strong>
                      {hasGeneratedDraft ? 'Generated Draft' : 'Template Body'}
                    </Typography.Text>
                    {generatedContextNote ? (
                      <Typography.Text type="secondary">{generatedContextNote}</Typography.Text>
                    ) : null}
                  </div>
                </div>
                <FormattedTextArea
                  rows={16}
                  value={workflow.body}
                  placeholder="Write the outbound campaign template. Use variables for meeting context; leave unknown details out."
                  chips={OUTBOUND_VARIABLES}
                  chipDescriptions={OUTBOUND_VARIABLE_DESCRIPTIONS}
                  chipHelp="Variables insert the right meeting details for each recipient during preview and send."
                  toolbarClassName="outbound-variable-toolbar"
                  onChange={(body) => onWorkflowChange({ ...workflow, body })}
                />
              </div>
            </div>
          ) : null}

          {workflow.step === 4 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>Review and Send</Typography.Title>
              <div className="outreach-preview-layout">
                <div className="outreach-preview-list">
                  {workflow.recipients.map((recipient, index) => (
                    <button
                      key={recipientKey(recipient)}
                      type="button"
                      className={workflow.selectedPreviewIndex === index ? 'active' : ''}
                      onClick={() => onWorkflowChange({ ...workflow, selectedPreviewIndex: index })}
                    >
                      {recipient.name || recipient.email}
                    </button>
                  ))}
                </div>
                <EmailPreview
                  to={selectedRecipient?.email || selectedRecipient?.name || 'Recipient'}
                  subject={assembleCampaignBody(
                    workflow.subject,
                    selectedRecipient,
                    workflow.record?.metadata,
                  )}
                  body={assembleCampaignBody(
                    workflow.body,
                    selectedRecipient,
                    workflow.record?.metadata,
                  )}
                />
              </div>
              <div className="outbound-attachments" style={{ marginTop: 16 }}>
                <Typography.Text strong>Attachments</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ margin: '2px 0 8px' }}>
                  Files added here are attached to every email on send (max 3MB each).
                </Typography.Paragraph>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {storedDocs.map((doc) => (
                    <Checkbox
                      key={doc.id}
                      checked={workflow.attachmentIds.includes(doc.id)}
                      onChange={() => toggleAttachment(doc.id)}
                    >
                      {doc.fileName}
                    </Checkbox>
                  ))}
                  {/* Attached ids not present in the stored-docs list (freshly
                      uploaded before refetch) still render as checked rows. */}
                  {workflow.attachmentIds
                    .filter((id) => !docNameById.has(id))
                    .map((id) => (
                      <Checkbox key={id} checked onChange={() => toggleAttachment(id)}>
                        {`Attached file (${id.slice(0, 8)}…)`}
                      </Checkbox>
                    ))}
                  {!workflow.clientId ? (
                    <Typography.Text type="secondary">
                      Select a client to attach files.
                    </Typography.Text>
                  ) : storedDocs.length === 0 && workflow.attachmentIds.length === 0 ? (
                    <Typography.Text type="secondary">
                      No files attached yet. Upload one from your computer below.
                    </Typography.Text>
                  ) : null}
                  <Upload
                    multiple
                    showUploadList={false}
                    disabled={!workflow.clientId || uploadingAttachment}
                    beforeUpload={(file) => {
                      void uploadAttachment(file as File);
                      return false; // handle the upload ourselves; skip AntD default
                    }}
                  >
                    <Button
                      size="small"
                      icon={<PaperClipOutlined />}
                      loading={uploadingAttachment}
                      disabled={!workflow.clientId}
                    >
                      Upload a file
                    </Button>
                  </Upload>
                </Space>
              </div>
              {!emailConnected ? (
                <div className="outreach-send-warning">
                  Connect your email in Settings before sending campaigns from Capiro.
                </div>
              ) : null}
            </div>
          ) : null}
        </main>
      </div>
      <WorkflowFooter
        step={workflow.step}
        total={4}
        saving={saving}
        nextLabel={workflow.step === 4 ? 'Send campaign' : 'Continue'}
        nextLoading={sending}
        nextDisabled={
          (workflow.step === 1 && (contactsLoading || emailContacts.length < 1)) ||
          (workflow.step === 2 &&
            workflow.recipients.filter((recipient) => recipient.email).length < 1) ||
          (workflow.step === 3 && (!workflow.subject.trim() || !workflow.body.trim())) ||
          (workflow.step === 4 && (!emailConnected || !workflow.record))
        }
        onBack={() => onWorkflowChange({ ...workflow, step: Math.max(1, workflow.step - 1) })}
        onNext={() => {
          if (workflow.step === 4) {
            onSend();
            return;
          }
          if (workflow.step === 1) {
            const recipients = emailContacts.map(outboundRecipientFromContact);
            void onSaveStep(
              {
                recipients,
                selectedContactIds: emailContacts.map((contact) => contact.id),
              },
              2,
            );
            return;
          }
          void onSaveStep(workflow, workflow.step + 1);
        }}
      />
    </div>
  );
}

function FollowUpWorkflow(
  props: SharedWorkflowProps & { meetings: OutreachMeeting[]; loading: boolean },
) {
  return (
    <SmallGroupWorkflow
      {...props}
      type="follow_up"
      title="Meeting Follow-up"
      total={4}
      meetings={props.meetings}
      loading={props.loading}
      selectHeading="Which meeting is this follow-up for?"
      recipientsHeading={(meeting) =>
        `${meeting.subject} - ${formatOptionalDate(meeting.startsAt)}`
      }
      draftHeading="Review Meri's follow-up draft"
      readyHeading="Your draft is ready"
      noMeetingsText="No past meetings found. Meetings appear here after they have taken place."
      meetingFilter={(meeting) => new Date(meeting.endsAt).getTime() <= Date.now()}
      meetingDisabled={() => false}
      disabledReason={() => null}
      prepopulateRecipients={meetingRecipients}
    />
  );
}

function PrepDistributionWorkflow(
  props: SharedWorkflowProps & { meetings: OutreachMeeting[]; loading: boolean },
) {
  return (
    <SmallGroupWorkflow
      {...props}
      type="prep"
      title="Prep Distribution"
      total={4}
      meetings={props.meetings}
      loading={props.loading}
      selectHeading="Which meeting are you sharing prep for?"
      recipientsHeading={() => 'Who are you sharing prep with?'}
      draftHeading="Review Meri's prep summary"
      readyHeading="Your draft is ready"
      noMeetingsText="No upcoming meetings have prep ready yet. Complete prep notes in the Meetings tab first."
      meetingFilter={(meeting) => new Date(meeting.startsAt).getTime() >= Date.now()}
      meetingDisabled={(meeting) => meeting.preps[0]?.status !== 'approved'}
      disabledReason={() => 'Prep not ready'}
      prepopulateRecipients={() => []}
    />
  );
}

interface SharedWorkflowProps {
  workflow: OutreachWorkflowState;
  emailConnected: boolean;
  aiConfigured: boolean;
  saving: boolean;
  generating: boolean;
  opening: boolean;
  onWorkflowChange: (value: OutreachWorkflowState) => void;
  onCancel: () => void;
  onSaveStep: (patch: Partial<OutreachWorkflowState>, step?: number) => Promise<void>;
  onGenerate: () => void;
  onOpenEmail: () => void;
}

function SmallGroupWorkflow({
  type,
  title,
  total,
  meetings,
  loading,
  workflow,
  emailConnected,
  aiConfigured,
  saving,
  generating,
  opening,
  selectHeading,
  recipientsHeading,
  draftHeading,
  readyHeading,
  noMeetingsText,
  meetingFilter,
  meetingDisabled,
  disabledReason,
  prepopulateRecipients,
  onWorkflowChange,
  onCancel,
  onSaveStep,
  onGenerate,
  onOpenEmail,
}: SharedWorkflowProps & {
  type: WorkflowType;
  title: string;
  total: number;
  meetings: OutreachMeeting[];
  loading: boolean;
  selectHeading: string;
  recipientsHeading: (meeting: OutreachMeeting) => string;
  draftHeading: string;
  readyHeading: string;
  noMeetingsText: string;
  meetingFilter: (meeting: OutreachMeeting) => boolean;
  meetingDisabled: (meeting: OutreachMeeting) => boolean;
  disabledReason: (meeting: OutreachMeeting) => string | null;
  prepopulateRecipients: (meeting: OutreachMeeting) => OutreachRecipient[];
}) {
  const visibleMeetings = meetings.filter(meetingFilter);
  const selectedMeeting = visibleMeetings.find((meeting) => meeting.id === workflow.meetingId);

  return (
    <div className="outreach-workflow">
      <WorkflowHeader title={title} onCancel={onCancel} />
      <div className="outreach-flow-body">
        <WorkflowSteps
          current={workflow.step}
          steps={
            type === 'follow_up'
              ? [
                  ['Select meeting', 'Past meetings'],
                  ['Recipients', 'Auto-populated from meeting'],
                  ['Review draft', "Edit Meri's draft"],
                  ['Open in email', 'Pre-filled, send from your inbox'],
                ]
              : [
                  ['Select meeting', 'Upcoming meetings only'],
                  ['Recipients', 'Colleagues or client'],
                  ['Review draft', "Edit Meri's prep summary"],
                  ['Open in email', 'Pre-filled, send from your inbox'],
                ]
          }
        />
        <main className="outreach-flow-panel">
          {workflow.step === 1 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>{selectHeading}</Typography.Title>
              <div className="outreach-meeting-picker">
                {loading ? (
                  <Typography.Text type="secondary">Loading meetings...</Typography.Text>
                ) : visibleMeetings.length ? (
                  visibleMeetings.map((meeting) => {
                    const disabled = meetingDisabled(meeting);
                    return (
                      <button
                        key={meeting.id}
                        type="button"
                        disabled={disabled}
                        className={workflow.meetingId === meeting.id ? 'selected' : ''}
                        onClick={() => {
                          const recipients = prepopulateRecipients(meeting);
                          void onSaveStep(
                            {
                              meetingId: meeting.id,
                              clientId: meeting.clientId,
                              recipients,
                              campaignName: meeting.subject,
                              subject: workflow.subject,
                              body: workflow.body,
                            },
                            2,
                          );
                        }}
                      >
                        <span />
                        <strong>{meeting.subject}</strong>
                        <small>
                          {[
                            formatDateTime(meeting.startsAt),
                            meeting.location,
                            meeting.client?.name,
                          ]
                            .filter(Boolean)
                            .join(' | ')}
                          {disabled ? ` | ${disabledReason(meeting)}` : ''}
                        </small>
                      </button>
                    );
                  })
                ) : (
                  <Empty description={noMeetingsText} />
                )}
              </div>
            </div>
          ) : null}

          {workflow.step === 2 && selectedMeeting ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>{recipientsHeading(selectedMeeting)}</Typography.Title>
              {type === 'follow_up' ? (
                <Typography.Paragraph type="secondary">
                  Recipients are pre-populated from the meeting record. Add or remove as needed.
                </Typography.Paragraph>
              ) : null}
              <RecipientEditor workflow={workflow} onWorkflowChange={onWorkflowChange} />
              <div className="outreach-context-note">
                <RobotOutlined />
                <span>
                  Meri will draft from saved prep or debrief notes, client profile, participant
                  profiles, and linked meeting context available to this tenant.
                </span>
              </div>
            </div>
          ) : null}

          {workflow.step === 3 ? (
            <DraftStep
              heading={draftHeading}
              contextNote="Drafting from the selected meeting, saved notes, client context, and participant profiles."
              aiConfigured={aiConfigured}
              generating={generating}
              subject={workflow.subject}
              body={workflow.body}
              onGenerate={onGenerate}
              onSubject={(subject) => onWorkflowChange({ ...workflow, subject })}
              onBody={(body) => onWorkflowChange({ ...workflow, body })}
            />
          ) : null}

          {workflow.step === 4 ? (
            <div className="outreach-flow-stack">
              <Typography.Title level={4}>{readyHeading}</Typography.Title>
              <EmailPreview
                to={workflow.recipients
                  .map((recipient) => recipient.email || recipient.name)
                  .join(', ')}
                subject={workflow.subject}
                body={workflow.body}
              />
              {!emailConnected ? (
                <div className="outreach-send-warning">
                  Connect your email in Settings to use this feature.
                </div>
              ) : null}
            </div>
          ) : null}
        </main>
      </div>
      <WorkflowFooter
        step={workflow.step}
        total={total}
        saving={saving}
        nextLabel={
          workflow.step === total
            ? 'Open in connected email'
            : workflow.step === 2
              ? 'Review draft'
              : 'Continue'
        }
        nextLoading={opening}
        nextDisabled={
          (workflow.step === 1 && !workflow.meetingId) ||
          (workflow.step === 2 && workflow.recipients.length < 1) ||
          (workflow.step === 3 && (!workflow.subject.trim() || !workflow.body.trim())) ||
          (workflow.step === 4 && !emailConnected)
        }
        onBack={() => onWorkflowChange({ ...workflow, step: Math.max(1, workflow.step - 1) })}
        onNext={() => {
          if (workflow.step === total) {
            onOpenEmail();
            return;
          }
          void onSaveStep(workflow, workflow.step + 1);
        }}
      />
    </div>
  );
}

function RecipientEditor({
  workflow,
  onWorkflowChange,
}: {
  workflow: OutreachWorkflowState;
  onWorkflowChange: (value: OutreachWorkflowState) => void;
}) {
  return (
    <div className="outreach-recipient-editor">
      <RecipientTags
        recipients={workflow.recipients}
        onRemove={(recipient) =>
          onWorkflowChange({
            ...workflow,
            recipients: removeRecipient(workflow.recipients, recipient),
          })
        }
      />
      <Space.Compact>
        <Input
          value={workflow.recipientInput}
          placeholder="Name <email@example.com>"
          onChange={(event) =>
            onWorkflowChange({ ...workflow, recipientInput: event.target.value })
          }
          onPressEnter={() => {
            const parsed = parseRecipient(workflow.recipientInput);
            if (!parsed) return;
            onWorkflowChange({
              ...workflow,
              recipients: addUniqueRecipient(workflow.recipients, parsed),
              recipientInput: '',
            });
          }}
        />
        <Button
          onClick={() => {
            const parsed = parseRecipient(workflow.recipientInput);
            if (!parsed) return;
            onWorkflowChange({
              ...workflow,
              recipients: addUniqueRecipient(workflow.recipients, parsed),
              recipientInput: '',
            });
          }}
        >
          Add recipient
        </Button>
      </Space.Compact>
    </div>
  );
}

function DraftStep({
  heading,
  contextNote,
  aiConfigured,
  generating,
  subject,
  body,
  promptTemplate,
  onPromptTemplate,
  onGenerate,
  onSubject,
  onBody,
}: {
  heading: string;
  contextNote: string;
  aiConfigured: boolean;
  generating: boolean;
  subject: string;
  body: string;
  promptTemplate?: PromptTemplate;
  onPromptTemplate?: (value: PromptTemplate) => void;
  onGenerate: () => void;
  onSubject: (value: string) => void;
  onBody: (value: string) => void;
}) {
  const activeTemplate = PROMPT_TEMPLATES.find((entry) => entry.value === promptTemplate);
  return (
    <div className="outreach-flow-stack">
      <Typography.Title level={4}>{heading}</Typography.Title>
      <div className="outreach-context-note">
        <RobotOutlined />
        <span>{contextNote}</span>
      </div>
      {onPromptTemplate ? (
        <label>
          Prompt template
          <Select
            value={promptTemplate ?? 'custom'}
            options={PROMPT_TEMPLATES.map((entry) => ({ value: entry.value, label: entry.label }))}
            onChange={(value) => onPromptTemplate(value as PromptTemplate)}
          />
          {activeTemplate ? (
            <Typography.Text type="secondary" style={{ marginTop: 4, display: 'block' }}>
              {activeTemplate.hint} Click "Regenerate" to draft using this template.
            </Typography.Text>
          ) : null}
        </label>
      ) : null}
      <label>
        Subject line
        <Input value={subject} onChange={(event) => onSubject(event.target.value)} />
      </label>
      <div className="outreach-editor">
        <FormattedTextArea
          rows={14}
          value={body}
          placeholder={
            aiConfigured
              ? 'Generate a Meri draft, then edit the email here.'
              : 'AI drafting is not configured. Set an OpenAI or Anthropic key to generate drafts.'
          }
          chips={['{district}', '{committee}', '{member_priority}', '{personal_note}']}
          actions={
            <Button
              size="small"
              icon={<RobotOutlined />}
              disabled={!aiConfigured}
              loading={generating}
              onClick={onGenerate}
            >
              Regenerate
            </Button>
          }
          onChange={onBody}
        />
      </div>
    </div>
  );
}

interface TextSelection {
  start: number;
  end: number;
}

interface TextEdit {
  value: string;
  selection: TextSelection;
}

function FormattedTextArea({
  value,
  rows,
  placeholder,
  chips = [],
  chipDescriptions,
  chipHelp,
  toolbarClassName,
  actions,
  onChange,
}: {
  value: string;
  rows: number;
  placeholder?: string;
  chips?: readonly string[];
  chipDescriptions?: Partial<Record<string, string>>;
  chipHelp?: string;
  toolbarClassName?: string;
  actions?: ReactNode;
  onChange: (value: string) => void;
}) {
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const [selection, setSelection] = useState<TextSelection>(() => ({
    start: value.length,
    end: value.length,
  }));

  const captureSelection = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    textAreaRef.current = target;
    setSelection({ start: target.selectionStart, end: target.selectionEnd });
  };

  const commitEdit = (edit: TextEdit) => {
    onChange(edit.value);
    setSelection(edit.selection);
    window.setTimeout(() => {
      const textArea = textAreaRef.current;
      if (!textArea) return;
      textArea.focus();
      textArea.setSelectionRange(edit.selection.start, edit.selection.end);
    }, 0);
  };

  return (
    <>
      <div className={['outreach-editor-toolbar', toolbarClassName].filter(Boolean).join(' ')}>
        <div className="outreach-editor-format-group" aria-label="Text formatting">
          <button
            type="button"
            className="outreach-editor-format-button"
            title="Bold"
            aria-label="Bold"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commitEdit(applyInlineFormat(value, selection, '**', '**', 'bold text'))}
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            className="outreach-editor-format-button"
            title="Italic"
            aria-label="Italic"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commitEdit(applyInlineFormat(value, selection, '*', '*', 'italic text'))}
          >
            <em>I</em>
          </button>
          <button
            type="button"
            className="outreach-editor-format-button"
            title="Bulleted list"
            aria-label="Bulleted list"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commitEdit(applyListFormat(value, selection, false))}
          >
            &bull;
          </button>
          <button
            type="button"
            className="outreach-editor-format-button"
            title="Numbered list"
            aria-label="Numbered list"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commitEdit(applyListFormat(value, selection, true))}
          >
            1.
          </button>
        </div>
        {chipHelp ? <span className="outreach-editor-chip-help">{chipHelp}</span> : null}
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            title={chipDescriptions?.[chip] ?? chip}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commitEdit(insertTextAtSelection(value, selection, chip))}
          >
            {chip}
          </button>
        ))}
        {actions}
      </div>
      <Input.TextArea
        rows={rows}
        value={value}
        placeholder={placeholder}
        onSelect={captureSelection}
        onClick={captureSelection}
        onKeyUp={captureSelection}
        onChange={(event) => {
          onChange(event.target.value);
          captureSelection(event);
        }}
      />
    </>
  );
}

function applyInlineFormat(
  value: string,
  selection: TextSelection,
  prefix: string,
  suffix: string,
  fallback: string,
): TextEdit {
  const range = normalizedSelection(value, selection);
  const selected = value.slice(range.start, range.end) || fallback;
  const nextValue = `${value.slice(0, range.start)}${prefix}${selected}${suffix}${value.slice(
    range.end,
  )}`;
  const nextStart = range.start + prefix.length;
  return {
    value: nextValue,
    selection: { start: nextStart, end: nextStart + selected.length },
  };
}

function applyListFormat(value: string, selection: TextSelection, ordered: boolean): TextEdit {
  const range = normalizedSelection(value, selection);
  const blockStart = value.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1;
  const nextBreak = value.indexOf('\n', range.end);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;
  const block = value.slice(blockStart, blockEnd);
  const formatted = block
    .split('\n')
    .map((line, index) => {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      const text = line.replace(/^\s*(?:[-*]\s+|\d+\.\s+)/, '');
      return `${indent}${ordered ? `${index + 1}. ` : '- '}${text}`;
    })
    .join('\n');
  return {
    value: `${value.slice(0, blockStart)}${formatted}${value.slice(blockEnd)}`,
    selection: { start: blockStart, end: blockStart + formatted.length },
  };
}

function insertTextAtSelection(
  value: string,
  selection: TextSelection,
  insertText: string,
): TextEdit {
  const range = normalizedSelection(value, selection);
  const nextValue = `${value.slice(0, range.start)}${insertText}${value.slice(range.end)}`;
  const nextEnd = range.start + insertText.length;
  return {
    value: nextValue,
    selection: { start: nextEnd, end: nextEnd },
  };
}

function normalizedSelection(value: string, selection: TextSelection): TextSelection {
  const start = Math.min(Math.max(0, selection.start), value.length);
  const end = Math.min(Math.max(0, selection.end), value.length);
  return start <= end ? { start, end } : { start: end, end: start };
}

function WorkflowHeader({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="outreach-workflow-head">
      <Typography.Title level={3}>{title}</Typography.Title>
      <Space>
        {children}
        <Button onClick={onCancel}>Cancel</Button>
      </Space>
    </div>
  );
}

function WorkflowSteps({ steps, current }: { steps: Array<[string, string]>; current: number }) {
  return (
    <aside className="outreach-steps">
      {steps.map(([title, description], index) => {
        const step = index + 1;
        return (
          <div
            className={step === current ? 'active' : step < current ? 'complete' : ''}
            key={title}
          >
            <span>{step < current ? <CheckOutlined /> : step}</span>
            <strong>{title}</strong>
            <small>{description}</small>
          </div>
        );
      })}
    </aside>
  );
}

function WorkflowFooter({
  step,
  total,
  saving,
  nextLabel,
  nextLoading,
  nextDisabled,
  hideNext,
  onBack,
  onNext,
}: {
  step: number;
  total: number;
  saving: boolean;
  nextLabel: string;
  nextLoading?: boolean;
  nextDisabled?: boolean;
  hideNext?: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="outreach-workflow-footer">
      <Button disabled={step === 1 || saving} onClick={onBack}>
        Back
      </Button>
      <span>
        Step {step} of {total}
      </span>
      <div className="outreach-progress">
        <i style={{ width: `${(step / total) * 100}%` }} />
      </div>
      {hideNext ? (
        <span />
      ) : (
        <Button
          type="primary"
          loading={saving || nextLoading}
          disabled={nextDisabled}
          onClick={onNext}
        >
          {nextLabel}
        </Button>
      )}
    </div>
  );
}

function ContextSuggestionRow({
  recipient,
  selected,
  onAdd,
}: {
  recipient: OutreachRecipient;
  selected: boolean;
  onAdd: (recipient: OutreachRecipient) => void;
}) {
  return (
    <button
      type="button"
      className="outreach-context-suggestion-row"
      disabled={selected}
      onClick={() => onAdd(recipient)}
    >
      <span>{initials(recipient.name || recipient.email || 'R')}</span>
      <div>
        <strong>{recipient.name || recipient.email}</strong>
        <small>{[recipient.office, recipient.title].filter(Boolean).join(' | ')}</small>
      </div>
      <em>
        {recipient.relevanceReason}
        {recipient.sourceLabel ? ` · Source: ${recipient.sourceLabel}` : ''}
      </em>
      <b className={`outreach-row-action${selected ? ' is-selected' : ''}`}>
        {selected ? 'Added' : 'Add'}
      </b>
    </button>
  );
}

interface CampaignExceptionRow {
  recipient: OutreachRecipient;
  field: CampaignDynamicField;
  fallback: string;
}

function CampaignExceptionsList({ rows }: { rows: CampaignExceptionRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="outreach-exceptions-panel">
      <div>
        <Typography.Text strong>Exceptions</Typography.Text>
        <Typography.Text type="secondary">
          Fallback text will be used for recipients missing directory data. Review fallback values
          before sending.
        </Typography.Text>
      </div>
      <div className="outreach-exceptions-table">
        <div>
          <strong>Recipient</strong>
          <strong>Dynamic field</strong>
          <strong>Fallback being used</strong>
        </div>
        {rows.map((row) => (
          <div key={`${recipientKey(row.recipient)}-${row.field}`}>
            <span>
              <strong>{row.recipient.name || row.recipient.email}</strong>
              <small>
                {row.recipient.directoryContactId ? 'Missing field data' : 'No directory data'}
              </small>
            </span>
            <span>{row.field}</span>
            <em>{row.fallback || 'Not set - add a fallback above'}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function CampaignSuggestionRow({
  entry,
  selected,
  relevanceReason,
  onToggle,
}: {
  entry: DirectoryEntry;
  selected: boolean;
  relevanceReason: string;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <div className="outreach-suggestion-row">
      <Checkbox checked={selected} onChange={(event) => onToggle(event.target.checked)} />
      <span>{initials(entry.memberName)}</span>
      <div>
        <strong>{entry.fullName}</strong>
        <small>{[entry.office, entry.committees[0]].filter(Boolean).join(' | ')}</small>
        <em>{relevanceReason}</em>
      </div>
    </div>
  );
}

function SelectedRecipientNotesPanel({
  recipients,
  onRemove,
}: {
  recipients: OutreachRecipient[];
  onRemove: (recipient: OutreachRecipient) => void;
}) {
  const { message } = App.useApp();
  const api = useApi();
  const queryClient = useQueryClient();
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  const createNote = useMutation({
    mutationFn: async ({ recipient, body }: { recipient: OutreachRecipient; body: string }) =>
      (
        await api.post<DirectoryContactNote>(
          `/api/directory/contacts/${encodeURIComponent(recipient.directoryContactId ?? '')}/notes`,
          {
            body,
            directoryContactName: recipient.directoryContactName || recipient.name,
          },
        )
      ).data,
    onSuccess: async (_note, variables) => {
      const key = recipientKey(variables.recipient);
      setNoteDrafts((current) => ({ ...current, [key]: '' }));
      await queryClient.invalidateQueries({
        queryKey: ['directory-contact-notes', variables.recipient.directoryContactId],
      });
      message.success('Directory note added.');
    },
    onError: (error) => {
      message.error((error as Error).message || 'Could not add note.');
    },
  });

  const directoryRecipients = recipients.filter((recipient) => recipient.directoryContactId);

  return (
    <section className="outreach-selected-recipients">
      <Typography.Text strong>Selected recipients</Typography.Text>
      <RecipientTags recipients={recipients} onRemove={onRemove} />
      {directoryRecipients.length ? (
        <div className="outreach-selected-note-list">
          {directoryRecipients.map((recipient) => {
            const key = recipientKey(recipient);
            const body = noteDrafts[key] ?? '';
            return (
              <div className="outreach-selected-note-row" key={key}>
                <div>
                  <Typography.Text strong>{recipient.name || recipient.email}</Typography.Text>
                  <Typography.Text type="secondary">
                    Notes added here are saved to the same Directory profile.
                  </Typography.Text>
                </div>
                <Input.TextArea
                  value={body}
                  placeholder="Add a tenant-visible note"
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  maxLength={4000}
                  onChange={(event) =>
                    setNoteDrafts((current) => ({ ...current, [key]: event.target.value }))
                  }
                />
                <Button
                  size="small"
                  disabled={!body.trim()}
                  loading={createNote.isPending && createNote.variables?.recipient === recipient}
                  onClick={() => createNote.mutate({ recipient, body: body.trim() })}
                >
                  Add Note
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function PersonalNotePrompts({
  client,
  objective,
  recipients,
  onChange,
}: {
  client: Client | null;
  objective: string;
  recipients: OutreachRecipient[];
  onChange: (index: number, patch: Partial<OutreachRecipient>) => void;
}) {
  if (!recipients.length) return null;
  return (
    <section className="outreach-personal-note-panel">
      <Typography.Text strong>Personal notes</Typography.Text>
      <Typography.Text type="secondary">
        Optional. These notes only personalize this campaign and are separate from Directory notes.
      </Typography.Text>
      <div className="outreach-personal-note-list">
        {recipients.map((recipient, index) => (
          <div className="outreach-personal-note-row" key={recipientKey(recipient)}>
            <span>{recipient.name || recipient.email}</span>
            <Input
              value={recipient.personalNote}
              placeholder="Add a personal note..."
              onChange={(event) => onChange(index, { personalNote: event.target.value })}
            />
            <Tooltip title="Suggest a note from this recipient context">
              <Button
                icon={<RobotOutlined />}
                aria-label={`Suggest a personal note for ${recipient.name || recipient.email}`}
                onClick={() =>
                  onChange(index, {
                    personalNote: suggestPersonalNote(recipient, objective, client),
                  })
                }
              />
            </Tooltip>
          </div>
        ))}
      </div>
    </section>
  );
}

function ClientRecipientRow({
  client,
  selected,
  onAdd,
}: {
  client: Client;
  selected: boolean;
  onAdd: (recipient: OutreachRecipient) => void;
}) {
  const recipient: OutreachRecipient = {
    name: client.primaryContactName || client.name,
    email: client.primaryContactEmail || undefined,
    title: client.primaryContactName ? `Primary contact - ${client.name}` : 'Client',
    relevanceReason: client.name,
  };
  const subtitle = [
    client.primaryContactEmail ?? 'No primary contact email on file',
    client.website,
  ]
    .filter(Boolean)
    .join(' | ');
  return (
    <button
      type="button"
      className="outreach-directory-row"
      onClick={() => onAdd(recipient)}
      disabled={!client.primaryContactEmail}
    >
      <span>{initials(client.name)}</span>
      <div>
        <strong>{recipient.name}</strong>
        <small>{subtitle}</small>
        <em>{client.name}</em>
      </div>
      <b className={`outreach-row-action${selected ? ' is-selected' : ''}`}>
        {selected ? 'Selected' : client.primaryContactEmail ? 'Add' : 'No email'}
      </b>
    </button>
  );
}

function OutboundContactCard({ contact }: { contact: OutboundContactRecord }) {
  return (
    <article className="outbound-contact-card">
      <header>
        <span>{initials(contact.attendeeName || contact.attendeeEmail || 'Contact')}</span>
        <div>
          <strong>{contact.attendeeName || contact.attendeeEmail || 'Unnamed attendee'}</strong>
          <small>{contact.attendeeEmail || 'No email on meeting attendee'}</small>
        </div>
      </header>
      <div className="outbound-contact-meta">
        <span>{contact.meetingSubject}</span>
        <span>{contact.clientName || 'No client linked'}</span>
      </div>
      <details>
        <summary>View full context</summary>
        <dl>
          <div>
            <dt>Title</dt>
            <dd>{contact.title || 'No title found'}</dd>
          </div>
          <div>
            <dt>Participants</dt>
            <dd>{contact.attendeeNames || 'No participants found'}</dd>
          </div>
          <div>
            <dt>Prep Summary</dt>
            <dd>{contact.prepSummary || 'No prep summary saved'}</dd>
          </div>
          <div>
            <dt>Debrief Summary</dt>
            <dd>{contact.debriefSummary || 'No debrief summary saved'}</dd>
          </div>
          <div>
            <dt>Meeting Location</dt>
            <dd>{contact.meetingLocation || 'No directory office address found'}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

function clientRecipientKey(client: Client): string {
  if (client.primaryContactEmail) return client.primaryContactEmail.toLowerCase();
  return (client.primaryContactName || client.name).toLowerCase();
}

function DirectoryRecipientRow({
  entry,
  recipients,
  onAdd,
}: {
  entry: DirectoryEntry;
  recipients: OutreachRecipient[];
  onAdd: (recipient: OutreachRecipient) => void;
}) {
  const memberRecipient = directoryRecipientFromEntry(entry);
  const isSelected = (candidate: OutreachRecipient) =>
    recipients.some(
      (recipient) =>
        (Boolean(candidate.directoryContactId) &&
          recipient.directoryContactId === candidate.directoryContactId) ||
        (Boolean(candidate.email) &&
          recipient.email?.toLowerCase() === candidate.email?.toLowerCase()),
    );

  return (
    <div className="outreach-directory-row-group">
      <button type="button" className="outreach-directory-row" onClick={() => onAdd(memberRecipient)}>
        <span>{initials(entry.memberName)}</span>
        <div>
          <strong>{entry.fullName}</strong>
          <small>{[entry.office, entry.committees[0]].filter(Boolean).join(' | ')}</small>
          <em>{memberRecipient.relevanceReason}</em>
        </div>
        <b className={`outreach-row-action${isSelected(memberRecipient) ? ' is-selected' : ''}`}>
          {isSelected(memberRecipient) ? 'Selected' : 'Add'}
        </b>
      </button>
      {entry.staff.length ? (
        <div className="outreach-directory-staff">
          {entry.staff.map((staffer) => {
            const stafferRecipient = directoryStafferRecipient(entry, staffer);
            return (
              <button
                type="button"
                key={staffer.id}
                className="outreach-directory-row outreach-directory-staff-row"
                onClick={() => onAdd(stafferRecipient)}
              >
                <span>{initials(staffer.fullName)}</span>
                <div>
                  <strong>{staffer.fullName}</strong>
                  <small>{[staffer.title, staffer.issueAreas[0]].filter(Boolean).join(' | ')}</small>
                </div>
                <b className={`outreach-row-action${isSelected(stafferRecipient) ? ' is-selected' : ''}`}>
                  {isSelected(stafferRecipient) ? 'Selected' : 'Add'}
                </b>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function RecipientTags({
  recipients,
  onRemove,
}: {
  recipients: OutreachRecipient[];
  onRemove: (recipient: OutreachRecipient) => void;
}) {
  return (
    <div className="outreach-recipient-tags">
      {recipients.length ? (
        recipients.map((recipient) => (
          <Tag key={recipientKey(recipient)} closable onClose={() => onRemove(recipient)}>
            {recipient.name || recipient.email}
          </Tag>
        ))
      ) : (
        <Typography.Text type="secondary">No recipients selected yet.</Typography.Text>
      )}
    </div>
  );
}

function EmailPreview({
  to,
  from,
  subject,
  body,
  actions,
}: {
  to: string;
  from?: string;
  subject: string;
  body: string;
  actions?: ReactNode;
}) {
  return (
    <div className="outreach-email-preview">
      <div>
        <strong>To</strong>
        <span>{to || 'Recipients'}</span>
      </div>
      {from ? (
        <div>
          <strong>From</strong>
          <span>{from}</span>
        </div>
      ) : null}
      <div>
        <strong>Subject</strong>
        <span>{subject || 'No subject'}</span>
      </div>
      <pre>{body || 'No body drafted yet.'}</pre>
      {actions ? <div className="outreach-email-preview-actions">{actions}</div> : null}
    </div>
  );
}

function OutreachRecordCard({
  record,
  deleting,
  onClick,
  onDelete,
  onRestore,
  restoring,
}: {
  record: OutreachRecord;
  deleting: boolean;
  onClick: (record: OutreachRecord) => void;
  onDelete: (record: OutreachRecord) => void;
  onRestore?: (record: OutreachRecord) => void;
  restoring?: boolean;
}) {
  const displayDate = outreachRecordDisplayDate(record);
  return (
    <article
      className="outreach-record-card"
      role="button"
      tabIndex={0}
      onClick={() => onClick(record)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onClick(record);
      }}
    >
      <Tag className={`outreach-record-type outreach-record-type--${recordTypeClass(record.type)}`}>
        {outreachRecordTypeLabel(record.type)}
      </Tag>
      <div>
        <strong>{record.subject || record.title}</strong>
        <span>
          {[
            record.client?.name,
            record.meeting?.subject,
            `${record.recipientCount} recipients`,
            formatOptionalDate(displayDate),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <em>{recordStats(record)}</em>
      </div>
      <aside>
        <span>{statusLabel(record)}</span>
        <time>{formatOptionalDate(displayDate)}</time>
        {onRestore ? (
          <Button
            size="small"
            type="text"
            icon={<UndoOutlined />}
            loading={restoring}
            aria-label={`Restore ${record.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onRestore(record);
            }}
          >
            Restore
          </Button>
        ) : (
          <Button
            danger
            size="small"
            type="text"
            icon={<DeleteOutlined />}
            loading={deleting}
            aria-label={`Delete ${record.title} from Capiro`}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(record);
            }}
          >
            Delete
          </Button>
        )}
      </aside>
    </article>
  );
}

function OutreachReadonly({
  record,
  deleting,
  onClose,
  onDelete,
}: {
  record: OutreachRecord;
  deleting: boolean;
  onClose: () => void;
  onDelete: (record: OutreachRecord) => void;
}) {
  return (
    <div className="outreach-workflow">
      <WorkflowHeader title={record.title} onCancel={onClose}>
        <Button
          danger
          icon={<DeleteOutlined />}
          loading={deleting}
          onClick={() => onDelete(record)}
        >
          Delete
        </Button>
      </WorkflowHeader>
      <div className="outreach-readonly">
        <Tag>{WORKFLOW_LABELS[record.type]}</Tag>
        <Typography.Text type="secondary">{recordStats(record)}</Typography.Text>
        <EmailPreview
          to={record.recipients.map((recipient) => recipient.email || recipient.name).join(', ')}
          subject={record.subject ?? ''}
          body={record.body ?? ''}
        />
      </div>
    </div>
  );
}

function workflowPayload(workflow: OutreachWorkflowState): Record<string, unknown> {
  const title =
    workflow.campaignName ||
    workflow.subject ||
    workflow.record?.title ||
    (workflow.meetingId ? 'Meeting outreach' : 'Outreach draft');
  return {
    title,
    clientId: workflow.clientId,
    meetingId: workflow.meetingId,
    subject: workflow.subject || null,
    body: workflow.body || null,
    recipients: workflow.recipients,
    lastStep: workflow.step,
    metadata: {
      campaignName: workflow.campaignName || null,
      objective: workflow.objective || null,
      selectedPreviewIndex: workflow.selectedPreviewIndex,
      promptTemplate: workflow.promptTemplate,
      campaignRecipientTab: workflow.campaignRecipientTab,
      selectedContactIds: workflow.selectedContactIds,
      templateId: workflow.templateId,
      templateMode: workflow.templateMode,
      customTemplateName: workflow.customTemplateName || null,
      outboundTone: workflow.outboundTone,
      sendTiming: workflow.sendTiming,
      scheduledFor: workflow.scheduledFor || null,
      fieldFallbacks: workflow.fieldFallbacks,
      personalNotesSaved: workflow.personalNotesSaved,
      attachmentIds: workflow.attachmentIds,
    },
  };
}

function hydrateWorkflowFromRecord(
  record: OutreachRecord,
  current: OutreachWorkflowState,
): OutreachWorkflowState {
  return {
    ...current,
    record,
    step: record.lastStep || current.step || 1,
    campaignName: readString(record.metadata?.campaignName) || record.title,
    objective: readString(record.metadata?.objective) || current.objective,
    clientId: record.clientId,
    meetingId: record.meetingId,
    recipients: normalizeRecipients(record.recipients),
    subject: record.subject ?? '',
    body: record.body ?? '',
    selectedPreviewIndex: Number(record.metadata?.selectedPreviewIndex ?? 0) || 0,
    promptTemplate: readPromptTemplate(record.metadata?.promptTemplate, current.promptTemplate),
    campaignRecipientTab: readRecipientTab(
      record.metadata?.campaignRecipientTab,
      current.campaignRecipientTab,
    ),
    selectedContactIds: readStringArray(record.metadata?.selectedContactIds),
    templateId: readString(record.metadata?.templateId) || null,
    templateMode:
      record.metadata?.templateMode === 'custom' || record.metadata?.templateMode === 'existing'
        ? record.metadata.templateMode
        : current.templateMode,
    customTemplateName:
      readString(record.metadata?.customTemplateName) || current.customTemplateName,
    outboundTone: readOutboundTone(record.metadata?.outboundTone, current.outboundTone),
    sendTiming:
      record.metadata?.sendTiming === 'later' || record.metadata?.sendTiming === 'now'
        ? record.metadata.sendTiming
        : current.sendTiming,
    scheduledFor: readString(record.metadata?.scheduledFor) || current.scheduledFor,
    sentRecipientCount:
      Number(record.stats?.recipientsSent ?? record.recipientCount ?? current.sentRecipientCount) ||
      current.sentRecipientCount,
    fieldFallbacks: readStringRecord(record.metadata?.fieldFallbacks),
    personalNotesSaved:
      typeof record.metadata?.personalNotesSaved === 'boolean'
        ? record.metadata.personalNotesSaved
        : current.personalNotesSaved,
    attachmentIds: readStringArray(record.metadata?.attachmentIds),
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, entryValue]) => [key, entryValue]),
  );
}

function templateOptionFromRecord(template: OutreachTemplate): TemplateOption {
  return {
    id: template.id,
    name: template.name,
    description:
      readString(template.metadata?.description) ||
      (template.source === 'user'
        ? 'Your saved outbound campaign template.'
        : 'Reusable outbound campaign template.'),
    source: template.source,
    subject: template.subject ?? '',
    body: template.body,
  };
}

function readPromptTemplate(value: unknown, fallback: PromptTemplate): PromptTemplate {
  return PROMPT_TEMPLATES.some((entry) => entry.value === value)
    ? (value as PromptTemplate)
    : fallback;
}

function readRecipientTab(value: unknown, fallback: CampaignRecipientTab): CampaignRecipientTab {
  return value === 'directory' || value === 'clients' ? value : fallback;
}

function readOutboundTone(
  value: unknown,
  fallback: OutreachWorkflowState['outboundTone'],
): OutreachWorkflowState['outboundTone'] {
  return OUTBOUND_TONES.some((entry) => entry.value === value)
    ? (value as OutreachWorkflowState['outboundTone'])
    : fallback;
}

function meetingRecipients(meeting: OutreachMeeting): OutreachRecipient[] {
  const rows: OutreachRecipient[] = [];
  if (meeting.organizerEmail || meeting.organizerName) {
    rows.push({
      name: meeting.organizerName ?? meeting.organizerEmail ?? undefined,
      email: meeting.organizerEmail ?? undefined,
      title: 'Organizer',
    });
  }
  for (const attendee of meeting.attendees) {
    rows.push({
      name: attendee.name ?? attendee.email ?? undefined,
      email: attendee.email ?? undefined,
      title: attendee.role ?? undefined,
    });
  }
  return normalizeRecipients(rows);
}

function outboundRecipientFromContact(contact: OutboundContactRecord): OutreachRecipient {
  return {
    name: textOrUndefined(contact.attendeeName || contact.attendeeEmail),
    email: textOrUndefined(contact.attendeeEmail),
    office: textOrUndefined(contact.office),
    title: textOrUndefined(contact.title),
    directoryContactId: textOrUndefined(contact.directoryContactId),
    directoryContactName: textOrUndefined(contact.directoryContactName),
    committee: textOrUndefined(contact.committee),
    relevanceReason: textOrUndefined(contact.relevanceReason),
    meetingId: contact.meetingId,
    meetingSubject: contact.meetingSubject,
    meetingDateTime: formatDateTime(contact.meetingDateTime),
    attendeeNames: textOrUndefined(contact.attendeeNames),
    attendeeEmails: textOrUndefined(contact.attendeeEmails),
    prepSummary: textOrUndefined(contact.prepSummary),
    debriefSummary: textOrUndefined(contact.debriefSummary),
    meetingLocation: textOrUndefined(contact.meetingLocation),
  };
}

function directoryRecipientFromEntry(
  entry: DirectoryEntry,
  relevanceReason = defaultDirectoryRelevanceReason(entry),
): OutreachRecipient {
  return {
    name: entry.fullName,
    email: textOrUndefined(entry.email),
    office: textOrUndefined(entry.office),
    title: textOrUndefined(entry.title),
    chamber: textOrUndefined(entry.chamber),
    state: textOrUndefined(entry.state),
    district: textOrUndefined(entry.district),
    party: textOrUndefined(entry.partyName),
    directoryContactId: entry.id,
    directoryContactName: entry.fullName,
    committee: textOrUndefined(entry.committees[0]),
    address: textOrUndefined(formatDirectoryMainAddress(entry)),
    relevanceReason,
  };
}

function directoryStafferRecipient(
  entry: DirectoryEntry,
  staffer: DirectoryEntry['staff'][number],
): OutreachRecipient {
  return {
    name: staffer.fullName,
    email: textOrUndefined(staffer.email),
    office: textOrUndefined(entry.office),
    title: textOrUndefined(staffer.title),
    chamber: textOrUndefined(entry.chamber),
    state: textOrUndefined(entry.state),
    district: textOrUndefined(entry.district),
    party: textOrUndefined(entry.partyName),
    directoryContactId: `${entry.id}:${staffer.id}`,
    directoryContactName: `${staffer.fullName} (${entry.memberName})`,
    committee: textOrUndefined(entry.committees[0]),
    relevanceReason: `Staffer to ${entry.fullName}${staffer.title ? `, ${staffer.title}` : ''}`,
  };
}

function addUniqueRecipient(recipients: OutreachRecipient[], recipient: OutreachRecipient) {
  const key = recipientKey(recipient);
  if (recipients.some((row) => recipientKey(row) === key)) return recipients;
  return [...recipients, recipient];
}

function removeRecipient(recipients: OutreachRecipient[], recipient: OutreachRecipient) {
  const key = recipientKey(recipient);
  return recipients.filter((row) => recipientKey(row) !== key);
}

function normalizeRecipients(value: unknown): OutreachRecipient[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (entry && typeof entry === 'object' ? (entry as OutreachRecipient) : null))
        .filter((entry): entry is OutreachRecipient => Boolean(entry?.name || entry?.email))
    : [];
}

function textOrUndefined(value?: string | null): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function outboundGenerationBrief(): string {
  return [
    'Generate a personalized outbound campaign email from the loaded Capiro meeting context.',
    'Start with a letterhead-style block using current date/time, participant names, and location.',
    'Use attendee names, attendee emails, prep summary, debrief summary, meeting location, meeting subject, and meeting date/time when available.',
    'If a detail is missing, omit it rather than making anything up.',
  ].join('\n');
}

function parseRecipient(value: string): OutreachRecipient | null {
  const text = value.trim();
  if (!text) return null;
  const angle = text.match(/^(.*)<([^>]+)>$/);
  if (angle) return { name: angle[1]?.trim(), email: angle[2]?.trim() };
  if (text.includes('@')) return { email: text };
  return { name: text };
}

// Direction of an outreach record for the Client/External filter. OutreachRecord
// has no explicit direction column, so prefer a persisted metadata.direction and
// otherwise infer from type (campaigns go to congressional offices on behalf of
// the client; follow-ups / prep go to the client).
function recordDirection(record: OutreachRecord): 'on-behalf' | 'to-clients' {
  const meta = (record.metadata ?? {}) as { direction?: string };
  if (meta.direction === 'on-behalf' || meta.direction === 'to-clients') return meta.direction;
  return record.type === 'campaign' || record.type === 'outbound_campaign'
    ? 'on-behalf'
    : 'to-clients';
}

function recipientKey(recipient: OutreachRecipient): string {
  return (
    recipient.email?.toLowerCase() ||
    recipient.directoryContactId ||
    recipient.name?.toLowerCase() ||
    JSON.stringify(recipient)
  );
}

function personalizedPreview(recipient: OutreachRecipient): string {
  return [recipient.committee, recipient.state, recipient.relevanceReason]
    .filter(Boolean)
    .join(' | ');
}

function assembleCampaignBody(
  body: string,
  recipient: OutreachRecipient | null,
  metadata?: Record<string, unknown> | null,
): string {
  const currentDateTime = readCurrentDateTime(metadata);
  const withCurrentDate = body.replaceAll(
    '{current_date_time}',
    formatCurrentDateTime(currentDateTime),
  );
  if (!recipient) return stripUnresolvedTemplateFields(withCurrentDate);
  const fallbacks = readStringRecord(metadata?.fieldFallbacks);
  return stripUnresolvedTemplateFields(
    withCurrentDate
      .replaceAll(
        '{district}',
        recipient.district || recipient.state || fallbacks['{district}'] || '',
      )
      .replaceAll('{committee}', recipient.committee || fallbacks['{committee}'] || '')
      .replaceAll('{member_priority}', recipient.relevanceReason || '')
      .replaceAll('{personal_note}', recipient.personalNote || '')
      .replaceAll(
        '{address}',
        recipient.address || recipient.meetingLocation || fallbacks['{address}'] || '',
      )
      .replaceAll('{attendee_names}', recipient.attendeeNames || recipient.name || '')
      .replaceAll('{attendee_emails}', recipient.attendeeEmails || recipient.email || '')
      .replaceAll('{prep_summary}', recipient.prepSummary || '')
      .replaceAll('{debrief_summary}', recipient.debriefSummary || '')
      .replaceAll('{meeting_location}', recipient.meetingLocation || '')
      .replaceAll('{meeting_subject}', recipient.meetingSubject || '')
      .replaceAll('{meeting_date_time}', recipient.meetingDateTime || ''),
  );
}

function readCurrentDateTime(metadata?: Record<string, unknown> | null): Date {
  const explicit =
    readString(metadata?.campaignCurrentDateTime) || readString(metadata?.outboundCurrentDateTime);
  const ai = metadata?.ai;
  const generatedAt =
    ai && typeof ai === 'object' && !Array.isArray(ai)
      ? readString((ai as Record<string, unknown>).generatedAt)
      : '';
  const parsed = new Date(explicit || generatedAt || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function outreachRecordTypeLabel(type: WorkflowType): string {
  if (type === 'campaign' || type === 'outbound_campaign') return 'Campaign';
  if (type === 'follow_up') return 'Follow-up';
  return 'Prep';
}

function recordTypeClass(type: WorkflowType): string {
  if (type === 'campaign' || type === 'outbound_campaign') return 'campaign';
  if (type === 'follow_up') return 'follow-up';
  return 'prep';
}

function outreachRecordDisplayDate(record: OutreachRecord): string {
  return record.sentAt ?? record.openedInEmailAt ?? record.updatedAt ?? record.createdAt;
}

function outreachRecordTimestamp(record: OutreachRecord): number {
  const timestamp = new Date(outreachRecordDisplayDate(record)).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function recordStats(record: OutreachRecord): string {
  if (record.type === 'campaign' || record.type === 'outbound_campaign') {
    const sentCount = readStatText(record.stats?.recipientsSent, String(record.recipientCount));
    const openRate = readString(record.stats?.openRate) || '0%';
    const replies = readStatText(record.stats?.replyCount, '0');
    return record.status === 'sent'
      ? `${sentCount} recipients sent · ${openRate} open rate · ${replies} replies`
      : `${record.recipientCount} recipients · Meri draft ${record.subject ? 'ready' : 'pending'}`;
  }
  if (record.status !== 'draft') {
    return `Opened in connected email · ${formatOptionalDate(
      record.openedInEmailAt ?? record.updatedAt,
    )}`;
  }
  return `${record.recipientCount} recipients`;
}

function readStatText(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readString(value) || fallback;
}

function statusLabel(record: OutreachRecord): string {
  if (record.status === 'draft') return 'Draft';
  if (record.status === 'sent') return 'Sent';
  if (record.status === 'opened_in_email') return 'Opened in email';
  return 'Failed';
}

function objectiveSearchSeed(client: Client): string {
  const intake = client.intakeData ?? {};
  const portfolio = Array.isArray(intake.portfolio) ? intake.portfolio[0] : '';
  return [portfolio, intake.requestType, intake.sector, client.name].filter(Boolean).join(' ');
}

function campaignContextSuggestions(context?: ClientContext): OutreachRecipient[] {
  if (!context) return [];
  const rows: OutreachRecipient[] = context.keyStakeholders
    .map<OutreachRecipient>((stakeholder) => ({
      name: textOrUndefined(stakeholder.fullName || stakeholder.email),
      email: textOrUndefined(stakeholder.email),
      office: textOrUndefined(stakeholder.organization),
      title: textOrUndefined(stakeholder.title),
      relevanceReason: contextSuggestionReason(context),
      sourceLabel: textOrUndefined(stakeholder.source ?? undefined),
    }))
    .filter((recipient) => Boolean(recipient.name || recipient.email));
  return normalizeRecipients(rows).slice(0, 20);
}

function contextSuggestionReason(context: ClientContext): string {
  const parts = [
    context.summary.meetings ? `${context.summary.meetings} meeting invites` : '',
    context.summary.mailThreads ? `${context.summary.mailThreads} email threads` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : 'Synced client context';
}

function campaignDynamicFieldsIn(subject: string, body: string): CampaignDynamicField[] {
  const text = `${subject}\n${body}`;
  return CAMPAIGN_DYNAMIC_FIELDS.filter((field) => text.includes(field));
}

function campaignFieldValue(recipient: OutreachRecipient, field: CampaignDynamicField): string {
  if (field === '{district}') return recipient.district || recipient.state || '';
  if (field === '{committee}') return recipient.committee || '';
  if (field === '{address}') return recipient.address || recipient.meetingLocation || '';
  if (field === '{personal_note}') return recipient.personalNote || '';
  return '';
}

function stripUnresolvedTemplateFields(value: string): string {
  return value
    .replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function campaignExceptionRows(
  recipients: OutreachRecipient[],
  fields: CampaignDynamicField[],
  fallbacks: Record<string, string>,
): CampaignExceptionRow[] {
  return recipients.flatMap((recipient) =>
    fields
      .filter((field) => field !== '{personal_note}' && !campaignFieldValue(recipient, field))
      .map((field) => ({
        recipient,
        field,
        fallback: fallbacks[field] ?? '',
      })),
  );
}

function campaignExceptionsSummary(rows: CampaignExceptionRow[]): string {
  if (!rows.length) return 'No exceptions';
  const missingDirectory = new Set(
    rows
      .filter((row) => !row.recipient.directoryContactId)
      .map((row) => recipientKey(row.recipient)),
  ).size;
  if (missingDirectory) {
    return `${missingDirectory} recipient${missingDirectory === 1 ? ' has' : 's have'} no directory data - dynamic fields will use fallback text`;
  }
  return `${rows.length} dynamic field fallback${rows.length === 1 ? '' : 's'} will be used`;
}

function campaignDirectorySuggestionQuery(client: Client | null, objective: string): string {
  const seed = [client ? objectiveSearchSeed(client) : '', objective].filter(Boolean).join(' ');
  const lowered = seed.toLowerCase();
  const committeeHints: string[] = [];
  if (
    /\b(ai|a\/i|ml|machine learning|digital|technology|innovation|software|data)\b/.test(lowered)
  ) {
    committeeHints.push('Science Space Technology');
  }
  if (/\b(defense|dod|military|aerospace|national security)\b/.test(lowered)) {
    committeeHints.push('Armed Services');
  }
  if (/\b(health|healthcare|medical|drug|pharma|biotech)\b/.test(lowered)) {
    committeeHints.push('Energy Commerce Health');
  }
  if (/\b(energy|grid|climate|nuclear|renewable)\b/.test(lowered)) {
    committeeHints.push('Energy Natural Resources');
  }
  if (/\b(transport|infrastructure|aviation|rail|highway)\b/.test(lowered)) {
    committeeHints.push('Transportation Infrastructure');
  }
  if (/\b(tax|finance|banking|capital|insurance)\b/.test(lowered)) {
    committeeHints.push('Financial Services Ways Means');
  }
  return [...committeeHints, seed].filter(Boolean).join(' ');
}

function defaultDirectoryRelevanceReason(entry: DirectoryEntry): string {
  return [
    entry.committees[0],
    entry.focusAreas[0],
    entry.officeLocation ? `Office: ${entry.officeLocation}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

function campaignRelevanceReason(
  entry: DirectoryEntry,
  objective: string,
  client: Client | null,
): string {
  const seed = [client ? objectiveSearchSeed(client) : '', objective].join(' ').toLowerCase();
  const committee = entry.committees[0];
  const focus = entry.focusAreas[0];
  if (/\b(ai|ml|machine learning|digital|technology|innovation|software|data)\b/.test(seed)) {
    const scienceCommittee = entry.committees.find((value) =>
      /science|space|technology|commerce/i.test(value),
    );
    if (scienceCommittee) {
      return `${scienceCommittee} aligns with the client technology or innovation objective.`;
    }
  }
  if (committee && seed.includes(committee.toLowerCase().split(/\s+/)[0] ?? '')) {
    return `${committee} appears relevant to the client portfolio and campaign objective.`;
  }
  if (focus) return `${focus} focus area appears relevant to the objective.`;
  return defaultDirectoryRelevanceReason(entry) || 'Relevant Directory profile for this campaign.';
}

function formatDirectoryMainAddress(entry: DirectoryEntry): string {
  const address = entry.addresses.find((row) => row.isMain) ?? entry.addresses[0];
  if (!address) return entry.officeLocation;
  return [
    address.address1,
    address.address2,
    [address.city, address.state, address.zip].filter(Boolean).join(', '),
  ]
    .filter(Boolean)
    .join('\n');
}

function suggestPersonalNote(
  recipient: OutreachRecipient,
  objective: string,
  client: Client | null,
): string {
  const clientName = client?.name ?? 'our client';
  const committee = recipient.committee ? `your work on ${recipient.committee}` : 'your office';
  const objectiveText = objective.trim()
    ? ` around ${objective.trim().replace(/\s+/g, ' ').slice(0, 140)}`
    : '';
  return `Given ${committee}, ${clientName} would value your perspective${objectiveText}.`;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase()).join('') || 'C';
}

function todayInputValue(): string {
  return inputValueFromDate(new Date());
}

function inputValueFromDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDateStartIso(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const fallback = new Date();
  return new Date(
    year ?? fallback.getFullYear(),
    (month ?? fallback.getMonth() + 1) - 1,
    day ?? fallback.getDate(),
    0,
    0,
    0,
    0,
  ).toISOString();
}

function localDateEndIso(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const fallback = new Date();
  return new Date(
    year ?? fallback.getFullYear(),
    (month ?? fallback.getMonth() + 1) - 1,
    day ?? fallback.getDate(),
    23,
    59,
    59,
    999,
  ).toISOString();
}

function formatOptionalDate(value?: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatCurrentDateTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(value);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
