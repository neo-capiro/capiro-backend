import { lazy, Suspense } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  DIRECTORY_LEGACY_ROUTE,
  DIRECTORY_ROUTES,
  resolveLegacyDirectoryTarget,
} from './directory-routes.js';

const CongressionalStaffVNext = lazy(async () => ({
  default: (await import('./CongressionalStaffVNext.js')).CongressionalStaffVNext,
}));

const DowVNext = lazy(async () => ({
  default: (await import('./DowVNext.js')).DowVNext,
}));

const StateLegislatorsVNext = lazy(async () => ({
  default: (await import('./StateLegislatorsVNext.js')).StateLegislatorsVNext,
}));

const CommitteeStaffVNext = lazy(async () => ({
  default: (await import('./CommitteeStaffVNext.js')).CommitteeStaffVNext,
}));

function RouteLoading() {
  return <div className="capiro-vnext-route-loading">Loading…</div>;
}

/**
 * Directory vNext module router (DIRECTORY-HANDOFF §6).
 *
 * The four list surfaces are peer routes over one canonical directory dataset;
 * `/directory` is the backward-compatible entry point and redirects to
 * Congressional Staff with the query string preserved verbatim. Profile
 * destinations stay on the canonical routes (`/directory/staff/:staffId` is one
 * identity for both staff surfaces), so only the *list* surfaces and the legacy
 * redirect are intercepted here — profile paths fall through to canonical.
 *
 * Committee Staff (`?view=hierarchy|roster`), Department of War and State
 * Legislators land as their own surfaces in later phases; until their vNext
 * bodies exist they render the Congressional shell's peers via canonical fall
 * -through in `VNextRouter` (the route is only claimed once its surface is
 * ready). Congressional Staff is the first surface wired end to end.
 */
export function VNextDirectoryRoutes() {
  const location = useLocation();

  // Legacy entry point: `/directory` → `/directory/congressional-staff`, query
  // preserved so bookmarks and shared searches keep their filters.
  if (location.pathname === DIRECTORY_LEGACY_ROUTE) {
    return <Navigate to={resolveLegacyDirectoryTarget(location.search)} replace />;
  }

  if (location.pathname === DIRECTORY_ROUTES.congressionalStaff) {
    return (
      <Suspense fallback={<RouteLoading />}>
        <CongressionalStaffVNext />
      </Suspense>
    );
  }

  if (location.pathname === DIRECTORY_ROUTES.departmentOfWar) {
    return (
      <Suspense fallback={<RouteLoading />}>
        <DowVNext />
      </Suspense>
    );
  }

  if (location.pathname === DIRECTORY_ROUTES.stateLegislators) {
    return (
      <Suspense fallback={<RouteLoading />}>
        <StateLegislatorsVNext />
      </Suspense>
    );
  }

  if (location.pathname === DIRECTORY_ROUTES.committeeStaff) {
    return (
      <Suspense fallback={<RouteLoading />}>
        <CommitteeStaffVNext />
      </Suspense>
    );
  }

  // Not a vNext-owned directory path yet — caller (VNextRouter) falls through.
  return null;
}

/**
 * Whether vNext claims this directory pathname. `VNextRouter` uses this to
 * decide between rendering the vNext module and falling through to the
 * canonical page. Only the legacy redirect and the surfaces with a native
 * vNext body are claimed; profile routes stay canonical.
 */
export function isVNextDirectoryPath(pathname: string): boolean {
  // Claimed today: the legacy redirect plus all four list surfaces. Profile
  // routes stay canonical throughout.
  return (
    pathname === DIRECTORY_LEGACY_ROUTE ||
    pathname === DIRECTORY_ROUTES.congressionalStaff ||
    pathname === DIRECTORY_ROUTES.departmentOfWar ||
    pathname === DIRECTORY_ROUTES.stateLegislators ||
    pathname === DIRECTORY_ROUTES.committeeStaff
  );
}
