import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

/**
 * Funding Opportunities vNext module router.
 *
 * The canonical list and deep-linkable detail routes share one lazy page module.
 * Keeping that module lazy preserves the existing chunk boundary while allowing
 * either route to resolve independently.
 *
 * The `funding_opportunities` feature flag remains an in-page, fail-closed
 * decision so direct links resolve to the named not-enabled state.
 */
const FundingOpportunitiesPage = lazy(async () => ({
  default: (await import('./FundingOpportunitiesPage.js')).FundingOpportunitiesPage,
}));

function Loading() {
  return (
    <div className="fo-v2-loading" aria-busy="true">
      Loading Opportunities…
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
            <FundingOpportunitiesPage />
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
    pathname === '/intelligence/opportunities' ||
    pathname.startsWith('/intelligence/opportunities/')
  );
}
