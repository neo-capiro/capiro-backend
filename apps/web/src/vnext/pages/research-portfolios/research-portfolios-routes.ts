/**
 * Phase 0‑4 — Research Portfolios vNext route contract.
 *
 * Exact match only:
 *   /research-portfolios                     list view
 *   /research-portfolios/:id                 detail view (UUID)
 *
 * Rejects malformed, encoded slash, trailing/deeper paths, and any extra segments.
 */
export const RESEARCH_PORTFOLIOS_ROOT = '/research-portfolios';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ResearchPortfolioRoute =
  | { kind: 'list' }
  | { kind: 'detail'; portfolioId: string };

export function matchResearchPortfolioPath(pathname: string): ResearchPortfolioRoute | null {
  if (pathname === RESEARCH_PORTFOLIOS_ROOT) return { kind: 'list' };
  if (!pathname.startsWith(`${RESEARCH_PORTFOLIOS_ROOT}/`)) return null;
  const candidate = pathname.slice(RESEARCH_PORTFOLIOS_ROOT.length + 1);
  if (!UUID.test(candidate)) return null;
  return { kind: 'detail', portfolioId: candidate };
}

export function isVNextResearchPortfolioPath(pathname: string): boolean {
  return matchResearchPortfolioPath(pathname) !== null;
}
