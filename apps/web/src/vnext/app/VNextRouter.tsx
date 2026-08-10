import { Outlet, useLocation } from 'react-router-dom';
import { DashboardVNext } from '../pages/dashboard/DashboardVNext.js';

/**
 * The canonical App.tsx route tree remains authoritative. vNext owns only the
 * presentation boundary, so route registration, deep links, feature gates and
 * page business logic are not duplicated here.
 *
 * Screens that have an approved vNext presentation are substituted at their
 * existing URL — the route itself is still the canonical one, so deep links,
 * back/forward and refresh behave identically. Everything else falls through
 * to the canonical page via Outlet.
 */
export function VNextRouter() {
  const location = useLocation();

  if (location.pathname === '/') return <DashboardVNext />;

  return <Outlet />;
}
