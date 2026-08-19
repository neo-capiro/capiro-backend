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
 * Phase 3 branches (all NATIVE now — no antd anywhere in this module):
 *  - The capiro-internal PROFILE branch mounts PeProfileVNext
 *    (vnext/pages/program-elements/profile).
 *  - The non-internal fallback branches mount the native PE-FALLBACK module
 *    (vnext/pages/program-elements/fallback): PeFinderFallbackVNext /
 *    PeWatchFallbackVNext — same endpoints, query keys, copy and states as the
 *    canonical finder/watch pages they replaced. Now that they are native
 *    vNext pages they render INSIDE the `.pe-vnext-root` wrapper like every
 *    other branch (the pre-swap canonical mounts deliberately rendered without
 *    it, preserving the old Outlet-fallthrough layout).
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

const PeProfileVNext = lazy(async () => ({
  default: (await import('./profile/index.js')).PeProfileVNext,
}));

const PeFinderFallbackVNext = lazy(async () => ({
  default: (await import('./fallback/PeFinderFallbackVNext.js')).PeFinderFallbackVNext,
}));

const PeWatchFallbackVNext = lazy(async () => ({
  default: (await import('./fallback/PeWatchFallbackVNext.js')).PeWatchFallbackVNext,
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
    // Line profile: native vNext profile for capiro-internal, native fallback
    // watch (PE-FALLBACK) for everyone else.
    return isInternal ? (
      <div className="pe-vnext-root">
        <Suspense fallback={<RouteLoading />}>
          <PeProfileVNext />
        </Suspense>
      </div>
    ) : (
      <div className="pe-vnext-root">
        <Suspense fallback={<RouteLoading />}>
          <PeWatchFallbackVNext />
        </Suspense>
      </div>
    );
  }

  // Workspace root: native workspace for capiro-internal, native fallback
  // finder (PE-FALLBACK) for everyone else.
  return isInternal ? (
    <div className="pe-vnext-root">
      <Suspense fallback={<RouteLoading />}>
        <PeWorkspacePage />
      </Suspense>
    </div>
  ) : (
    <div className="pe-vnext-root">
      <Suspense fallback={<RouteLoading />}>
        <PeFinderFallbackVNext />
      </Suspense>
    </div>
  );
}

export { isVNextProgramElementsPath } from './pe-routes.js';
