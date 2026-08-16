import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClientFillWithMeriDrawer } from './ClientFillWithMeriDrawer.js';
import { DataHealthDrawer, PfToast } from './portfolio-overlays.js';
import { ClientCrmCapabilitiesProto } from './tabs/CapabilitiesTab.js';
import { ClientCrmOrganizationProto } from './tabs/RelationshipsOrgTab.js';
import { ClientCrmGovernmentProto } from './tabs/RelationshipsGovTab.js';
import { ClientCrmHistoryProto } from './tabs/RelationshipsHistoryTab.js';
import { ClientCrmWorkProto } from './tabs/WorkTab.js';
import { ClientCrmIntelligenceProto } from './tabs/IntelligenceTab.js';
import { ClientCrmFilesProto } from './tabs/FilesTab.js';
import {
  applyCrmRoute,
  resolveCrmRoute,
  type CrmSurface,
  type CrmView,
  type IntelligenceView,
  type RelationshipView,
} from './client-crm-routing.js';
import { ClientProfileShell } from './ClientProfileShell.js';
import { ClientCrmOverviewProto } from './tabs/OverviewTab.js';
import { SegmentedTabs } from './portfolio-primitives.js';
import { RELATIONSHIP_VIEW_LABELS, INTELLIGENCE_VIEW_LABELS } from './client-crm-routing.js';
import { ClientFormModal } from '../../../pages/clients/ClientFormModal.js';
import type { Client, ClientFormSubmit } from '../../../pages/clients/clientTypes.js';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { hasAtLeast } from '@capiro/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import './client-crm.css';
import './portfolio-proto.css';

/**
 * Client CRM vNext — Portfolio prototype.
 *
 * The body is a faithful port of the Portfolio prototype (PORTFOLIO-UI-BUILD-
 * SPEC). The shared AppShellUui owns the global top bar + rail; this mounts
 * the prototype's client shell (breadcrumb, identity, six tabs) and the tab
 * body inside `.uui-content`. Tab/view state stays in the URL (§2).
 */
export function ClientCrmPage({ client }: { client: Client }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const route = useMemo(() => resolveCrmRoute(searchParams), [searchParams]);

  useEffect(() => {
    if (!route.didNormalize) return;
    setSearchParams(applyCrmRoute(searchParams, { tab: route.tab, view: route.view }), {
      replace: true,
    });
  }, [route, searchParams, setSearchParams]);

  const goTo = useCallback(
    (tab: CrmSurface, view?: CrmView | null) => {
      setSearchParams(applyCrmRoute(searchParams, { tab, view }));
    },
    [searchParams, setSearchParams],
  );

  const [fillOpen, setFillOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [fillBusy, setFillBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const me = useMe();
  const canManageClients = Boolean(me.data && hasAtLeast(me.data.role, 'user_admin'));

  // §15: Fill with Meri — 1700ms "Analyzing…" → toast, then the review drawer.
  const runFillWithMeri = useCallback(() => {
    if (fillBusy) return;
    setFillBusy(true);
    window.setTimeout(() => {
      setFillBusy(false);
      setToast('Meri proposed 7 field changes for review');
      setFillOpen(true);
    }, 1700);
  }, [fillBusy]);

  // §15: Sync — 1500ms "Syncing…" → toast.
  const runSync = useCallback(() => {
    if (syncBusy) return;
    setSyncBusy(true);
    window.setTimeout(() => {
      setSyncBusy(false);
      setToast('Sources refreshed · 6 of 6 connected');
    }, 1500);
  }, [syncBusy]);

  return (
    <>
      <ClientProfileShell
        client={client}
        tab={route.tab}
        view={route.view}
        onNavigate={goTo}
        onFillWithMeri={runFillWithMeri}
        onDataHealth={() => setHealthOpen(true)}
        fillBusy={fillBusy}
        syncLabel={syncBusy ? 'Syncing…' : 'Sync'}
        onSync={runSync}
        profileGapCount={1}
      >
        <ClientCrmBody
          client={client}
          route={route}
          onNavigate={goTo}
          onEditProfile={() => setEditing(true)}
          canManageClients={canManageClients}
          onFillWithMeri={runFillWithMeri}
        />
      </ClientProfileShell>
      {fillOpen ? (
        <ClientFillWithMeriDrawer
          clientId={client.id}
          clientName={client.name}
          open
          onClose={() => setFillOpen(false)}
        />
      ) : null}
      {healthOpen ? (
        <DataHealthDrawer
          onClose={() => setHealthOpen(false)}
          onResolveGap={() => {
            setHealthOpen(false);
            goTo('intelligence', 'district');
            setToast('Jump to District Nexus · resolve the Arlington facility');
          }}
        />
      ) : null}
      {editing ? <ClientProfileEditor client={client} onClose={() => setEditing(false)} /> : null}
      {toast ? <PfToast message={toast} onDone={() => setToast(null)} /> : null}
    </>
  );
}

/* ───────────────────────────────── body ──────────────────────────────────── */

function ClientCrmBody({
  client,
  route,
  onNavigate,
  onEditProfile,
  canManageClients,
  onFillWithMeri,
}: {
  client: Client;
  route: { tab: CrmSurface; view: CrmView | null };
  onNavigate: (tab: CrmSurface, view?: CrmView | null) => void;
  onEditProfile: () => void;
  canManageClients: boolean;
  onFillWithMeri: () => void;
}) {
  const views =
    route.tab === 'relationships'
      ? RELATIONSHIP_VIEW_LABELS
      : route.tab === 'intelligence'
        ? INTELLIGENCE_VIEW_LABELS
        : null;

  return (
    <div
      role="tabpanel"
      id={`cap-pf-panel-${route.tab}`}
      aria-labelledby={`cap-pf-tab-${route.tab}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 24 }}
    >
      {views ? (
        <SegmentedTabs
          ariaLabel={`${route.tab} views`}
          options={views.map((v) => ({ key: v.key as string, label: v.label }))}
          value={(route.view ?? views[0]?.key ?? '') as string}
          onChange={(v) => onNavigate(route.tab, v as CrmView)}
        />
      ) : null}

      <ClientCrmSurface
        client={client}
        route={route}
        onEditProfile={canManageClients ? onEditProfile : undefined}
        canManageClients={canManageClients}
        onFillWithMeri={onFillWithMeri}
      />
    </div>
  );
}

function ClientCrmSurface({
  client,
  route,
  onEditProfile,
  canManageClients,
  onFillWithMeri,
}: {
  client: Client;
  route: { tab: CrmSurface; view: CrmView | null };
  onEditProfile?: () => void;
  canManageClients: boolean;
  onFillWithMeri: () => void;
}) {
  if (route.tab === 'overview') return <ClientCrmOverviewProto client={client} onEditProfile={onEditProfile} />;
  if (route.tab === 'capabilities') return <ClientCrmCapabilitiesProto client={client} onFillWithMeri={onFillWithMeri} />;
  if (route.tab === 'relationships') {
    if (route.view === 'government') return <ClientCrmGovernmentProto client={client} />;
    if (route.view === 'history') return <ClientCrmHistoryProto client={client} />;
    return <ClientCrmOrganizationProto client={client} />;
  }
  if (route.tab === 'work') return <ClientCrmWorkProto client={client} />;
  if (route.tab === 'intelligence') {
    return <ClientCrmIntelligenceProto client={client} view={(route.view ?? 'overview') as IntelligenceView} />;
  }
  if (route.tab === 'files') return <ClientCrmFilesProto client={client} />;
  return null;
}

/** Reuse the canonical edit wizard and its update contract. */
function ClientProfileEditor({ client, onClose }: { client: Client; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: async (submission: ClientFormSubmit) => {
      const updated = (await api.put<Client>(`/api/clients/${client.id}`, submission.payload)).data;
      if (submission.logo) await uploadClientLogo(api, updated.id, submission.logo);
      if (submission.documents.length) await uploadClientDocuments(api, updated.id, submission.documents);
      return (await api.get<Client>(`/api/clients/${updated.id}`)).data;
    },
    onSuccess: (updated) => {
      qc.setQueryData(['client', updated.id], updated);
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void qc.invalidateQueries({ queryKey: ['client', updated.id] });
      onClose();
    },
  });

  return (
    <ClientFormModal
      open
      mode="edit"
      client={client}
      submitting={update.isPending}
      onCancel={onClose}
      onSubmit={(submission) => update.mutate(submission)}
    />
  );
}

async function uploadClientLogo(api: ReturnType<typeof useApi>, clientId: string, file: File) {
  const presigned = (
    await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
      `/api/clients/${clientId}/logo/upload-url`,
      { contentType: file.type, contentLength: file.size },
    )
  ).data;
  await uploadToS3(presigned, file);
  await api.post(`/api/clients/${clientId}/logo/confirm`, {
    s3Key: presigned.s3Key,
    contentType: file.type,
  });
}

async function uploadClientDocuments(api: ReturnType<typeof useApi>, clientId: string, files: File[]) {
  for (const file of files) {
    const contentType = file.type || 'application/octet-stream';
    const presigned = (
      await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
        '/api/engagement/attachments/upload-url',
        { clientId, fileName: file.name, contentType, contentLength: file.size },
      )
    ).data;
    await uploadToS3(presigned, file);
    await api.post('/api/engagement/attachments/confirm', {
      clientId,
      fileName: file.name,
      contentType,
      s3Key: presigned.s3Key,
    });
  }
}

async function uploadToS3(presigned: { url: string; fields: Record<string, string> }, file: File) {
  const form = new FormData();
  for (const [key, value] of Object.entries(presigned.fields)) form.append(key, value);
  form.append('file', file);
  const response = await fetch(presigned.url, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
}
