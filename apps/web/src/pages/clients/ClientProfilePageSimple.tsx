import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Drawer, Input, Modal, Segmented } from 'antd';
import { MemoryFileEditor } from '../../components/MemoryFileEditor.js';
import {
  clearChatSession,
  setActiveConversation,
  setChatOpen,
} from '../../components/chat/chat-store.js';
import { useMe } from '../../lib/me.js';
import { useClientFilter } from '../../state/client-filter.js';
import { ClientProfileCapabilities } from './ClientProfileCapabilities.js';
import { ClientProfileFiles } from './ClientProfileFiles.js';
import type { Client } from './clientTypes.js';
import {
  TAB_LABELS,
  errorMessage,
  readInitialRoute,
  type ActivityKind,
  type ClientPerson,
  type CrmTab,
  type IntelligenceView,
  type RelationshipView,
} from './client-profile-crm-model.js';
import { Intelligence } from './ClientProfileIntelligence.js';
import { AccountHeader, ActivityTimeline, Overview } from './ClientProfileOverview.js';
import { PersonModal, Relationships } from './ClientProfileRelationships.js';
import { useClientProfileData } from './useClientProfileData.js';
import './client-profile-crm.css';

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
  const me = useMe();
  const { message, modal } = AntApp.useApp();
  const { setSelectedClientId } = useClientFilter();
  const initialRoute = useMemo(readInitialRoute, []);
  const [activeTab, setActiveTabState] = useState<CrmTab>(initialRoute.tab);
  const [relationshipView, setRelationshipView] = useState<RelationshipView>(initialRoute.relationshipView);
  const [intelligenceView, setIntelligenceView] = useState<IntelligenceView>(initialRoute.intelligenceView);
  const [activityFilter, setActivityFilter] = useState<'all' | ActivityKind>('all');
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [capabilityCreateRequested, setCapabilityCreateRequested] = useState(false);
  const [personModal, setPersonModal] = useState<{ open: boolean; person: ClientPerson | null }>({ open: false, person: null });
  const [notes, setNotes] = useState(() => profileNotesOf(client));
  const isAdmin = me.data?.role === 'user_admin' || me.data?.role === 'capiro_admin';
  const data = useClientProfileData(client, onClientUpdated);

  useEffect(() => setNotes(profileNotesOf(client)), [client]);

  const setActiveTab = (tab: CrmTab) => {
    setActiveTabState(tab);
    try {
      const params = new URLSearchParams(window.location.search);
      params.set('tab', tab);
      window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
    } catch {
      // Browser history is best effort.
    }
  };

  const askMeriAboutClient = () => {
    setSelectedClientId(client.id);
    clearChatSession();
    setActiveConversation(null);
    setChatOpen(true);
  };

  const filteredActivities = useMemo(
    () => activityFilter === 'all' ? data.activities : data.activities.filter((item) => item.kind === activityFilter),
    [activityFilter, data.activities],
  );

  return (
    <div className="crm-profile">
      <AccountHeader
        client={client}
        canManage={canManageClients}
        canRemove={canRemoveClients}
        onBack={onBack}
        onAskMeri={askMeriAboutClient}
        onAccountNote={() => setNoteOpen(true)}
        onEdit={() => onEdit(client)}
        onRemove={() => onRemove(client)}
        onUploadLogo={onUploadLogo}
        onClientUpdated={onClientUpdated}
        onCreate={(key) => {
          if (key === 'contact') {
            setRelationshipView('contacts');
            setActiveTab('relationships');
            setPersonModal({ open: true, person: null });
          } else if (key === 'file') setActiveTab('files');
          else if (key === 'capability') {
            setActiveTab('capabilities');
            setCapabilityCreateRequested(true);
          }
        }}
      />

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
            {key === 'intelligence' && (data.trackerSummary.data?.unread ?? 0) > 0 ? <span className="crm-tab-alert" /> : null}
          </button>
        ))}
      </nav>

      <main className="crm-profile-body">
        {activeTab === 'overview' ? (
          <Overview
            client={client}
            nextAction={data.attention[0]}
            activities={data.activities.slice(0, 5)}
            capabilities={data.capabilities.data?.length ?? 0}
            relationships={(data.people.data?.length ?? 0) + (data.targets.data?.length ?? 0) + (data.facilities.data?.length ?? 0)}
            trackedBills={data.trackerSummary.data?.boardCount ?? 0}
            peCount={data.peRelevance.data?.total ?? 0}
            files={data.documents.data?.length ?? 0}
            kbStatus={data.kbStatus.data}
            onTab={setActiveTab}
            onEdit={() => onEdit(client)}
            onMemory={() => setMemoryOpen(true)}
            onIntelligence={(view) => {
              setIntelligenceView(view);
              setActiveTab('intelligence');
            }}
          />
        ) : null}

        {activeTab === 'activity' ? (
          <section className="crm-section-shell">
            <div className="crm-section-head">
              <div><h2>Activity</h2><p>Meetings, actions and files in one chronological history.</p></div>
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
            </div>
            <div className="crm-card"><ActivityTimeline items={filteredActivities} empty="No activity matches this filter." /></div>
          </section>
        ) : null}

        {activeTab === 'capabilities' ? (
          <ClientProfileCapabilities
            clientId={client.id}
            capabilities={data.capabilities.data ?? []}
            documents={data.documents.data ?? []}
            loading={data.capabilities.isLoading}
            canManage={canManageClients}
            onRefresh={data.refreshCapabilities}
            uploadFiles={data.uploadFiles}
            deleteDocument={(document) => data.deleteDocument.mutateAsync(document.id)}
            createRequested={capabilityCreateRequested}
            onCreateRequestHandled={() => setCapabilityCreateRequested(false)}
          />
        ) : null}

        {activeTab === 'intelligence' ? (
          <Intelligence
            client={client}
            view={intelligenceView}
            setView={setIntelligenceView}
            trackerSummary={data.trackerSummary.data}
            peCount={data.peRelevance.data?.total ?? 0}
            topAction={data.openActions[0]}
          />
        ) : null}

        {activeTab === 'relationships' ? (
          <Relationships
            client={client}
            view={relationshipView}
            setView={setRelationshipView}
            people={data.people.data ?? []}
            loadingPeople={data.people.isLoading}
            targetsCount={data.targets.data?.length ?? 0}
            facilitiesCount={data.facilities.data?.length ?? 0}
            canManage={canManageClients}
            onAddPerson={() => setPersonModal({ open: true, person: null })}
            onEditPerson={(person) => setPersonModal({ open: true, person })}
            onDeletePerson={(person) =>
              modal.confirm({
                title: `Remove ${person.name}?`,
                okText: 'Remove',
                okButtonProps: { danger: true },
                onOk: () => data.deletePerson.mutateAsync(person.id),
              })
            }
            onOpenIntelligence={() => {
              setIntelligenceView('summary');
              setActiveTab('intelligence');
            }}
          />
        ) : null}

        {activeTab === 'files' ? (
          <ClientProfileFiles
            client={client}
            documents={data.documents.data ?? []}
            loading={data.documents.isLoading}
            canManage={canManageClients}
            kbStatus={data.kbStatus.data}
            onUpload={async (files) => {
              try {
                await data.uploadFiles(files);
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
                onOk: () => data.deleteDocument.mutateAsync(document.id),
              })
            }
          />
        ) : null}
      </main>

      <Drawer title="Meri context" width={720} open={memoryOpen} onClose={() => setMemoryOpen(false)}>
        <MemoryFileEditor scope="client" slug={client.id} ready canEdit={isAdmin} />
      </Drawer>

      <Modal
        title="Edit account note"
        open={noteOpen}
        onCancel={() => setNoteOpen(false)}
        onOk={() => data.saveNotes.mutate(notes, { onSuccess: () => setNoteOpen(false) })}
        confirmLoading={data.saveNotes.isPending}
        okText="Save account note"
      >
        <Input.TextArea
          rows={7}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Durable internal account context. This is not a timeline activity."
        />
      </Modal>

      <PersonModal
        open={personModal.open}
        person={personModal.person}
        submitting={data.savePerson.isPending}
        onCancel={() => setPersonModal({ open: false, person: null })}
        onSubmit={(values) =>
          data.savePerson.mutate(
            { person: personModal.person, values },
            {
              onSuccess: () => {
                message.success(personModal.person ? 'Contact updated' : 'Contact added');
                setPersonModal({ open: false, person: null });
              },
            },
          )
        }
      />
    </div>
  );
}

function profileNotesOf(client: Client): string {
  const value = client.intakeData && typeof client.intakeData === 'object' && !Array.isArray(client.intakeData)
    ? (client.intakeData as Record<string, unknown>)['profileNotes']
    : undefined;
  return typeof value === 'string' ? value : '';
}
