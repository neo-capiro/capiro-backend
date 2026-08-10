import { MemoryRouter, Link } from 'react-router-dom';
import { CapiroBrand, CapiroTopBar } from '../../shell/TopBar/index.js';
import { GlobalSearch } from '../../shell/GlobalSearch/index.js';
import { MeriLauncher } from '../../shell/MeriLauncher/index.js';
import { CapiroSidebar } from '../../shell/Sidebar/index.js';
import { MailboxSyncStatusView } from '../../shell/MailboxSyncStatus/index.js';
import { FOUNDATION_MAILBOX_STATES } from '../fixtures/foundation.js';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', path: '/', icon: '⌂' },
  { id: 'portfolio', label: 'Portfolio', path: '/clients', icon: '◎' },
  { id: 'engagement', label: 'Engagement Manager', path: '/engagement', icon: '⌁' },
  { id: 'workspace', label: 'Workspace', path: '/workspace', icon: '▦' },
  { id: 'strategies', label: 'Strategies', path: '/strategies', icon: '◇' },
];

export function VNextShellVisual({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <MemoryRouter initialEntries={['/clients']}>
      <div className="capiro-vnext-root">
        <div className={`capiro-vnext-shell${collapsed ? ' capiro-vnext-shell--collapsed' : ''}`}>
          <CapiroTopBar
            brand={<CapiroBrand environmentLabel="visual baseline" />}
            search={<GlobalSearch onSubmit={() => undefined} />}
            actions={<MeriLauncher onLaunch={() => undefined} />}
          />
          <CapiroSidebar
            items={navItems}
            footer={
              <>
                <MailboxSyncStatusView status={FOUNDATION_MAILBOX_STATES[0]} />
                <Link className="capiro-vnext-nav-item" to="/settings">Settings</Link>
              </>
            }
          />
          <main className="capiro-vnext-content" style={{ padding: 20 }}>
            <div className="capiro-vnext-foundation-banner" style={{ margin: 0 }}>
              empty vNext shell scaffold · product screens intentionally absent
            </div>
          </main>
        </div>
      </div>
    </MemoryRouter>
  );
}
