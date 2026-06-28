import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeftOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownOutlined,
  RightOutlined,
  DownloadOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  LinkOutlined,
  MailOutlined,
  MessageOutlined,
  PhoneOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import { useApi } from '../../lib/use-api.js';
import { useClientFilter } from '../../state/client-filter.js';
import {
  clearChatSession,
  setActiveConversation,
  setChatOpen,
} from '../../components/chat/chat-store.js';
import {
  CAPABILITY_TAG_SUGGESTIONS,
  SECTOR_LABELS,
  SECTOR_TAGS,
  SUBMISSION_TRACK_LABELS,
  normalizeSector,
  type SectorTag,
  type SubmissionTrack,
} from '@capiro/shared';
import type { Capability } from './CapabilityDrawer.js';
import { CapabilityDrawer } from './CapabilityDrawer.js';
import type { Client, ClientAttachment, ClientFormSubmit } from './clientTypes.js';
import { IntelligenceTab } from './IntelligenceTab.js';
import { TargetsTab } from './TargetsTab.js';
import { TrackerTab } from './tracker/TrackerTab.js';
import type { TrackerSummary } from './tracker/tracker-api.js';
import { FacilitiesEditor } from './FacilitiesEditor.js';
import { DefenseBudgetExposureCard } from './DefenseBudgetExposureCard.js';
import { getRelevantPesForClient } from './relevance-api.js';
import type { ClientFacility } from './facilities-api.js';

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
}

type ProfileTab =
  | 'overview'
  | 'capabilities'
  | 'targets'
  | 'tracker'
  | 'people'
  | 'facilities'
  | 'documents'
  | 'intelligence';

const PROFILE_TABS: ProfileTab[] = [
  'overview',
  'capabilities',
  'targets',
  'tracker',
  'people',
  'facilities',
  'documents',
  'intelligence',
];

const STATUS_COLOR: Record<string, string> = {
  active: '#52c41a',
  inactive: '#faad14',
  archived: '#8c8c8c',
};

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
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { setSelectedClientId } = useClientFilter();
  const [activeTab, setActiveTab] = useState<ProfileTab>(() => {
    // Deep links (e.g. Tracker alert emails → ?tab=tracker) open a specific tab.
    try {
      const t = new URLSearchParams(window.location.search).get('tab');
      if (t && (PROFILE_TABS as string[]).includes(t)) return t as ProfileTab;
    } catch {
      /* ignore */
    }
    return 'overview';
  });

  // "Ask Meri about this client": scope the global client filter to this
  // client and open the chat drawer with a fresh session. ChatDrawer creates
  // its next conversation with the selected client as the conversation's
  // clientId (on open, or lazily on first send if it is already open).
  const askMeriAboutClient = () => {
    setSelectedClientId(client.id);
    clearChatSession();
    setActiveConversation(null);
    setChatOpen(true);
  };
  // Track the SELECTED CAPABILITY BY ID, not by snapshot object. The drawer edits
  // capabilities inline; if we held a snapshot, an edit would refetch the list but
  // leave the drawer pointing at the stale object, so the just-edited value would
  // visually revert ("can't edit"). Deriving from the live query keeps it fresh.
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string | null>(null);
  const [addCapabilityOpen, setAddCapabilityOpen] = useState(false);
  const [addPersonOpen, setAddPersonOpen] = useState(false);

  const capabilities = useQuery<Capability[]>({
    queryKey: ['client-capabilities', client.id],
    queryFn: async () =>
      (await api.get<Capability[]>(`/api/clients/${client.id}/capabilities`)).data,
  });

  const selectedCapability = capabilities.data?.find((c) => c.id === selectedCapabilityId) ?? null;

  const people = useQuery<ClientPerson[]>({
    queryKey: ['client-people', client.id],
    queryFn: async () => (await api.get<ClientPerson[]>(`/api/clients/${client.id}/people`)).data,
    // Eager-load for tab badge counts; cheap query and lets the tab strip
    // show "(N)" without waiting for the user to click in.
  });

  const docsCount = useQuery<{ id: string }[]>({
    // Same key as DocumentsTab so upload/delete invalidations refresh the badge
    // and React Query dedupes the duplicate fetch.
    queryKey: ['client-attachments', client.id],
    queryFn: async () =>
      (
        await api.get<{ id: string }[]>('/api/engagement/attachments', {
          params: { clientId: client.id },
        })
      ).data,
    staleTime: 60_000,
  });

  const facilitiesCount = useQuery<ClientFacility[]>({
    queryKey: ['client-facilities', client.id],
    queryFn: async () =>
      (await api.get<ClientFacility[]>(`/api/clients/${client.id}/facilities`)).data,
    staleTime: 60_000,
  });

  // Tracker tab badge: number of bills on the board + an unread-alert dot.
  const trackerSummary = useQuery<TrackerSummary>({
    queryKey: ['tracker-summary', client.id],
    queryFn: async () =>
      (await api.get<TrackerSummary>(`/api/intelligence/clients/${client.id}/tracker/summary`))
        .data,
    staleTime: 60_000,
  });

  const createCapability = useMutation({
    mutationFn: async (data: Record<string, unknown>) =>
      (await api.post(`/api/clients/${client.id}/capabilities`, data)).data,
    onSuccess: () => {
      message.success('Capability added');
      setAddCapabilityOpen(false);
      qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const deleteCapability = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/api/clients/${client.id}/capabilities/${id}`)).data,
    onSuccess: () => {
      message.success('Capability removed');
      if (selectedCapabilityId) setSelectedCapabilityId(null);
      qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const createPerson = useMutation({
    mutationFn: async (data: Record<string, unknown>) =>
      (await api.post(`/api/clients/${client.id}/people`, data)).data,
    onSuccess: () => {
      message.success('Person added');
      setAddPersonOpen(false);
      qc.invalidateQueries({ queryKey: ['client-people', client.id] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const deletePerson = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/api/clients/${client.id}/people/${id}`)).data,
    onSuccess: () => {
      message.success('Person removed');
      qc.invalidateQueries({ queryKey: ['client-people', client.id] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const intake = toRecord(client.intakeData);
  const tags = portfolioTags(client);

  return (
    <div
      className="redesign"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        background: 'var(--bg-canvas)',
      }}
    >
      <h1 className="cp-page-title">Portfolio</h1>

      {/* Banner */}
      <div className="cp-banner">
        <button className="cp-back" onClick={onBack} aria-label="Back to clients">
          <ArrowLeftOutlined style={{ fontSize: 13 }} />
        </button>

        <div className="cp-logo">
          {client.logoUrl ? <img src={client.logoUrl} alt={client.name} /> : initials(client.name)}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cp-name">{client.name}</div>
          <div className="cp-meta">
            {client.website ? (
              <a
                href={externalUrl(client.website)}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <LinkOutlined /> {client.website}
              </a>
            ) : null}
            {client.primaryContactName ? <span>{client.primaryContactName}</span> : null}
            {client.primaryContactEmail ? (
              <a href={`mailto:${client.primaryContactEmail}`}>
                <MailOutlined /> {client.primaryContactEmail}
              </a>
            ) : null}
            {client.primaryContactPhone ? (
              <a href={`tel:${client.primaryContactPhone.replace(/[^\d+]/g, '')}`}>
                <PhoneOutlined /> {client.primaryContactPhone}
              </a>
            ) : null}
          </div>
          {tags.length ? (
            <div className="cp-tag-row">
              {tags.slice(0, 5).map((tag) => (
                <span key={tag} className="cp-tag">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="cp-actions">
          <Tooltip title="Ask Meri about this client">
            <Button
              size="small"
              icon={<MessageOutlined />}
              onClick={askMeriAboutClient}
              aria-label="Ask Meri about this client"
              style={{
                borderColor: 'rgba(255,255,255,.25)',
                color: 'rgba(255,255,255,.8)',
                background: 'transparent',
              }}
            >
              Ask Meri
            </Button>
          </Tooltip>
          <Upload
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            showUploadList={false}
            beforeUpload={(file) => {
              if ((file as File).size > 2 * 1024 * 1024) {
                void message.error('Logo must be 2 MB or smaller.');
                return Upload.LIST_IGNORE;
              }
              void onUploadLogo(client, file as File)
                .then(() => onClientUpdated())
                .catch((err) => message.error(errorMessage(err)));
              return false;
            }}
          >
            <Tooltip title="PNG, JPG, SVG or WebP. Max 2 MB.">
              <Button
                size="small"
                icon={<UploadOutlined />}
                style={{
                  borderColor: 'rgba(255,255,255,.25)',
                  color: 'rgba(255,255,255,.8)',
                  background: 'transparent',
                }}
              >
                Logo
              </Button>
            </Tooltip>
          </Upload>
          <Button
            size="small"
            disabled={!canManageClients}
            onClick={() => onEdit(client)}
            style={{
              borderColor: 'rgba(255,255,255,.25)',
              color: 'rgba(255,255,255,.8)',
              background: 'transparent',
            }}
          >
            Edit
          </Button>
          {canRemoveClients ? (
            <Button
              size="small"
              onClick={() => onRemove(client)}
              style={{
                borderColor: 'rgba(255,100,100,.4)',
                color: '#ff7875',
                background: 'transparent',
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      {/* Tab nav */}
      <div className="cp-tabs" role="tablist" aria-label="Client profile sections">
        {PROFILE_TABS.map((tab) => {
          const badge =
            tab === 'capabilities'
              ? capabilities.data?.length
              : tab === 'people'
                ? people.data?.length
                : tab === 'facilities'
                  ? facilitiesCount.data?.length
                  : tab === 'documents'
                    ? docsCount.data?.length
                    : tab === 'tracker'
                      ? trackerSummary.data?.boardCount
                      : null;
          return (
            <div
              key={tab}
              id={`cp-tab-${tab}`}
              className={`cp-tab${activeTab === tab ? ' active' : ''}`}
              onClick={() => setActiveTab(tab)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setActiveTab(tab);
                  return;
                }
                // WAI-ARIA tabs pattern: arrows/Home/End move focus AND selection.
                const idx = PROFILE_TABS.indexOf(tab);
                const next =
                  event.key === 'ArrowRight'
                    ? PROFILE_TABS[(idx + 1) % PROFILE_TABS.length]
                    : event.key === 'ArrowLeft'
                      ? PROFILE_TABS[(idx - 1 + PROFILE_TABS.length) % PROFILE_TABS.length]
                      : event.key === 'Home'
                        ? PROFILE_TABS[0]
                        : event.key === 'End'
                          ? PROFILE_TABS[PROFILE_TABS.length - 1]
                          : undefined;
                if (next) {
                  event.preventDefault();
                  setActiveTab(next);
                  document.getElementById(`cp-tab-${next}`)?.focus();
                }
              }}
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls="cp-tabpanel"
              tabIndex={activeTab === tab ? 0 : -1}
            >
              <span>
                {tab === 'overview'
                  ? 'Overview'
                  : tab === 'capabilities'
                    ? 'Capabilities'
                    : tab === 'targets'
                      ? 'Targets'
                      : tab === 'tracker'
                        ? 'Tracker'
                        : tab === 'people'
                          ? 'People'
                          : tab === 'facilities'
                            ? 'Facilities'
                            : tab === 'documents'
                              ? 'Documents'
                              : 'Intelligence'}
              </span>
              {badge != null && badge > 0 ? (
                <span className="cp-tab-badge num">{badge}</span>
              ) : null}
              {tab === 'tracker' && (trackerSummary.data?.unread ?? 0) > 0 ? (
                <span className="cp-tab-alert" title="Unread bill alerts" />
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Body */}
      <div className={`cp-body${selectedCapability ? ' cp-body--with-drawer' : ''}`}>
        <div
          className="cp-content"
          role="tabpanel"
          id="cp-tabpanel"
          aria-labelledby={`cp-tab-${activeTab}`}
          style={selectedCapability ? { flex: 1, overflowY: 'auto' } : {}}
        >
          {activeTab === 'overview' && (
            <OverviewTab
              client={client}
              intake={intake}
              capabilities={capabilities.data ?? []}
              capsLoading={capabilities.isLoading}
              people={people.data ?? []}
              peopleLoading={people.isLoading}
              onViewAllCaps={() => setActiveTab('capabilities')}
              onViewAllPeople={() => setActiveTab('people')}
              onCapClick={(cap) => {
                // Open the capability in the dedicated Capabilities tab (with the
                // drawer) rather than over the Overview, so the user lands in the
                // full editing context.
                setActiveTab('capabilities');
                setSelectedCapabilityId(cap.id);
              }}
              onAddCap={() => setAddCapabilityOpen(true)}
            />
          )}
          {activeTab === 'capabilities' && (
            <CapabilitiesTab
              capabilities={capabilities.data ?? []}
              loading={capabilities.isLoading}
              onCapClick={(cap) => setSelectedCapabilityId(cap.id)}
              onAddCap={() => setAddCapabilityOpen(true)}
              onDeleteCap={(id) => {
                modal.confirm({
                  title: 'Remove this capability?',
                  content:
                    'Submission history is kept but will no longer be linked to this capability.',
                  okText: 'Remove',
                  okButtonProps: { danger: true },
                  onOk: () => deleteCapability.mutateAsync(id),
                });
              }}
            />
          )}
          {activeTab === 'targets' && (
            <TargetsTab
              clientId={client.id}
              canManage={canManageClients}
              onViewIntelligence={() => setActiveTab('intelligence')}
            />
          )}
          {activeTab === 'tracker' && <TrackerTab clientId={client.id} clientName={client.name} />}
          {activeTab === 'people' && (
            <PeopleTab
              people={people.data ?? []}
              loading={people.isLoading}
              onAddPerson={() => setAddPersonOpen(true)}
              onDeletePerson={(id) => {
                modal.confirm({
                  title: 'Remove this person?',
                  okText: 'Remove',
                  okButtonProps: { danger: true },
                  onOk: () => deletePerson.mutateAsync(id),
                });
              }}
            />
          )}
          {activeTab === 'facilities' && (
            <FacilitiesEditor clientId={client.id} canManage={canManageClients} />
          )}
          {activeTab === 'documents' && (
            <DocumentsTab
              client={client}
              canManage={canManageClients}
              onClientUpdated={onClientUpdated}
            />
          )}
          {activeTab === 'intelligence' && (
            <IntelligenceTab clientId={client.id} clientName={client.name} />
          )}
        </div>

        {selectedCapability ? (
          <CapabilityDrawer
            capability={selectedCapability}
            clientId={client.id}
            onClose={() => setSelectedCapabilityId(null)}
            onUpdated={() => {
              qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] });
            }}
            onDelete={() => {
              const cap = selectedCapability;
              if (!cap) return;
              modal.confirm({
                title: 'Remove this capability?',
                content:
                  'Submission history is kept but will no longer be linked to this capability.',
                okText: 'Remove',
                okButtonProps: { danger: true },
                onOk: () => deleteCapability.mutateAsync(cap.id),
              });
            }}
          />
        ) : null}
      </div>

      <AddCapabilityModal
        open={addCapabilityOpen}
        onCancel={() => setAddCapabilityOpen(false)}
        onSubmit={(data) => createCapability.mutate(data)}
        submitting={createCapability.isPending}
      />

      <AddPersonModal
        open={addPersonOpen}
        onCancel={() => setAddPersonOpen(false)}
        onSubmit={(data) => createPerson.mutate(data)}
        submitting={createPerson.isPending}
      />
    </div>
  );
}

/* ── Overview Tab ────────────────────────────────────────────────────────── */

function OverviewTab({
  client,
  intake,
  capabilities,
  capsLoading,
  people,
  peopleLoading,
  onViewAllCaps,
  onViewAllPeople,
  onCapClick,
  onAddCap,
}: {
  client: Client;
  intake: Record<string, unknown>;
  capabilities: Capability[];
  capsLoading: boolean;
  people: ClientPerson[];
  peopleLoading: boolean;
  onViewAllCaps: () => void;
  onViewAllPeople: () => void;
  onCapClick: (c: Capability) => void;
  onAddCap: () => void;
}) {
  const api = useApi();

  // Defense budget exposure: PEs this client is most relevant to (>= the API floor).
  // Fetched here so the card lives on the Overview tab; presentational card receives the data.
  const exposure = useQuery({
    queryKey: ['client-pe-relevance', client.id, { minScore: 0.5 }],
    queryFn: () => getRelevantPesForClient(api, client.id, { minScore: 0.5, limit: 8 }),
    staleTime: 60_000,
  });

  // Capabilities preview is collapsible; persist the choice across the session
  // (and future visits) via localStorage so it doesn't reset on every render.
  const [capsCollapsed, setCapsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('capiro:overview-caps-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleCaps = () =>
    setCapsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('capiro:overview-caps-collapsed', next ? '1' : '0');
      } catch {
        /* ignore storage failures (private mode, etc.) */
      }
      return next;
    });

  // Company-info fields.
  const dba = readText(intake, ['dba']);
  const location = formatLocation(intake);
  const sbClassLabels = sbClassificationLabels(intake);
  const engagementStart = readText(intake, ['engagementStartDate', 'engagement_start_date']);

  // Sector tags: prefer the stored multi-select list (intakeData.sectors),
  // rendered via controlled labels; fall back to the single primary sector.
  const sectorTagsList = readList(intake, ['sectors']);
  const sectorLabels = sectorTagsList.length
    ? sectorTagsList.map((s) => SECTOR_LABELS[s as SectorTag] ?? s)
    : (() => {
        const single = sectorLabelFor(client) ?? readText(intake, ['sector']);
        return single ? [single] : [];
      })();
  const submissionTracks = (client.submissionTracks ?? []).map(
    (t) => SUBMISSION_TRACK_LABELS[t as SubmissionTrack] ?? t,
  );

  return (
    <div className="overview-grid">
      <div>
        {/* Company information */}
        <section className="surface">
          <header className="surface-head">
            <h3>Company information</h3>
          </header>
          <div className="info-table">
            <InfoRow
              label="Legal name"
              value={<span style={{ fontWeight: 600 }}>{client.name}</span>}
            />
            <InfoRow label="DBA / trade name" value={dba} />
            <InfoRow
              label="Website"
              value={
                client.website ? (
                  <a
                    href={externalUrl(client.website)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--info)' }}
                  >
                    {client.website}
                  </a>
                ) : null
              }
            />
            <InfoRow label="Description" value={client.description} />
            <InfoRow label="Location" value={location} />
            <InfoRow
              label="Small Business Classification"
              value={
                sbClassLabels.length ? (
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {sbClassLabels.map((c) => (
                      <span key={c} className="tag-chip">
                        {c}
                      </span>
                    ))}
                  </span>
                ) : null
              }
            />
            <InfoRow
              label="Sector tags"
              value={
                sectorLabels.length ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {sectorLabels.map((label, i) => (
                      <span
                        key={label}
                        className="tag-chip"
                        style={
                          i === 0
                            ? {
                                background: 'var(--accent-soft)',
                                color: 'var(--accent-ink)',
                                borderColor: 'transparent',
                                fontWeight: 600,
                              }
                            : undefined
                        }
                      >
                        {label}
                      </span>
                    ))}
                  </span>
                ) : null
              }
            />
            <InfoRow
              label="Submission tracks"
              value={
                submissionTracks.length ? (
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {submissionTracks.map((t) => (
                      <span key={t} className="tag-chip">
                        {t}
                      </span>
                    ))}
                  </span>
                ) : null
              }
            />
            <InfoRow
              label="Engagement start"
              value={engagementStart ? formatDate(engagementStart) : null}
            />
            <InfoRow
              label="Status"
              value={
                <span>
                  <span
                    style={{ color: STATUS_COLOR[client.status] ?? '#8c8c8c', fontWeight: 600 }}
                  >
                    {titleCase(client.status)}
                  </span>
                  {' · since '}
                  {formatDate(client.createdAt)}
                </span>
              }
            />
          </div>
        </section>

        {/* Contact, only show if any company-level contact field is populated */}
        {client.primaryContactName || client.primaryContactEmail || client.primaryContactPhone ? (
          <section className="surface" style={{ marginTop: 14 }}>
            <header className="surface-head">
              <h3>Contact</h3>
            </header>
            <div className="info-table">
              <InfoRow label="Primary POC" value={client.primaryContactName} />
              <InfoRow
                label="Company email"
                value={
                  client.primaryContactEmail ? (
                    <a
                      href={`mailto:${client.primaryContactEmail}`}
                      style={{ color: 'var(--info)' }}
                    >
                      {client.primaryContactEmail}
                    </a>
                  ) : null
                }
              />
              <InfoRow
                label="Company phone"
                value={
                  client.primaryContactPhone ? (
                    <a
                      href={`tel:${client.primaryContactPhone.replace(/[^\d+]/g, '')}`}
                      style={{ color: 'var(--info)' }}
                    >
                      {client.primaryContactPhone}
                    </a>
                  ) : null
                }
              />
            </div>
          </section>
        ) : null}

        {/* Defense budget exposure: explainable client ⇄ PE relevance (Step 2.3). */}
        <DefenseBudgetExposureCard
          relevance={exposure.data}
          loading={exposure.isLoading}
          error={exposure.isError}
        />
      </div>

      <div>
        {/* Capabilities preview */}
        <section className="surface">
          <header className="surface-head">
            <button
              type="button"
              onClick={toggleCaps}
              aria-label={capsCollapsed ? 'Expand capabilities' : 'Collapse capabilities'}
              aria-expanded={!capsCollapsed}
              title={capsCollapsed ? 'Expand' : 'Collapse'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                marginRight: 6,
                color: 'var(--ink-3)',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              {capsCollapsed ? (
                <RightOutlined style={{ fontSize: 11 }} />
              ) : (
                <DownOutlined style={{ fontSize: 11 }} />
              )}
            </button>
            <h3>Capabilities</h3>
            <span className="sub">{capabilities.length} total</span>
            <button className="surface-link" onClick={onViewAllCaps} type="button">
              View all →
            </button>
          </header>
          {!capsCollapsed && (
            <>
              <div style={{ padding: 4 }}>
                {capsLoading ? (
                  <Skeleton active paragraph={{ rows: 3 }} />
                ) : capabilities.length === 0 ? (
                  <div style={{ padding: '20px 14px', fontSize: 12, color: 'var(--ink-3)' }}>
                    No capabilities yet.
                  </div>
                ) : (
                  capabilities.slice(0, 4).map((cap) => (
                    <button
                      type="button"
                      key={cap.id}
                      onClick={() => onCapClick(cap)}
                      className="overview-cap-row"
                    >
                      <span className="overview-cap-name">{cap.name}</span>
                      <span className="overview-cap-meta">
                        {cap.type ? (
                          <span className={`cap-pill ${cap.type.toLowerCase()}`}>{cap.type}</span>
                        ) : null}
                        {cap.sector ? <span className="cap-sector">{cap.sector}</span> : null}
                      </span>
                      <span className="overview-cap-trl num">
                        {cap.trl != null ? `TRL ${cap.trl}` : '-'}
                        {cap.mrl != null ? ` · MRL ${cap.mrl}` : ''}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <button
                className="she-add-btn"
                onClick={onAddCap}
                style={{ margin: '4px 14px 14px' }}
              >
                <PlusOutlined /> Add capability
              </button>
            </>
          )}
        </section>

        {/* Primary contacts preview */}
        <section className="surface" style={{ marginTop: 14 }}>
          <header className="surface-head">
            <h3>Primary contacts</h3>
            {people.length > 0 ? <span className="sub">{people.length} total</span> : null}
            {people.length > 0 ? (
              <button className="surface-link" onClick={onViewAllPeople} type="button">
                View all →
              </button>
            ) : null}
          </header>
          <div style={{ padding: '6px 14px 14px' }}>
            {peopleLoading ? (
              <Skeleton active paragraph={{ rows: 2 }} />
            ) : people.length === 0 ? (
              <div style={{ padding: '20px 0', fontSize: 12, color: 'var(--ink-3)' }}>
                No people added yet.
              </div>
            ) : (
              people.slice(0, 3).map((p) => (
                <div key={p.id} className="overview-person-row">
                  <span
                    className="overview-person-avatar"
                    style={{ background: avatarColor(p.id) }}
                  >
                    {personInitials(p.name)}
                  </span>
                  <span className="overview-person-text">
                    <span className="overview-person-name">{p.name}</span>
                    {p.title ? <span className="overview-person-title">{p.title}</span> : null}
                  </span>
                  {p.role ? <PersonRoleTag role={p.role} /> : null}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="info-row">
      <span className="k">{label}</span>
      <span className={`v${empty ? ' muted' : ''}`}>{empty ? '-' : value}</span>
    </div>
  );
}

function PersonRoleTag({ role }: { role: string }) {
  const lower = role.toLowerCase();
  const isPoc = lower.includes('primary') || lower.includes('poc');
  const isExec =
    lower.includes('exec') ||
    lower.includes('ceo') ||
    lower.includes('cfo') ||
    lower.includes('president');
  const bg = isPoc ? 'var(--accent-soft)' : isExec ? 'var(--notable-soft)' : 'var(--bg-sunken)';
  const color = isPoc ? 'var(--accent-ink)' : isExec ? 'var(--notable)' : 'var(--ink-2)';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        padding: '3px 8px',
        borderRadius: 4,
        background: bg,
        color,
        whiteSpace: 'nowrap',
      }}
    >
      {role}
    </span>
  );
}

function personInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
}

const AVATAR_PALETTE = [
  '#5e7ce2',
  '#7a3fb5',
  '#c98a1d',
  '#2e6b43',
  '#b5301b',
  '#1a3f9f',
  '#3a7a4d',
];
function avatarColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length] ?? AVATAR_PALETTE[0]!;
}

/* ── Capabilities Tab ────────────────────────────────────────────────────── */

function CapabilitiesTab({
  capabilities,
  loading,
  onCapClick,
  onAddCap,
  onDeleteCap,
}: {
  capabilities: Capability[];
  loading: boolean;
  onCapClick: (c: Capability) => void;
  onAddCap: () => void;
  onDeleteCap: (id: string) => void;
}) {
  if (loading) return <Skeleton active paragraph={{ rows: 5 }} />;

  return (
    <>
      <header className="cp-tab-header">
        <div>
          <h3 className="cp-tab-h3">Capabilities</h3>
          <p className="cp-tab-dek">
            Products, services, technologies, and programs, with full submission history per
            capability.
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} size="small" onClick={onAddCap}>
          Add capability
        </Button>
      </header>

      {capabilities.length ? (
        capabilities.map((cap) => (
          <div key={cap.id} className="cap-card-row">
            <CapabilityCard cap={cap} onClick={() => onCapClick(cap)} large />
            <div className="cap-card-actions" onClick={(e) => e.stopPropagation()}>
              <Button
                size="small"
                type="text"
                icon={<DeleteOutlined />}
                danger
                onClick={() => onDeleteCap(cap.id)}
              />
            </div>
          </div>
        ))
      ) : (
        <div className="cp-tab-empty">
          <Empty description="No capabilities yet." />
          <Button type="primary" icon={<PlusOutlined />} onClick={onAddCap}>
            Add capability
          </Button>
        </div>
      )}
    </>
  );
}

/* ── People Tab ─────────────────────────────────────────────────────────── */

function PeopleTab({
  people,
  loading,
  onAddPerson,
  onDeletePerson,
}: {
  people: ClientPerson[];
  loading: boolean;
  onAddPerson: () => void;
  onDeletePerson: (id: string) => void;
}) {
  if (loading) return <Skeleton active paragraph={{ rows: 4 }} />;

  return (
    <>
      <header className="cp-tab-header">
        <div>
          <h3 className="cp-tab-h3">People</h3>
          <p className="cp-tab-dek">
            Key contacts at this client, executives, government affairs, compliance, and operational
            POCs.
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} size="small" onClick={onAddPerson}>
          Add person
        </Button>
      </header>

      {people.length ? (
        <div className="cp-people-grid">
          {people.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              onDelete={() => onDeletePerson(person.id)}
            />
          ))}
        </div>
      ) : (
        <div className="cp-tab-empty">
          <Empty description="No people added yet." />
          <Button type="primary" icon={<PlusOutlined />} onClick={onAddPerson}>
            Add person
          </Button>
        </div>
      )}
    </>
  );
}

/* ── Documents Tab ──────────────────────────────────────────────────────── */

/** GET /api/clio/kb/:clientId/status — Meri knowledge-base index status (F5). */
interface KbStatusResponse {
  counts: {
    client_profile?: number;
    client_person?: number;
    client_facility?: number;
    client_doc_chunk?: number;
  };
  lastIndexedAt: string | null;
}

const KB_KIND_LABELS: Array<{ key: keyof KbStatusResponse['counts']; label: string }> = [
  { key: 'client_profile', label: 'Profile' },
  { key: 'client_person', label: 'People' },
  { key: 'client_facility', label: 'Facilities' },
  { key: 'client_doc_chunk', label: 'Document chunks' },
];

function kbRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function KbStatusChip({ status }: { status: KbStatusResponse }) {
  const counts = status.counts ?? {};
  const total = KB_KIND_LABELS.reduce((sum, kind) => sum + (counts[kind.key] ?? 0), 0);
  if (total === 0) {
    return (
      <Tooltip title="No knowledge-base entries indexed for this client yet.">
        <Tag icon={<DatabaseOutlined />}>Not indexed yet</Tag>
      </Tooltip>
    );
  }
  const breakdown = (
    <div>
      {KB_KIND_LABELS.map((kind) => (
        <div key={kind.key}>
          {kind.label}: {counts[kind.key] ?? 0}
        </div>
      ))}
    </div>
  );
  return (
    <Tooltip title={breakdown}>
      <Tag icon={<DatabaseOutlined />} color="blue">
        Meri knowledge: {total} item{total === 1 ? '' : 's'} indexed
        {status.lastIndexedAt ? ` · updated ${kbRelativeTime(status.lastIndexedAt)}` : ''}
      </Tag>
    </Tooltip>
  );
}

function DocumentsTab({
  client,
  canManage,
  onClientUpdated,
}: {
  client: Client;
  canManage: boolean;
  onClientUpdated: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notes, setNotes] = useState(() => {
    const v = toRecord(client.intakeData)['profileNotes'];
    return typeof v === 'string' ? v : '';
  });
  const [notesDirty, setNotesDirty] = useState(false);

  const docs = useQuery<ClientAttachment[]>({
    queryKey: ['client-attachments', client.id],
    queryFn: async () =>
      (
        await api.get<ClientAttachment[]>('/api/engagement/attachments', {
          params: { clientId: client.id },
        })
      ).data,
  });

  const kbStatus = useQuery<KbStatusResponse>({
    queryKey: ['client-kb-status', client.id],
    queryFn: async () => (await api.get<KbStatusResponse>(`/api/clio/kb/${client.id}/status`)).data,
    staleTime: 60_000,
  });

  const deleteDoc = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/engagement/attachments/${id}`)).data,
    onSuccess: () => {
      message.success('Document removed');
      qc.invalidateQueries({ queryKey: ['client-attachments', client.id] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const saveNotes = useMutation({
    // Dedicated endpoint merges the note server-side; a wholesale intakeData PUT
    // from a stale prop would silently drop concurrent edits.
    mutationFn: async (value: string) =>
      (await api.put(`/api/clients/${client.id}/profile-notes`, { notes: value })).data,
    onSuccess: () => {
      message.success('Notes saved');
      setNotesDirty(false);
      onClientUpdated();
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  async function handleFiles(files: FileList | File[]) {
    const fileArr = Array.from(files);
    if (!fileArr.length) return;
    setUploading(true);
    try {
      for (const file of fileArr) {
        const contentType = file.type || 'application/octet-stream';
        const presigned = (
          await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
            '/api/engagement/attachments/upload-url',
            { clientId: client.id, fileName: file.name, contentType, contentLength: file.size },
          )
        ).data;
        const form = new FormData();
        for (const [k, v] of Object.entries(presigned.fields)) form.append(k, v);
        form.append('file', file);
        const res = await fetch(presigned.url, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`S3 upload failed: ${res.status}`);
        await api.post('/api/engagement/attachments/confirm', {
          clientId: client.id,
          fileName: file.name,
          contentType,
          s3Key: presigned.s3Key,
        });
      }
      message.success(
        fileArr.length === 1 ? 'Document uploaded' : `${fileArr.length} documents uploaded`,
      );
      qc.invalidateQueries({ queryKey: ['client-attachments', client.id] });
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.csv,image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
        }}
      />

      <header className="cp-tab-header">
        <div>
          <h3 className="cp-tab-h3">Documents</h3>
          <p className="cp-tab-dek">
            Capiro auto-parses every upload and routes findings into the Intelligence tab.
          </p>
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {kbStatus.data ? <KbStatusChip status={kbStatus.data} /> : null}
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            {docs.data?.length ?? 0} file{(docs.data?.length ?? 0) === 1 ? '' : 's'}
          </span>
        </span>
      </header>

      <div
        className={`doc-drop-zone${dragging ? ' dragging' : ''}`}
        onClick={() => !uploading && fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files) void handleFiles(e.dataTransfer.files);
        }}
      >
        {uploading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Spin size="small" />
            <span>Uploading…</span>
          </div>
        ) : (
          <>
            <div className="doc-drop-zone-icon">
              <CloudUploadOutlined />
            </div>
            <div style={{ fontFamily: 'var(--font-sans-rd)' }}>
              Drop files here or{' '}
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>click to upload</span>
            </div>
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--ink-3)' }}>
              PDF, DOC, DOCX, TXT, images · max 25 MB each
            </div>
          </>
        )}
      </div>

      {docs.isLoading ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : docs.data?.length ? (
        <div className="doc-list">
          {docs.data.map((doc) => {
            const { bg, fg } = docColors(doc.contentType, doc.fileName);
            return (
              <div className="doc-item" key={doc.id}>
                <div className="doc-icon" style={{ background: bg, color: fg }}>
                  {docIcon(doc.contentType, doc.fileName)}
                </div>
                <div className="doc-info">
                  <div className="doc-name" title={doc.fileName}>
                    {doc.fileName}
                  </div>
                  <div className="doc-meta">
                    {formatDate(doc.createdAt)}
                    {doc.byteSize != null ? ` · ${formatBytes(doc.byteSize)}` : ''}
                  </div>
                </div>
                <div className="doc-actions">
                  {doc.downloadUrl ? (
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      type="text"
                      href={doc.downloadUrl}
                      target="_blank"
                      rel="noreferrer"
                    />
                  ) : null}
                  <Button
                    size="small"
                    icon={<DeleteOutlined />}
                    type="text"
                    danger
                    onClick={() => {
                      modal.confirm({
                        title: 'Remove document?',
                        okText: 'Remove',
                        okButtonProps: { danger: true },
                        onOk: () => deleteDoc.mutateAsync(doc.id),
                      });
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Typography.Text
          type="secondary"
          style={{ display: 'block', marginBottom: 20, fontSize: 13 }}
        >
          No documents yet. Upload files above.
        </Typography.Text>
      )}

      <div className="doc-notes-label">Client Notes</div>
      <Input.TextArea
        rows={4}
        placeholder="Add any additional context about this client…"
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
          setNotesDirty(true);
        }}
        disabled={!canManage}
        style={{ marginBottom: 8 }}
      />
      {canManage && notesDirty && (
        <Button
          size="small"
          type="primary"
          loading={saveNotes.isPending}
          onClick={() => saveNotes.mutate(notes)}
        >
          Save notes
        </Button>
      )}
    </div>
  );
}

function docColors(contentType: string, fileName: string): { bg: string; fg: string } {
  if (contentType.startsWith('image/')) return { bg: '#d1fae5', fg: '#065f46' };
  if (contentType === 'application/pdf' || /\.pdf$/i.test(fileName))
    return { bg: '#fee2e2', fg: '#991b1b' };
  if (contentType.includes('word') || /\.docx?$/i.test(fileName))
    return { bg: '#dbeafe', fg: '#1e40af' };
  if (contentType === 'text/plain' || /\.txt$/i.test(fileName))
    return { bg: '#f1f5f9', fg: '#475569' };
  return { bg: '#f2f4f7', fg: '#475467' };
}

function docIcon(contentType: string, fileName: string): ReactNode {
  if (contentType.startsWith('image/')) return <FileImageOutlined />;
  if (contentType === 'application/pdf' || /\.pdf$/i.test(fileName)) return <FilePdfOutlined />;
  if (contentType === 'text/plain' || /\.txt$/i.test(fileName)) return <FileTextOutlined />;
  return <FileOutlined />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Shared sub-components ───────────────────────────────────────────────── */

function CapabilityCard({
  cap,
  onClick,
  large,
}: {
  cap: Capability;
  onClick: () => void;
  large?: boolean;
}) {
  const typeKey = (cap.type ?? 'product').toLowerCase();
  const tags = Array.isArray(cap.tags) ? (cap.tags as string[]) : [];
  const ownerInitial = (cap.peNumber || cap.name || '?')[0]?.toUpperCase() ?? '?';

  return (
    <div className={`cap-card${large ? ' cap-card-large' : ''}`} onClick={onClick}>
      <div className="cap-card-hd">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cap-name" style={large ? { fontSize: 16 } : undefined}>
            {cap.name}
            {large ? <span className={`cap-pill ${typeKey}`}>{cap.type ?? 'Product'}</span> : null}
          </div>
          {!large ? (
            <div className="cap-tags-row">
              <span className={`cap-pill ${typeKey}`} style={{ textTransform: 'capitalize' }}>
                {cap.type}
              </span>
              {cap.sector ? <span className="cap-sector">{cap.sector}</span> : null}
              {tags.slice(0, 2).map((t) => (
                <span key={t} className="cap-sector">
                  {t}
                </span>
              ))}
            </div>
          ) : (
            <div className="cap-sectors">
              {cap.sector ? <span className="cap-sector">{cap.sector}</span> : null}
              {tags.slice(0, 4).map((t) => (
                <span key={t} className="cap-sector">
                  {t}
                </span>
              ))}
            </div>
          )}
          {large && cap.description ? <p className="cap-desc">{cap.description}</p> : null}
          {!large && (cap.trl != null || cap.mrl != null) ? (
            <div className="cap-trl">
              {[
                cap.trl != null ? `TRL ${cap.trl}` : null,
                cap.mrl != null ? `MRL ${cap.mrl}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          ) : null}
        </div>
        {!large && cap.fundingAsk != null ? (
          <div className="cap-ask">
            ${(cap.fundingAsk / 1_000_000).toFixed(cap.fundingAsk >= 10_000_000 ? 0 : 1)}M
            {cap.fundingAskLabel ? (
              <div className="cap-ask-label">{cap.fundingAskLabel}</div>
            ) : null}
          </div>
        ) : null}
      </div>

      {large ? (
        <aside className="cap-trl-block">
          <div className="cap-trl-label">Maturity</div>
          <div className="cap-trl-row">
            <span className="cap-trl-key">TRL</span>
            <div className="cap-trl-bar">
              <span
                style={{ width: `${((cap.trl ?? 0) / 9) * 100}%`, background: 'var(--accent)' }}
              />
            </div>
            <span className="cap-trl-val num">{cap.trl ?? '-'}/9</span>
          </div>
          <div className="cap-trl-row">
            <span className="cap-trl-key">MRL</span>
            <div className="cap-trl-bar">
              <span
                style={{ width: `${((cap.mrl ?? 0) / 10) * 100}%`, background: 'var(--notable)' }}
              />
            </div>
            <span className="cap-trl-val num">{cap.mrl ?? '-'}/10</span>
          </div>
          {cap.fundingAsk != null ? (
            <div className="cap-trl-foot">
              <span className="cap-trl-foot-label">Funding ask</span>
              <span className="cap-trl-foot-value num">
                ${(cap.fundingAsk / 1_000_000).toFixed(cap.fundingAsk >= 10_000_000 ? 0 : 1)}M
              </span>
            </div>
          ) : null}
          <div
            className="cap-trl-foot"
            style={{ borderTop: '1px solid var(--border-1)', paddingTop: 10 }}
          >
            <span className="cap-trl-owner-avatar">{ownerInitial}</span>
            <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>Capability owner</span>
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function PersonCard({ person, onDelete }: { person: ClientPerson; onDelete: () => void }) {
  const AVATAR_COLORS = [
    '#1a5276',
    '#1b4fd8',
    '#6b21a8',
    '#166534',
    '#0369a1',
    '#b45309',
    '#9d174d',
    '#1d4ed8',
  ];
  const idx =
    person.name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % AVATAR_COLORS.length;
  const avatarColor = AVATAR_COLORS[idx] ?? '#1a5276';

  return (
    <div className="cp-person-card">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
        <div className="cp-person-avatar" style={{ background: avatarColor }}>
          {initials(person.name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong style={{ fontSize: 13, display: 'block' }}>
            {person.name}
          </Typography.Text>
          {person.title ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {person.title}
            </Typography.Text>
          ) : null}
        </div>
        {person.role ? <PersonRoleTag role={person.role} /> : null}
        <Button size="small" type="text" icon={<DeleteOutlined />} danger onClick={onDelete} />
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          fontSize: 12,
          color: 'var(--ink-2, #595959)',
        }}
      >
        {person.email ? (
          <a
            href={`mailto:${person.email}`}
            style={{ color: 'var(--ink-2, #595959)', textDecoration: 'none' }}
          >
            <MailOutlined style={{ marginRight: 5 }} />
            {person.email}
          </a>
        ) : null}
        {person.phone ? (
          <a
            href={`tel:${person.phone.replace(/[^\d+]/g, '')}`}
            style={{ color: 'var(--ink-2, #595959)', textDecoration: 'none' }}
          >
            <PhoneOutlined style={{ marginRight: 5 }} />
            {person.phone}
          </a>
        ) : null}
        {person.lastContact ? (
          <Typography.Text type="secondary" style={{ fontSize: 11, marginTop: 4 }}>
            Last contact: {formatDate(person.lastContact)}
          </Typography.Text>
        ) : null}
      </div>
    </div>
  );
}

/* ── Modals ──────────────────────────────────────────────────────────────── */

function AddCapabilityModal({
  open,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (data: Record<string, unknown>) => void;
  submitting: boolean;
}) {
  const [form] = Form.useForm();
  return (
    <Modal
      title="Add Capability"
      open={open}
      onCancel={() => {
        form.resetFields();
        onCancel();
      }}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      okText="Add Capability"
      width={600}
      afterClose={() => form.resetFields()}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          onSubmit({
            name: values.name,
            type: values.type ?? 'product',
            description: values.description ?? null,
            sector: values.sector ?? null,
            tags: Array.isArray(values.tags) ? values.tags : [],
            trl: values.trl ? Number(values.trl) : null,
          });
        }}
      >
        <Form.Item name="name" label="Name" rules={[{ required: true, min: 1 }]}>
          <Input placeholder="e.g. JaiaBot Hydro" />
        </Form.Item>
        <Form.Item name="type" label="Type" initialValue="product">
          <Select
            options={[
              { label: 'Product', value: 'product' },
              { label: 'Service', value: 'service' },
              { label: 'Platform', value: 'platform' },
              { label: 'Technology', value: 'technology' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="sector"
          label="Sector"
          tooltip="Pick the closest sector. Used for downstream agency/policy matching."
        >
          <Select
            allowClear
            placeholder="Pick a sector"
            options={SECTOR_TAGS.map((t) => ({ label: SECTOR_LABELS[t], value: t }))}
          />
        </Form.Item>
        <Form.Item
          name="tags"
          label="Tags"
          tooltip="Pick from suggestions or type-and-enter custom tags. Used for bill matching and intelligence triage."
        >
          <Select
            mode="tags"
            allowClear
            placeholder="Pick or add tags"
            tokenSeparators={[',']}
            options={CAPABILITY_TAG_SUGGESTIONS.map((t) => ({ label: t, value: t }))}
          />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item name="trl" label="TRL (1–9)">
          <Input type="number" min={1} max={9} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// Empty antd Inputs submit '' which the server rejects (@IsOptional skips only null/undefined).
const orNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : (v ?? null));

function AddPersonModal({
  open,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (data: Record<string, unknown>) => void;
  submitting: boolean;
}) {
  const [form] = Form.useForm();
  return (
    <Modal
      title="Add Person"
      open={open}
      onCancel={() => {
        form.resetFields();
        onCancel();
      }}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      okText="Add Person"
      afterClose={() => form.resetFields()}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          onSubmit({
            name: values.name,
            title: orNull(values.title),
            email: orNull(values.email),
            phone: orNull(values.phone),
            role: values.role ?? null,
            notes: orNull(values.notes),
          });
        }}
      >
        <Form.Item name="name" label="Full Name" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="title" label="Title">
          <Input placeholder="e.g. VP Government Affairs" />
        </Form.Item>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="email" label="Email" style={{ flex: 1 }} rules={[{ type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Phone" style={{ flex: 1 }}>
            <Input placeholder="+1 202-555-0142" />
          </Form.Item>
        </div>
        <Form.Item name="role" label="Role">
          <Select
            placeholder="Select role"
            allowClear
            options={[
              { label: 'Primary POC', value: 'Primary POC' },
              { label: 'Executive', value: 'Executive' },
              { label: 'BD', value: 'BD' },
              { label: 'Technical', value: 'Technical' },
              { label: 'Legal', value: 'Legal' },
              { label: 'Finance', value: 'Finance' },
            ]}
          />
        </Form.Item>
        <Form.Item name="notes" label="Notes">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function portfolioTags(client: Client): string[] {
  const intake = toRecord(client.intakeData);
  const tags: string[] = [];
  const sectorLabel = sectorLabelFor(client);
  if (sectorLabel) tags.push(sectorLabel);
  for (const track of client.submissionTracks ?? []) {
    const label = SUBMISSION_TRACK_LABELS[track as SubmissionTrack] ?? track;
    if (label) tags.push(label);
  }
  const raw = (intake['portfolio'] ?? intake['tags']) as unknown;
  const explicit = Array.isArray(raw)
    ? (raw as unknown[]).map((t) => String(t ?? '').trim()).filter(Boolean)
    : [];
  for (const t of explicit) if (!tags.includes(t)) tags.push(t);
  if (!tags.length) {
    const fallback = readText(intake, ['requestType', 'request_type']);
    if (fallback) tags.push(fallback);
  }
  return tags;
}

function sectorLabelFor(client: Client): string | undefined {
  if (client.sectorTag) {
    return SECTOR_LABELS[client.sectorTag as SectorTag] ?? client.sectorTag;
  }
  const intake = toRecord(client.intakeData);
  const raw = readText(intake, ['sector']);
  if (!raw) return undefined;
  const normalized = normalizeSector(raw);
  return normalized ? SECTOR_LABELS[normalized] : raw;
}

function readText(record: Record<string, unknown>, keys: string[]): string | undefined {
  const val = readFirst(record, keys);
  if (val == null) return undefined;
  if (typeof val === 'string') return val.trim() || undefined;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return undefined;
}

/** Read a string[] from the first matching key; accepts comma strings too. */
function readList(record: Record<string, unknown>, keys: string[]): string[] {
  const raw = readFirst(record, keys);
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item ?? '').trim()).filter(Boolean);
  }
  const text = readText(record, keys);
  return text
    ? text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

/** Compose "City, ST, Country" from the address fields in intakeData. */
function formatLocation(intake: Record<string, unknown>): string | undefined {
  const city = readText(intake, ['city']);
  const state = readText(intake, ['state']);
  const country = readText(intake, ['country']);
  const parts = [
    [city, state].filter(Boolean).join(', '),
    // Only show country if it isn't the default USA, to keep the row tidy.
    country && country.toUpperCase() !== 'USA' ? country : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** Human-readable labels for the checked Small Business Classification flags. */
const SB_CLASS_LABELS: Array<[string, string]> = [
  ['sb', 'Small Business'],
  ['wosb', 'WOSB'],
  ['sdvosb', 'SDVOSB'],
  ['hubzone', 'HUBZone'],
  ['eightA', '8(a)'],
  ['large', 'Large Business'],
  ['foreignOwned', 'Foreign-owned'],
];

function sbClassificationLabels(intake: Record<string, unknown>): string[] {
  const sb = toRecord(readFirst(intake, ['sbClassification']));
  return SB_CLASS_LABELS.filter(([key]) => sb[key] === true || sb[key] === 'true').map(
    ([, label]) => label,
  );
}

function readFirst(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'CL';
  const first = parts[0] ?? '';
  const second = parts[1] ?? '';
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ''}${second[0] ?? ''}`.toUpperCase();
}

function externalUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function titleCase(value: string): string {
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
