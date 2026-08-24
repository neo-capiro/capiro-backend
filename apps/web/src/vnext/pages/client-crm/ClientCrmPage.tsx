import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClientFillWithMeriDrawer } from './ClientFillWithMeriDrawer.js';
import { ClientDataHealthDrawer } from './ClientDataHealthDrawer.js';
import { PfToast } from './portfolio-overlays.js';
import { ClientCrmCapabilitiesProto } from './tabs/CapabilitiesTab.js';
import { ClientCrmOrganizationProto } from './tabs/RelationshipsOrgTab.js';
import { ClientCrmGovernmentProto } from './tabs/RelationshipsGovTab.js';
import { ClientCrmHistoryProto } from './tabs/RelationshipsHistoryTab.js';
import { ClientCrmAdvocacyMattersProto } from './tabs/AdvocacyMattersTab.js';
import { ClientCrmWorkProto } from './tabs/WorkTab.js';
import { ClientCrmIntelligenceProto } from './tabs/IntelligenceTab.js';
import { ClientCrmFilesProto } from './tabs/FilesTab.js';
import {
  applyCrmRoute,
  resolveCrmRoute,
  INTELLIGENCE_VIEWS,
  type CrmSurface,
  type CrmView,
  type RelationshipView,
} from './client-crm-routing.js';
import { ClientProfileShell } from './ClientProfileShell.js';
import { ClientCrmOverviewProto } from './tabs/OverviewTab.js';
import { AccordionSection } from './AccordionSection.js';
import { DRAWER_META, drawerKeyForRoute } from './DrawerRail.js';
import { SegmentedTabs } from './portfolio-primitives.js';
import { RELATIONSHIP_VIEW_LABELS } from './client-crm-routing.js';
import { ClientFormDialogVNext } from './ClientFormDialogVNext.js';
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
 * SPEC), restructured for Phase 4 of the vnext UI cleanup program: the
 * shared AppShellUui owns the global top bar + rail; this mounts the
 * prototype's client shell (breadcrumb, identity, sticky DrawerRail) and,
 * inside it, the always-mounted accordion-section stack (Overview / Timeline
 * / Advocacy history / Intelligence) — see `ClientCrmBody` below. Tab/view
 * state still stays entirely in the URL (§2) and `client-crm-routing.ts` is
 * untouched: this page only changed how a `(tab, view)` pair is PRESENTED
 * (which section expands vs. which drawer opens), never what the URL
 * contract accepts or resolves to.
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
  // lets the user choose a document upload vs. a source run — no fabricated
  // delay or change count here. It cannot auto-start a source run itself
  // (see ClientFillWithMeriDrawer.contract.test.ts): the backend resumes any
  // run still within its 15-minute staleness window regardless of the new
  // request, so an eager auto-start would silently swallow a document pick.
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

  // Phase 4: which drawer (if any) this route now opens, and its title/sub —
  // computed here (not in ClientProfileShell, which stays presentational and
  // does not import any `ClientCrmXxxProto`) from the same `DRAWER_META` the
  // rail itself renders from, so the drawer's header always matches the rail
  // row that opened it.
  const drawerKey = drawerKeyForRoute(route.tab, route.view);
  const drawerRow = drawerKey ? DRAWER_META.find((row) => row.key === drawerKey) : undefined;

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
        drawerContent={drawerRow ? <ClientCrmDrawerBody client={client} route={route} onNavigate={goTo} /> : null}
        drawerTitle={drawerRow?.label}
        drawerSub={drawerRow?.detail}
        // Closing returns to Overview — the same destination a plain
        // `/clients?clientId=` open lands on — rather than leaving the URL on
        // a tab whose only presentation IS the now-closed drawer.
        onCloseDrawer={() => goTo('overview')}
      >
        <ClientCrmBody
          client={client}
          route={route}
          onNavigate={goTo}
          onEditProfile={() => setEditing(true)}
          canManageClients={canManageClients}
        />
      </ClientProfileShell>
      {fillOpen ? (
        <ClientFillWithMeriDrawer
          clientId={client.id}
          clientName={client.name}
          open
          onClose={() => setFillOpen(false)}
          initialWebsite={client.website}
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

/**
 * Phase 4 (vnext UI cleanup — client record restructuring). The four
 * always-mounted, independently collapsible sections that replaced the old
 * single-active-panel switch. Order matches the real prototype's own
 * `SECTIONS` data (reading order, not the old tab strip's): Timeline,
 * Advocacy history, Intelligence — Overview is prepended (it was never in
 * that list; the prototype's own SECTIONS comment explains why: it "restated
 * the same figures each domain panel already reads", which is exactly the
 * old six-tab Overview's job, still real and still needed here as the
 * record's landing section).
 */
type SectionId = 'overview' | 'timeline' | 'advocacy' | 'intelligence';

/**
 * Static section copy (title + one-line sub), transcribed from the real
 * prototype's `SECTIONS` fixture — verbatim, since it is descriptive text,
 * not a data claim. Overview has no prototype-given sub (it was not one of
 * the prototype's SECTIONS at all) and the embedded `ClientCrmOverviewProto`
 * already opens with its own descriptive `TabPageHead`, so none is invented
 * here to avoid saying the same thing twice in adjacent lines.
 */
const SECTION_COPY: Record<SectionId, { title: string; sub?: string }> = {
  overview: { title: 'Overview' },
  timeline: {
    title: 'Timeline',
    sub: 'The shared institutional record of what happened between your firm and this client.',
  },
  advocacy: {
    title: 'Advocacy history',
    sub: 'What this client asked for, and what happened. Submissions are recorded against the capability they support.',
  },
  intelligence: {
    title: 'Intelligence',
    sub: 'Four domains read from the client-intelligence surface.',
  },
};

/**
 * Which promoted section (if any) a route now renders as. `relationships`'s
 * `history`/`matters` views and `intelligence` (any view) moved out of the
 * old single-panel switch into this always-mounted stack — this is the
 * "same URL, different presentation" trick client-crm-routing.ts's top-of-
 * file comment on the Advocacy History routing decision anticipates: the
 * URL contract (and `resolveCrmRoute`/`applyCrmRoute`) is completely
 * unchanged, only what a given `(tab, view)` pair causes to expand/scroll
 * here is new. Tabs with no matching section (capabilities/work/files, and
 * relationships' organization/government views) open the `RecordDrawer`
 * instead — see `drawerKeyForRoute` in `DrawerRail.tsx`.
 */
function sectionForRoute(route: { tab: CrmSurface; view: CrmView | null }): SectionId | null {
  if (route.tab === 'overview') return 'overview';
  if (route.tab === 'relationships' && route.view === 'history') return 'timeline';
  if (route.tab === 'relationships' && route.view === 'matters') return 'advocacy';
  if (route.tab === 'intelligence') return 'intelligence';
  return null;
}

function ClientCrmBody({
  client,
  route,
  onNavigate,
  onEditProfile,
  canManageClients,
}: {
  client: Client;
  route: { tab: CrmSurface; view: CrmView | null };
  onNavigate: (tab: CrmSurface, view?: CrmView | null) => void;
  onEditProfile: () => void;
  canManageClients: boolean;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<SectionId>>(() => {
    // Overview is always open on first render — the record must never look
    // entirely collapsed the moment a drawer-tab deep link (e.g. `?tab=work`)
    // closes its drawer — plus whatever section this exact initial route
    // also targets.
    const initial = new Set<SectionId>(['overview']);
    const target = sectionForRoute(route);
    if (target) initial.add(target);
    return initial;
  });
  const sectionNodes = useRef<Partial<Record<SectionId, HTMLElement>>>({});

  // Route-driven auto-expand + scroll — the section-stack half of what the
  // old six-tab strip did by swapping to a single active panel. Landing on
  // or navigating to `?tab=overview`, `?tab=relationships&view=history`,
  // `?tab=relationships&view=matters`, or `?tab=intelligence` (any view)
  // expands the matching section and scrolls it into view. Sections are
  // independently collapsible, so this only ever ADDS to the expanded set —
  // it never closes a section the visitor opened by hand.
  useEffect(() => {
    const target = sectionForRoute(route);
    if (!target) return;
    setExpanded((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
    // Deferred one frame so the section has actually expanded (and the DOM
    // it needs to scroll to has laid out) before scrollIntoView measures it.
    const raf = requestAnimationFrame(() => {
      const domainAnchor =
        route.tab === 'intelligence' && route.view ? document.getElementById(`cap-pf-intel-${route.view}`) : null;
      (domainAnchor ?? sectionNodes.current[target])?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.tab, route.view]);

  const toggle = (id: SectionId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const refFor = (id: SectionId) => (node: HTMLElement | null) => {
    if (node) sectionNodes.current[id] = node;
  };

  return (
    <>
      <AccordionSection
        id="cap-pf-section-overview"
        title={SECTION_COPY.overview.title}
        sub={SECTION_COPY.overview.sub}
        open={expanded.has('overview')}
        onToggle={() => toggle('overview')}
        sectionRef={refFor('overview')}
      >
        <ClientCrmOverviewProto
          client={client}
          onEditProfile={canManageClients ? onEditProfile : undefined}
          onOpenFederalFootprint={() => onNavigate('intelligence', 'footprint')}
          onOpenWork={() => onNavigate('work')}
          onOpenIntelligence={() => onNavigate('intelligence')}
        />
      </AccordionSection>

      <AccordionSection
        id="cap-pf-section-timeline"
        title={SECTION_COPY.timeline.title}
        sub={SECTION_COPY.timeline.sub}
        open={expanded.has('timeline')}
        onToggle={() => toggle('timeline')}
        sectionRef={refFor('timeline')}
      >
        <ClientCrmHistoryProto client={client} />
      </AccordionSection>

      <AccordionSection
        id="cap-pf-section-advocacy"
        title={SECTION_COPY.advocacy.title}
        sub={SECTION_COPY.advocacy.sub}
        open={expanded.has('advocacy')}
        onToggle={() => toggle('advocacy')}
        sectionRef={refFor('advocacy')}
      >
        <ClientCrmAdvocacyMattersProto client={client} />
      </AccordionSection>

      <AccordionSection
        id="cap-pf-section-intelligence"
        title={SECTION_COPY.intelligence.title}
        sub={SECTION_COPY.intelligence.sub}
        open={expanded.has('intelligence')}
        onToggle={() => toggle('intelligence')}
        sectionRef={refFor('intelligence')}
      >
        <IntelligenceDomainStack client={client} />
      </AccordionSection>
    </>
  );
}

/**
 * Intelligence used to render exactly one of its four domains at a time,
 * switched by a segmented sub-tab bar this page owned. Promoted into an
 * always-visible section (per this closeout's brief), it now stacks all
 * four. `ClientCrmIntelligenceProto` itself is UNCHANGED — same props, same
 * per-domain query keys — this only mounts it four times, once per
 * `IntelligenceView`, each wrapped in a `cap-pf-intel-<view>` anchor so a
 * route that still names a specific view (e.g. `?tab=intelligence&view=
 * funding`, or Overview's "Open federal footprint" action) can scroll
 * straight to that domain rather than just to the top of the section.
 */
function IntelligenceDomainStack({ client }: { client: Client }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {INTELLIGENCE_VIEWS.map((view, index) => (
        <div
          key={view}
          id={`cap-pf-intel-${view}`}
          style={{
            scrollMarginTop: 24,
            ...(index > 0 ? { paddingTop: 32, borderTop: '1px solid #E8E5DF' } : null),
          }}
        >
          <ClientCrmIntelligenceProto client={client} view={view} />
        </div>
      ))}
    </div>
  );
}

/**
 * The `RecordDrawer` body for Relationships/Work/Files/Capabilities — the
 * four "directory" tabs that stayed single-surface-at-a-time instead of
 * being promoted to sections (spec: "Relationships and Files are
 * directories, not narrative — long, filterable lists that would dominate
 * the record stream"). Every `ClientCrmXxxProto` below is mounted exactly as
 * it was under the old tab strip, unchanged.
 */
function ClientCrmDrawerBody({
  client,
  route,
  onNavigate,
}: {
  client: Client;
  route: { tab: CrmSurface; view: CrmView | null };
  onNavigate: (tab: CrmSurface, view?: CrmView | null) => void;
}) {
  if (route.tab === 'capabilities') return <ClientCrmCapabilitiesProto client={client} />;
  if (route.tab === 'work') return <ClientCrmWorkProto client={client} />;
  if (route.tab === 'files') return <ClientCrmFilesProto client={client} />;

  // relationships — history/matters are gone from this sub-nav (promoted to
  // the Timeline/Advocacy history sections above); the routing file itself
  // still declares all four RELATIONSHIP_VIEWS, this just no longer opens
  // the drawer for two of them (see drawerKeyForRoute, DrawerRail.tsx).
  const relationshipViews = RELATIONSHIP_VIEW_LABELS.filter((v) => v.key === 'organization' || v.key === 'government');
  const relView: RelationshipView = route.view === 'government' ? 'government' : 'organization';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SegmentedTabs
        ariaLabel="Relationships view"
        options={relationshipViews}
        value={relView}
        onChange={(v) => onNavigate('relationships', v as RelationshipView)}
      />
      {relView === 'government' ? <ClientCrmGovernmentProto client={client} /> : <ClientCrmOrganizationProto client={client} />}
    </div>
  );
}

/** The vNext edit wizard on the canonical update contract (PUT + upload + refetch). */
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
    <ClientFormDialogVNext
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
