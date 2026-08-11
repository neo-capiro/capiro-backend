import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useClerk } from '@clerk/clerk-react';
import { CapiroTopBar, CapiroBrand, NotificationBell, ProfileMenu } from '../TopBar/index.js';
import { MeriLauncher } from '../MeriLauncher/index.js';
import { MailboxSyncStatus } from '../MailboxSyncStatus/index.js';
import { GlobalSearch } from '../GlobalSearch/index.js';
import { CapiroSidebar, CapiroNavItem } from '../Sidebar/index.js';
import { CapiroContextBar } from '../ContextBar/index.js';
import { MobileBottomNav } from '../BottomNav/index.js';
import { ShellOverlayProvider } from '../overlay-manager.js';
import { useShellNavigation } from '../../adapters/legacy/useShellNavigation.js';
import { useShellClientContext } from '../../adapters/legacy/useShellClientContext.js';
import { useShellIdentity } from '../../adapters/legacy/useShellIdentity.js';
import { useShellNotifications } from '../../adapters/legacy/useShellNotifications.js';
import { openMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';

const COLLAPSE_STORAGE_KEY = 'capiro.vnext.shell.collapsed';

/** Destinations the mobile bottom bar already exposes as tabs (759:2693). */
const BOTTOM_NAV_IDS = new Set(['dashboard', 'portfolio', 'intelligence', 'workspace']);

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * vNext application shell (`722:2502` expanded, `723:2530` collapsed).
 *
 * Presentation only: navigation targets come from the route manifest mapped to
 * routes registered in `App.tsx`, and every displayed value resolves to an
 * existing canonical query. See IMPLEMENTATION_CONTRACT.md.
 */
function VNextShellChrome({ children }: { children: ReactNode }) {
  const navigation = useShellNavigation();
  const clientContext = useShellClientContext();
  const identity = useShellIdentity();
  const notifications = useShellNotifications();
  const navigate = useNavigate();
  const { signOut } = useClerk();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [moreOpen, setMoreOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // A blocked storage write must not break navigation.
      }
      return next;
    });
  }, []);

  // MERI contract (`730:2574`): Ctrl+J opens the separate workspace window.
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

  return (
    <div className="capiro-vnext-shell" data-collapsed={collapsed || undefined}>
        {/* CapiroBrand takes no environment label: 722:2507, the wordmark-plus-
            environment copy, is hidden in the frame. */}
        <CapiroTopBar
          brand={<CapiroBrand />}
          search={<GlobalSearch scopeLabel={clientContext.scopeLabel} />}
          actions={
            <>
              <MeriLauncher />
              {/* Badge is count-only; detail opens in the dedicated surface. */}
              <NotificationBell
                notifications={notifications}
                onOpen={() => navigate('/workspace')}
              />
              <ProfileMenu
                identity={identity}
                onNavigate={navigate}
                onSignOut={() => void signOut()}
              />
            </>
          }
        />

        <CapiroSidebar
          routes={navigation.primary}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          footer={
            <>
              <MailboxSyncStatus />
              {navigation.settings?.path ? (
                <CapiroNavItem
                  item={{
                    id: 'settings',
                    label: navigation.settings.label,
                    path: navigation.settings.path,
                  }}
                />
              ) : null}
            </>
          }
        />

        {/* The context bar is per-screen, not global chrome: the Dashboard
            mockup (751:2502) has no context row, matching `DASHBOARD · OFF`. */}
        {clientContext.enabled ? <CapiroContextBar /> : null}

        <main className="capiro-vnext-content">{children}</main>

        {/* Mobile navigation is a bottom bar (759:2693), not a hidden sidebar.
            CSS owns which one is visible so there is no JS breakpoint here. */}
        <MobileBottomNav routes={navigation.primary} onOpenMore={() => setMoreOpen(true)} />

        {moreOpen ? (
          <div
            className="capiro-vnext-moresheet__scrim"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setMoreOpen(false);
            }}
          >
            <div className="capiro-vnext-moresheet" role="dialog" aria-modal="true" aria-label="More">
              <p className="capiro-vnext-moresheet__label">MORE</p>
              {navigation.primary
                .filter((route) => !BOTTOM_NAV_IDS.has(route.id))
                .map((route) =>
                  route.path ? (
                    <CapiroNavItem
                      key={route.id}
                      item={{ id: route.id, label: route.label, path: route.path }}
                    />
                  ) : null,
                )}
              {navigation.settings?.path ? (
                <CapiroNavItem
                  item={{
                    id: 'settings',
                    label: navigation.settings.label,
                    path: navigation.settings.path,
                  }}
                />
              ) : null}
              <MailboxSyncStatus />
            </div>
          </div>
        ) : null}
    </div>
  );
}

export function VNextShellScaffold({ children }: { children: ReactNode }) {
  return (
    <ShellOverlayProvider>
      <VNextShellChrome>{children}</VNextShellChrome>
    </ShellOverlayProvider>
  );
}
