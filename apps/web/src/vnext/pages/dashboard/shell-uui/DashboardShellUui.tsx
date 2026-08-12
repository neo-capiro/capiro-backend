import { useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useClerk } from '@clerk/clerk-react';
import { useShellNavigation, type ShellNavigationViewModel } from '../../../adapters/legacy/useShellNavigation.js';
import { useShellIdentity, type ShellIdentityViewModel } from '../../../adapters/legacy/useShellIdentity.js';
import { useShellNotifications, type ShellNotificationsViewModel } from '../../../adapters/legacy/useShellNotifications.js';
import type { VNextRouteDefinition } from '../../../adapters/routes/routeManifest.js';
import { MeriLauncher } from '../../../shell/MeriLauncher/index.js';
import { NotificationBell, ProfileMenu } from '../../../shell/TopBar/index.js';
import { GlobalSearch } from '../../../shell/GlobalSearch/index.js';
import { MailboxSyncStatusView } from '../../../shell/MailboxSyncStatus/index.js';
import { useMailboxSyncStatus, type MailboxSyncViewModel } from '../../../adapters/legacy/useMailboxSyncStatus.js';
import { ShellOverlayProvider, useShellOverlay } from '../../../shell/overlay-manager.js';
import { SHELL_NAV_DESCRIPTIONS } from '../../../shell/nav-content.js';
import { Icon, NAV_ICON_BY_ROUTE_ID } from './icons.js';
import './dashboard-shell-uui.css';

const COLLAPSE_KEY = 'capiro.vnext.dashboard-shell-uui.collapsed';
/**
 * Same four destinations the Capiro-native BottomNav exposes as tabs, plus
 * More — in the handoff's specified order (Home/Clients/Intel/Work), which
 * differs from the rail's order. Labels differ too: the rail says
 * "Dashboard", the tab bar says "Home" for the same route (`TABS` in the
 * reference .dc component draws this same distinction).
 */
const TAB_ROUTE_IDS = ['dashboard', 'portfolio', 'intelligence', 'workspace'];
const TAB_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  dashboard: 'Home',
  portfolio: 'Clients',
  intelligence: 'Intel',
  workspace: 'Work',
};

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function NavFlyout({ route }: { route: VNextRouteDefinition }) {
  const { isOpen, containerRef, toggle, close } = useShellOverlay(
    route.id as 'directory' | 'intelligence',
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const location = useLocation();
  const children = route.children ?? [];
  const hasCurrentChild = children.some(
    (child) => child.path && location.pathname.startsWith(child.path),
  );

  return (
    <div className="uui-nav-group" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`uui-nav-item${hasCurrentChild ? ' uui-nav-item--current' : ''}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={() => toggle(triggerRef.current)}
      >
        <Icon name={NAV_ICON_BY_ROUTE_ID[route.id] ?? 'grid'} className="uui-nav-item__icon" />
        <span className="uui-nav-item__label">{route.label}</span>
        <Icon name="chevronRight" size={16} className="uui-nav-item__chevron" />
      </button>

      {isOpen ? (
        <div className="uui-flyout" role="menu" aria-label={route.label}>
          {children.map((child) =>
            child.path ? (
              <NavLink key={child.id} role="menuitem" to={child.path} className="uui-flyout__item" onClick={close}>
                <span className="uui-flyout__name">{child.label}</span>
                {SHELL_NAV_DESCRIPTIONS[child.id] ? (
                  <span className="uui-flyout__meta">{SHELL_NAV_DESCRIPTIONS[child.id]}</span>
                ) : null}
              </NavLink>
            ) : (
              <div key={child.id} role="menuitem" aria-disabled="true" className="uui-flyout__item uui-flyout__item--disabled">
                <span className="uui-flyout__name">{child.label}</span>
                <span className="uui-flyout__tag">Not available</span>
              </div>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function NavRow({ route }: { route: VNextRouteDefinition }) {
  if (route.children?.length) return <NavFlyout route={route} />;
  if (!route.path) return null;
  return (
    <NavLink
      to={route.path}
      end={route.path === '/'}
      className={({ isActive }) => `uui-nav-item${isActive ? ' uui-nav-item--current' : ''}`}
    >
      <Icon name={NAV_ICON_BY_ROUTE_ID[route.id] ?? 'grid'} className="uui-nav-item__icon" />
      <span className="uui-nav-item__label">{route.label}</span>
    </NavLink>
  );
}

export interface DashboardShellUuiViewProps {
  navigation: ShellNavigationViewModel;
  identity: ShellIdentityViewModel;
  notifications: ShellNotificationsViewModel;
  mailboxStatus: MailboxSyncViewModel;
  onNavigate: (path: string) => void;
  onOpenNotifications: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

/**
 * Pure presentation — no data hooks of its own beyond local UI state and the
 * overlay coordinator, so it renders identically in the real app and in the
 * Clerk-free vnext-shell.html visual harness (`?screen=dashboard-uui`).
 * Mirrors the DashboardVNext / DashboardVNextView split one directory over.
 */
export function DashboardShellUuiView({
  navigation,
  identity,
  notifications,
  mailboxStatus,
  onNavigate,
  onOpenNotifications,
  onSignOut,
  children,
}: DashboardShellUuiViewProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [moreOpen, setMoreOpen] = useState(false);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // A blocked storage write must not break navigation.
      }
      return next;
    });
  };

  const tabRoutes = TAB_ROUTE_IDS.map((id) => navigation.primary.find((r) => r.id === id)).filter(
    (r): r is VNextRouteDefinition => !!r,
  );
  const moreRoutes = navigation.primary.filter((r) => !TAB_ROUTE_IDS.includes(r.id));

  return (
    <ShellOverlayProvider>
      <div className="capiro-dash-uui" data-collapsed={collapsed || undefined}>
        <header className="uui-topbar">
          <span className="uui-topbar__brand">
            <img src="/logo.png" alt="Capiro" className="uui-topbar__wordmark" />
          </span>
          <div className="uui-topbar__search">
            <GlobalSearch />
          </div>
          <div className="uui-topbar__actions">
            <MeriLauncher />
            <NotificationBell notifications={notifications} onOpen={onOpenNotifications} />
            <ProfileMenu identity={identity} onNavigate={onNavigate} onSignOut={onSignOut} />
          </div>
        </header>

        <aside className="uui-rail" data-collapsed={collapsed || undefined} aria-label="Primary navigation">
          <nav className="uui-rail__nav">
            {navigation.primary.map((route) => <NavRow key={route.id} route={route} />)}
          </nav>
          <div className="uui-rail__footer">
            <MailboxSyncStatusView status={mailboxStatus} onClick={() => onNavigate('/settings/integrations')} />
            {navigation.settings?.path ? (
              <NavLink to={navigation.settings.path} className="uui-nav-item">
                <Icon name="grid" className="uui-nav-item__icon" />
                <span className="uui-nav-item__label">{navigation.settings.label}</span>
              </NavLink>
            ) : null}
            <button
              type="button"
              className="uui-collapse-btn"
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            >
              <Icon name={collapsed ? 'expand' : 'collapse'} size={16} />
              {!collapsed ? <span>Collapse</span> : null}
            </button>
          </div>
        </aside>

        <main className="uui-content">{children}</main>

        <nav className="uui-bottomnav" aria-label="Primary navigation">
          {tabRoutes.map((route) => (
            <NavLink key={route.id} to={route.path ?? '#'} end={route.path === '/'} className={({ isActive }) => `uui-bottomnav__item${isActive ? ' uui-bottomnav__item--current' : ''}`}>
              <Icon name={NAV_ICON_BY_ROUTE_ID[route.id] ?? 'grid'} size={22} />
              <span>{TAB_LABEL_OVERRIDES[route.id] ?? route.label}</span>
            </NavLink>
          ))}
          <button type="button" className="uui-bottomnav__item" onClick={() => setMoreOpen(true)}>
            <Icon name="dots" size={22} />
            <span>More</span>
          </button>
        </nav>

        {moreOpen ? (
          <div className="uui-moresheet__scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setMoreOpen(false); }}>
            <div className="uui-moresheet" role="dialog" aria-modal="true" aria-label="More">
              <p className="uui-moresheet__label">MORE</p>
              {moreRoutes.map((route) => (
                route.path ? (
                  <NavLink key={route.id} to={route.path} className="uui-nav-item" onClick={() => setMoreOpen(false)}>
                    <Icon name={NAV_ICON_BY_ROUTE_ID[route.id] ?? 'grid'} className="uui-nav-item__icon" />
                    <span className="uui-nav-item__label">{route.label}</span>
                  </NavLink>
                ) : null
              ))}
              {navigation.settings?.path ? (
                <NavLink to={navigation.settings.path} className="uui-nav-item" onClick={() => setMoreOpen(false)}>
                  <span className="uui-nav-item__label">{navigation.settings.label}</span>
                </NavLink>
              ) : null}
              <MailboxSyncStatusView status={mailboxStatus} onClick={() => onNavigate('/settings/integrations')} />
            </div>
          </div>
        ) : null}
      </div>
    </ShellOverlayProvider>
  );
}

/**
 * Dashboard's own Untitled-UI shell container (`Capiro Dashboard - Untitled
 * UI.dc.html`). Deliberately NOT VNextShellScaffold: reskinning the shared
 * Capiro-native shell would touch every other vnext page (LegiWatch,
 * Strategies, Directory, Program Elements, Client CRM). This mounts only at
 * `/`, and every other vnext route keeps the existing shell untouched — see
 * VNextApp.tsx.
 *
 * Behavior is 100% reused, not reimplemented: useShellNavigation/Identity/
 * Notifications, useMailboxSyncStatus (via MailboxSyncStatusView), Clerk
 * sign-out, MeriLauncher, GlobalSearch, NotificationBell and ProfileMenu are
 * the exact same modules the Capiro-native shell uses. Only the markup and
 * CSS in DashboardShellUuiView are new — see icons.tsx for why the icon
 * treatment differs on purpose. All real hooks live here in the container so
 * DashboardShellUuiView stays renderable in the Clerk-free vnext-shell.html
 * harness with fixture props, same split as DashboardVNext/DashboardVNextView.
 */
export function DashboardShellUui({ children }: { children: ReactNode }) {
  const navigation = useShellNavigation();
  const identity = useShellIdentity();
  const notifications = useShellNotifications();
  const mailboxStatus = useMailboxSyncStatus();
  const navigate = useNavigate();
  const { signOut } = useClerk();

  return (
    <DashboardShellUuiView
      navigation={navigation}
      identity={identity}
      notifications={notifications}
      mailboxStatus={mailboxStatus}
      onNavigate={navigate}
      onOpenNotifications={() => navigate('/workspace')}
      onSignOut={() => void signOut()}
    >
      {children}
    </DashboardShellUuiView>
  );
}
