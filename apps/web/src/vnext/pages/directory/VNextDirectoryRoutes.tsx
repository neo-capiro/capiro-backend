import { lazy, Suspense } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  DIRECTORY_LEGACY_ROUTE,
  DIRECTORY_ROUTES,
  matchDirectoryProfilePath,
  resolveLegacyDirectoryTarget,
  type DirectoryProfileMatch,
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

const MemberProfileVNext = lazy(async () => ({
  default: (await import('./MemberProfileVNext.js')).MemberProfileVNext,
}));

const StaffProfileVNext = lazy(async () => ({
  default: (await import('./StaffProfileVNext.js')).StaffProfileVNext,
}));

const CommitteeProfileVNext = lazy(async () => ({
  default: (await import('./CommitteeProfileVNext.js')).CommitteeProfileVNext,
}));

const StateLegislatorProfileVNext = lazy(async () => ({
  default: (await import('./StateLegislatorProfileVNext.js')).StateLegislatorProfileVNext,
}));

const DistrictProfileVNext = lazy(async () => ({
  default: (await import('./DistrictProfileVNext.js')).DistrictProfileVNext,
}));

function RouteLoading() {
  return <div className="capiro-vnext-route-loading">Loading…</div>;
}

/** The five deep-linkable profile destinations, dispatched on parsed params. */
function ProfileRoute({ match }: { match: DirectoryProfileMatch }) {
  switch (match.kind) {
    case 'member':
      return <MemberProfileVNext memberId={match.memberId} />;
    case 'staff':
      return <StaffProfileVNext staffId={match.staffId} />;
    case 'committee':
      return <CommitteeProfileVNext committeeId={match.committeeId} />;
    case 'stateLegislator':
      return <StateLegislatorProfileVNext id={match.id} />;
    case 'district':
      return <DistrictProfileVNext state={match.state} districtNo={match.districtNo} />;
  }
}

/**
 * Directory vNext module router (DIRECTORY-HANDOFF §6).
 *
 * The four list surfaces are peer routes over one canonical directory dataset;
 * `/directory` is the backward-compatible entry point and redirects to
 * Congressional Staff with the query string preserved verbatim.
 *
 * The deep-linkable profile destinations (`/directory/members/:memberId`,
 * `/directory/staff/:staffId`, `/directory/committees/:committeeId`,
 * `/directory/state-legislators/:id`, `/directory/districts/:state/:no`) are
 * claimed here too (Phase 2 old-UI purge) — `/directory/staff/:staffId` stays
 * one identity for both staff surfaces. VNextRouter intercepts above the
 * canonical param `<Route>`s, so params are parsed from the pathname by
 * `matchDirectoryProfilePath` rather than `useParams`.
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

  const profileMatch = matchDirectoryProfilePath(location.pathname);
  if (profileMatch) {
    return (
      <Suspense fallback={<RouteLoading />}>
        <ProfileRoute match={profileMatch} />
      </Suspense>
    );
  }

  // Not a vNext-owned directory path yet — caller (VNextRouter) falls through.
  return null;
}

/**
 * Whether vNext claims this directory pathname. `VNextRouter` uses this to
 * decide between rendering the vNext module and falling through to the
 * canonical page. Claimed: the legacy redirect, all four list surfaces, and
 * the five deep-linkable profile routes (Phase 2 old-UI purge).
 */
export function isVNextDirectoryPath(pathname: string): boolean {
  return (
    pathname === DIRECTORY_LEGACY_ROUTE ||
    pathname === DIRECTORY_ROUTES.congressionalStaff ||
    pathname === DIRECTORY_ROUTES.departmentOfWar ||
    pathname === DIRECTORY_ROUTES.stateLegislators ||
    pathname === DIRECTORY_ROUTES.committeeStaff ||
    matchDirectoryProfilePath(pathname) !== null
  );
}
