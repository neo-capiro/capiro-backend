import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';
import { matchPeProfilePath, matchPeStaticPath } from './pe-routes.js';
import './pe-vnext.css';

/**
 * Defense Budget / Program Elements vNext module router.
 *
 * Every tenant receives the same native workspace and line profile. The
 * underlying endpoints remain tenant-scoped and preserve the stage-ladder and
 * missing-is-not-zero invariants in `pe-v2-model.ts`.
 */
const PeWorkspacePage = lazy(async () => ({
  default: (await import('./PeWorkspacePage.js')).PeWorkspacePage,
}));

const PeMarkupMonitorPage = lazy(async () => ({
  default: (await import('./PeMarkupMonitorPage.js')).PeMarkupMonitorPage,
}));

const PePersonCandidatesPage = lazy(async () => ({
  default: (await import('./PePersonCandidatesPage.js')).PePersonCandidatesPage,
}));

const PeResearchView = lazy(async () => ({
  default: (await import('./PeResearchView.js')).PeResearchView,
}));

const PeProfileVNext = lazy(async () => ({
  default: (await import('./profile/index.js')).PeProfileVNext,
}));

function RouteLoading() {
  return <div className="capiro-vnext-route-loading">Loading…</div>;
}

export function VNextProgramElementsRoutes() {
  const location = useLocation();
  const staticSegment = matchPeStaticPath(location.pathname);
  const peCode = matchPeProfilePath(location.pathname);

  if (staticSegment === 'mark-up-monitor') {
    return (
      <div className="pe-vnext-root">
        <Suspense fallback={<RouteLoading />}>
          <PeMarkupMonitorPage />
        </Suspense>
      </div>
    );
  }
  if (staticSegment === 'contacts') {
    return (
      <div className="pe-vnext-root">
        <Suspense fallback={<RouteLoading />}>
          <PePersonCandidatesPage />
        </Suspense>
      </div>
    );
  }
  if (staticSegment === 'research') {
    return (
      <div className="pe-vnext-root">
        <Suspense fallback={<RouteLoading />}>
          <PeResearchView />
        </Suspense>
      </div>
    );
  }

  if (peCode) {
    return (
      <div className="pe-vnext-root">
        <Suspense fallback={<RouteLoading />}>
          <PeProfileVNext />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="pe-vnext-root">
      <Suspense fallback={<RouteLoading />}>
        <PeWorkspacePage />
      </Suspense>
    </div>
  );
}

export { isVNextProgramElementsPath } from './pe-routes.js';
