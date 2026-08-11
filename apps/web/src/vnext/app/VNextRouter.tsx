import { lazy, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

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
 */
export function VNextRouter() {
  const location = useLocation();
  const fallback = <div className="capiro-vnext-route-loading">Loading…</div>;

  if (location.pathname === '/strategies' || location.pathname.startsWith('/strategies/')) {
    return <Suspense fallback={fallback}><VNextStrategiesRoutes /></Suspense>;
  }
  if (location.pathname === '/legiwatch' || location.pathname.startsWith('/legiwatch/')) {
    return <Suspense fallback={fallback}><VNextLegiWatchPage /></Suspense>;
  }
  return <Outlet />;
}
