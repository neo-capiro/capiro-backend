import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useClerk } from '@clerk/clerk-react';
import {
  useShellNavigation,
  type ShellNavigationViewModel,
} from '../../adapters/legacy/useShellNavigation.js';
import {
  useShellIdentity,
  type ShellIdentityViewModel,
} from '../../adapters/legacy/useShellIdentity.js';
import {
  useShellNotifications,
  type ShellNotificationsViewModel,
} from '../../adapters/legacy/useShellNotifications.js';
import { useShellClientContext } from '../../adapters/legacy/useShellClientContext.js';
import type { VNextRouteDefinition } from '../../adapters/routes/routeManifest.js';
import { MeriLauncher } from '../MeriLauncher/index.js';
import { NotificationBell, ProfileMenu } from '../TopBar/index.js';
import { GlobalSearch } from '../GlobalSearch/index.js';
import { MailboxSyncStatusView } from '../MailboxSyncStatus/index.js';
import {
  useMailboxSyncStatus,
  type MailboxSyncViewModel,
} from '../../adapters/legacy/useMailboxSyncStatus.js';
import { ShellOverlayProvider, useShellOverlay } from '../overlay-manager.js';
import { openMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';
import { Icon, NAV_ICON_BY_ROUTE_ID } from './icons.js';
import './shell-uui.css';

const COLLAPSE_KEY = 'capiro.vnext.shell-uui.collapsed';
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

/**
 * ============================================================================
 * GLOBAL LEFT NAV — INLINE DROPDOWNS (Neo Martinez directive 2026-08-16)
 * ============================================================================
 * Directory / Intelligence / Engagement families ALWAYS expand INLINE below
 * their parent row — NEVER as a white flyout positioned to the right of the
 * rail. The 2026-08-16 target screenshot (dark rail, Meetings expanded inline
 * under Engagement) is the canonical reference. The nested list reuses the
 * v3 dark-chrome treatment; the active child is the soft white-tint fill.
 *
 * Behavior:
 *   - While the current location is inside a family, that family is pinned
 *     open (the child list is always visible) — same as the legacy
 *     ContextBar-area IntelligenceRail this shell replaced.
 *   - Off-family, clicking the parent row toggles the inline list.
 *
 * DO NOT modify this component, the rail markup, or the rail CSS unless the
 * change is explicitly approved by Neo Martinez. The left nav and top bar are
 * global chrome and must look identical on every vNext page.
 * ============================================================================
 */
function NavFlyout({ route }: { route: VNextRouteDefinition }) {
  const { isOpen, containerRef, toggle, close } = useShellOverlay(
    route.id as 'directory' | 'intelligence' | 'engagement-manager',
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const location = useLocation();
  const children = route.children ?? [];
  const hasCurrentChild = children.some(
    (child) => child.path && location.pathname.startsWith(child.path),
  );

  // Pinned open while on a family route; otherwise the click toggles the
  // inline list. Either way the children render INSIDE the rail below the
  // parent row — there is no detached right-opening flyout anymore.
  const expanded = hasCurrentChild || isOpen;

  const childList = () =>
    children.map((child) => {
      // Every family here so far (Directory, Intelligence) has disjoint sibling
      // paths, so React Router's default prefix match ("/foo" matches
      // "/foo/bar") never collides. Strategies breaks that assumption: its
      // library child IS "/strategies", a strict prefix of its own siblings
      // ("/strategies/context", "/strategies/agents/..."), so without `end`
      // it would stay lit as "current" while actually on Context library or
      // Agent review. `end` scopes it to an exact match instead.
      const end = child.path
        ? children.some((sibling) => sibling !== child && sibling.path?.startsWith(`${child.path}/`))
        : false;
      return child.path ? (
        <NavLink
          key={child.id}
          role="menuitem"
          to={child.path}
          end={end}
          className="uui-nav-nested-item"
          onClick={close}
        >
          <span className="uui-nav-nested-item__label">{child.label}</span>
        </NavLink>
      ) : (
        <div
          key={child.id}
          role="menuitem"
          aria-disabled="true"
          className="uui-nav-nested-item uui-nav-nested-item--disabled"
        >
          <span className="uui-nav-nested-item__label">{child.label}</span>
        </div>
      );
    });

  return (
    <div className="uui-nav-group" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`uui-nav-item uui-nav-item--trigger${
          hasCurrentChild ? ' uui-nav-item--current' : ''
        }`}
        aria-expanded={expanded}
        aria-haspopup="menu"
        onClick={() => toggle(triggerRef.current)}
      >
        <Icon
          name={NAV_ICON_BY_ROUTE_ID[route.id] ?? 'grid'}
          size={20}
          className="uui-nav-item__icon"
        />
        <span className="uui-nav-item__label">{route.label}</span>
        {/* chevronRight rotates 90deg (points down) when the family is open —
            the CSS transition on .uui-nav-item__chevron animates it. */}
        <Icon
          name="chevronRight"
          size={16}
          className="uui-nav-item__chevron"
          data-open={expanded || undefined}
        />
      </button>

      {expanded ? (
        <div className="uui-nav-nested" role="menu" aria-label={route.label}>
          {childList()}
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
      <Icon
        name={NAV_ICON_BY_ROUTE_ID[route.id] ?? 'grid'}
        size={20}
        className="uui-nav-item__icon"
      />
      <span className="uui-nav-item__label">{route.label}</span>
    </NavLink>
  );
}

/** Exported for the shell contract test; the topbar is its only caller. */
export function topbarSectionLabel(
  pathname: string,
  routes: readonly VNextRouteDefinition[],
): string {
  const current = routes.find((route) => {
    if (route.path && (pathname === route.path || pathname.startsWith(`${route.path}/`))) {
      return true;
    }
    return route.children?.some(
      (child) => child.path && (pathname === child.path || pathname.startsWith(`${child.path}/`)),
    );
  });
  if (!current) return 'Dashboard';
  return current.id === 'engagement-manager' ? 'Engagement' : current.label;
}

export interface AppShellUuiViewProps {
  navigation: ShellNavigationViewModel;
  identity: ShellIdentityViewModel;
  notifications: ShellNotificationsViewModel;
  mailboxStatus: MailboxSyncViewModel;
  /** SCOPE contract (730:2589) — same string GlobalSearch's footer states on
   * every other vnext page; Dashboard forces "All clients" (729:2612). */
  scopeLabel: string;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
  onOpenProfile: () => void;
  /** Overrides the persisted collapse state — the vnext-visual-capture
   * script's only way to force the collapsed screenshot variant (it has no
   * localStorage to seed). Real usage omits this and reads localStorage. */
  initialCollapsed?: boolean;
  children: ReactNode;
}

/**
 * Pure presentation — no data hooks of its own beyond local UI state and the
 * overlay coordinator, so it renders identically in the real app and in the
 * Clerk-free vnext-shell.html visual harness (`?screen=dashboard-uui`).
 * Mirrors the DashboardVNext / DashboardVNextView split elsewhere in vnext.
 */
export function AppShellUuiView({
  navigation,
  identity,
  notifications,
  mailboxStatus,
  scopeLabel,
  onNavigate,
  onSignOut,
  onOpenProfile,
  initialCollapsed,
  children,
}: AppShellUuiViewProps) {
  const [collapsed, setCollapsed] = useState(() => initialCollapsed ?? readCollapsed());
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const sectionLabel = topbarSectionLabel(location.pathname, navigation.primary);

  // Same MERI contract VNextShellChrome enforces (730:2574): Ctrl+J opens the
  // separate workspace window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        openMeriWorkspaceWindow();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  /*
   * A nav FAMILY carries no path of its own — `intelligence` is `path: null` in
   * the route manifest because the legacy /intelligence route only redirects to
   * Data Explorer. Rendering `to="#"` for it made the mobile Intel tab (a) go
   * nowhere and (b) match the current location on EVERY page, so it painted as
   * the active tab everywhere. Resolve a family to its first child that has a
   * real path; only fall back to '#' if the manifest genuinely offers nothing.
   * Uses manifest data only — no invented URLs.
   */
  const destinationOf = (route: VNextRouteDefinition): string | null =>
    route.path ?? route.children?.find((child) => child.path)?.path ?? null;

  return (
    <ShellOverlayProvider>
      <div className="capiro-vnext-uui" data-collapsed={collapsed || undefined}>
        <header className="uui-topbar">
          <span className="uui-topbar__brand">
            <img src="/logo.png" alt="Capiro" className="uui-topbar__wordmark" />
            <span className="uui-topbar__divider" aria-hidden="true" />
            <span className="uui-topbar__section">{sectionLabel}</span>
            <span className="uui-topbar__scope">{scopeLabel}</span>
          </span>
          <div className="uui-topbar__search">
            <GlobalSearch scopeLabel={scopeLabel} />
          </div>
          <div className="uui-topbar__actions">
            <MeriLauncher />
            <NotificationBell notifications={notifications} />
            <ProfileMenu
              identity={identity}
              onNavigate={onNavigate}
              onSignOut={onSignOut}
              onOpenProfile={onOpenProfile}
            />
          </div>
        </header>

        <aside
          className="uui-rail"
          data-collapsed={collapsed || undefined}
          aria-label="Primary navigation"
        >
          {!collapsed ? <div className="uui-rail__eyebrow">NAVIGATION</div> : null}
          <nav className="uui-rail__nav">
            {navigation.primary.map((route) => (
              <NavRow key={route.id} route={route} />
            ))}
          </nav>
          <div className="uui-rail__footer">
            <MailboxSyncStatusView
              status={mailboxStatus}
              onClick={() => onNavigate('/settings/integrations')}
            />
            {navigation.settings?.path ? (
              <NavLink to={navigation.settings.path} className="uui-nav-item">
                <Icon name="settings" size={20} className="uui-nav-item__icon" />
                <span className="uui-nav-item__label">{navigation.settings.label}</span>
              </NavLink>
            ) : null}
            <button
              type="button"
              className="uui-collapse-btn"
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            >
              <Icon name={collapsed ? 'expand' : 'collapse'} size={20} />
              {!collapsed ? <span className="uui-collapse-btn__label">Collapse</span> : null}
            </button>
          </div>
        </aside>

        <main className="uui-content">{children}</main>

        <nav className="uui-bottomnav" aria-label="Primary navigation">
          {tabRoutes.map((route) => (
            <NavLink
              key={route.id}
              to={destinationOf(route) ?? '#'}
              end={route.path === '/'}
              className={({ isActive }) =>
                `uui-bottomnav__item${isActive ? ' uui-bottomnav__item--current' : ''}`
              }
            >
              <Icon name={NAV_ICON_BY_ROUTE_ID[route.id] ?? 'grid'} size={21} />
              <span>{TAB_LABEL_OVERRIDES[route.id] ?? route.label}</span>
            </NavLink>
          ))}
          <button type="button" className="uui-bottomnav__item" onClick={() => setMoreOpen(true)}>
            <Icon name="dots" size={21} />
            <span>More</span>
          </button>
        </nav>

        {moreOpen ? (
          <div
            className="uui-moresheet__scrim"
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setMoreOpen(false);
            }}
          >
            <div className="uui-moresheet" role="dialog" aria-modal="true" aria-label="More">
              <p className="uui-moresheet__label">MORE</p>
              {moreRoutes.map((route) =>
                destinationOf(route) ? (
                  <NavLink
                    key={route.id}
                    to={destinationOf(route) as string}
                    className="uui-nav-item"
                    onClick={() => setMoreOpen(false)}
                  >
                    <Icon
                      name={NAV_ICON_BY_ROUTE_ID[route.id] ?? 'grid'}
                      size={20}
                      className="uui-nav-item__icon"
                    />
                    <span className="uui-nav-item__label">{route.label}</span>
                  </NavLink>
                ) : null,
              )}
              {navigation.settings?.path ? (
                <NavLink
                  to={navigation.settings.path}
                  className="uui-nav-item"
                  onClick={() => setMoreOpen(false)}
                >
                  <span className="uui-nav-item__label">{navigation.settings.label}</span>
                </NavLink>
              ) : null}
              <MailboxSyncStatusView
                status={mailboxStatus}
                onClick={() => onNavigate('/settings/integrations')}
              />
            </div>
          </div>
        ) : null}
      </div>
    </ShellOverlayProvider>
  );
}

/**
 * ============================================================================
 * GLOBAL vNext SHELL — TOP BAR + LEFT NAV (Neo Martinez directive 2026-08-16)
 * ============================================================================
 * The one global vNext shell (Figma `Capiro Dashboard - Untitled UI.dc.html`,
 * top bar/rail geometry from `748:2503`). Replaces VNextShellScaffold
 * (`shell/AppShell/index.tsx`) as of 2026-08 — Neo: "the top nav and left nav
 * should be global and look exactly the same across all pages." The old
 * Capiro-native shell components are left in place (VNextShellVisual.tsx's
 * harness screens still use them) but nothing in production mounts them
 * anymore; see VNextApp.tsx.
 *
 * 2026-08-16: the left-rail dropdown families (Directory / Intelligence /
 * Engagement) now expand INLINE below their parent row — never a white
 * flyout to the right — matching the target screenshot Neo attached. See the
 * NavFlyout comment and the rail rules in shell-uui.css.
 *
 * DO NOT modify the left nav or top bar — markup, tokens, or CSS — unless the
 * change is explicitly approved by Neo Martinez. This chrome is global and
 * must look identical on every vNext page.
 * ============================================================================
 *
 * Behavior is 100% reused, not reimplemented: useShellNavigation/Identity/
 * Notifications/ClientContext, useMailboxSyncStatus (via
 * MailboxSyncStatusView), Clerk sign-out, MeriLauncher, GlobalSearch,
 * NotificationBell and ProfileMenu are the exact same modules the
 * Capiro-native shell used. Only the markup and CSS in AppShellUuiView are
 * new — see icons.tsx for why the icon treatment differs on purpose. All real
 * hooks live here in the container so AppShellUuiView stays renderable in the
 * Clerk-free vnext-shell.html harness with fixture props.
 */
export function AppShellUui({ children }: { children: ReactNode }) {
  const navigation = useShellNavigation();
  const identity = useShellIdentity();
  const notifications = useShellNotifications();
  const mailboxStatus = useMailboxSyncStatus();
  const clientContext = useShellClientContext();
  const navigate = useNavigate();
  const { signOut, openUserProfile } = useClerk();

  return (
    <AppShellUuiView
      navigation={navigation}
      identity={identity}
      notifications={notifications}
      mailboxStatus={mailboxStatus}
      scopeLabel={clientContext.scopeLabel}
      onNavigate={navigate}
      onSignOut={() => void signOut()}
      onOpenProfile={() => openUserProfile()}
    >
      {children}
    </AppShellUuiView>
  );
}
