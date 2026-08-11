import { lazy, Suspense } from 'react';
import { Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { DashboardVNext } from '../pages/dashboard/DashboardVNext.js';

const VNextStrategiesRoutes = lazy(async () => ({
  default: (await import('../pages/strategies/VNextStrategiesRoutes.js')).VNextStrategiesRoutes,
}));
const VNextLegiWatchPage = lazy(async () => ({
  default: (await import('../pages/legiwatch/VNextLegiWatchPage.js')).VNextLegiWatchPage,
}));

/**
 * Presentation-only interception for os.capiro.ai. Authentication, billing and
 * the canonical application route tree remain owned by App.tsx; vNext swaps a
 * page only where an approved Figma implementation exists.
 *
 * Screens that have an approved vNext presentation are substituted at their
 * existing URL — the route itself is still the canonical one, so deep links,
 * back/forward and refresh behave identically. Everything else falls through
 * to the canonical page via Outlet.
 */
export function VNextRouter() {
  const location = useLocation();
  const fallback = <div className="capiro-vnext-route-loading">Loading…</div>;

  // Dashboard is eager: it is the entry screen, so a lazy chunk would cost a
  // blank frame on the most common navigation in the product.
  if (location.pathname === '/') return <DashboardVNext />;

  // VNextApp renders outside the canonical route tree, so a descendant <Routes>
  // resolves against "/" — at /strategies that left "strategies" as the
  // remaining segment, which the family's `:id` route swallowed and tried to
  // open as a strategy ("This strategy could not be loaded"). Mounting the
  // family under its own route re-bases the nested Routes so `index` matches.
  if (location.pathname === '/strategies' || location.pathname.startsWith('/strategies/')) {
    return (
      <Suspense fallback={fallback}>
        <Routes>
          <Route path="strategies/*" element={<VNextStrategiesRoutes />} />
        </Routes>
      </Suspense>
    );
  }
  if (location.pathname === '/legiwatch' || location.pathname.startsWith('/legiwatch/')) {
    return <Suspense fallback={fallback}><VNextLegiWatchPage /></Suspense>;
  }

  return <Outlet />;
}
