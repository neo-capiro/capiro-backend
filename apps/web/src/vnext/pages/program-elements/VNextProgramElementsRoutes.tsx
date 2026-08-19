import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';
import { useMe } from '../../../lib/me.js';
import { matchPeProfilePath, matchPeStaticPath } from './pe-routes.js';
import './pe-vnext.css';

/**
 * Program Elements vNext module router (Phase 3 native rebuild).
 *
 * The WORKSPACE (Explore · Movement · Congressional · Actions · Portfolio) and
 * the two static segments (mark-up monitor, contact review queue) are NATIVE
 * vNext pages — no antd anywhere on those branches. They talk to the same
 * backend endpoints with the same query keys as the canonical pages and keep
 * the stage-ladder / missing-≠-zero invariants in `pe-v2-model.ts`.
 *
 * Tenant gate: the canonical app gates the v2 workspace/profile to the
 * `capiro-internal` tenant at the route boundary (App.tsx
 * ProgramElementFinderGate / ProgramElementWatchGate). That gate is reproduced
 * here byte-for-byte — including the no-loading-branch semantics: while /me is
 * in flight the non-internal read surface renders, exactly as canonical.
 *
 * INTEGRATION CONTRACT (Phase 3 siblings):
 *  - The capiro-internal PROFILE branch still lazy-mounts the canonical
 *    ProgramElementV2ProfilePage (allowlisted in
 *    no-legacy-ui.contract.test.ts). The PE-PROFILE agent swaps it for the
 *    native profile and deletes that allowlist edge.
 *  - The non-internal fallback branches still lazy-mount the canonical
 *    ProgramElementFinderPage / ProgramElementWatchPage (TEMP allowlist
 *    edges). The PE-FALLBACK agent swaps them and deletes those edges.
 *  - Fallback branches render WITHOUT the `.pe-vnext-root` wrapper on purpose:
 *    before Phase 3 they reached these exact canonical pages via the
 *    VNextRouter `<Outlet/>` fallthrough, i.e. with no PE module chrome — the
 *    wrapper's `.uui-content` width escape must not change their layout.
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

const ProgramElementV2ProfilePage = lazy(async () => ({
  default: (await import('../../../pages/program-element/ProgramElementV2ProfilePage.js'))
    .ProgramElementV2ProfilePage,
}));

const ProgramElementFinderPage = lazy(async () => ({
  default: (await import('../../../pages/program-element/ProgramElementFinderPage.js'))
    .ProgramElementFinderPage,
}));

const ProgramElementWatchPage = lazy(async () => ({
  default: (await import('../../../pages/program-element/ProgramElementWatchPage.js'))
    .ProgramElementWatchPage,
}));

function RouteLoading() {
  return <div className="capiro-vnext-route-loading">Loading…</div>;
}

export function VNextProgramElementsRoutes() {
  const location = useLocation();
  const me = useMe();
  // Same predicate as App.tsx's ProgramElementFinderGate/ProgramElementWatchGate.
  const isInternal = me.data?.tenant.slug === 'capiro-internal';
  const staticSegment = matchPeStaticPath(location.pathname);
  const peCode = matchPeProfilePath(location.pathname);

  // Native static segments — not tenant-gated, matching canonical App.tsx.
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

  if (peCode) {
    // Line profile: canonical v2 profile for capiro-internal (PE-PROFILE agent
    // swaps this), canonical watch page for everyone else (PE-FALLBACK agent
    // swaps that).
    return isInternal ? (
      <div className="pe-vnext-root">
        <Suspense fallback={<RouteLoading />}>
          <ProgramElementV2ProfilePage />
        </Suspense>
      </div>
    ) : (
      <Suspense fallback={<RouteLoading />}>
        <ProgramElementWatchPage />
      </Suspense>
    );
  }

  // Workspace root: native workspace for capiro-internal, canonical finder for
  // everyone else (PE-FALLBACK agent swaps that).
  return isInternal ? (
    <div className="pe-vnext-root">
      <Suspense fallback={<RouteLoading />}>
        <PeWorkspacePage />
      </Suspense>
    </div>
  ) : (
    <Suspense fallback={<RouteLoading />}>
      <ProgramElementFinderPage />
    </Suspense>
  );
}

export { isVNextProgramElementsPath } from './pe-routes.js';
