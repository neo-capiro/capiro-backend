import { lazy, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { DashboardVNext } from '../pages/dashboard/DashboardVNext.js';
import { VNextStrategiesRoutes } from '../pages/strategies/VNextStrategiesRoutes.js';
import {
  isVNextDirectoryPath,
  VNextDirectoryRoutes,
} from '../pages/directory/VNextDirectoryRoutes.js';
import {
  isVNextProgramElementsPath,
  VNextProgramElementsRoutes,
} from '../pages/program-elements/VNextProgramElementsRoutes.js';
import {
  isVNextLegiWatchPath,
  VNextLegiWatchRoutes,
} from '../pages/legiwatch/VNextLegiWatchRoutes.js';
import {
  isWorkspaceVNextRoute,
  WorkspaceVNextRoutes,
} from '../pages/workspace/WorkspaceVNextRoutes.js';
import {
  isVNextEngagementPath,
  VNextEngagementRoutes,
} from '../pages/engagement/VNextEngagementRoutes.js';
import {
  isVNextFundingOpportunitiesPath,
  VNextFundingOpportunitiesRoutes,
} from '../pages/funding-opportunities/VNextFundingOpportunitiesRoutes.js';
import { isVNextDistrictNexusPath } from '../pages/district-nexus/district-nexus-route.js';
import {
  isVNextIntelligencePath,
  VNextIntelligenceRoutes,
} from '../pages/intelligence/VNextIntelligenceRoutes.js';
import {
  isVNextBillPath,
  VNextBillRoutes,
} from '../pages/bills/VNextBillRoutes.js';
import { isVNextSettingsPath } from '../pages/settings/settings-route.js';

const VNextClientCrmRoute = lazy(async () => ({
  default: (await import('../pages/client-crm/VNextClientCrmRoute.js')).VNextClientCrmRoute,
}));

// Lazy like Client CRM: the District Nexus page reaches the MapLibre engine,
// which must never be eagerly reachable (bundle-boundaries.test.ts).
const VNextDistrictNexusPage = lazy(async () => ({
  default: (await import('../pages/district-nexus/DistrictNexusPageVNext.js')).DistrictNexusPageVNext,
}));

const DataExplorerVNext = lazy(async () => ({
  default: (await import('../pages/explorer/DataExplorerVNext.js')).DataExplorerVNext,
}));

// Lazy like Explorer: Settings is fourteen sub-pages (incl. recharts on the
// AI-usage panels) behind a rail item — no reason to pay for it on entry.
const VNextSettingsRoutes = lazy(async () => ({
  default: (await import('../pages/settings/VNextSettingsRoutes.js')).VNextSettingsRoutes,
}));

/**
 * Presentation-only interception for os.capiro.ai. Authentication, billing and
 * the canonical application route tree remain owned by App.tsx; vNext swaps a
 * page only where an approved Figma implementation exists.
 *
 * Dashboard (`/`), Portfolio (client CRM + Portfolio index at `/clients`),
 * Strategies (`/strategies/*`), and Directory (`/directory` +
 * `/directory/congressional-staff`) have native vNext presentations and are
 * substituted here. The Strategies module is a complete native rebuild (no old
 * pages/strategy/* components) over the same backend endpoints. The Directory
 * module claims the legacy redirect, all four list surfaces, and the five
 * deep-linkable profile routes (see isVNextDirectoryPath /
 * matchDirectoryProfilePath). LegiWatch was intercepted here
 * previously — see git history on this file if reviving it. Everything else
 * falls through to the canonical page via Outlet.
 *
 * Engagement's four destinations (Meetings, Library, Outreach, Reports) all
 * have native vNext bodies (ENGAGEMENT_DESTINATION_READY in
 * engagement-route-state.ts) and are claimed unconditionally, like every
 * other ported module. The per-tenant `features.engagementVNext` dogfood
 * gate that used to sit on top was removed at GA (2026-08-18, owner
 * decision: no legacy UI on os.capiro.ai) — see git history on this file
 * for the canary-era wiring if a tenant-level hold-back is ever needed
 * again.
 *
 * Screens that have an approved vNext presentation are substituted at their
 * existing URL — the route itself is still the canonical one, so deep links,
 * back/forward and refresh behave identically.
 */
export function VNextRouter() {
  const location = useLocation();

  // Portfolio: the client CRM profile at /clients?clientId=<id> and, with no
  // clientId, the Portfolio index (PORTFOLIO-HANDOFF §7.1). vNext owns /clients
  // outright because the canonical page tracks the selected client in local
  // state and never writes clientId to the URL (see VNextClientCrmRoute).
  if (location.pathname === '/clients') {
    return (
      <Suspense fallback={<div className="capiro-vnext-route-loading">Loading…</div>}>
        <VNextClientCrmRoute />
      </Suspense>
    );
  }

  // Dashboard is eager: it is the entry screen, so a lazy chunk would cost a
  // blank frame on the most common navigation in the product.
  if (location.pathname === '/') return <DashboardVNext />;

  // Strategies: native vNext module (library, timeline editor, context, agents).
  if (location.pathname === '/strategies' || location.pathname.startsWith('/strategies/')) {
    return <VNextStrategiesRoutes />;
  }

  // Directory: the legacy `/directory` redirect, the four list surfaces, and
  // the five deep-linkable profile routes (members/staff/committees/
  // state-legislators/districts) — all natively vNext as of Phase 2.
  if (isVNextDirectoryPath(location.pathname)) {
    return <VNextDirectoryRoutes />;
  }

  // Program Elements: the native workspace (Explore · Movement ·
  // Congressional · Actions · Portfolio) plus the native mark-up-monitor and
  // contacts segments (Phase 3, PE-CORE). The five-tab line profile and the
  // non-internal finder/watch fallbacks still lazy-mount canonical pages
  // inside the module router — see VNextProgramElementsRoutes for the sibling
  // swap contract. Only /program-elements/reconciliation falls through.
  if (isVNextProgramElementsPath(location.pathname)) {
    return <VNextProgramElementsRoutes />;
  }

  // LegiWatch: the native vNext module (Hearings · Feed · Bills · Digest ·
  // Analytics) plus the live hearing room route. Tabs stay URL-addressable;
  // removed surfaces (overview, watchlist) redirect to the Hearings landing.
  if (isVNextLegiWatchPath(location.pathname)) {
    return <VNextLegiWatchRoutes />;
  }

  // Workspace: library, creation flow, editor, studio, public share.
  // The public /share/:token route is intercepted here too — it renders a
  // shell-free entry. Authenticated workspace routes use the shared vNext
  // shell; the editor's three-pane layout lives inside it.
  if (isWorkspaceVNextRoute(location.pathname)) {
    return <WorkspaceVNextRoutes />;
  }

  // Engagement: all four destinations (Meetings · Library · Outreach ·
  // Reports) — claimed for every tenant since GA on 2026-08-18.
  if (isVNextEngagementPath(location.pathname)) {
    return <VNextEngagementRoutes />;
  }

  // Funding Opportunities: the list (Inbox · Explore · Pipeline) and the
  // deep-linkable detail, both at their canonical URLs. The
  // `funding_opportunities` feature flag stays in-page, exactly as the
  // canonical pages gate it.
  if (isVNextFundingOpportunitiesPath(location.pathname)) {
    return <VNextFundingOpportunitiesRoutes />;
  }

  // District Nexus: the firm-wide district map at /intelligence/district-nexus.
  // The `district_nexus_v2` flag-off state is rendered IN-PAGE (fail-closed
  // guide), matching canonical — so the claim itself is unconditional.
  if (isVNextDistrictNexusPath(location.pathname)) {
    return (
      <Suspense fallback={<div className="capiro-vnext-route-loading">Loading…</div>}>
        <VNextDistrictNexusPage />
      </Suspense>
    );
  }

  // Intelligence deep links (Phase 3): Federal Spending, the issue
  // leaderboard, the knowledge graph, the changes inbox, and the
  // Intelligence Center "coming soon" stub — the five routes that used to
  // fall through to canonical antd pages. Hearing rooms, opportunities and
  // District Nexus belong to their own modules above; redirects
  // (/intelligence, /intelligence/hearing-watch, bills/client paths, the
  // catch-all) stay canonical <Navigate>s.
  if (isVNextIntelligencePath(location.pathname)) {
    return <VNextIntelligenceRoutes />;
  }

  // Data Explorer ("Intelligence Center"): the 18-source explorer at
  // /explorer, ?source=/?bill= deep links included. The canonical
  // /intelligence and /intelligence/* redirects resolve here via their
  // existing <Navigate to="/explorer">s in App.tsx — no claim needed there.
  if (location.pathname === '/explorer') {
    return (
      <Suspense fallback={<div className="capiro-vnext-route-loading">Loading…</div>}>
        <DataExplorerVNext />
      </Suspense>
    );
  }

  // Bill 360: the deep-linkable dossier at /bills/:billId (vNext LegiWatch's
  // drawer links into it). The bill_360 fail-closed flag gate lives inside the
  // page, exactly as on canonical.
  if (isVNextBillPath(location.pathname)) {
    return <VNextBillRoutes />;
  }

  // Settings: the whole /settings prefix — layout with role-filtered tabs plus
  // all fourteen sub-pages (personal/contact/memory/team/branding/clients/
  // integrations/billing/customers/ai-usage/intelligence-mappings/skills/
  // policy-packs/tenants). The legacy /admin and /capiro-admin redirects stay
  // canonical <Navigate>s in App.tsx and land here.
  if (isVNextSettingsPath(location.pathname)) {
    return (
      <Suspense fallback={<div className="capiro-vnext-route-loading">Loading…</div>}>
        <VNextSettingsRoutes />
      </Suspense>
    );
  }

  return <Outlet />;
}
