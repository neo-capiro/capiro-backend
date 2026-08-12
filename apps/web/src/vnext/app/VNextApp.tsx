import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { MeriOverlay } from '../../components/chat/MeriOverlay.js';
import { isMeriWorkspaceWindow } from '../../components/chat/meri-window.js';
import { OnboardingGates } from '../../components/onboarding/OnboardingGates.js';
import { TrialBanner } from '../../components/onboarding/TrialBanner.js';
import { CapiroToastProvider } from '../components/feedback/toast.js';
import { VNextShellScaffold } from '../shell/AppShell/index.js';
import { DashboardShellUui } from '../pages/dashboard/shell-uui/DashboardShellUui.js';
import { VNextRouter } from './VNextRouter.js';
import '../foundations/index.css';

/**
 * vNext presentation root. Shared Clerk, Query, Ant and BrowserRouter providers
 * stay above this component in main.tsx. Existing route/page logic stays below
 * it through VNextRouter's Outlet.
 *
 * Shell choice is per-route, not global: Dashboard (`/`) is being reskinned
 * onto the purchased Untitled UI kit (`Capiro Dashboard - Untitled UI.dc.html`)
 * and gets its own DashboardShellUui. Every other vnext page keeps the
 * Capiro-native VNextShellScaffold untouched — reskinning the shared shell is
 * a separate, much larger decision this does not make unilaterally.
 */
export function VNextApp() {
  // Preserve the existing real top-level Meri workspace behavior. A Meri popup
  // must not accidentally render another copy of the Capiro shell.
  if (isMeriWorkspaceWindow()) {
    return <MeriOverlay selectedClientName={null} />;
  }

  return (
    <div className="capiro-vnext-root" data-web-surface="vnext">
      {/* Inside the root: `.capiro-toast-region` styles are scoped to it. */}
      <CapiroToastProvider>
        <VNextShell>
          <TrialBanner />
          <OnboardingGates>
            <VNextRouter />
          </OnboardingGates>
        </VNextShell>
      </CapiroToastProvider>
    </div>
  );
}

function VNextShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  return location.pathname === '/' ? (
    <DashboardShellUui>{children}</DashboardShellUui>
  ) : (
    <VNextShellScaffold>{children}</VNextShellScaffold>
  );
}
