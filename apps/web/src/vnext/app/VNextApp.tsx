import { useLocation } from 'react-router-dom';
import { MeriOverlay } from '../../components/chat/MeriOverlay.js';
import { isMeriWorkspaceWindow } from '../../components/chat/meri-window.js';
import { OnboardingGates } from '../../components/onboarding/OnboardingGates.js';
import { TrialBanner } from '../../components/onboarding/TrialBanner.js';
import { CapiroToastProvider } from '../components/feedback/toast.js';
import { VNextMeriWorkspace } from '../meri/VNextMeriWorkspace.js';
import { AppShellUui } from '../shell/AppShellUui/index.js';
import { VNextRouter } from './VNextRouter.js';
import '../foundations/index.css';

/**
 * vNext presentation root. Shared Clerk, Query, Ant and BrowserRouter providers
 * stay above this component in main.tsx. Existing route/page logic stays below
 * it through VNextRouter's Outlet.
 *
 * One global shell (AppShellUui) for normal vNext product pages. Meri is the
 * deliberate exception: the undocked workspace is itself a full-window shell,
 * so /meri* bypasses AppShellUui exactly like the existing popup does.
 */
export function VNextApp() {
  const location = useLocation();

  // Preserve the existing real top-level Meri workspace behavior. A Meri popup
  // must not accidentally render another copy of the Capiro shell.
  if (isMeriWorkspaceWindow()) {
    return <MeriOverlay selectedClientName={null} />;
  }

  // Addressable Meri routes are their own full-window workspace. They reuse the
  // canonical controller/store through a vNext-only adapter, so the normal app
  // shell cannot create nested navigation chrome around the assistant.
  if (location.pathname === '/meri' || location.pathname.startsWith('/meri/')) {
    return (
      <div className="capiro-vnext-root" data-web-surface="vnext" data-vnext-module="meri">
        <CapiroToastProvider>
          <VNextMeriWorkspace />
        </CapiroToastProvider>
      </div>
    );
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
