import { MeriOverlay } from '../../components/chat/MeriOverlay.js';
import { isMeriWorkspaceWindow } from '../../components/chat/meri-window.js';
import { OnboardingGates } from '../../components/onboarding/OnboardingGates.js';
import { TrialBanner } from '../../components/onboarding/TrialBanner.js';
import { CapiroToastProvider } from '../components/feedback/toast.js';
import { AppShellUui } from '../shell/AppShellUui/index.js';
import { VNextRouter } from './VNextRouter.js';
import '../foundations/index.css';

/**
 * vNext presentation root. Shared Clerk, Query, Ant and BrowserRouter providers
 * stay above this component in main.tsx. Existing route/page logic stays below
 * it through VNextRouter's Outlet.
 *
 * One global shell (AppShellUui) for every vnext page, as of 2026-08 — Neo:
 * "the top nav and left nav should be global and look exactly the same
 * across all pages." Previously this picked between AppShellUui and the
 * Capiro-native VNextShellScaffold by route; that scaffold is retired from
 * production (still used by VNextShellVisual.tsx's harness screens, but
 * nothing real mounts it).
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
        <AppShellUui>
          <TrialBanner />
          <OnboardingGates>
            <VNextRouter />
          </OnboardingGates>
        </AppShellUui>
      </CapiroToastProvider>
    </div>
  );
}
