import { MemoryRouter } from 'react-router-dom';
import {
  CapiroBrand,
  CapiroTopBar,
  NotificationBell,
  ProfileMenu,
} from '../../shell/TopBar/index.js';
import { CapiroNavItem } from '../../shell/Sidebar/index.js';
import { GlobalSearch } from '../../shell/GlobalSearch/index.js';
import { MeriLauncher } from '../../shell/MeriLauncher/index.js';
import { CapiroSidebar } from '../../shell/Sidebar/index.js';
import { MailboxSyncStatusView } from '../../shell/MailboxSyncStatus/index.js';
import { ShellOverlayProvider } from '../../shell/overlay-manager.js';
import { VNEXT_ROUTE_MANIFEST } from '../../adapters/routes/routeManifest.js';
import { DashboardVNextView } from '../../pages/dashboard/DashboardVNext.js';
import { DashboardShellUuiView } from '../../pages/dashboard/shell-uui/DashboardShellUui.js';
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
 */
const visualRoutes = VNEXT_ROUTE_MANIFEST.filter((route) => route.id !== 'settings');

const fixtureIdentity = {
  loading: false,
  unavailable: false,
  name: 'Neo Martinez',
  role: 'VP Government Affairs',
  email: 'neo@capiro.ai',
  initials: 'NM',
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
  // Temporary: the Untitled-UI reskin's own shell, verified in isolation
  // before the dashboard content modules are reskinned onto it too. Remove
  // once dashboard-uui is folded into the real / route and this harness no
  // longer needs a side-by-side comparison point.
  | 'dashboard-uui'
  | 'client-crm'
  | 'congressional-staff'
  | 'congressional-staff-empty';

/**
 * Each screen renders at the route it actually ships on, so the sidebar's
 * current-item state and the context bar are exercised, not faked.
 *
 * `/clients` carries `clientId` because the vNext interception requires a param
 * the app does not otherwise set — see `1a0b000c`, where its absence meant the
 * CRM surface never rendered at all.
 */
const SCREEN_ROUTES: Record<VNextVisualScreen, string> = {
  empty: '/clients?clientId=visual-fixture',
  dashboard: '/',
  'dashboard-uui': '/',
  'client-crm': '/clients?clientId=visual-fixture',
  'congressional-staff': DIRECTORY_ROUTES.congressionalStaff,
  'congressional-staff-empty': DIRECTORY_ROUTES.congressionalStaff,
};

export function VNextShellVisual({
  collapsed = false,
  screen = 'empty',
  crmTab = 'overview',
  attnState,
}: {
  collapsed?: boolean;
  screen?: VNextVisualScreen;
  crmTab?: 'overview' | 'relationships' | 'work' | 'intelligence' | 'files';
  /** Forces Needs Attention into one of the six named states (754:2885) —
   * ModuleStateView is shared across all four modules, so this exercises the
   * same render path every module's state block uses. */
  attnState?: keyof typeof DASHBOARD_STATE_FIXTURES;
}) {
  if (screen === 'dashboard-uui') {
    const settingsRoute = VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'settings') ?? null;
    const dashboardModel = attnState && DASHBOARD_STATE_FIXTURES[attnState]
      ? DASHBOARD_STATE_FIXTURES[attnState]
      : DASHBOARD_VISUAL_FIXTURE;
    return (
      <MemoryRouter initialEntries={[SCREEN_ROUTES[screen]]}>
        <div className="capiro-vnext-root">
          <DashboardShellUuiView
            navigation={{ primary: visualRoutes, settings: settingsRoute, loading: false }}
            identity={fixtureIdentity}
            notifications={fixtureNotifications}
            mailboxStatus={FOUNDATION_MAILBOX_STATES[0]}
            onNavigate={() => undefined}
            onOpenNotifications={() => undefined}
            onSignOut={() => undefined}
          >
            <DashboardVNextView model={dashboardModel} />
          </DashboardShellUuiView>
        </div>
      </MemoryRouter>
    );
  }

  return (
    <MemoryRouter initialEntries={[SCREEN_ROUTES[screen]]}>
      <ShellOverlayProvider>
        <div className="capiro-vnext-root">
          <div className="capiro-vnext-shell" data-collapsed={collapsed || undefined}>
            <CapiroTopBar
              brand={<CapiroBrand environmentLabel="visual baseline" />}
              search={<GlobalSearch scopeLabel="All clients" />}
              actions={
                <>
                  <MeriLauncher onLaunch={() => undefined} />
                  <NotificationBell
                    notifications={fixtureNotifications}
                    onOpen={() => undefined}
                  />
                  <ProfileMenu
                    identity={fixtureIdentity}
                    onNavigate={() => undefined}
                    onSignOut={() => undefined}
                  />
                </>
              }
            />
            <CapiroSidebar
              routes={visualRoutes}
              collapsed={collapsed}
              onToggleCollapsed={() => undefined}
              footer={
                <>
                  <MailboxSyncStatusView status={FOUNDATION_MAILBOX_STATES[0]} />
                  <CapiroNavItem item={{ id: 'settings', label: 'Settings', path: '/settings' }} />
                </>
              }
            />
            <div className="capiro-vnext-contextbar" role="region" aria-label="Working context">
              <span className="capiro-vnext-context-chip capiro-vnext-context-chip--unavailable">
                <span className="capiro-vnext-context-chip__label">CLIENT</span>
                <span className="capiro-vnext-context-chip__value">All clients</span>
              </span>
              <span className="capiro-vnext-contextbar__scope">All clients</span>
            </div>
            <main className="capiro-vnext-content">
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
                <DashboardVNextView model={DASHBOARD_VISUAL_FIXTURE} />
              ) : screen === 'congressional-staff' ? (
                <CongressionalStaffVNextView model={CONGRESSIONAL_STAFF_VISUAL_FIXTURE} />
              ) : screen === 'congressional-staff-empty' ? (
                <CongressionalStaffVNextView model={CONGRESSIONAL_STAFF_EMPTY_FIXTURE} />
              ) : (
                <div className="capiro-vnext-foundation-banner" style={{ margin: 20 }}>
                  shell baseline · product screens intentionally absent
                </div>
              )}
            </main>
          </div>
        </div>
      </ShellOverlayProvider>
    </MemoryRouter>
  );
}
