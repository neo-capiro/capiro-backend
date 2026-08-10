import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useClerk } from '@clerk/clerk-react';
import { CapiroTopBar, CapiroBrand, NotificationBell, ProfileMenu } from '../TopBar/index.js';
import { MeriLauncher } from '../MeriLauncher/index.js';
import { MailboxSyncStatus } from '../MailboxSyncStatus/index.js';
import { GlobalSearch } from '../GlobalSearch/index.js';
import { CapiroSidebar, CapiroNavItem } from '../Sidebar/index.js';
import { CapiroContextBar } from '../ContextBar/index.js';
import { ShellOverlayProvider } from '../overlay-manager.js';
import { useShellNavigation } from '../../adapters/legacy/useShellNavigation.js';
import { useShellClientContext } from '../../adapters/legacy/useShellClientContext.js';
import { useShellIdentity } from '../../adapters/legacy/useShellIdentity.js';
import { useShellNotifications } from '../../adapters/legacy/useShellNotifications.js';
import { openMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';

const COLLAPSE_STORAGE_KEY = 'capiro.vnext.shell.collapsed';

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
        <CapiroTopBar
          brand={<CapiroBrand environmentLabel="vNext" />}
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

        <CapiroContextBar />

        <main className="capiro-vnext-content">{children}</main>
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
