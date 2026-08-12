import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';
import { matchPeProfilePath } from './pe-routes.js';
import './pe-vnext.css';

/**
 * Program Elements vNext module router (PROGRAM-ELEMENTS-HANDOFF §8).
 *
 * The workspace shell (Explore · Movement · Congressional · Actions ·
 * Portfolio) and the five-tab line profile reuse the canonical v2 components —
 * they are already wired to the existing backend endpoints (no new backend per
 * the handoff) and already implement the stage-ladder / missing-≠-zero
 * invariants in `pe-v2-model.ts`. The vNext module re-skins them onto the
 * canonical vNext token layer (`pe-vnext.css`) and mounts them under the vNext
 * shell.
 *
 * The v2 pages are gated to the `capiro-internal` tenant at their own route
 * boundary (the same gate the canonical app uses), so on the vNext surface the
 * module renders for that tenant and falls back to the canonical read surface
 * otherwise — matching the legacy behaviour exactly.
 */
const ProgramElementsV2Page = lazy(async () => ({
  default: (await import('../../../pages/program-element/ProgramElementsV2Page.js'))
    .ProgramElementsV2Page,
}));

const ProgramElementV2ProfilePage = lazy(async () => ({
  default: (await import('../../../pages/program-element/ProgramElementV2ProfilePage.js'))
    .ProgramElementV2ProfilePage,
}));

function RouteLoading() {
  return <div className="capiro-vnext-route-loading">Loading…</div>;
}

export function VNextProgramElementsRoutes() {
  const location = useLocation();
  const peCode = matchPeProfilePath(location.pathname);

  return (
    <div className="pe-vnext-root">
      {peCode ? (
        <Suspense fallback={<RouteLoading />}>
          <ProgramElementV2ProfilePage />
        </Suspense>
      ) : (
        <Suspense fallback={<RouteLoading />}>
          <ProgramElementsV2Page />
        </Suspense>
      )}
    </div>
  );
}

export { isVNextProgramElementsPath } from './pe-routes.js';
