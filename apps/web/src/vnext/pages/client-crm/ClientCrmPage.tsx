import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClientFillWithMeriDrawer } from './ClientFillWithMeriDrawer.js';
import { ClientDataHealthDrawer } from './ClientDataHealthDrawer.js';
import { PfToast } from './portfolio-overlays.js';
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
import { useClientDataHealth } from './client-data-health.js';
import { refreshOfficeRecommendations } from '../../../pages/clients/targets-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
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
  const [archiving, setArchiving] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const canManageClients = Boolean(me.data && hasAtLeast(me.data.role, 'user_admin'));
  // Archive is DELETE /api/clients/:id, which the API gates at standard_user —
  // a lower bar than editing, so it gets its own flag rather than reusing
  // canManageClients (which mirrors the user_admin gate on PUT).
  const canArchiveClient = Boolean(me.data && hasAtLeast(me.data.role, 'standard_user'));

  // Items 11-12: one read of the client's sources, shared with the Data health
  // drawer. Same query keys the tabs use, so this adds no requests.
  const health = useClientDataHealth(client);

  const archive = useMutation({
    // The API calls this "archive": DELETE flips status to 'archived', which
    // hides the client from every default list. It is not a hard delete, and
    // the confirm copy says so rather than implying the record is gone.
    mutationFn: async () => (await api.delete(`/api/clients/${client.id}`)).data,
    onSuccess: () => {
      setArchiving(false);
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void qc.invalidateQueries({ queryKey: ['client', client.id] });
      // The profile we are standing on no longer belongs in any list.
      navigate('/clients');
    },
  });

  // §15: opens the real review drawer, which resumes any in-flight run or
  // starts a fresh one itself — no fabricated delay or change count here.
  const runFillWithMeri = useCallback(() => {
    setFillOpen(true);
  }, []);

  /**
   * Sync — a real re-read of this client's sources.
   *
   * Two things actually happen, and the toast reports what came back rather
   * than the old hardcoded "6 of 6 connected" (which was a 1500ms setTimeout
   * and no request at all):
   *
   *  1. Every source behind the profile is refetched — the same reads the Data
   *     health drawer and the breadcrumb freshness label use, so the "Sources
   *     read N ago" stamp beside this button moves for real.
   *  2. Office recommendations are force-recomputed server-side
   *     (`POST /clients/:id/target-recommendations/refresh`) — the only real
   *     per-client recompute this product exposes. It is slow by design (the
   *     server caches precisely because computing is expensive), and it is
   *     allowed to fail without failing the whole Sync: a re-read that worked
   *     should not report as a failure because one recompute timed out.
   *
   * What Sync deliberately does NOT do: re-pull LDA, FEC, awards or Federal
   * Register for this client. No endpoint ingests those per client. The other
   * `/sync` routes in the API are per-integration-connection OAuth jobs
   * (Google/Microsoft mailbox + calendar, tenant-wide) — a different and
   * side-effectful operation this button must not trigger silently.
   */
  const runSync = useCallback(async () => {
    if (syncBusy) return;
    setSyncBusy(true);
    let recomputed = false;
    let total = 0;
    let failed = 0;
    try {
      const [read, recompute] = await Promise.all([
        health.refetchAll(),
        refreshOfficeRecommendations(api, client.id).then(
          () => true,
          () => false,
        ),
      ]);
      // Counts come from the refetch results themselves — sampling the
      // rendered state here would race the re-render and under-report
      // failures (see refetchAll's docblock).
      total = read.total;
      failed = read.failures;
      recomputed = recompute;
      if (recompute) {
        void qc.invalidateQueries({ queryKey: ['client-target-recommendations', client.id] });
      }
    } finally {
      setSyncBusy(false);
    }
    const answered = total - failed;
    setToast(
      failed > 0
        ? `${answered} of ${total} sources answered · ${failed} unavailable`
        : recomputed
          ? `${total} of ${total} sources answered · recommendations recomputed`
          : `${total} of ${total} sources answered · recommendations unavailable`,
    );
  }, [syncBusy, health, api, qc, client.id]);

  return (
    <>
      <ClientProfileShell
        client={client}
        tab={route.tab}
        view={route.view}
        onNavigate={goTo}
        onFillWithMeri={runFillWithMeri}
        onDataHealth={() => setHealthOpen(true)}
        syncLabel={syncBusy ? 'Syncing…' : 'Sync'}
        onSync={() => void runSync()}
        // Item 12: a real count of sources that answered with nothing, not a
        // hardcoded 1. Held back until every source has settled so the chip
        // does not flash a number that is really "still loading".
        profileGapCount={health.settled ? health.gaps : 0}
        // Item 11: how fresh what is on screen actually is.
        refreshedLabel={health.refreshedLabel}
        sourceFailures={health.failures}
        canArchive={canArchiveClient}
        onArchive={() => setArchiving(true)}
        canEditFocus={canManageClients}
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
        <ClientDataHealthDrawer client={client} onClose={() => setHealthOpen(false)} />
      ) : null}
      {editing ? <ClientProfileEditor client={client} onClose={() => setEditing(false)} /> : null}

      {/* Item 9: archive is a real, list-wide state change — it confirms. */}
      <CapiroModal open={archiving} title={`Archive ${client.name}?`} onClose={() => setArchiving(false)}>
        <p style={{ margin: 0, fontSize: 14, color: '#475467' }}>
          This hides <strong>{client.name}</strong> from client lists, pickers, and portfolio
          rollups for everyone in this workspace. Nothing is deleted — the record and its history
          stay, and an admin can restore it.
        </p>
        {archive.isError ? (
          <p style={{ margin: '8px 0 0', fontSize: 14, color: '#B42318' }}>
            {archive.error instanceof Error ? archive.error.message : 'Could not archive this client'}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <CapiroButton variant="primary" size="compact" loading={archive.isPending} onClick={() => archive.mutate()}>
            Archive client
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={() => setArchiving(false)}>
            Cancel
          </CapiroButton>
        </div>
      </CapiroModal>

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
        onNavigate={onNavigate}
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
  onNavigate,
}: {
  client: Client;
  route: { tab: CrmSurface; view: CrmView | null };
  onEditProfile?: () => void;
  canManageClients: boolean;
  onFillWithMeri: () => void;
  onNavigate: (tab: CrmSurface, view?: CrmView | null) => void;
}) {
  if (route.tab === 'overview')
    return (
      <ClientCrmOverviewProto
        client={client}
        onEditProfile={onEditProfile}
        onOpenFederalFootprint={() => onNavigate('intelligence', 'footprint')}
        onOpenWork={() => onNavigate('work')}
        onOpenIntelligence={() => onNavigate('intelligence')}
      />
    );
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
