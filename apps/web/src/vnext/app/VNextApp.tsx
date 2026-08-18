import { Navigate, useLocation } from 'react-router-dom';
import { CapiroToastProvider } from '../components/feedback/toast.js';
import { VNextOnboardingGates } from './onboarding/VNextOnboardingGates.js';
import { VNextTrialBanner } from './onboarding/VNextTrialBanner.js';
import { VNextMeriWorkspace } from '../meri/VNextMeriWorkspace.js';
import { legacyMeriWindowRedirect } from '../meri/meri-route-state.js';
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
 * so /meri* bypasses AppShellUui.
 */
export function VNextApp() {
  const location = useLocation();

  // Compatibility only. Older vNext callers (and stale tabs/bookmarks) may still
  // open `/?meriWindow=1`. Never render the legacy overlay on the vNext surface:
  // canonicalize immediately onto the addressable Meri route while preserving
  // only the documented one-time prompt/client context.
  const legacyMeriTarget = legacyMeriWindowRedirect(location.search);
  if (legacyMeriTarget) {
    return <Navigate to={legacyMeriTarget} replace />;
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
          {/* vNext-native onboarding chrome — the legacy OnboardingGates/
              TrialBanner (ob-overlay.css) stay on the canonical AppShell only.
              Same gating logic, endpoints and copy; vNext tokens. */}
          <VNextTrialBanner />
          <VNextOnboardingGates>
            <VNextRouter />
          </VNextOnboardingGates>
        </AppShellUui>
      </CapiroToastProvider>
    </div>
  );
}
