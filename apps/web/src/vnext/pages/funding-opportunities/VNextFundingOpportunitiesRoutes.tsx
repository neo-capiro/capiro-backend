import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { FovSkeletonRows } from './fov-ui.js';
import './funding-opportunities-vnext.css';

/**
 * Funding Opportunities vNext — module router (Phase 2 old-UI purge).
 *
 * Claims the two canonical FO routes at their existing URLs:
 *
 *   /intelligence/opportunities                          — list (Inbox/Explore)
 *   /intelligence/opportunities/:source/:sourceRecordId  — deep-linkable detail
 *
 * Both pages stay lazy for the same chunk-splitting reason App.tsx gives: the
 * list and the detail are reached independently (a detail link pasted into a
 * ticket does not go via the inbox), and this is a large surface nothing else
 * needs.
 *
 * The `funding_opportunities` feature flag stays IN-PAGE (canonical
 * precedent): the route registers unconditionally so a deep link resolves, and
 * the page renders the named not-enabled state itself. Fail-closed semantics
 * are identical to canonical.
 *
 * Any other `/intelligence/opportunities/...` shape (e.g. a single trailing
 * segment) is claimed too and canonicalises exactly the way the legacy route
 * table would resolve it: App.tsx's `/intelligence/*` catch-all redirects to
 * /explorer.
 */
const FundingOpportunitiesPage = lazy(async () => ({
  default: (await import('./FundingOpportunitiesPage.js')).FundingOpportunitiesPage,
}));
const FundingOpportunityDetailPage = lazy(async () => ({
  default: (await import('./FundingOpportunityDetail.js')).FundingOpportunityDetailPage,
}));

function Loading() {
  return (
    <div className="fov" aria-busy="true">
      <FovSkeletonRows rows={6} />
    </div>
  );
}

export function VNextFundingOpportunitiesRoutes() {
  return (
    <Routes>
      <Route
        path="/intelligence/opportunities"
        element={
          <Suspense fallback={<Loading />}>
            <FundingOpportunitiesPage />
          </Suspense>
        }
      />
      <Route
        path="/intelligence/opportunities/:source/:sourceRecordId"
        element={
          <Suspense fallback={<Loading />}>
            <FundingOpportunityDetailPage />
          </Suspense>
        }
      />
      {/* A malformed depth (one segment, or three-plus) matches neither route
          above. Canonical resolution for those shapes is App.tsx's
          `/intelligence/*` catch-all — reproduce it, do not invent a page. */}
      <Route path="*" element={<Navigate to="/explorer" replace />} />
    </Routes>
  );
}

/**
 * Path predicate for VNextRouter: the module owns the FO list route and
 * everything under it. Everything else falls through to canonical.
 */
export function isVNextFundingOpportunitiesPath(pathname: string): boolean {
  return (
    pathname === '/intelligence/opportunities' || pathname.startsWith('/intelligence/opportunities/')
  );
}
