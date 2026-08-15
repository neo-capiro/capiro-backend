import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { VNEXT_ROUTE_MANIFEST } from '../../adapters/routes/routeManifest.js';
import { AppShellUuiView } from '../../shell/AppShellUui/index.js';
import { DashboardVNextView } from '../../pages/dashboard/DashboardVNext.js';
import { CongressionalStaffVNextView } from '../../pages/directory/CongressionalStaffVNext.js';
import { FOUNDATION_MAILBOX_STATES } from '../fixtures/foundation.js';
import { DASHBOARD_VISUAL_FIXTURE, DASHBOARD_STATE_FIXTURES } from '../fixtures/dashboard.js';
import {
  CONGRESSIONAL_STAFF_EMPTY_FIXTURE,
  CONGRESSIONAL_STAFF_VISUAL_FIXTURE,
} from '../fixtures/directory.js';
import { DIRECTORY_ROUTES } from '../../pages/directory/directory-routes.js';
import { ClientProfileShell } from '../../pages/client-crm/ClientProfileShell.js';
import { ClientCrmOverviewProto } from '../../pages/client-crm/tabs/OverviewTab.js';
import { ClientCrmCapabilitiesProto } from '../../pages/client-crm/tabs/CapabilitiesTab.js';
import { ClientCrmOrganizationProto } from '../../pages/client-crm/tabs/RelationshipsOrgTab.js';
import { ClientCrmGovernmentProto } from '../../pages/client-crm/tabs/RelationshipsGovTab.js';
import { ClientCrmHistoryProto } from '../../pages/client-crm/tabs/RelationshipsHistoryTab.js';
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
    queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false, gcTime: Infinity },
    mutations: { retry: false },
  },
});

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
  | 'congressional-staff-empty';

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
};

export function VNextShellVisual({
  collapsed,
  screen = 'empty',
  crmTab = 'overview',
  intelView = 'overview',
  relView = 'organization',
  crmOverlay,
  attnState,
}: {
  collapsed?: boolean;
  screen?: VNextVisualScreen;
  crmTab?: 'overview' | 'capabilities' | 'relationships' | 'work' | 'intelligence' | 'files';
  intelView?: 'overview' | 'legislative' | 'regulatory' | 'funding' | 'footprint' | 'district';
  relView?: 'organization' | 'government' | 'history';
  crmOverlay?: 'person' | 'target' | 'strategy' | 'health' | 'hierarchy' | 'move' | 'toast';
  /** Forces Needs Attention into one of the six named states (754:2885) —
   * ModuleStateView is shared across all four modules, so this exercises the
   * same render path every module's state block uses. Dashboard-only. */
  attnState?: keyof typeof DASHBOARD_STATE_FIXTURES;
}) {
  const dashboardModel =
    attnState && DASHBOARD_STATE_FIXTURES[attnState]
      ? DASHBOARD_STATE_FIXTURES[attnState]
      : DASHBOARD_VISUAL_FIXTURE;

  return (
    <QueryClientProvider client={harnessQueryClient}>
      <MemoryRouter initialEntries={[SCREEN_ROUTES[screen]]}>
        <div className="capiro-vnext-root">
        <AppShellUuiView
          navigation={{ primary: visualRoutes, settings: settingsRoute, loading: false }}
          identity={fixtureIdentity}
          notifications={fixtureNotifications}
          mailboxStatus={FOUNDATION_MAILBOX_STATES[0]}
          scopeLabel="All clients"
          onNavigate={() => undefined}
          onSignOut={() => undefined}
          onOpenProfile={() => undefined}
          initialCollapsed={collapsed}
        >
          {screen === 'client-crm' ? (
            // Client CRM — Portfolio prototype shell + body (proto tabs).
            <ClientProfileShell
              client={CLIENT_CRM_VISUAL_CLIENT}
              tab={crmTab}
              view={null}
              onNavigate={() => undefined}
              onFillWithMeri={() => undefined}
              onDataHealth={() => undefined}
            >
              {crmTab === 'overview' ? (
                <ClientCrmOverviewProto client={CLIENT_CRM_VISUAL_CLIENT} />
              ) : crmTab === 'capabilities' ? (
                <ClientCrmCapabilitiesProto client={CLIENT_CRM_VISUAL_CLIENT} />
              ) : crmTab === 'relationships' ? (
                relView === 'government' ? (
                  <ClientCrmGovernmentProto client={CLIENT_CRM_VISUAL_CLIENT} />
                ) : relView === 'history' ? (
                  <ClientCrmHistoryProto client={CLIENT_CRM_VISUAL_CLIENT} />
                ) : (
                  <ClientCrmOrganizationProto client={CLIENT_CRM_VISUAL_CLIENT} />
                )
              ) : crmTab === 'work' ? (
                <ClientCrmWorkProto client={CLIENT_CRM_VISUAL_CLIENT} />
              ) : crmTab === 'intelligence' ? (
                <ClientCrmIntelligenceProto client={CLIENT_CRM_VISUAL_CLIENT} view={intelView} />
              ) : (
                <ClientCrmFilesProto client={CLIENT_CRM_VISUAL_CLIENT} />
              )}
            </ClientProfileShell>
          ) : screen === 'dashboard' ? (
            <DashboardVNextView model={dashboardModel} />
          ) : screen === 'congressional-staff' ? (
            <CongressionalStaffVNextView model={CONGRESSIONAL_STAFF_VISUAL_FIXTURE} />
          ) : screen === 'congressional-staff-empty' ? (
            <CongressionalStaffVNextView model={CONGRESSIONAL_STAFF_EMPTY_FIXTURE} />
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
        </AppShellUuiView>
        </div>
      </MemoryRouter>
    </QueryClientProvider>
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
