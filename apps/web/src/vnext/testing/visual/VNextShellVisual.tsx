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
import { FOUNDATION_MAILBOX_STATES } from '../fixtures/foundation.js';

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

export function VNextShellVisual({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <MemoryRouter initialEntries={['/clients']}>
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
            <main className="capiro-vnext-content" style={{ padding: 20 }}>
              <div className="capiro-vnext-foundation-banner" style={{ margin: 0 }}>
                shell baseline · product screens intentionally absent
              </div>
            </main>
          </div>
        </div>
      </ShellOverlayProvider>
    </MemoryRouter>
  );
}
