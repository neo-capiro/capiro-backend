import { MeriOverlay } from '../../components/chat/MeriOverlay.js';
import { isMeriWorkspaceWindow } from '../../components/chat/meri-window.js';
import { OnboardingGates } from '../../components/onboarding/OnboardingGates.js';
import { TrialBanner } from '../../components/onboarding/TrialBanner.js';
import { VNextShellScaffold } from '../shell/AppShell/index.js';
import { VNextRouter } from './VNextRouter.js';
import '../foundations/index.css';

/**
 * vNext presentation root. Shared Clerk, Query, Ant and BrowserRouter providers
 * stay above this component in main.tsx. Existing route/page logic stays below
 * it through VNextRouter's Outlet.
 */
export function VNextApp() {
  // Preserve the existing real top-level Meri workspace behavior. A Meri popup
  // must not accidentally render another copy of the Capiro shell.
  if (isMeriWorkspaceWindow()) {
    return <MeriOverlay selectedClientName={null} />;
  }

  return (
    <div className="capiro-vnext-root" data-web-surface="vnext">
      <VNextShellScaffold>
        <TrialBanner />
        <OnboardingGates>
          <VNextRouter />
        </OnboardingGates>
      </VNextShellScaffold>
    </div>
  );
}
