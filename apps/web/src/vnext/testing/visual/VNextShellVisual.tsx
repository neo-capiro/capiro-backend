import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { VNEXT_ROUTE_MANIFEST } from '../../adapters/routes/routeManifest.js';
import { AppShellUuiView } from '../../shell/AppShellUui/index.js';
import { DashboardVNextView } from '../../pages/dashboard/DashboardVNext.js';
import { StrategyLibraryVNext } from '../../pages/strategies/StrategyLibraryVNext.js';
import { StrategyEditorVNext } from '../../pages/strategies/StrategyEditorVNext.js';
// Normally imported once by VNextStrategiesRoutes (the module root, per that
// folder's BUILD-CONTRACT.md) — imported here too since the harness mounts
// the view directly and skips that router.
import '../../pages/strategies/strategies-tokens.css';
import { CongressionalStaffVNextView } from '../../pages/directory/CongressionalStaffVNext.js';
import { FOUNDATION_MAILBOX_STATES } from '../fixtures/foundation.js';
import { DASHBOARD_VISUAL_FIXTURE, DASHBOARD_STATE_FIXTURES } from '../fixtures/dashboard.js';
import {
  CONGRESSIONAL_STAFF_EMPTY_FIXTURE,
  CONGRESSIONAL_STAFF_VISUAL_FIXTURE,
} from '../fixtures/directory.js';
import { DIRECTORY_ROUTES } from '../../pages/directory/directory-routes.js';
import { ClientProfileShell } from '../../pages/client-crm/ClientProfileShell.js';
import { ClientFillWithMeriDrawer } from '../../pages/client-crm/ClientFillWithMeriDrawer.js';
import {
  CLIENT_DIRECTORY_ROWS,
  DRAWER_META,
  activeDirectoryKey,
  drawerKeyForRoute,
} from '../../pages/client-crm/ClientRecordDirectory.js';
import { SegmentedTabs } from '../../pages/client-crm/portfolio-primitives.js';
import {
  RELATIONSHIP_VIEW_LABELS,
  INTELLIGENCE_VIEWS,
  type CrmSurface,
  type CrmView,
  type RelationshipView,
  type IntelligenceView,
} from '../../pages/client-crm/client-crm-routing.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { ClientCrmCapabilitiesProto } from '../../pages/client-crm/tabs/CapabilitiesTab.js';
import { ClientCrmOrganizationProto } from '../../pages/client-crm/tabs/RelationshipsOrgTab.js';
import { ClientCrmGovernmentProto } from '../../pages/client-crm/tabs/RelationshipsGovTab.js';
import { ClientCrmHistoryProto } from '../../pages/client-crm/tabs/RelationshipsHistoryTab.js';
import { ClientCrmAdvocacyMattersProto } from '../../pages/client-crm/tabs/AdvocacyMattersTab.js';
import { ClientCrmWorkProto } from '../../pages/client-crm/tabs/WorkTab.js';
import { ClientCrmIntelligenceProto } from '../../pages/client-crm/tabs/IntelligenceTab.js';
import { ClientCrmFilesProto } from '../../pages/client-crm/tabs/FilesTab.js';
import {
  CLIENT_CRM_VISUAL_CLIENT,
} from '../fixtures/client-crm.js';
import {
  PersonDrawer,
  TargetDrawer,
  StrategyDrawer,
  DataHealthDrawer,
  HierarchyModal,
  MoveToFolderModal,
  PfToast,
} from '../../pages/client-crm/portfolio-overlays.js';
import { PEOPLE, TARGETS, NODES, FOLDERS } from '../../pages/client-crm/portfolio-fixtures.js';
import '../../pages/client-crm/client-crm.css';
import '../../pages/client-crm/client-record-surface.css';
import '../../pages/client-crm/portfolio-proto.css';

/**
 * Clerk-free shell baseline. The nav model comes from the real route manifest so
 * the capture exercises the shipped navigation, but every data-backed control is
 * replaced by a fixture — this harness never calls the API.
 *
 * One shell (AppShellUui) for every screen, matching production as of 2026-08
 * — there is no longer a separate Capiro-native harness path to keep in sync;
 * VNextShellScaffold/CapiroSidebar/CapiroTopBar are retired from production
 * but still exist as files if a future session needs to compare against them.
 */
/**
 * `AppShellUuiView` renders the real `NotificationBell`, which runs its own
 * `useNotifications()` query rather than reading the injected `notifications`
 * view-model. That needs a QueryClient in context or the tree throws. Retries
 * and refetches are off so the harness stays offline and deterministic; the
 * query fails immediately against the stubbed (token-less) client and the bell
 * renders its real "unavailable" state.
 */
const harnessQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false, staleTime: Infinity, gcTime: Infinity },
    mutations: { retry: false },
  },
});

// Deterministic harness data lives only in the visual entry point. Production
// ClientCrmHistoryProto still reads the real activity/account APIs.
const visualOwner = {
  id: 'visual-sarah',
  email: 'sarah@capiro.ai',
  firstName: 'Sarah',
  lastName: 'Martinez',
};
harnessQueryClient.setQueryData(['client-account-owner', CLIENT_CRM_VISUAL_CLIENT.id], {
  accountOwnerUserId: visualOwner.id,
  accountOwner: visualOwner,
});
harnessQueryClient.setQueryData(['client-account-owner-options'], [visualOwner]);
harnessQueryClient.setQueryData(['client-team', CLIENT_CRM_VISUAL_CLIENT.id], [
  { ...visualOwner, id: null, userId: visualOwner.id, role: null, isOwner: true, addedAt: null },
  { id: 'team-jc', userId: 'visual-jordan', email: 'jordan@capiro.ai', firstName: 'Jordan', lastName: 'Clayton', role: null, isOwner: false, addedAt: '2026-01-15T00:00:00.000Z' },
  { id: 'team-ar', userId: 'visual-amara', email: 'amara@capiro.ai', firstName: 'Amara', lastName: 'Reid', role: null, isOwner: false, addedAt: '2026-01-15T00:00:00.000Z' },
]);
harnessQueryClient.setQueryData(['client-activity', CLIENT_CRM_VISUAL_CLIENT.id], [
  { id: 'visual-note', kind: 'note', origin: 'recorded', occurredAt: '2026-08-10T12:00:00.000Z', title: 'Priority shifted toward Army procurement', body: 'Stephanie wants the next meeting focused on procurement rather than RDT&E.', pinned: true, sourceType: 'activity', sourceId: null, dueAt: null, settledAt: null },
  { id: 'visual-email', kind: 'email', origin: 'synced', occurredAt: '2026-08-08T12:00:00.000Z', title: 'RE: FY27 Ground Robotics Mark', body: '2 emails exchanged with Stephanie Bonk. Client requested an assessment before Tuesday.', pinned: false, sourceType: 'mail_thread', sourceId: 'visual-thread', dueAt: null, settledAt: null },
  { id: 'visual-meeting', kind: 'meeting', origin: 'synced', occurredAt: '2026-08-06T12:00:00.000Z', title: 'Strategy review · conference outlook', body: 'Debrief filed. Two commitments recorded, one still open.', pinned: false, sourceType: 'meeting', sourceId: 'visual-meeting', dueAt: null, settledAt: null },
  { id: 'visual-outreach', kind: 'outreach', origin: 'synced', occurredAt: '2026-08-04T12:00:00.000Z', title: 'HASC staff outreach · 6 recipients', body: 'Campaign sent. Two replies synced back to this client.', pinned: false, sourceType: 'outreach', sourceId: 'visual-outreach', dueAt: null, settledAt: null },
  { id: 'visual-commitment', kind: 'commitment', origin: 'recorded', occurredAt: '2026-07-30T12:00:00.000Z', title: 'Send Army procurement assessment', body: 'Committed on the Jul 30 call.', pinned: false, sourceType: 'activity', sourceId: null, dueAt: '2026-08-12T12:00:00.000Z', settledAt: null },
]);

const visualFillRun = {
  id: 'visual-fill-run', clientId: CLIENT_CRM_VISUAL_CLIENT.id, status: 'completed', stage: 'review_ready',
  requestedSources: ['public_web', 'sam_gov', 'synced_email', 'lda'], sourceStates: {}, summary: {}, error: null,
  startedAt: '2026-08-25T12:00:00.000Z', completedAt: '2026-08-25T12:02:00.000Z',
  progress: { total: 8, queued: 0, running: 0, completed: 7, failed: 1, cancelled: 0 },
  tasks: [
    { id: 'vf-web', runId: 'visual-fill-run', taskType: 'public_web', taskKey: 'public_web', status: 'completed', dependsOn: [], attempt: 1, maxAttempts: 3, outputSummary: null, errorCode: null, errorMessage: null, nextAttemptAt: null, completedAt: '2026-08-25T12:00:30.000Z', createdAt: '', updatedAt: '' },
    { id: 'vf-sam', runId: 'visual-fill-run', taskType: 'sam_gov', taskKey: 'sam_gov', status: 'completed', dependsOn: [], attempt: 1, maxAttempts: 3, outputSummary: null, errorCode: null, errorMessage: null, nextAttemptAt: null, completedAt: '2026-08-25T12:00:40.000Z', createdAt: '', updatedAt: '' },
    { id: 'vf-mail', runId: 'visual-fill-run', taskType: 'synced_email', taskKey: 'synced_email', status: 'completed', dependsOn: [], attempt: 1, maxAttempts: 3, outputSummary: null, errorCode: null, errorMessage: null, nextAttemptAt: null, completedAt: '2026-08-25T12:00:50.000Z', createdAt: '', updatedAt: '' },
    { id: 'vf-federal', runId: 'visual-fill-run', taskType: 'federal_market', taskKey: 'federal_market', status: 'completed', dependsOn: [], attempt: 1, maxAttempts: 3, outputSummary: null, errorCode: null, errorMessage: null, nextAttemptAt: null, completedAt: '2026-08-25T12:01:00.000Z', createdAt: '', updatedAt: '' },
    { id: 'vf-facilities', runId: 'visual-fill-run', taskType: 'facility_resolution', taskKey: 'facility_resolution', status: 'failed', dependsOn: [], attempt: 3, maxAttempts: 3, outputSummary: null, errorCode: 'unavailable', errorMessage: 'Facility records unavailable', nextAttemptAt: null, completedAt: null, createdAt: '', updatedAt: '' },
    { id: 'vf-lda', runId: 'visual-fill-run', taskType: 'lda', taskKey: 'lda', status: 'completed', dependsOn: [], attempt: 1, maxAttempts: 3, outputSummary: null, errorCode: null, errorMessage: null, nextAttemptAt: null, completedAt: '2026-08-25T12:01:15.000Z', createdAt: '', updatedAt: '' },
    { id: 'vf-reconcile', runId: 'visual-fill-run', taskType: 'reconciliation', taskKey: 'reconciliation', status: 'completed', dependsOn: [], attempt: 1, maxAttempts: 3, outputSummary: null, errorCode: null, errorMessage: null, nextAttemptAt: null, completedAt: '2026-08-25T12:01:45.000Z', createdAt: '', updatedAt: '' },
    { id: 'vf-audit', runId: 'visual-fill-run', taskType: 'completion_audit', taskKey: 'completion_audit', status: 'completed', dependsOn: [], attempt: 1, maxAttempts: 3, outputSummary: null, errorCode: null, errorMessage: null, nextAttemptAt: null, completedAt: '2026-08-25T12:02:00.000Z', createdAt: '', updatedAt: '' },
  ],
  findings: [
    { id: 'vf-description', runId: 'visual-fill-run', kind: 'profile_field', targetKey: 'description', source: 'public_web', factKind: 'fact', currentValue: null, proposedValue: 'Autonomy software and unmanned-ground systems for defense and national-security missions.', evidence: [{ label: 'Company overview', source: 'overland.ai/about' }], confidence: .96, status: 'pending', appliedAt: null, createdAt: '' },
    { id: 'vf-website', runId: 'visual-fill-run', kind: 'profile_field', targetKey: 'website', source: 'public_web', factKind: 'fact', currentValue: 'overland.com', proposedValue: 'overland.ai', evidence: [{ label: 'Canonical website', source: 'Public web' }], confidence: .99, status: 'pending', appliedAt: null, createdAt: '' },
    { id: 'vf-capability', runId: 'visual-fill-run', kind: 'capability', targetKey: 'capability.autonomy', source: 'client_document', factKind: 'fact', currentValue: null, proposedValue: { name: 'Autonomous ground systems' }, evidence: [{ label: 'Capability statement · page 3' }], confidence: .92, status: 'pending', appliedAt: null, createdAt: '' },
    { id: 'vf-advocacy', runId: 'visual-fill-run', kind: 'advocacy_record', targetKey: 'advocacy.fy27-ground-robotics', source: 'lda', factKind: 'fact', currentValue: null, proposedValue: { title: 'FY27 ground robotics engagement' }, evidence: [{ label: 'LDA filing Q2 2026' }], confidence: .88, status: 'pending', appliedAt: null, createdAt: '' },
    { id: 'vf-context', runId: 'visual-fill-run', kind: 'program_element', targetKey: '0605053A', source: 'program_elements', factKind: 'recommendation', currentValue: null, proposedValue: { title: 'Ground Robotics' }, evidence: [{ label: 'FY27 budget request' }], confidence: .84, status: 'informational', appliedAt: null, createdAt: '' },
    { id: 'vf-coverage', runId: 'visual-fill-run', kind: 'profile_completion', targetKey: 'profile-completion', source: 'completion_audit', factKind: 'fact', currentValue: null, proposedValue: { score: 87 }, evidence: [], confidence: 1, status: 'informational', appliedAt: null, createdAt: '' },
  ],
};
harnessQueryClient.setQueryData(['client-fill-with-meri', CLIENT_CRM_VISUAL_CLIENT.id, 'latest'], visualFillRun);
harnessQueryClient.setQueryData(['client-fill-with-meri', CLIENT_CRM_VISUAL_CLIENT.id, 'run', visualFillRun.id], visualFillRun);
harnessQueryClient.setQueryData(['client-advocacy-matters', CLIENT_CRM_VISUAL_CLIENT.id], []);

const visualRoutes = VNEXT_ROUTE_MANIFEST.filter((route) => route.id !== 'settings');
const settingsRoute = VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'settings') ?? null;

const fixtureIdentity = {
  loading: false,
  unavailable: false,
  name: 'Neo Martinez',
  role: 'VP Government Affairs',
  email: 'neo@capiro.ai',
  initials: 'NM',
  imageUrl: null,
};

const fixtureNotifications = {
  loading: false,
  unavailable: false,
  unread: 3,
  showBadge: true,
  badgeLabel: '3',
};

export type VNextVisualScreen =
  | 'empty'
  | 'dashboard'
  | 'client-crm'
  | 'congressional-staff'
  | 'congressional-staff-empty'
  | 'strategies'
  | 'strategies-empty'
  | 'strategy-editor';

/**
 * Each screen renders at the route it actually ships on, so the sidebar's
 * current-item state is exercised, not faked.
 *
 * `/clients` carries `clientId` because the vNext interception requires a param
 * the app does not otherwise set — see `1a0b000c`, where its absence meant the
 * CRM surface never rendered at all.
 */
const SCREEN_ROUTES: Record<VNextVisualScreen, string> = {
  empty: '/clients?clientId=visual-fixture',
  dashboard: '/',
  'client-crm': '/clients?clientId=visual-fixture',
  'congressional-staff': DIRECTORY_ROUTES.congressionalStaff,
  'congressional-staff-empty': DIRECTORY_ROUTES.congressionalStaff,
  strategies: '/strategies',
  'strategies-empty': '/strategies',
  'strategy-editor': '/strategies/7f1c9a20-4d3e-4b8a-9c21-6e0f5a8b1d34',
};

export function VNextShellVisual({
  collapsed,
  screen = 'empty',
  crmTab = 'overview',
  intelView = 'legislative',
  relView = 'organization',
  crmOverlay,
  attnState,
}: {
  collapsed?: boolean;
  screen?: VNextVisualScreen;
  crmTab?: CrmSurface;
  intelView?: IntelligenceView;
  relView?: RelationshipView;
  crmOverlay?: 'person' | 'target' | 'strategy' | 'health' | 'hierarchy' | 'move' | 'toast' | 'fill';
  /** Forces Needs Attention into one of the six named states (754:2885) —
   * ModuleStateView is shared across all four modules, so this exercises the
   * same render path every module's state block uses. Dashboard-only. */
  attnState?: keyof typeof DASHBOARD_STATE_FIXTURES;
}) {
  const dashboardModel =
    attnState && DASHBOARD_STATE_FIXTURES[attnState]
      ? DASHBOARD_STATE_FIXTURES[attnState]
      : DASHBOARD_VISUAL_FIXTURE;

  // Same (tab, view) shape ClientCrmPage derives from the URL.
  const crmRoute: { tab: CrmSurface; view: CrmView | null } =
    crmTab === 'relationships'
      ? { tab: 'relationships', view: relView }
      : crmTab === 'intelligence'
        ? { tab: 'intelligence', view: intelView }
        : { tab: crmTab, view: null };
  const crmDrawerKey = drawerKeyForRoute(crmRoute.tab, crmRoute.view);
  const crmDrawerRow = crmDrawerKey ? DRAWER_META.find((row) => row.key === crmDrawerKey) : undefined;

  return (
    <QueryClientProvider client={harnessQueryClient}>
      <MemoryRouter initialEntries={[SCREEN_ROUTES[screen]]}>
        <div className="capiro-vnext-root">
        <AppShellUuiView
          navigation={{ primary: visualRoutes, settings: settingsRoute, loading: false }}
          identity={fixtureIdentity}
          notifications={fixtureNotifications}
          mailboxStatus={FOUNDATION_MAILBOX_STATES[0]}
          scopeLabel={screen === 'client-crm' ? CLIENT_CRM_VISUAL_CLIENT.name : 'All clients'}
          onNavigate={() => undefined}
          onSignOut={() => undefined}
          onOpenProfile={() => undefined}
          initialCollapsed={collapsed}
        >
          {screen === 'client-crm' ? (
            // Client CRM — seven-row directory + one active surface.
            <ClientProfileShell
              client={CLIENT_CRM_VISUAL_CLIENT}
              tab={crmRoute.tab}
              view={crmRoute.view}
              onNavigate={() => undefined}
              onFillWithMeri={() => undefined}
              onDataHealth={() => undefined}
              // Harness-only values so the captured frame still carries the
              // breadcrumb freshness, the gap chip, the focus "Add" affordance
              // and the archive menu item that the Figma frame shows. In the
              // product these come from the real source reads and the viewer's
              // role (ClientCrmPage); this file is the offline capture harness
              // and is never mounted as product code.
              refreshedLabel="2 hours ago"
              profileGapCount={1}
              canEditFocus
              canArchive
              onArchive={() => undefined}
              drawerContent={
                crmDrawerRow ? (
                  <ClientCrmDrawerBodyFixture client={CLIENT_CRM_VISUAL_CLIENT} tab={crmRoute.tab} relView={relView} />
                ) : null
              }
              drawerTitle={crmDrawerRow?.label}
              drawerSub={crmDrawerRow?.description}
              onCloseDrawer={() => undefined}
            >
              <ClientCrmSurfaceFixture client={CLIENT_CRM_VISUAL_CLIENT} route={crmRoute} />
            </ClientProfileShell>
          ) : screen === 'dashboard' ? (
            <DashboardVNextView model={dashboardModel} />
          ) : screen === 'congressional-staff' ? (
            <CongressionalStaffVNextView model={CONGRESSIONAL_STAFF_VISUAL_FIXTURE} />
          ) : screen === 'congressional-staff-empty' ? (
            <CongressionalStaffVNextView model={CONGRESSIONAL_STAFF_EMPTY_FIXTURE} />
          ) : screen === 'strategies' || screen === 'strategies-empty' ? (
            // .capiro-strategies normally comes from VNextStrategiesRoutes' wrapper
            // div, not StrategyLibraryVNext itself — reproduced here since the
            // harness mounts the view directly, skipping that route shell.
            <div className="capiro-strategies" data-module="strategies">
              <StrategyLibraryVNext />
            </div>
          ) : screen === 'strategy-editor' ? (
            <div className="capiro-strategies" data-module="strategies">
              <Routes>
                <Route path="/strategies/:strategyId" element={<StrategyEditorVNext />} />
              </Routes>
            </div>
          ) : (
            <div className="capiro-vnext-foundation-banner" style={{ margin: 20 }}>
              shell baseline · product screens intentionally absent
            </div>
          )}
          {/* Portfolio prototype overlays (segment §12), mounted over the shell for capture. */}
          {screen === 'client-crm' && crmOverlay === 'person' ? (
            <PersonDrawer person={personFixture('sb')} onClose={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'target' ? (
            <TargetDrawer target={targetFixture('t1')} onClose={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'strategy' ? (
            <StrategyDrawer nodes={strategyNodeFixture()} onClose={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'health' ? (
            <DataHealthDrawer onClose={() => undefined} onResolveGap={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'hierarchy' ? (
            <HierarchyModal onClose={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'move' ? (
            <MoveToFolderModal count={3} folders={folderFixture()} onClose={() => undefined} onMove={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'toast' ? (
            <PfToast message="Meri proposed 7 field changes for review" onDone={() => undefined} />
          ) : null}
          {screen === 'client-crm' && crmOverlay === 'fill' ? (
            <ClientFillWithMeriDrawer
              clientId={CLIENT_CRM_VISUAL_CLIENT.id}
              clientName={CLIENT_CRM_VISUAL_CLIENT.name}
              initialWebsite={CLIENT_CRM_VISUAL_CLIENT.website}
              open
              onClose={() => undefined}
            />
          ) : null}
        </AppShellUuiView>
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/* ── Client CRM body fixture: same one-surface architecture as production. */

function ClientCrmSurfaceFixture({
  client,
  route,
}: {
  client: Client;
  route: { tab: CrmSurface; view: CrmView | null };
}) {
  const key = activeDirectoryKey(route.tab, route.view);
  const row =
    CLIENT_DIRECTORY_ROWS.find((item) => item.key === key && !item.drawer) ??
    CLIENT_DIRECTORY_ROWS[0]!;

  return (
    <section className="cap-pf-record-surface" data-record-surface={row.key}>
      <header className="cap-pf-record-surface__head">
        <div>
          <h2 className="cap-pf-record-surface__title">{row.label}</h2>
          <p className="cap-pf-record-surface__sub">{row.description}</p>
        </div>
      </header>
      {row.key === 'advocacy' ? (
        <ClientCrmAdvocacyMattersProto client={client} />
      ) : row.key === 'intelligence' ? (
        <div className="cap-pf-intelligence-domain-stack">
          {INTELLIGENCE_VIEWS.map((view) => (
            <div key={view} className="cap-pf-intelligence-domain">
              <ClientCrmIntelligenceProto client={client} view={view} />
            </div>
          ))}
        </div>
      ) : (
        <ClientCrmHistoryProto client={client} />
      )}
    </section>
  );
}

/** Relationships/Work/Files/Capabilities content that opens in `RecordDrawer`.
 *  Relationships' history/matters views never reach here (`drawerKeyForRoute`
 *  returns null for them): those promote to the Timeline/Advocacy sections
 *  above instead. */
function ClientCrmDrawerBodyFixture({
  client,
  tab,
  relView,
}: {
  client: Client;
  tab: CrmSurface;
  relView: RelationshipView;
}) {
  if (tab === 'capabilities') return <ClientCrmCapabilitiesProto client={client} />;
  if (tab === 'work') return <ClientCrmWorkProto client={client} />;
  if (tab === 'files') return <ClientCrmFilesProto client={client} />;

  const relationshipViews = RELATIONSHIP_VIEW_LABELS.filter((v) => v.key === 'organization' || v.key === 'government');
  const view: RelationshipView = relView === 'government' ? 'government' : 'organization';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SegmentedTabs ariaLabel="Relationships view" options={relationshipViews} value={view} onChange={() => undefined} />
      {view === 'government' ? <ClientCrmGovernmentProto client={client} /> : <ClientCrmOrganizationProto client={client} />}
    </div>
  );
}

/* ── Overlay fixture adapters (map prototype fixtures → overlay prop shapes) ── */

function personFixture(id: keyof typeof PEOPLE) {
  const p = PEOPLE[id] as { init: string; name: string; title: string; level: string; meta: string; email: string; phone: string; levelFull: string; reports: string; override?: boolean; note: string };
  return {
    level: p.level,
    levelFull: p.levelFull,
    init: p.init,
    name: p.name,
    title: p.title,
    meta: p.meta,
    email: p.email,
    phone: p.phone,
    location: 'Seattle, WA',
    reports: p.reports,
    placement: (p.override ? 'Manual override' : 'Auto-placed') as 'Manual override' | 'Auto-placed',
    note: p.note,
  };
}

function targetFixture(id: string) {
  const t = (TARGETS as Array<Record<string, unknown>>).find((x) => x.id === id) as Record<string, any>;
  return {
    kind: t.kind as 'person' | 'org',
    init: t.init,
    name: t.name,
    role: t.role,
    disposition: t.disposition,
    dispTone: 'success' as const,
    confirm: t.confirm,
    strategy: t.strategy,
    ask: t.ask,
    next: t.next,
    why: t.why as Array<[string, string]>,
  };
}

function strategyNodeFixture() {
  return (NODES as Array<Record<string, any>>).map((n) => ({
    mark: n.mark,
    kind: n.kind,
    title: n.title,
    init: n.init,
    date: n.date,
    status: n.status,
    tone: n.ui,
  }));
}

function folderFixture() {
  return (FOLDERS as Array<Record<string, any>>).map((f) => ({
    label: f.label,
    depth: f.depth,
    count: f.count,
  }));
}
