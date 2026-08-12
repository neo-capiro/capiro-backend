import { lazy, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { DashboardVNext } from '../pages/dashboard/DashboardVNext.js';
import { VNextStrategiesRoutes } from '../pages/strategies/VNextStrategiesRoutes.js';
import {
  isVNextDirectoryPath,
  VNextDirectoryRoutes,
} from '../pages/directory/VNextDirectoryRoutes.js';
import {
  isVNextProgramElementsPath,
  VNextProgramElementsRoutes,
} from '../pages/program-elements/VNextProgramElementsRoutes.js';

const VNextClientCrmRoute = lazy(async () => ({
  default: (await import('../pages/client-crm/VNextClientCrmRoute.js')).VNextClientCrmRoute,
}));

/**
 * Presentation-only interception for os.capiro.ai. Authentication, billing and
 * the canonical application route tree remain owned by App.tsx; vNext swaps a
 * page only where an approved Figma implementation exists.
 *
 * Dashboard (`/`), Portfolio (client CRM + Portfolio index at `/clients`),
 * Strategies (`/strategies/*`), and Directory (`/directory` +
 * `/directory/congressional-staff`) have native vNext presentations and are
 * substituted here. The Strategies module is a complete native rebuild (no old
 * pages/strategy/* components) over the same backend endpoints. The Directory
 * module claims only the surfaces with a native vNext body (legacy redirect +
 * Congressional Staff in this phase); the remaining list surfaces and all
 * profile routes fall through to canonical. LegiWatch was intercepted here
 * previously — see git history on this file if reviving it. Everything else
 * falls through to the canonical page via Outlet.
 *
 * Screens that have an approved vNext presentation are substituted at their
 * existing URL — the route itself is still the canonical one, so deep links,
 * back/forward and refresh behave identically.
 */
export function VNextRouter() {
  const location = useLocation();

  // Portfolio: the client CRM profile at /clients?clientId=<id> and, with no
  // clientId, the Portfolio index (PORTFOLIO-HANDOFF §7.1). vNext owns /clients
  // outright because the canonical page tracks the selected client in local
  // state and never writes clientId to the URL (see VNextClientCrmRoute).
  if (location.pathname === '/clients') {
    return (
      <Suspense fallback={<div className="capiro-vnext-route-loading">Loading…</div>}>
        <VNextClientCrmRoute />
      </Suspense>
    );
  }

  // Dashboard is eager: it is the entry screen, so a lazy chunk would cost a
  // blank frame on the most common navigation in the product.
  if (location.pathname === '/') return <DashboardVNext />;

  // Strategies: native vNext module (library, timeline editor, context, agents).
  if (location.pathname === '/strategies' || location.pathname.startsWith('/strategies/')) {
    return <VNextStrategiesRoutes />;
  }

  // Directory: the legacy `/directory` redirect plus the surfaces with a native
  // vNext body (Congressional Staff in this phase). All other directory paths —
  // the remaining list surfaces and every profile route — fall through to the
  // canonical page below.
  if (isVNextDirectoryPath(location.pathname)) {
    return <VNextDirectoryRoutes />;
  }

  // Program Elements: the workspace (Explore · Movement · Congressional ·
  // Actions · Portfolio) plus the five-tab line profile. The module reuses the
  // canonical v2 components over the same backend endpoints, re-skinned onto
  // the vNext token layer. Static segments (mark-up-monitor, contacts) fall
  // through to canonical.
  if (isVNextProgramElementsPath(location.pathname)) {
    return <VNextProgramElementsRoutes />;
  }

  return <Outlet />;
}
