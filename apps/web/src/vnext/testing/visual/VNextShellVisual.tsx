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
import { ClientCrmHeader } from '../../pages/client-crm/ClientCrmPage.js';
import { ClientCrmOverviewView } from '../../pages/client-crm/ClientCrmOverview.js';
import {
  CLIENT_CRM_VISUAL_CLIENT,
  CLIENT_CRM_VISUAL_FIXTURE,
} from '../fixtures/client-crm.js';
import '../../pages/client-crm/client-crm.css';

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
  attnState,
}: {
  collapsed?: boolean;
  screen?: VNextVisualScreen;
  crmTab?: 'overview' | 'relationships' | 'work' | 'intelligence' | 'files';
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
            // Client CRM / 01 Overview (`906:2503`). Header and body are
            // composed separately so the body stays data-free.
            <div className="capiro-crm" data-tab="overview">
              <ClientCrmHeader
                client={CLIENT_CRM_VISUAL_CLIENT}
                route={{ tab: crmTab }}
                onNavigate={() => undefined}
              />
              {crmTab === 'overview' ? (
                <ClientCrmOverviewView model={CLIENT_CRM_VISUAL_FIXTURE} />
              ) : (
                <div className="capiro-crm__body">
                  <div className="capiro-crm__page-head">
                    <div>
                      <h2 className="capiro-crm__page-title">{crmTab}</h2>
                      <p className="capiro-crm__page-sub">
                        Data-backed surface; only the header geometry is captured here.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
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
        </AppShellUuiView>
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
