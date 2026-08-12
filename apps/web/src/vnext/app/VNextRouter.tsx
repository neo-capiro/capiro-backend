import { lazy, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { DashboardVNext } from '../pages/dashboard/DashboardVNext.js';

const VNextClientCrmRoute = lazy(async () => ({
  default: (await import('../pages/client-crm/VNextClientCrmRoute.js')).VNextClientCrmRoute,
}));

/**
 * Presentation-only interception for os.capiro.ai. Authentication, billing and
 * the canonical application route tree remain owned by App.tsx; vNext swaps a
 * page only where an approved Figma implementation exists.
 *
 * Dashboard + Portfolio (client CRM + Portfolio index). Strategies, LegiWatch
 * and the Directory splits were intercepted here previously — see git history
 * on this file if reviving any of them. Their own page components
 * (VNextStrategiesRoutes, VNextLegiWatchPage, CongressionalStaffVNext,
 * directory-routes.ts) are untouched and still build; a parallel effort is
 * developing Strategies against them independently of this router.
 *
 * Screens that have an approved vNext presentation are substituted at their
 * existing URL — the route itself is still the canonical one, so deep links,
 * back/forward and refresh behave identically. Everything else falls through
 * to the canonical page via Outlet, exactly like every route that has never
 * had a vNext presentation (e.g. Program Elements) already does.
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

  return <Outlet />;
}
