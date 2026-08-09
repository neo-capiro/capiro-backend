import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeftOutlined,
  CalendarOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  MailOutlined,
  MessageOutlined,
  MoreOutlined,
  PhoneOutlined,
  PlusOutlined,
  SearchOutlined,
  TeamOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  CAPABILITY_TAG_SUGGESTIONS,
  SECTOR_LABELS,
  SECTOR_TAGS,
  SUBMISSION_TRACK_LABELS,
  normalizeSector,
  type SectorTag,
  type SubmissionTrack,
} from '@capiro/shared';
import { MemoryFileEditor } from '../../components/MemoryFileEditor.js';
import {
  clearChatSession,
  setActiveConversation,
  setChatOpen,
} from '../../components/chat/chat-store.js';
import { useApi } from '../../lib/use-api.js';
import { useIntelFeature } from '../../lib/intel-feature-flags.js';
import { useMe } from '../../lib/me.js';
import { useClientFilter } from '../../state/client-filter.js';
import { useActionsList } from '../actions/actions-api.js';
import {
  STATUS_LABELS,
  type ActionCardDto,
  type ActionStatus,
} from '../actions/types.js';
import { SharedMeetingsSection } from '../engagement/meetings/SharedMeetingsSection.js';
import { useMeetings } from '../engagement/meetings/meetings-api.js';
import type { Meeting } from '../engagement/meetings/meetings-types.js';
import { FacilitiesEditor } from './FacilitiesEditor.js';
import { IntelligenceTab } from './IntelligenceTab.js';
import { TargetsTab } from './TargetsTab.js';
import type { Client, ClientAttachment } from './clientTypes.js';
import type { ClientFacility } from './facilities-api.js';
import { getRelevantPesForClient } from './relevance-api.js';
import { getClientTargets, type ClientTarget } from './targets-api.js';
import { intelTrackerPaths } from './tracker/intel-tracker-api.js';
import { TrackerTab } from './tracker/TrackerTab.js';
import { trackerKeys, trackerPaths, type TrackerSummary } from './tracker/tracker-api.js';

interface ClientPerson {
  id: string;
  clientId: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  lastContact: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt?: string;
}

interface CapabilityRecord {
  id: string;
  clientId: string;
  name: string;
  type: string;
  description: string | null;
  sector: string | null;
  tags: string[];
  issueCodes?: string[];
  trl: number | null;
  mrl: number | null;
  peNumber: string | null;
  peNumbers: string[];
  keywords: string[];
  appropriationAccount: string | null;
  serviceBranch: string | null;
  targetSubcommittee: string | null;
  fundingAsk: number | null;
  fundingAskLabel: string | null;
  justification: string | null;
  districtNexus: string | null;
  existingContracts: string | null;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface SubmissionHistory {
  id: string;
  clientId: string;
  capabilityId: string | null;
  fiscalYear: string;
  title: string;
  meta: string | null;
  outcome: string | null;
  outcomeType: 'success' | 'partial' | 'failed' | 'in_progress' | string;
  notes: string | null;
  createdAt: string;
}

interface KbStatusResponse {
  counts: {
    client_profile?: number;
    client_person?: number;
    client_facility?: number;
    client_doc_chunk?: number;
  };
  lastIndexedAt: string | null;
}

type CrmTab = 'overview' | 'activity' | 'capabilities' | 'intelligence' | 'relationships' | 'files';
type RelationshipView = 'contacts' | 'government' | 'locations';
type IntelligenceView = 'briefing' | 'legiwatch';
type ActivityKind = 'meeting' | 'action' | 'file';

interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: string;
  title: string;
  meta: string;
}

interface Props {
  client: Client;
  canManageClients: boolean;
  canRemoveClients: boolean;
  onBack: () => void;
  onEdit: (client: Client) => void;
  onRemove: (client: Client) => void;
  onUploadLogo: (client: Client, file: File) => Promise<void>;
  onClientUpdated: () => void;
}

const CLOSED_ACTION_STATUSES = new Set<ActionStatus>(['dismissed', 'archived']);
const TAB_LABELS: Array<{ key: CrmTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'activity', label: 'Activity' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'intelligence', label: 'Intelligence' },
  { key: 'relationships', label: 'Relationships' },
  { key: 'files', label: 'Files' },
];

export function ClientProfilePage({
  client,
  canManageClients,
  canRemoveClients,
  onBack,
  onEdit,
  onRemove,
  onUploadLogo,
  onClientUpdated,
}: Props) {
  const api = useApi();
  const me = useMe();
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { setSelectedClientId } = useClientFilter();
  const initialRoute = useMemo(readInitialRoute, []);
  const [activeTab, setActiveTabState] = useState<CrmTab>(initialRoute.tab);
  const [relationshipView, setRelationshipView] = useState<RelationshipView>(
    initialRoute.relationshipView,
  );
  const [intelligenceView, setIntelligenceView] = useState<IntelligenceView>(
    initialRoute.intelligenceView,
  );
  const [activityFilter, setActivityFilter] = useState<'all' | ActivityKind>('all');
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [capabilityModalOpen, setCapabilityModalOpen] = useState(false);
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string | null>(null);
  const [personModal, setPersonModal] = useState<{ open: boolean; person: ClientPerson | null }>({
    open: false,
    person: null,
  });
  const [notes, setNotes] = useState(() => profileNotesOf(client));
  const isAdmin = me.data?.role === 'user_admin' || me.data?.role === 'capiro_admin';

  useEffect(() => setNotes(profileNotesOf(client)), [client]);

  const setActiveTab = (tab: CrmTab) => {
    setActiveTabState(tab);
    try {
      const params = new URLSearchParams(window.location.search);
      params.set('tab', tab);
      window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
    } catch {
      /* Browser history is best-effort. */
    }
  };

  const askMeriAboutClient = () => {
    setSelectedClientId(client.id);
    clearChatSession();
    setActiveConversation(null);
    setChatOpen(true);
  };

  const capabilities = useQuery<CapabilityRecord[]>({
    queryKey: ['client-capabilities', client.id],
    queryFn: async () =>
      (await api.get<CapabilityRecord[]>(`/api/clients/${client.id}/capabilities`)).data,
  });
  const people = useQuery<ClientPerson[]>({
    queryKey: ['client-people', client.id],
    queryFn: async () =>
      (await api.get<ClientPerson[]>(`/api/clients/${client.id}/people`)).data,
  });
  const documents = useQuery<ClientAttachment[]>({
    queryKey: ['client-attachments', client.id],
    queryFn: async () =>
      (
        await api.get<ClientAttachment[]>('/api/engagement/attachments', {
          params: { clientId: client.id },
        })
      ).data,
  });
  const facilities = useQuery<ClientFacility[]>({
    queryKey: ['client-facilities', client.id],
    queryFn: async () =>
      (await api.get<ClientFacility[]>(`/api/clients/${client.id}/facilities`)).data,
    staleTime: 60_000,
  });
  const targets = useQuery<ClientTarget[]>({
    queryKey: ['client-targets', client.id],
    queryFn: () => getClientTargets(api, client.id),
    staleTime: 60_000,
  });
  const kbStatus = useQuery<KbStatusResponse>({
    queryKey: ['client-kb-status', client.id],
    queryFn: async () =>
      (await api.get<KbStatusResponse>(`/api/clio/kb/${client.id}/status`)).data,
    staleTime: 60_000,
  });
  const peRelevance = useQuery({
    queryKey: ['client-pe-relevance', client.id, { minScore: 0.5 }],
    queryFn: () => getRelevantPesForClient(api, client.id, { minScore: 0.5, limit: 8 }),
    staleTime: 60_000,
  });

  const { enabled: trackerV2, ready: intelFlagsReady } = useIntelFeature('tracker_v2');
  const trackerSummary = useQuery<TrackerSummary>({
    queryKey: trackerKeys.summary(client.id),
    queryFn: async () =>
      (
        await api.get<TrackerSummary>(
          trackerV2 ? intelTrackerPaths.summary(client.id) : trackerPaths.summary(client.id),
        )
      ).data,
    enabled: intelFlagsReady,
    staleTime: 60_000,
  });

  const actionQuery = useActionsList({ clientId: client.id, page: 1, limit: 50, sort: 'priority' });
  const dateRange = useMemo(() => {
    const from = new Date();
    from.setDate(from.getDate() - 120);
    const to = new Date();
    to.setDate(to.getDate() + 45);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);
  const meetings = useMeetings({ clientId: client.id, ...dateRange });

  const openActions = useMemo(
    () =>
      (actionQuery.data?.data ?? [])
        .filter((action) => !CLOSED_ACTION_STATUSES.has(action.status))
        .sort((a, b) => b.priority - a.priority || deadlineValue(a.deadline) - deadlineValue(b.deadline)),
    [actionQuery.data],
  );

  const activities = useMemo(
    () => buildActivityItems(openActions, meetings.data ?? [], documents.data ?? []),
    [openActions, meetings.data, documents.data],
  );

  const filteredActivities = useMemo(
    () =>
      activityFilter === 'all'
        ? activities
        : activities.filter((activity) => activity.kind === activityFilter),
    [activities, activityFilter],
  );

  const selectedCapability =
    capabilities.data?.find((capability) => capability.id === selectedCapabilityId) ?? null;

  const createCapability = useMutation({
    mutationFn: async (data: Record<string, unknown>) =>
      (await api.post<CapabilityRecord>(`/api/clients/${client.id}/capabilities`, data)).data,
    onSuccess: (created) => {
      message.success('Capability added');
      setCapabilityModalOpen(false);
      setSelectedCapabilityId(created.id);
      void qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const deleteCapability = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/api/clients/${client.id}/capabilities/${id}`)).data,
    onSuccess: () => {
      message.success('Capability removed');
      setSelectedCapabilityId(null);
      void qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const savePerson = useMutation({
    mutationFn: async ({
      person,
      values,
    }: {
      person: ClientPerson | null;
      values: Record<string, unknown>;
    }) =>
      person
        ? (await api.patch<ClientPerson>(`/api/clients/${client.id}/people/${person.id}`, values))
            .data
        : (await api.post<ClientPerson>(`/api/clients/${client.id}/people`, values)).data,
    onSuccess: () => {
      message.success(personModal.person ? 'Contact updated' : 'Contact added');
      setPersonModal({ open: false, person: null });
      void qc.invalidateQueries({ queryKey: ['client-people', client.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const deletePerson = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/api/clients/${client.id}/people/${id}`)).data,
    onSuccess: () => {
      message.success('Contact removed');
      void qc.invalidateQueries({ queryKey: ['client-people', client.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const saveNotes = useMutation({
    mutationFn: async (value: string) =>
      (await api.put(`/api/clients/${client.id}/profile-notes`, { notes: value })).data,
    onSuccess: () => {
      message.success('Note saved');
      setNoteOpen(false);
      onClientUpdated();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const deleteDocument = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/api/engagement/attachments/${id}`)).data,
    onSuccess: () => {
      message.success('File removed');
      void qc.invalidateQueries({ queryKey: ['client-attachments', client.id] });
      void qc.invalidateQueries({ queryKey: ['client-kb-status', client.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  async function uploadFiles(files: File[], source?: string) {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is larger than 25 MB.`);
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
      if (!response.ok) throw new Error(`Storage upload failed for ${file.name}.`);
      await api.post('/api/engagement/attachments/confirm', {
        clientId: client.id,
        fileName: file.name,
        contentType,
        s3Key: presigned.s3Key,
        ...(source ? { source } : {}),
      });
    }
    void qc.invalidateQueries({ queryKey: ['client-attachments', client.id] });
    void qc.invalidateQueries({ queryKey: ['client-kb-status', client.id] });
  }

  const attention = useMemo(
    () => buildAttentionItems(client, openActions, meetings.data ?? []),
    [client, openActions, meetings.data],
  );

  const relationshipCount =
    (people.data?.length ?? 0) + (targets.data?.length ?? 0) + (facilities.data?.length ?? 0);
  const tabCounts: Partial<Record<CrmTab, number>> = {
    capabilities: capabilities.data?.length ?? 0,
    relationships: relationshipCount,
    files: documents.data?.length ?? 0,
    intelligence: trackerSummary.data?.boardCount ?? 0,
  };

  const createMenuItems = [
    { key: 'capability', label: 'Capability' },
    { key: 'contact', label: 'Contact' },
    { key: 'file', label: 'File' },
    { key: 'note', label: 'Client note' },
  ];

  return (
    <div className="crm-profile">
      <style>{CRM_STYLES}</style>
      <header className="crm-account-header">
        <div className="crm-account-header__top">
          <button type="button" className="crm-account-back" onClick={onBack} aria-label="Back to clients">
            <ArrowLeftOutlined />
          </button>
          <div className="crm-account-logo">
            {client.logoUrl ? <img src={client.logoUrl} alt="" /> : initials(client.name)}
          </div>
          <div className="crm-account-identity">
            <div className="crm-account-title-row">
              <h1 className="crm-account-name">{client.name}</h1>
              <span className={`crm-account-status is-${client.status}`}>{titleCase(client.status)}</span>
            </div>
            <div className="crm-account-subtitle">
              {portfolioTags(client).slice(0, 4).map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
              <span>Client since {formatMonthYear(client.createdAt)}</span>
            </div>
            <div className="crm-account-contact-line">
              {client.primaryContactName ? <span>{client.primaryContactName}</span> : null}
              {client.primaryContactEmail ? (
                <a href={`mailto:${client.primaryContactEmail}`}><MailOutlined /> {client.primaryContactEmail}</a>
              ) : null}
              {client.primaryContactPhone ? (
                <a href={`tel:${client.primaryContactPhone.replace(/[^\d+]/g, '')}`}>
                  <PhoneOutlined /> {client.primaryContactPhone}
                </a>
              ) : null}
              {client.website ? (
                <a href={externalUrl(client.website)} target="_blank" rel="noreferrer">
                  <LinkOutlined /> {client.website}
                </a>
              ) : null}
            </div>
          </div>
          <div className="crm-account-actions">
            <Button type="primary" className="crm-primary-action" icon={<MessageOutlined />} onClick={askMeriAboutClient}>
              Ask Meri
            </Button>
            <Button icon={<FileTextOutlined />} onClick={() => setNoteOpen(true)}>
              Add note
            </Button>
            <Dropdown
              trigger={['click']}
              menu={{
                items: createMenuItems,
                onClick: ({ key }) => {
                  if (key === 'capability') {
                    setActiveTab('capabilities');
                    setCapabilityModalOpen(true);
                  } else if (key === 'contact') {
                    setActiveTab('relationships');
                    setRelationshipView('contacts');
                    setPersonModal({ open: true, person: null });
                  } else if (key === 'file') {
                    setActiveTab('files');
                  } else if (key === 'note') {
                    setNoteOpen(true);
                  }
                },
              }}
            >
              <Button icon={<PlusOutlined />}>Create</Button>
            </Dropdown>
            <Upload
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              showUploadList={false}
              beforeUpload={(file) => {
                if ((file as File).size > 2 * 1024 * 1024) {
                  void message.error('Logo must be 2 MB or smaller.');
                  return Upload.LIST_IGNORE;
                }
                void onUploadLogo(client, file as File)
                  .then(() => {
                    message.success('Logo updated');
                    onClientUpdated();
                  })
                  .catch((error) => message.error(errorMessage(error)));
                return false;
              }}
            >
              <Tooltip title="Change logo">
                <Button aria-label="Change logo" icon={<UploadOutlined />} />
              </Tooltip>
            </Upload>
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'edit', label: 'Edit client', icon: <EditOutlined />, disabled: !canManageClients },
                  { key: 'remove', label: 'Remove client', icon: <DeleteOutlined />, danger: true, disabled: !canRemoveClients },
                ],
                onClick: ({ key }) => {
                  if (key === 'edit') onEdit(client);
                  if (key === 'remove') onRemove(client);
                },
              }}
            >
              <Button aria-label="More client actions" icon={<MoreOutlined />} />
            </Dropdown>
          </div>
        </div>

        <nav className="crm-profile-tabs" aria-label="Client profile sections">
          {TAB_LABELS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`crm-profile-tab${activeTab === key ? ' is-active' : ''}`}
              onClick={() => setActiveTab(key)}
              aria-current={activeTab === key ? 'page' : undefined}
            >
              {label}
              {(tabCounts[key] ?? 0) > 0 ? <span className="crm-tab-count">{tabCounts[key]}</span> : null}
              {key === 'intelligence' && (trackerSummary.data?.unread ?? 0) > 0 ? (
                <span className="crm-tab-alert" title="Unread intelligence" />
              ) : null}
            </button>
          ))}
        </nav>
      </header>

      <main className="crm-profile-body">
        {activeTab === 'overview' ? (
          <OverviewPanel
            client={client}
            attention={attention}
            actions={openActions}
            activities={activities.slice(0, 6)}
            capabilities={capabilities.data ?? []}
            people={people.data ?? []}
            facilities={facilities.data ?? []}
            targets={targets.data ?? []}
            documents={documents.data ?? []}
            trackerSummary={trackerSummary.data}
            peCount={peRelevance.data?.total ?? 0}
            kbStatus={kbStatus.data}
            onTab={setActiveTab}
            onRelationshipView={(view) => {
              setRelationshipView(view);
              setActiveTab('relationships');
            }}
            onIntelligenceView={(view) => {
              setIntelligenceView(view);
              setActiveTab('intelligence');
            }}
            onEdit={() => onEdit(client)}
            onMemory={() => setMemoryOpen(true)}
          />
        ) : null}

        {activeTab === 'activity' ? (
          <section className="crm-section-shell">
            <div className="crm-section-head">
              <div>
                <h2>Activity</h2>
                <p>One chronological account history. Meetings, actions and files are shown once.</p>
              </div>
              <Space>
                <Segmented
                  value={activityFilter}
                  options={[
                    { label: 'All', value: 'all' },
                    { label: 'Meetings', value: 'meeting' },
                    { label: 'Actions', value: 'action' },
                    { label: 'Files', value: 'file' },
                  ]}
                  onChange={(value) => setActivityFilter(value as typeof activityFilter)}
                />
                <Button type="primary" icon={<FileTextOutlined />} onClick={() => setNoteOpen(true)}>
                  Add note
                </Button>
              </Space>
            </div>
            <div className="crm-card">
              <ActivityTimeline items={filteredActivities} empty="No activity matches this filter." />
            </div>
          </section>
        ) : null}

        {activeTab === 'capabilities' ? (
          <CapabilitiesPanel
            capabilities={capabilities.data ?? []}
            loading={capabilities.isLoading}
            canManage={canManageClients}
            onAdd={() => setCapabilityModalOpen(true)}
            onOpen={(id) => setSelectedCapabilityId(id)}
            onDelete={(capability) =>
              modal.confirm({
                title: `Remove ${capability.name}?`,
                content: 'Submission history is retained but will no longer be linked to this capability.',
                okText: 'Remove',
                okButtonProps: { danger: true },
                onOk: () => deleteCapability.mutateAsync(capability.id),
              })
            }
          />
        ) : null}

        {activeTab === 'intelligence' ? (
          <section className="crm-section-shell">
            <div className="crm-section-head">
              <div>
                <h2>Intelligence</h2>
                <p>Client-specific signals and workspaces, without repeating account details.</p>
              </div>
              <Segmented
                value={intelligenceView}
                options={[
                  { label: 'Briefing', value: 'briefing' },
                  { label: 'LegiWatch', value: 'legiwatch' },
                ]}
                onChange={(value) => setIntelligenceView(value as IntelligenceView)}
              />
            </div>
            {intelligenceView === 'briefing' ? (
              <IntelligenceTab clientId={client.id} clientName={client.name} />
            ) : (
              <div className="lw-root redesign"><TrackerTab clientId={client.id} clientName={client.name} /></div>
            )}
          </section>
        ) : null}

        {activeTab === 'relationships' ? (
          <section className="crm-section-shell">
            <div className="crm-section-head">
              <div>
                <h2>Relationships</h2>
                <p>Client contacts, government targets and locations live in one place.</p>
              </div>
              <Segmented
                value={relationshipView}
                options={[
                  { label: `Contacts ${people.data?.length ?? 0}`, value: 'contacts' },
                  { label: `Government ${targets.data?.length ?? 0}`, value: 'government' },
                  { label: `Locations ${facilities.data?.length ?? 0}`, value: 'locations' },
                ]}
                onChange={(value) => setRelationshipView(value as RelationshipView)}
              />
            </div>
            {relationshipView === 'contacts' ? (
              <ContactsPanel
                people={people.data ?? []}
                loading={people.isLoading}
                canManage={canManageClients}
                onAdd={() => setPersonModal({ open: true, person: null })}
                onEdit={(person) => setPersonModal({ open: true, person })}
                onDelete={(person) =>
                  modal.confirm({
                    title: `Remove ${person.name}?`,
                    okText: 'Remove',
                    okButtonProps: { danger: true },
                    onOk: () => deletePerson.mutateAsync(person.id),
                  })
                }
              />
            ) : null}
            {relationshipView === 'government' ? (
              <TargetsTab
                clientId={client.id}
                canManage={canManageClients}
                onViewIntelligence={() => {
                  setIntelligenceView('briefing');
                  setActiveTab('intelligence');
                }}
              />
            ) : null}
            {relationshipView === 'locations' ? (
              <FacilitiesEditor clientId={client.id} canManage={canManageClients} />
            ) : null}
          </section>
        ) : null}

        {activeTab === 'files' ? (
          <FilesPanel
            client={client}
            documents={documents.data ?? []}
            loading={documents.isLoading}
            canManage={canManageClients}
            kbStatus={kbStatus.data}
            notes={notes}
            setNotes={setNotes}
            savingNotes={saveNotes.isPending}
            onSaveNotes={() => saveNotes.mutate(notes)}
            onUpload={async (files) => {
              try {
                await uploadFiles(files);
                message.success(files.length === 1 ? 'File uploaded' : `${files.length} files uploaded`);
              } catch (error) {
                message.error(errorMessage(error));
              }
            }}
            onDelete={(document) =>
              modal.confirm({
                title: `Remove ${document.fileName}?`,
                okText: 'Remove',
                okButtonProps: { danger: true },
                onOk: () => deleteDocument.mutateAsync(document.id),
              })
            }
          />
        ) : null}
      </main>

      <Drawer
        title="Meri context"
        width={720}
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
      >
        <Typography.Paragraph type="secondary">
          Human-authored client memory is managed here so it grounds Meri without occupying the main CRM overview.
        </Typography.Paragraph>
        <MemoryFileEditor scope="client" slug={client.id} ready canEdit={isAdmin} />
      </Drawer>

      <Modal
        title="Add client note"
        open={noteOpen}
        onCancel={() => setNoteOpen(false)}
        onOk={() => saveNotes.mutate(notes)}
        confirmLoading={saveNotes.isPending}
        okText="Save note"
      >
        <Input.TextArea
          rows={7}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add client context, decisions or follow-up notes…"
        />
      </Modal>

      <CapabilityCreateModal
        open={capabilityModalOpen}
        submitting={createCapability.isPending}
        onCancel={() => setCapabilityModalOpen(false)}
        onSubmit={(values) => createCapability.mutate(values)}
      />

      <PersonModal
        open={personModal.open}
        person={personModal.person}
        submitting={savePerson.isPending}
        onCancel={() => setPersonModal({ open: false, person: null })}
        onSubmit={(values) => savePerson.mutate({ person: personModal.person, values })}
      />

      <CapabilityCrmDrawer
        clientId={client.id}
        capability={selectedCapability}
        documents={documents.data ?? []}
        canManage={canManageClients}
        onClose={() => setSelectedCapabilityId(null)}
        onUpdated={() => void qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] })}
        onUpload={uploadFiles}
        onDeleteDocument={(document) => deleteDocument.mutateAsync(document.id)}
      />
    </div>
  );
}

function OverviewPanel({
  client,
  attention,
  actions,
  activities,
  capabilities,
  people,
  facilities,
  targets,
  documents,
  trackerSummary,
  peCount,
  kbStatus,
  onTab,
  onRelationshipView,
  onIntelligenceView,
  onEdit,
  onMemory,
}: {
  client: Client;
  attention: Array<{ id: string; urgent: boolean; title: string; copy: string; action: 'activity' | 'intelligence' | 'edit' }>;
  actions: ActionCardDto[];
  activities: ActivityItem[];
  capabilities: CapabilityRecord[];
  people: ClientPerson[];
  facilities: ClientFacility[];
  targets: ClientTarget[];
  documents: ClientAttachment[];
  trackerSummary?: TrackerSummary;
  peCount: number;
  kbStatus?: KbStatusResponse;
  onTab: (tab: CrmTab) => void;
  onRelationshipView: (view: RelationshipView) => void;
  onIntelligenceView: (view: IntelligenceView) => void;
  onEdit: () => void;
  onMemory: () => void;
}) {
  const intake = toRecord(client.intakeData);
  const contextTotal = kbTotal(kbStatus);
  const contextInputs = capabilities.length + people.length + facilities.length + documents.length;
  const contextPercent = Math.min(100, Math.max(12, contextTotal ? 100 : contextInputs * 6));
  const workStats = [
    { label: 'Tracked bills', value: trackerSummary?.boardCount ?? 0, onClick: () => onIntelligenceView('legiwatch') },
    { label: 'Open actions', value: actions.length, onClick: () => onTab('activity') },
    { label: 'Capabilities', value: capabilities.length, onClick: () => onTab('capabilities') },
    { label: 'Target offices', value: targets.length, onClick: () => onRelationshipView('government') },
    { label: 'Relevant PEs', value: peCount, onClick: () => onIntelligenceView('briefing') },
    { label: 'Files', value: documents.length, onClick: () => onTab('files') },
  ];
  return (
    <div className="crm-overview">
      <div className="crm-overview-main">
        <section className="crm-card">
          <div className="crm-card__header">
            <span className="crm-card__eyebrow">Needs attention</span>
            <span className="crm-card__grow" />
            <span className="crm-card__muted">{attention.length} item{attention.length === 1 ? '' : 's'}</span>
          </div>
          {attention.length ? (
            <div className="crm-attention-list">
              {attention.slice(0, 4).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`crm-attention-item${item.urgent ? ' is-urgent' : ''}`}
                  onClick={() => {
                    if (item.action === 'activity') onTab('activity');
                    if (item.action === 'intelligence') onIntelligenceView('briefing');
                    if (item.action === 'edit') onEdit();
                  }}
                >
                  <span className="crm-attention-dot" />
                  <span>
                    <span className="crm-attention-title">{item.title}</span>
                    <span className="crm-attention-copy">{item.copy}</span>
                  </span>
                  <span className="crm-attention-action">Review →</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="crm-empty-copy">Nothing urgent is waiting on this account.</div>
          )}
        </section>

        <section className="crm-card">
          <div className="crm-card__header"><h2>Active work</h2></div>
          <div className="crm-work-grid">
            {workStats.map((stat) => (
              <button key={stat.label} type="button" className="crm-work-stat" onClick={stat.onClick}>
                <span className="crm-work-stat__value">{stat.value}</span>
                <span className="crm-work-stat__label">{stat.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="crm-card">
          <div className="crm-card__header">
            <h2>Recent activity</h2>
            <span className="crm-card__grow" />
            <Button type="link" size="small" onClick={() => onTab('activity')}>View all →</Button>
          </div>
          <ActivityTimeline items={activities} empty="No activity has been recorded yet." />
        </section>
      </div>

      <aside className="crm-overview-rail">
        <section className="crm-card">
          <div className="crm-card__header">
            <h3>Client details</h3>
            <span className="crm-card__grow" />
            <Button type="text" size="small" icon={<EditOutlined />} onClick={onEdit} aria-label="Edit client details" />
          </div>
          <div className="crm-card__body crm-detail-list">
            <DetailRow label="Primary contact" value={client.primaryContactName} />
            <DetailRow label="Email" value={client.primaryContactEmail ? <a href={`mailto:${client.primaryContactEmail}`}>{client.primaryContactEmail}</a> : null} />
            <DetailRow label="Phone" value={client.primaryContactPhone} />
            <DetailRow label="Client since" value={formatDate(client.createdAt)} />
            <DetailRow label="Sector" value={sectorLabelFor(client)} />
            <DetailRow
              label="Tracks"
              value={
                client.submissionTracks?.length ? (
                  <InlineTags values={client.submissionTracks.map((track) => SUBMISSION_TRACK_LABELS[track as SubmissionTrack] ?? track)} />
                ) : null
              }
            />
          </div>
        </section>

        <section className="crm-card">
          <div className="crm-card__header"><h3>Government profile</h3></div>
          <div className="crm-card__body crm-detail-list">
            <DetailRow label="UEI" value={client.uei} mono />
            <DetailRow label="CAGE" value={client.cageCode} mono />
            <DetailRow label="SAM" value={readText(intake, ['samStatus'])} />
            <DetailRow label="SAM expires" value={formatOptionalDate(readText(intake, ['samExpirationDate']))} />
            <DetailRow label="NAICS" value={<CodeSummary values={client.naicsCodes ?? []} />} />
            <DetailRow label="PSC" value={<CodeSummary values={client.pscCodes ?? []} />} />
            <DetailRow label="Certifications" value={<InlineTags values={client.setAsideCertifications ?? []} />} />
            <DetailRow label="Grant eligibility" value={<InlineTags values={client.applicantTypes ?? []} max={2} />} />
          </div>
        </section>

        <section className="crm-card">
          <div className="crm-card__header">
            <h3>Meri context</h3>
            <span className="crm-card__grow" />
            <Button type="link" size="small" onClick={onMemory}>Manage</Button>
          </div>
          <div className="crm-card__body">
            <div className="crm-context-label">{contextTotal > 0 ? 'Well grounded' : 'Needs context'}</div>
            <div className="crm-context-meter"><span style={{ width: `${contextPercent}%` }} /></div>
            <div className="crm-context-summary">
              {contextTotal > 0
                ? `${contextTotal} indexed knowledge items across the profile, people, facilities and documents.`
                : `${contextInputs} account records are available. Add documents or memory to improve grounding.`}
            </div>
          </div>
        </section>
      </aside>
    </div>
  );
}

function ActivityTimeline({ items, empty }: { items: ActivityItem[]; empty: string }) {
  if (!items.length) return <div className="crm-empty-copy">{empty}</div>;
  return (
    <div className="crm-timeline">
      {items.map((item) => (
        <div key={`${item.kind}:${item.id}`} className="crm-timeline-item">
          <div className="crm-timeline-time">{formatActivityDate(item.at)}</div>
          <div className={`crm-timeline-marker is-${item.kind}`} />
          <div>
            <div className="crm-timeline-title">{item.title}</div>
            <div className="crm-timeline-meta">{item.meta}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CapabilitiesPanel({
  capabilities,
  loading,
  canManage,
  onAdd,
  onOpen,
  onDelete,
}: {
  capabilities: CapabilityRecord[];
  loading: boolean;
  canManage: boolean;
  onAdd: () => void;
  onOpen: (id: string) => void;
  onDelete: (capability: CapabilityRecord) => void;
}) {
  return (
    <section className="crm-section-shell">
      <div className="crm-section-head">
        <div>
          <h2>Capabilities</h2>
          <p>Products and programs with readiness, policy context, evidence and advocacy history.</p>
        </div>
        {canManage ? <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>Add capability</Button> : null}
      </div>
      <div className="crm-card">
        {loading ? (
          <div className="crm-card__body"><Skeleton active paragraph={{ rows: 5 }} /></div>
        ) : capabilities.length ? (
          <div className="crm-related-list">
            <div className="crm-related-list__head">
              <span>Name</span><span>Type</span><span>Readiness</span><span>Funding ask</span><span />
            </div>
            {capabilities.map((capability) => (
              <button key={capability.id} type="button" className="crm-related-list__row" onClick={() => onOpen(capability.id)}>
                <span>
                  <b>{capability.name}</b>
                  <small>{capability.description ?? 'No description yet.'}</small>
                </span>
                <span>{titleCase(capability.type || 'capability')}</span>
                <span>{capability.trl != null ? `TRL ${capability.trl}` : '—'}{capability.mrl != null ? ` · MRL ${capability.mrl}` : ''}</span>
                <span>{capability.fundingAsk != null ? formatMoney(capability.fundingAsk) : '—'}</span>
                <span onClick={(event) => event.stopPropagation()}>
                  {canManage ? <Button type="text" danger icon={<DeleteOutlined />} aria-label={`Remove ${capability.name}`} onClick={() => onDelete(capability)} /> : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="crm-empty-state">
            <FolderOpenOutlined />
            <h3>No capabilities yet</h3>
            <p>Add a capability to connect this client to budget lines, policy issues and submission history.</p>
            {canManage ? <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>Add capability</Button> : null}
          </div>
        )}
      </div>
    </section>
  );
}

function ContactsPanel({
  people,
  loading,
  canManage,
  onAdd,
  onEdit,
  onDelete,
}: {
  people: ClientPerson[];
  loading: boolean;
  canManage: boolean;
  onAdd: () => void;
  onEdit: (person: ClientPerson) => void;
  onDelete: (person: ClientPerson) => void;
}) {
  return (
    <div className="crm-card">
      <div className="crm-card__header">
        <h3>Client contacts</h3>
        <span className="crm-card__grow" />
        {canManage ? <Button type="primary" size="small" icon={<PlusOutlined />} onClick={onAdd}>Add contact</Button> : null}
      </div>
      {loading ? (
        <div className="crm-card__body"><Skeleton active paragraph={{ rows: 4 }} /></div>
      ) : people.length ? (
        <div className="crm-contact-grid">
          {people.map((person) => (
            <article key={person.id} className="crm-contact-card">
              <div className="crm-contact-card__top">
                <span className="crm-avatar">{initials(person.name)}</span>
                <span className="crm-contact-card__identity">
                  <b>{person.name}</b>
                  <small>{person.title ?? 'No title'}</small>
                </span>
                {person.role ? <span className="crm-inline-tag">{person.role}</span> : null}
              </div>
              <div className="crm-contact-card__details">
                {person.email ? <a href={`mailto:${person.email}`}><MailOutlined /> {person.email}</a> : null}
                {person.phone ? <a href={`tel:${person.phone.replace(/[^\d+]/g, '')}`}><PhoneOutlined /> {person.phone}</a> : null}
                {person.lastContact ? <span><CalendarOutlined /> Last contact {formatDate(person.lastContact)}</span> : null}
                {person.notes ? <p>{person.notes}</p> : null}
              </div>
              {canManage ? (
                <div className="crm-contact-card__actions">
                  <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(person)}>Edit</Button>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDelete(person)}>Remove</Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="crm-empty-state"><TeamOutlined /><h3>No contacts yet</h3><p>Add the people who own decisions and day-to-day work at this client.</p>{canManage ? <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>Add contact</Button> : null}</div>
      )}
    </div>
  );
}

function FilesPanel({
  client,
  documents,
  loading,
  canManage,
  kbStatus,
  notes,
  setNotes,
  savingNotes,
  onSaveNotes,
  onUpload,
  onDelete,
}: {
  client: Client;
  documents: ClientAttachment[];
  loading: boolean;
  canManage: boolean;
  kbStatus?: KbStatusResponse;
  notes: string;
  setNotes: (value: string) => void;
  savingNotes: boolean;
  onSaveNotes: () => void;
  onUpload: (files: File[]) => Promise<void>;
  onDelete: (document: ClientAttachment) => void;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const filtered = documents.filter((document) => {
    const sourceLabel = documentSourceLabel(document.source);
    return (
      (!query.trim() || document.fileName.toLowerCase().includes(query.trim().toLowerCase())) &&
      (source === 'all' || sourceLabel === source)
    );
  });
  const sourceOptions = Array.from(new Set(documents.map((document) => documentSourceLabel(document.source))));
  return (
    <section className="crm-section-shell">
      <div className="crm-section-head">
        <div>
          <h2>Files</h2>
          <p>Meeting records, generated work and uploaded evidence are organized once, with provenance.</p>
        </div>
        <KbStatusTag status={kbStatus} />
      </div>

      <SharedMeetingsSection clientId={client.id} clientName={client.name} />

      <div className="crm-card">
        <div className="crm-card__header">
          <h3>Client files</h3>
          <span className="crm-card__grow" />
          <Input prefix={<SearchOutlined />} allowClear placeholder="Search files" value={query} onChange={(event) => setQuery(event.target.value)} style={{ width: 220 }} />
          <Select value={source} onChange={setSource} style={{ width: 170 }} options={[{ label: 'All sources', value: 'all' }, ...sourceOptions.map((value) => ({ label: value, value }))]} />
        </div>
        {canManage ? (
          <div className="crm-upload-wrap">
            <Upload.Dragger
              multiple
              showUploadList={false}
              accept=".pdf,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.csv,image/*"
              beforeUpload={(file, fileList) => {
                if (file.uid === fileList[0]?.uid) void onUpload(fileList.map((item) => item as File));
                return false;
              }}
            >
              <p className="ant-upload-drag-icon"><UploadOutlined /></p>
              <p className="ant-upload-text">Drop files here or click to upload</p>
              <p className="ant-upload-hint">PDF, Office files, text, CSV and images · max 25 MB each</p>
            </Upload.Dragger>
          </div>
        ) : null}
        {loading ? (
          <div className="crm-card__body"><Skeleton active paragraph={{ rows: 4 }} /></div>
        ) : filtered.length ? (
          <div className="crm-file-list">
            {filtered.map((document) => (
              <div className="crm-file-row" key={document.id}>
                <span className="crm-file-icon">{documentIcon(document.contentType, document.fileName)}</span>
                <span className="crm-file-info">
                  <b>{document.fileName}</b>
                  <small>
                    {documentSourceLabel(document.source)} · {formatDate(document.createdAt)}
                    {document.byteSize != null ? ` · ${formatBytes(document.byteSize)}` : ''}
                    {document.uploadedByName ? ` · ${document.uploadedByName}` : ''}
                  </small>
                </span>
                <span>{document.indexedAt ? <Tag color="green">Indexed</Tag> : <Tag>Not indexed</Tag>}</span>
                <span className="crm-file-actions">
                  {document.downloadUrl ? <Button type="text" icon={<DownloadOutlined />} href={document.downloadUrl} target="_blank" aria-label={`Download ${document.fileName}`} /> : null}
                  {canManage ? <Button type="text" danger icon={<DeleteOutlined />} onClick={() => onDelete(document)} aria-label={`Remove ${document.fileName}`} /> : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="crm-empty-copy">No files match the current filters.</div>
        )}
      </div>

      <div className="crm-card">
        <div className="crm-card__header"><h3>Client note</h3></div>
        <div className="crm-card__body">
          <Input.TextArea rows={5} value={notes} onChange={(event) => setNotes(event.target.value)} disabled={!canManage} placeholder="Add durable account context that should be visible to the team…" />
          {canManage ? <Button type="primary" style={{ marginTop: 10 }} loading={savingNotes} onClick={onSaveNotes}>Save note</Button> : null}
        </div>
      </div>
    </section>
  );
}

function CapabilityCreateModal({
  open,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [form] = Form.useForm();
  return (
    <Modal title="Add capability" open={open} onCancel={onCancel} onOk={() => form.submit()} confirmLoading={submitting} okText="Add capability" destroyOnClose>
      <Form form={form} layout="vertical" onFinish={(values) => onSubmit({ ...values, tags: values.tags ?? [], trl: values.trl ?? null, mrl: values.mrl ?? null })}>
        <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="type" label="Type" initialValue="product"><Select options={['product', 'service', 'platform', 'technology'].map((value) => ({ label: titleCase(value), value }))} /></Form.Item>
        <Form.Item name="sector" label="Sector"><Select allowClear options={SECTOR_TAGS.map((value) => ({ value, label: SECTOR_LABELS[value] }))} /></Form.Item>
        <Form.Item name="tags" label="Tags"><Select mode="tags" tokenSeparators={[',']} options={CAPABILITY_TAG_SUGGESTIONS.map((value) => ({ value, label: value }))} /></Form.Item>
        <Form.Item name="description" label="Description"><Input.TextArea rows={3} /></Form.Item>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="trl" label="TRL"><InputNumber min={1} max={9} /></Form.Item>
          <Form.Item name="mrl" label="MRL"><InputNumber min={1} max={10} /></Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}

function PersonModal({
  open,
  person,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  person: ClientPerson | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [form] = Form.useForm();
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      name: person?.name,
      title: person?.title,
      email: person?.email,
      phone: person?.phone,
      role: person?.role,
      lastContact: person?.lastContact?.slice(0, 10),
      notes: person?.notes,
    });
  }, [form, open, person]);
  return (
    <Modal title={person ? 'Edit contact' : 'Add contact'} open={open} onCancel={onCancel} onOk={() => form.submit()} confirmLoading={submitting} okText={person ? 'Save changes' : 'Add contact'} destroyOnClose>
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) =>
          onSubmit({
            name: values.name,
            title: optional(values.title),
            email: optional(values.email),
            phone: optional(values.phone),
            role: optional(values.role),
            lastContact: optional(values.lastContact),
            notes: optional(values.notes),
          })
        }
      >
        <Form.Item name="name" label="Full name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="title" label="Title"><Input /></Form.Item>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}><Input /></Form.Item>
          <Form.Item name="phone" label="Phone"><Input /></Form.Item>
        </Space>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="role" label="Relationship"><Select allowClear options={['Primary POC', 'Executive', 'Government Affairs', 'BD', 'Technical', 'Legal', 'Finance'].map((value) => ({ label: value, value }))} /></Form.Item>
          <Form.Item name="lastContact" label="Last contact"><Input type="date" /></Form.Item>
        </Space>
        <Form.Item name="notes" label="Notes"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Modal>
  );
}

function CapabilityCrmDrawer({
  clientId,
  capability,
  documents,
  canManage,
  onClose,
  onUpdated,
  onUpload,
  onDeleteDocument,
}: {
  clientId: string;
  capability: CapabilityRecord | null;
  documents: ClientAttachment[];
  canManage: boolean;
  onClose: () => void;
  onUpdated: () => void;
  onUpload: (files: File[], source?: string) => Promise<void>;
  onDeleteDocument: (document: ClientAttachment) => Promise<unknown>;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm();
  const [tab, setTab] = useState<'overview' | 'policy' | 'history' | 'documents'>('overview');
  const [historyModal, setHistoryModal] = useState<{ open: boolean; row: SubmissionHistory | null }>({ open: false, row: null });

  useEffect(() => {
    if (!capability) return;
    form.resetFields();
    form.setFieldsValue({ ...capability, fundingAsk: capability.fundingAsk ?? undefined });
    setTab('overview');
  }, [capability, form]);

  const history = useQuery<SubmissionHistory[]>({
    queryKey: ['capability-history', clientId, capability?.id],
    queryFn: async () =>
      (await api.get<SubmissionHistory[]>(`/api/clients/${clientId}/capabilities/${capability!.id}/history`)).data,
    enabled: Boolean(capability),
  });

  const saveCapability = useMutation({
    mutationFn: async (values: Record<string, unknown>) =>
      (await api.patch(`/api/clients/${clientId}/capabilities/${capability!.id}`, cleanObject(values))).data,
    onSuccess: () => {
      message.success('Capability updated');
      onUpdated();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const saveHistory = useMutation({
    mutationFn: async ({ row, values }: { row: SubmissionHistory | null; values: Record<string, unknown> }) =>
      row
        ? (await api.patch(`/api/clients/${clientId}/history/${row.id}`, cleanObject(values))).data
        : (await api.post(`/api/clients/${clientId}/capabilities/${capability!.id}/history`, cleanObject(values))).data,
    onSuccess: () => {
      message.success(historyModal.row ? 'History updated' : 'History added');
      setHistoryModal({ open: false, row: null });
      void qc.invalidateQueries({ queryKey: ['capability-history', clientId, capability?.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const deleteHistory = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/clients/${clientId}/history/${id}`)).data,
    onSuccess: () => {
      message.success('History entry removed');
      void qc.invalidateQueries({ queryKey: ['capability-history', clientId, capability?.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const capabilityDocs = documents.filter((document) => document.source === `capability:${capability?.id}`);

  return (
    <>
      <Drawer
        title={capability?.name ?? 'Capability'}
        width={760}
        open={Boolean(capability)}
        onClose={onClose}
        extra={canManage && (tab === 'overview' || tab === 'policy') ? <Button type="primary" loading={saveCapability.isPending} onClick={() => form.submit()}>Save</Button> : null}
      >
        <Segmented
          block
          value={tab}
          options={[
            { label: 'Overview', value: 'overview' },
            { label: 'Budget & policy', value: 'policy' },
            { label: 'Advocacy history', value: 'history' },
            { label: 'Documents', value: 'documents' },
          ]}
          onChange={(value) => setTab(value as typeof tab)}
          style={{ marginBottom: 18 }}
        />

        <Form form={form} layout="vertical" disabled={!canManage} onFinish={(values) => saveCapability.mutate(values)}>
          {tab === 'overview' ? (
            <>
              <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
              <Space style={{ display: 'flex' }} align="start">
                <Form.Item name="type" label="Type"><Select options={['product', 'service', 'platform', 'technology'].map((value) => ({ label: titleCase(value), value }))} /></Form.Item>
                <Form.Item name="sector" label="Sector"><Select allowClear options={SECTOR_TAGS.map((value) => ({ value, label: SECTOR_LABELS[value] }))} /></Form.Item>
                <Form.Item name="trl" label="TRL"><InputNumber min={1} max={9} /></Form.Item>
                <Form.Item name="mrl" label="MRL"><InputNumber min={1} max={10} /></Form.Item>
              </Space>
              <Form.Item name="tags" label="Tags"><Select mode="tags" tokenSeparators={[',']} options={CAPABILITY_TAG_SUGGESTIONS.map((value) => ({ label: value, value }))} /></Form.Item>
              <Form.Item name="description" label="Description"><Input.TextArea rows={4} /></Form.Item>
              <Form.Item name="notes" label="Internal notes"><Input.TextArea rows={3} /></Form.Item>
            </>
          ) : null}
          {tab === 'policy' ? (
            <>
              <Form.Item name="peNumbers" label="Program Element numbers"><Select mode="tags" tokenSeparators={[',', ' ']} placeholder="0605053A" /></Form.Item>
              <Form.Item name="keywords" label="Match keywords"><Select mode="tags" tokenSeparators={[',']} /></Form.Item>
              <Space style={{ display: 'flex' }} align="start">
                <Form.Item name="appropriationAccount" label="Appropriation account"><Input /></Form.Item>
                <Form.Item name="serviceBranch" label="Service branch"><Input /></Form.Item>
                <Form.Item name="targetSubcommittee" label="Target subcommittee"><Input /></Form.Item>
              </Space>
              <Space style={{ display: 'flex' }} align="start">
                <Form.Item name="fundingAsk" label="Funding ask"><InputNumber min={0} prefix="$" style={{ width: 220 }} /></Form.Item>
                <Form.Item name="fundingAskLabel" label="Funding ask label"><Input placeholder="FY27 increase" /></Form.Item>
              </Space>
              <Form.Item name="justification" label="Justification"><Input.TextArea rows={4} /></Form.Item>
              <Form.Item name="districtNexus" label="District nexus"><Input.TextArea rows={3} /></Form.Item>
              <Form.Item name="existingContracts" label="Existing contracts"><Input.TextArea rows={3} /></Form.Item>
            </>
          ) : null}
        </Form>

        {tab === 'history' ? (
          <div>
            <div className="crm-drawer-section-head">
              <div><h3>Advocacy & funding history</h3><p>Public evidence can seed this record; users validate attribution and outcomes.</p></div>
              {canManage ? <Button type="primary" icon={<PlusOutlined />} onClick={() => setHistoryModal({ open: true, row: null })}>Add entry</Button> : null}
            </div>
            {history.isLoading ? <Skeleton active paragraph={{ rows: 4 }} /> : history.data?.length ? (
              <div className="crm-history-list">
                {history.data.map((entry) => (
                  <article key={entry.id} className="crm-history-row">
                    <span className="crm-history-year">{entry.fiscalYear}</span>
                    <span className={`crm-history-dot is-${entry.outcomeType}`} />
                    <span className="crm-history-content">
                      <b>{entry.title}</b>
                      {entry.meta ? <small>{entry.meta}</small> : null}
                      {entry.outcome ? <p>{entry.outcome}</p> : null}
                      {entry.notes ? <p className="muted">{entry.notes}</p> : null}
                    </span>
                    {canManage ? <span><Button type="text" icon={<EditOutlined />} onClick={() => setHistoryModal({ open: true, row: entry })} /><Button type="text" danger icon={<DeleteOutlined />} onClick={() => modal.confirm({ title: 'Remove history entry?', okText: 'Remove', okButtonProps: { danger: true }, onOk: () => deleteHistory.mutateAsync(entry.id) })} /></span> : null}
                  </article>
                ))}
              </div>
            ) : <Empty description="No advocacy history yet." />}
          </div>
        ) : null}

        {tab === 'documents' ? (
          <div>
            {canManage ? (
              <Upload
                multiple
                showUploadList={false}
                accept=".pdf,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.csv,image/*"
                beforeUpload={(file, fileList) => {
                  if (file.uid === fileList[0]?.uid) {
                    void onUpload(fileList.map((item) => item as File), `capability:${capability!.id}`)
                      .then(() => message.success('Capability document added'))
                      .catch((error) => message.error(errorMessage(error)));
                  }
                  return false;
                }}
              ><Button icon={<UploadOutlined />}>Upload document</Button></Upload>
            ) : null}
            <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
              Capability files also appear in the client Files tab, so the same record is never duplicated.
            </Typography.Paragraph>
            {capabilityDocs.length ? capabilityDocs.map((document) => (
              <div key={document.id} className="crm-file-row">
                <span className="crm-file-icon">{documentIcon(document.contentType, document.fileName)}</span>
                <span className="crm-file-info"><b>{document.fileName}</b><small>{formatDate(document.createdAt)}</small></span>
                <span className="crm-file-actions">{document.downloadUrl ? <Button type="text" icon={<DownloadOutlined />} href={document.downloadUrl} target="_blank" /> : null}{canManage ? <Button type="text" danger icon={<DeleteOutlined />} onClick={() => void onDeleteDocument(document)} /> : null}</span>
              </div>
            )) : <Empty description="No documents for this capability." />}
          </div>
        ) : null}
      </Drawer>
      <HistoryModal
        open={historyModal.open}
        row={historyModal.row}
        submitting={saveHistory.isPending}
        onCancel={() => setHistoryModal({ open: false, row: null })}
        onSubmit={(values) => saveHistory.mutate({ row: historyModal.row, values })}
      />
    </>
  );
}

function HistoryModal({
  open,
  row,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  row: SubmissionHistory | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [form] = Form.useForm();
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      fiscalYear: row?.fiscalYear,
      title: row?.title,
      meta: row?.meta,
      outcomeType: row?.outcomeType ?? 'in_progress',
      outcome: row?.outcome,
      notes: row?.notes,
    });
  }, [form, open, row]);
  return (
    <Modal title={row ? 'Edit advocacy history' : 'Add advocacy history'} open={open} onCancel={onCancel} onOk={() => form.submit()} confirmLoading={submitting} okText={row ? 'Save changes' : 'Add entry'} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="fiscalYear" label="Fiscal year" rules={[{ required: true }]}><Input placeholder="FY27" /></Form.Item>
          <Form.Item name="outcomeType" label="Status" initialValue="in_progress"><Select options={[
            { label: 'In progress', value: 'in_progress' },
            { label: 'Success', value: 'success' },
            { label: 'Partial', value: 'partial' },
            { label: 'Failed', value: 'failed' },
          ]} /></Form.Item>
        </Space>
        <Form.Item name="title" label="Effort / submission" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="meta" label="Vehicle, committee or evidence"><Input placeholder="HAC-D · PE 0605053A · LDA Q2" /></Form.Item>
        <Form.Item name="outcome" label="Outcome"><Input.TextArea rows={3} /></Form.Item>
        <Form.Item name="notes" label="Internal notes"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Modal>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  const empty = value === null || value === undefined || value === '';
  return <div className="crm-detail-row"><span className="crm-detail-label">{label}</span><span className={`crm-detail-value${mono ? ' is-mono' : ''}`}>{empty ? '—' : value}</span></div>;
}

function InlineTags({ values, max = 3 }: { values: string[]; max?: number }) {
  const clean = values.filter(Boolean);
  if (!clean.length) return <>—</>;
  return <span className="crm-inline-tags">{clean.slice(0, max).map((value) => <span key={value} className="crm-inline-tag">{value}</span>)}{clean.length > max ? <span className="crm-inline-tag">+{clean.length - max}</span> : null}</span>;
}

function CodeSummary({ values }: { values: string[] }) {
  return values.length ? <span className="is-mono">{values[0]}{values.length > 1 ? ` +${values.length - 1}` : ''}</span> : <>—</>;
}

function KbStatusTag({ status }: { status?: KbStatusResponse }) {
  const total = kbTotal(status);
  return total ? <Tag color="blue" icon={<DatabaseOutlined />}>{total} Meri knowledge items</Tag> : <Tag icon={<DatabaseOutlined />}>Not indexed yet</Tag>;
}

function buildActivityItems(
  actions: ActionCardDto[],
  meetings: Meeting[],
  documents: ClientAttachment[],
): ActivityItem[] {
  const rows: ActivityItem[] = [
    ...actions.map((action) => ({
      id: action.id,
      kind: 'action' as const,
      at: action.updatedAt,
      title: action.issueTitle,
      meta: `${STATUS_LABELS[action.status]} · ${action.recommendedAction}`,
    })),
    ...meetings.map((meeting) => ({
      id: meeting.id,
      kind: 'meeting' as const,
      at: meeting.startsAt,
      title: meeting.subject,
      meta: `${meeting.attendees.length} attendee${meeting.attendees.length === 1 ? '' : 's'}${meeting.notes.length ? ' · Notes' : ''}${meeting.debriefs.length ? ' · Debrief' : ''}`,
    })),
    ...documents.map((document) => ({
      id: document.id,
      kind: 'file' as const,
      at: document.createdAt,
      title: document.fileName,
      meta: `${documentSourceLabel(document.source)}${document.uploadedByName ? ` · ${document.uploadedByName}` : ''}${document.indexedAt ? ' · Indexed for Meri' : ''}`,
    })),
  ];
  const seen = new Set<string>();
  return rows
    .sort((a, b) => dateValue(b.at) - dateValue(a.at))
    .filter((row) => {
      const key = `${row.kind}:${row.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildAttentionItems(client: Client, actions: ActionCardDto[], meetings: Meeting[]) {
  const items: Array<{ id: string; urgent: boolean; title: string; copy: string; action: 'activity' | 'intelligence' | 'edit' }> = [];
  for (const action of actions.slice(0, 3)) {
    items.push({
      id: `action:${action.id}`,
      urgent: action.priority >= 80 || (action.deadline ? daysUntil(action.deadline) <= 7 : false),
      title: action.issueTitle,
      copy: action.whyItMatters || action.recommendedAction,
      action: 'activity',
    });
  }
  const samExpiration = readText(toRecord(client.intakeData), ['samExpirationDate']);
  const samDays = samExpiration ? daysUntil(samExpiration) : null;
  if (samDays != null && samDays >= 0 && samDays <= 60) {
    items.push({
      id: 'sam-expiration',
      urgent: samDays <= 30,
      title: `SAM.gov registration expires in ${samDays} day${samDays === 1 ? '' : 's'}`,
      copy: 'Update the client registration record so opportunity eligibility and government identifiers stay current.',
      action: 'edit',
    });
  }
  const now = Date.now();
  const upcoming = meetings
    .filter((meeting) => dateValue(meeting.startsAt) >= now)
    .sort((a, b) => dateValue(a.startsAt) - dateValue(b.startsAt))[0];
  if (upcoming && daysUntil(upcoming.startsAt) <= 7) {
    items.push({
      id: `meeting:${upcoming.id}`,
      urgent: daysUntil(upcoming.startsAt) <= 2,
      title: `Upcoming meeting: ${upcoming.subject}`,
      copy: `${formatDateTime(upcoming.startsAt)} · ${upcoming.attendees.length} attendee${upcoming.attendees.length === 1 ? '' : 's'}`,
      action: 'activity',
    });
  }
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

function readInitialRoute(): {
  tab: CrmTab;
  relationshipView: RelationshipView;
  intelligenceView: IntelligenceView;
} {
  let tab: CrmTab = 'overview';
  let relationshipView: RelationshipView = 'contacts';
  let intelligenceView: IntelligenceView = 'briefing';
  try {
    const raw = new URLSearchParams(window.location.search).get('tab');
    if (raw && TAB_LABELS.some((entry) => entry.key === raw)) tab = raw as CrmTab;
    if (raw === 'documents') tab = 'files';
    if (raw === 'people') {
      tab = 'relationships';
      relationshipView = 'contacts';
    }
    if (raw === 'targets') {
      tab = 'relationships';
      relationshipView = 'government';
    }
    if (raw === 'facilities') {
      tab = 'relationships';
      relationshipView = 'locations';
    }
    if (raw === 'tracker' || raw === 'radar' || raw === 'legiwatch') {
      tab = 'intelligence';
      intelligenceView = 'legiwatch';
    }
  } catch {
    /* ignore */
  }
  return { tab, relationshipView, intelligenceView };
}

function profileNotesOf(client: Client): string {
  const value = toRecord(client.intakeData)['profileNotes'];
  return typeof value === 'string' ? value : '';
}

function portfolioTags(client: Client): string[] {
  const tags: string[] = [];
  const sector = sectorLabelFor(client);
  if (sector) tags.push(sector);
  for (const track of client.submissionTracks ?? []) {
    const label = SUBMISSION_TRACK_LABELS[track as SubmissionTrack] ?? track;
    if (label && !tags.includes(label)) tags.push(label);
  }
  return tags;
}

function sectorLabelFor(client: Client): string | undefined {
  if (client.sectorTag) return SECTOR_LABELS[client.sectorTag as SectorTag] ?? client.sectorTag;
  const raw = readText(toRecord(client.intakeData), ['sector']);
  if (!raw) return undefined;
  const normalized = normalizeSector(raw);
  return normalized ? SECTOR_LABELS[normalized] : raw;
}

function documentSourceLabel(source: string | null | undefined): string {
  const value = (source ?? '').toLowerCase();
  if (value.startsWith('capability:')) return 'Capability document';
  if (value.includes('hearing')) return 'Hearing recap';
  if (value.includes('meeting')) return 'Meeting record';
  if (value.includes('memo') || value.includes('generated')) return 'Generated work';
  if (value.includes('mail') || value.includes('email')) return 'Email attachment';
  return 'Uploaded file';
}

function documentIcon(contentType: string, fileName: string) {
  if (contentType.startsWith('image/')) return <FileImageOutlined />;
  if (contentType === 'application/pdf' || /\.pdf$/i.test(fileName)) return <FilePdfOutlined />;
  if (contentType === 'text/plain' || /\.txt$/i.test(fileName)) return <FileTextOutlined />;
  return <FileOutlined />;
}

function kbTotal(status?: KbStatusResponse): number {
  const values = Object.values(status?.counts ?? {}) as Array<number | undefined>;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}

function optional(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanObject(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      typeof value === 'string' && value.trim() === '' ? null : value,
    ]),
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase()
    : (parts[0] ?? 'CL').slice(0, 2).toUpperCase();
}

function externalUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function titleCase(value: string): string {
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateValue(value: string | null | undefined): number {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function deadlineValue(value: string | null | undefined): number {
  const time = value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function daysUntil(value: string): number {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 9999;
  return Math.ceil((time - Date.now()) / 86_400_000);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatOptionalDate(value: string | undefined): string | null {
  return value ? formatDate(value) : null;
}

function formatMonthYear(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatActivityDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value).toLocaleString()}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const message = (error as { response?: { data?: { message?: unknown } } }).response?.data?.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}

const CRM_STYLES = `
.crm-profile{--c-bg:#f4f6f8;--c-s:#fff;--c-b:#e1e6ec;--c-ink:#182231;--c-ink2:#4a586c;--c-ink3:#778397;--c-navy:#183861;--c-blue:#28649d;--c-green:#26744b;--c-amber:#9b671c;--c-red:#b43b34;display:flex;flex:1;min-height:0;flex-direction:column;overflow:hidden;background:var(--c-bg);color:var(--c-ink)}
.crm-profile *{box-sizing:border-box}.crm-account-header{padding:18px 24px 0;background:#fff;border-bottom:1px solid var(--c-b)}.crm-account-header__top{display:flex;align-items:flex-start;gap:15px}.crm-account-back{display:flex;width:32px;height:32px;align-items:center;justify-content:center;margin-top:8px;border:1px solid var(--c-b);border-radius:8px;background:#fff;color:var(--c-ink2);cursor:pointer}.crm-account-logo{display:flex;width:58px;height:58px;flex:0 0 58px;align-items:center;justify-content:center;overflow:hidden;border:1px solid var(--c-b);border-radius:12px;background:#f7f9fb;color:var(--c-navy);font-size:18px;font-weight:800}.crm-account-logo img{width:100%;height:100%;object-fit:contain}.crm-account-identity{min-width:0;flex:1}.crm-account-title-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.crm-account-name{margin:0;font-size:23px;line-height:1.2;letter-spacing:-.025em}.crm-account-status{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;background:#edf8f1;color:var(--c-green);font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}.crm-account-status:before{width:6px;height:6px;border-radius:50%;background:currentColor;content:''}.crm-account-status.is-inactive{background:#fff6e5;color:var(--c-amber)}.crm-account-status.is-archived{background:#eef0f3;color:var(--c-ink3)}.crm-account-subtitle,.crm-account-contact-line{display:flex;gap:8px;flex-wrap:wrap;margin-top:5px;color:var(--c-ink3);font-size:12.5px}.crm-account-subtitle span:not(:last-child):after{margin-left:8px;content:'·'}.crm-account-contact-line a{color:var(--c-ink2);text-decoration:none}.crm-account-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap;padding-top:5px}.crm-primary-action.ant-btn-primary{background:var(--c-navy);border-color:var(--c-navy);box-shadow:none}.crm-profile-tabs{display:flex;align-items:flex-end;gap:2px;margin:15px 0 0 105px;overflow-x:auto}.crm-profile-tab{position:relative;display:flex;min-height:39px;align-items:center;gap:7px;padding:0 13px;border:0;background:transparent;color:var(--c-ink3);cursor:pointer;font:inherit;font-size:12.5px;font-weight:650;white-space:nowrap}.crm-profile-tab:after{position:absolute;right:12px;bottom:0;left:12px;height:2px;border-radius:2px;background:transparent;content:''}.crm-profile-tab.is-active{color:var(--c-navy)}.crm-profile-tab.is-active:after{background:var(--c-navy)}.crm-tab-count{display:inline-flex;min-width:19px;height:19px;align-items:center;justify-content:center;padding:0 5px;border-radius:999px;background:#edf0f4;color:var(--c-ink2);font-size:10.5px}.crm-tab-alert{width:7px;height:7px;border-radius:50%;background:var(--c-red)}.crm-profile-body{min-height:0;flex:1;overflow:auto;padding:20px 24px 34px}.crm-overview{display:grid;max-width:1440px;margin:0 auto;grid-template-columns:minmax(0,1fr) 320px;gap:18px}.crm-overview-main,.crm-overview-rail{display:flex;min-width:0;flex-direction:column;gap:16px}.crm-card{overflow:hidden;border:1px solid var(--c-b);border-radius:10px;background:#fff}.crm-card__header{display:flex;min-height:46px;align-items:center;gap:9px;padding:0 16px;border-bottom:1px solid var(--c-b)}.crm-card__header h2,.crm-card__header h3{margin:0;font-size:13px}.crm-card__eyebrow{color:var(--c-ink3);font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.crm-card__grow{flex:1}.crm-card__muted{color:var(--c-ink3);font-size:11px}.crm-card__body{padding:15px 16px}.crm-attention-list{display:flex;flex-direction:column}.crm-attention-item{display:grid;width:100%;grid-template-columns:9px minmax(0,1fr) auto;gap:12px;padding:14px 16px;border:0;border-bottom:1px solid var(--c-b);background:#fff;text-align:left;cursor:pointer}.crm-attention-item:last-child{border-bottom:0}.crm-attention-item:hover{background:#f8fafc}.crm-attention-dot{width:8px;height:8px;margin-top:5px;border-radius:50%;background:var(--c-amber)}.crm-attention-item.is-urgent .crm-attention-dot{background:var(--c-red)}.crm-attention-title,.crm-attention-copy{display:block}.crm-attention-title{font-size:13px;font-weight:750}.crm-attention-copy{margin-top:4px;color:var(--c-ink2);font-size:12px;line-height:1.45}.crm-attention-action{align-self:center;color:var(--c-blue);font-size:11.5px;font-weight:700}.crm-empty-copy{padding:25px 16px;color:var(--c-ink3);font-size:12.5px;text-align:center}.crm-work-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr))}.crm-work-stat{display:flex;min-width:0;flex-direction:column;padding:16px;border:0;border-right:1px solid var(--c-b);background:#fff;text-align:left;cursor:pointer}.crm-work-stat:last-child{border-right:0}.crm-work-stat:hover{background:#f8fafc}.crm-work-stat__value{font-size:22px;font-weight:800;letter-spacing:-.03em}.crm-work-stat__label{margin-top:3px;color:var(--c-ink3);font-size:11px}.crm-timeline-item{display:grid;min-height:62px;grid-template-columns:82px 13px minmax(0,1fr);gap:10px;padding:10px 16px}.crm-timeline-time{padding-top:1px;color:var(--c-ink3);font-size:11px;text-align:right}.crm-timeline-marker{position:relative}.crm-timeline-marker:before{position:absolute;top:5px;left:3px;width:7px;height:7px;border:2px solid #fff;border-radius:50%;background:var(--c-blue);box-shadow:0 0 0 1px var(--c-blue);content:'';z-index:2}.crm-timeline-marker:after{position:absolute;top:14px;bottom:-16px;left:6px;width:1px;background:var(--c-b);content:''}.crm-timeline-item:last-child .crm-timeline-marker:after{display:none}.crm-timeline-marker.is-meeting:before{background:#6d4ab1;box-shadow:0 0 0 1px #6d4ab1}.crm-timeline-marker.is-file:before{background:var(--c-green);box-shadow:0 0 0 1px var(--c-green)}.crm-timeline-title{font-size:12.5px;font-weight:750}.crm-timeline-meta{margin-top:3px;color:var(--c-ink3);font-size:11.5px;line-height:1.45}.crm-detail-row{display:grid;grid-template-columns:104px minmax(0,1fr);gap:10px;padding:9px 0;border-bottom:1px solid var(--c-b)}.crm-detail-row:last-child{border-bottom:0}.crm-detail-label{color:var(--c-ink3);font-size:11.5px}.crm-detail-value{min-width:0;color:var(--c-ink2);font-size:12px;font-weight:650;overflow-wrap:anywhere}.crm-detail-value a{color:var(--c-blue);text-decoration:none}.is-mono,.crm-detail-value.is-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}.crm-inline-tags{display:flex;gap:4px;flex-wrap:wrap}.crm-inline-tag{display:inline-flex;padding:3px 7px;border:1px solid var(--c-b);border-radius:999px;background:#f8fafc;color:var(--c-ink2);font-size:10px;font-weight:650}.crm-context-label{font-size:14px;font-weight:800}.crm-context-meter{height:6px;overflow:hidden;margin:10px 0 8px;border-radius:999px;background:#edf0f4}.crm-context-meter span{display:block;height:100%;border-radius:inherit;background:var(--c-green)}.crm-context-summary{color:var(--c-ink3);font-size:11.5px;line-height:1.5}.crm-section-shell{max-width:1440px;margin:0 auto}.crm-section-head,.crm-drawer-section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.crm-section-head h2,.crm-drawer-section-head h3{margin:0;font-size:19px}.crm-section-head p,.crm-drawer-section-head p{margin:4px 0 0;color:var(--c-ink3);font-size:12px}.crm-related-list__head,.crm-related-list__row{display:grid;grid-template-columns:minmax(260px,2fr) 110px 150px 120px 44px;gap:14px;align-items:center;padding:12px 16px}.crm-related-list__head{background:#f7f9fb;color:var(--c-ink3);font-size:10.5px;font-weight:750;text-transform:uppercase;letter-spacing:.05em}.crm-related-list__row{width:100%;border:0;border-top:1px solid var(--c-b);background:#fff;color:var(--c-ink2);font-size:12px;text-align:left;cursor:pointer}.crm-related-list__row:hover{background:#f8fafc}.crm-related-list__row b,.crm-related-list__row small{display:block}.crm-related-list__row b{color:var(--c-ink);font-size:12.5px}.crm-related-list__row small{max-width:560px;margin-top:3px;overflow:hidden;color:var(--c-ink3);text-overflow:ellipsis;white-space:nowrap}.crm-empty-state{display:flex;min-height:280px;align-items:center;justify-content:center;flex-direction:column;padding:30px;color:var(--c-ink3);text-align:center}.crm-empty-state>.anticon{font-size:28px}.crm-empty-state h3{margin:12px 0 4px;color:var(--c-ink)}.crm-empty-state p{max-width:520px;margin:0 0 14px}.crm-contact-grid{display:grid;padding:16px;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.crm-contact-card{padding:14px;border:1px solid var(--c-b);border-radius:9px;background:#fff}.crm-contact-card__top{display:flex;align-items:flex-start;gap:9px}.crm-avatar{display:flex;width:36px;height:36px;align-items:center;justify-content:center;border-radius:50%;background:#edf3fa;color:var(--c-navy);font-size:11px;font-weight:800}.crm-contact-card__identity{min-width:0;flex:1}.crm-contact-card__identity b,.crm-contact-card__identity small{display:block}.crm-contact-card__identity small{margin-top:2px;color:var(--c-ink3);font-size:11px}.crm-contact-card__details{display:flex;flex-direction:column;gap:5px;margin-top:12px;color:var(--c-ink3);font-size:11.5px}.crm-contact-card__details a{color:var(--c-ink2);text-decoration:none}.crm-contact-card__details p{margin:4px 0 0;line-height:1.45}.crm-contact-card__actions{display:flex;gap:6px;margin-top:12px}.crm-upload-wrap{padding:14px 16px;border-bottom:1px solid var(--c-b)}.crm-file-row{display:grid;grid-template-columns:34px minmax(0,1fr) auto auto;gap:11px;align-items:center;padding:11px 16px;border-top:1px solid var(--c-b)}.crm-file-icon{display:flex;width:32px;height:32px;align-items:center;justify-content:center;border-radius:7px;background:#f1f4f7;color:var(--c-blue)}.crm-file-info b,.crm-file-info small{display:block}.crm-file-info b{font-size:12.5px}.crm-file-info small{margin-top:2px;color:var(--c-ink3);font-size:10.5px}.crm-file-actions{display:flex}.crm-history-row{display:grid;grid-template-columns:60px 12px minmax(0,1fr) auto;gap:10px;padding:13px 0;border-bottom:1px solid var(--c-b)}.crm-history-year{font-weight:800}.crm-history-dot{width:8px;height:8px;margin-top:5px;border-radius:50%;background:var(--c-amber)}.crm-history-dot.is-success{background:var(--c-green)}.crm-history-dot.is-failed{background:var(--c-red)}.crm-history-content b,.crm-history-content small{display:block}.crm-history-content small{margin-top:3px;color:var(--c-ink3)}.crm-history-content p{margin:6px 0 0;font-size:12px}.crm-history-content p.muted{color:var(--c-ink3)}
@media(max-width:1150px){.crm-overview{grid-template-columns:1fr}.crm-overview-rail{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.crm-work-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.crm-work-stat:nth-child(3n){border-right:0}.crm-work-stat:nth-child(-n+3){border-bottom:1px solid var(--c-b)}.crm-contact-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){.crm-account-header{padding:14px 14px 0}.crm-account-header__top{flex-wrap:wrap}.crm-account-actions{width:100%;justify-content:flex-start;padding-left:104px}.crm-profile-tabs{margin-left:0}.crm-profile-body{padding:14px}.crm-overview-rail{display:flex}.crm-work-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.crm-related-list__head{display:none}.crm-related-list__row{grid-template-columns:1fr auto}.crm-related-list__row>span:nth-child(2),.crm-related-list__row>span:nth-child(3),.crm-related-list__row>span:nth-child(4){display:none}.crm-contact-grid{grid-template-columns:1fr}.crm-attention-item{grid-template-columns:9px minmax(0,1fr)}.crm-attention-action{grid-column:2;justify-self:start}.crm-section-head{align-items:flex-start;flex-direction:column}.crm-file-row{grid-template-columns:34px minmax(0,1fr) auto}.crm-file-row>span:nth-child(3){display:none}}
`;
