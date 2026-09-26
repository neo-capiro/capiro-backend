import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RESEARCH_PORTFOLIOS_ROOT } from './research-portfolios-routes.js';
import './research-portfolios.css';

const ResearchPortfolioListPage = lazy(async () => ({ default: (await import('./ResearchPortfolioListPage.js')).ResearchPortfolioListPage }));
const ResearchPortfolioDetailPage = lazy(async () => ({ default: (await import('./ResearchPortfolioDetailPage.js')).ResearchPortfolioDetailPage }));

function Loading() {
  return (
    <div className="research-portfolios-vnext" aria-busy="true" style={{ padding: 24 }}>
      <p>Loading research portfolios…</p>
    </div>
  );
}

/**
 * Phase 0‑4 — Research Portfolios module router.
 *
 * Two exact routes:
 *   /research-portfolios                     list page
 *   /research-portfolios/:id                 detail page (UUID)
 *
 * Any other path under /research-portfolios redirects to the list.
 */
export function VNextResearchPortfolioRoutes() {
  return (
    <Routes>
      <Route
        path={RESEARCH_PORTFOLIOS_ROOT}
        element={
          <Suspense fallback={<Loading />}>
            <ResearchPortfolioListPage />
          </Suspense>
        }
      />
      <Route
        path={`${RESEARCH_PORTFOLIOS_ROOT}/:id`}
        element={
          <Suspense fallback={<Loading />}>
            <ResearchPortfolioDetailPage />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to={RESEARCH_PORTFOLIOS_ROOT} replace />} />
    </Routes>
  );
}

export { isVNextResearchPortfolioPath } from './research-portfolios-routes.js';
