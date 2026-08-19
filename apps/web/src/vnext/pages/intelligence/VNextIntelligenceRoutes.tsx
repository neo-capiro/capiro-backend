import { Suspense, lazy } from 'react';
import { useLocation } from 'react-router-dom';
import { IntelSkeletonRows } from './intel-ui.js';
import './intelligence-vnext.css';

/**
 * Intelligence deep-link module — module router (Phase 3 old-UI purge).
 *
 * Claims the deep-link-only intelligence routes that used to fall through to
 * canonical antd pages, at their existing URLs:
 *
 *   /intelligence/federal-spending — Federal Spending & Market Intelligence
 *   /intelligence/issues/:code     — LDA issue leaderboard
 *   /intelligence/graph            — institutional-memory knowledge graph
 *   /intelligence/changes          — changes inbox (bell "View all" target)
 *   /intelligence-center           — "Coming Soon" preview stub
 *
 * Deliberately NOT claimed (canonical resolution is correct for all of them):
 *   /intelligence                    — canonical <Navigate> to /explorer
 *   /intelligence/hearing-watch      — canonical <Navigate> to /legiwatch
 *   /intelligence/hearing-watch/:id  — vNext LegiWatch module (Phase 2)
 *   /intelligence/opportunities*     — vNext Funding Opportunities (Phase 2)
 *   /intelligence/district-nexus     — vNext District Nexus (Phase 2)
 *   /intelligence/bills/:bill        — canonical redirect (useBillTarget)
 *   /intelligence/client/*           — canonical <Navigate>s to /clients
 *   /intelligence/* (anything else)  — canonical catch-all to /explorer
 *
 * Every page stays lazy: these are deep-link destinations (nothing in the
 * vNext rail points at them), and the knowledge graph carries cytoscape —
 * no reason to pay for any of it on entry.
 *
 * Params come from location.pathname, not useParams — VNextRouter mounts
 * above the canonical param <Route>s (Phase 3 briefing lesson 2;
 * matchDirectoryProfilePath precedent).
 */

const FederalSpendingPageVNext = lazy(async () => ({
  default: (await import('./FederalSpendingPageVNext.js')).FederalSpendingPageVNext,
}));
const IssueLeaderboardPageVNext = lazy(async () => ({
  default: (await import('./IssueLeaderboardPageVNext.js')).IssueLeaderboardPageVNext,
}));
const KnowledgeGraphPageVNext = lazy(async () => ({
  default: (await import('./KnowledgeGraphPageVNext.js')).KnowledgeGraphPageVNext,
}));
const ChangesInboxPageVNext = lazy(async () => ({
  default: (await import('./ChangesInboxPageVNext.js')).ChangesInboxPageVNext,
}));
const IntelligenceCenterVNext = lazy(async () => ({
  default: (await import('./IntelligenceCenterVNext.js')).IntelligenceCenterVNext,
}));

/**
 * Parse `/intelligence/issues/:code` from a pathname. The canonical route's
 * `:code` is a single segment (an LDA issue code like `DEF` or `tax-policy`);
 * it is URL-decoded on the way out, exactly as react-router would have
 * decoded the param. Trailing slashes are tolerated the way the canonical
 * router tolerates them (`/intelligence/issues/DEF/` still resolves).
 */
export function matchIssueLeaderboardPath(pathname: string): string | null {
  const match = /^\/intelligence\/issues\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    // A malformed escape sequence cannot match a real issue code; fall through
    // to canonical, whose router rejects it the same way.
    return null;
  }
}

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function Loading() {
  return (
    <div className="intel" aria-busy="true">
      <IntelSkeletonRows rows={6} />
    </div>
  );
}

export function VNextIntelligenceRoutes() {
  const location = useLocation();
  const pathname = stripTrailingSlash(location.pathname);
  const issueCode = matchIssueLeaderboardPath(pathname);

  let page: React.ReactNode = null;
  if (pathname === '/intelligence/federal-spending') {
    page = <FederalSpendingPageVNext />;
  } else if (issueCode != null) {
    page = <IssueLeaderboardPageVNext code={issueCode} />;
  } else if (pathname === '/intelligence/graph') {
    page = <KnowledgeGraphPageVNext />;
  } else if (pathname === '/intelligence/changes') {
    page = <ChangesInboxPageVNext />;
  } else if (pathname === '/intelligence-center') {
    page = <IntelligenceCenterVNext />;
  }

  return <Suspense fallback={<Loading />}>{page}</Suspense>;
}

/**
 * Path predicate for VNextRouter: exactly the five deep-link routes above.
 * Everything else under /intelligence falls through to canonical (or is
 * claimed by the LegiWatch / Funding Opportunities / District Nexus modules,
 * whose predicates VNextRouter consults independently).
 */
export function isVNextIntelligencePath(pathname: string): boolean {
  const clean = stripTrailingSlash(pathname);
  return (
    clean === '/intelligence/federal-spending' ||
    clean === '/intelligence/graph' ||
    clean === '/intelligence/changes' ||
    clean === '/intelligence-center' ||
    matchIssueLeaderboardPath(clean) != null
  );
}
