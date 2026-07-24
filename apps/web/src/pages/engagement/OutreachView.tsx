import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { setActiveDraft } from '../../components/chat/chat-store.js';
import { useLocation, useNavigate } from 'react-router-dom';
// The v2 wizard is the sole outreach wizard; aliased to OutreachWizard so the
// existing render sites read unchanged.
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
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { useApi } from '../../lib/use-api.js';
import type { Client } from '../clients/clientTypes.js';
import type { DirectoryApiResponse, DirectoryEntry } from '../directory/directoryData.js';

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

  // Moved above the mode<->URL sync effects (was declared further down,
  // alongside the effect that consumes draftRecord.data) so the mode->URL
  // effect below can reference draftRecord.isError/isLoading without a
  // temporal-dead-zone error — see that effect's guard comment.
  const draftRecord = useQuery<OutreachRecord>({
    queryKey: ['engagement-outreach-record', draftRecordIdFromPath],
    queryFn: async () =>
      (await api.get<OutreachRecord>(`/api/engagement/outreach/${draftRecordIdFromPath}`)).data,
    enabled: Boolean(draftRecordIdFromPath),
  });

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
    // A direct/deep-link navigation to /draft/:id (bookmark, page reload, or
    // navigate() from another page — e.g. Strategy Execution's "Open in
    // Capiro") mounts this component with workflow.record still empty; the
    // draftRecord fetch below is what will populate it. Without this guard,
    // THIS effect would see mode='campaign' + workflow.record?.id=undefined
    // on that very first pass (before the async fetch resolves) and rewrite
    // the URL to /new/wizard, permanently discarding the deep link — even
    // though the record load was already in flight. Only the in-app openDraft()
    // path (click a row in the Outreach list) hydrates workflow.record
    // synchronously and never hits this branch. Wait for the fetch to settle
    // (success -> workflow.record picks up the id via the effect below;
    // error -> fall through so a genuinely bad id still lands on a sane URL).
    if (
      draftRecordIdFromPath &&
      workflow.record?.id !== draftRecordIdFromPath &&
      !draftRecord.isError
    ) {
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
  }, [
    location.pathname,
    mode,
    navigate,
    workflow.record?.id,
    draftRecordIdFromPath,
    draftRecord.isError,
  ]);

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
  // Every connected inbox the user can send outreach from (Outlook + Gmail),
  // for the wizard's sender-mailbox picker.
  const sendableInboxes = (integrations.data ?? [])
    .filter(
      (connection) =>
        connection.status === 'connected' &&
        (connection.provider === 'microsoft_365' || connection.provider === 'google_workspace'),
    )
    .map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      accountEmail: connection.accountEmail ?? null,
      displayName: connection.displayName ?? null,
    }));

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
        sendableInboxes={sendableInboxes}
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
    // Opens are not tracked (no pixels — D8); show only real signals.
    const replies = readStatText(record.stats?.replyCount, '0');
    return record.status === 'sent'
      ? `${sentCount} recipients sent · ${replies} replies`
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

function stripUnresolvedTemplateFields(value: string): string {
  return value
    .replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
