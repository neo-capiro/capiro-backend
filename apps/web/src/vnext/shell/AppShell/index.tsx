import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CapiroTopBar, CapiroBrand } from '../TopBar/index.js';
import { MeriLauncher } from '../MeriLauncher/index.js';
import { MailboxSyncStatus } from '../MailboxSyncStatus/index.js';
import { CapiroSidebar } from '../Sidebar/index.js';

/**
 * Foundation-only shell scaffold. It deliberately does not build the approved
 * navigation, context bar, page header or screen chrome yet; those land with
 * the page implementation phase. The scaffold proves the isolated ownership
 * boundary while continuing to render the existing route Outlet as children.
 */
export function VNextShellScaffold({ children }: { children: ReactNode }) {
  return (
    <div className="capiro-vnext-shell">
      <CapiroTopBar
        brand={<CapiroBrand environmentLabel="vNext" />}
        actions={<MeriLauncher />}
      />
      <CapiroSidebar
        items={[]}
        label="vNext foundation"
        footer={
          <>
            <MailboxSyncStatus />
            <Link className="capiro-vnext-nav-item" to="/settings">Settings</Link>
          </>
        }
      />
      <main className="capiro-vnext-content">
        <div className="capiro-vnext-foundation-banner">
          vNext foundation active · page implementation intentionally deferred
        </div>
        {children}
      </main>
    </div>
  );
}
