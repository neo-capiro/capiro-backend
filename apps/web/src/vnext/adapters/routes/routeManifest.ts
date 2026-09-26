import { DIRECTORY_ROUTES } from '../../pages/directory/directory-routes.js';

export type VNextRouteAvailability = 'existing' | 'gap';

export interface VNextRouteDefinition {
  id: string;
  label: string;
  path: string | null;
  availability: VNextRouteAvailability;
  featureFlag?: string;
  meFeature?: string;
  /**
   * Per-tenant-slug label override. Presentation only — the route id and
   * path never change, so this never invents a new URL or a feature gate.
   */
  tenantLabels?: Readonly<Record<string, string>>;
  children?: VNextRouteDefinition[];
  note?: string;
}

export interface VNextRouteVisibilityContext {
  featureFlags?: Readonly<Record<string, boolean | undefined>>;
  meFeatures?: Readonly<Record<string, boolean | undefined>>;
  tenantSlug?: string;
}

/**
 * vNext navigation contract mapped to routes that already exist in App.tsx.
 * Gaps stay explicit; this file never invents replacement URLs or redirects.
 */
export const VNEXT_ROUTE_MANIFEST: VNextRouteDefinition[] = [
  { id: 'dashboard', label: 'Dashboard', path: '/', availability: 'existing' },
  {
    id: 'portfolio',
    label: 'Portfolio',
    path: '/clients',
    availability: 'existing',
    children: [
      { id: 'portfolio-clients', label: 'Clients', path: '/clients', availability: 'existing' },
      {
        id: 'portfolio-business-development',
        label: 'Business Development',
        path: '/clients?view=business-development',
        availability: 'existing',
        // Navigation visibility only; the page and API independently fail closed.
        meFeature: 'businessDevelopment',
      },
      {
        id: 'portfolio-research-portfolios',
        label: 'Research Portfolios',
        path: '/research-portfolios',
        availability: 'existing',
        // Navigation-only rollout switch. Saved records and authorized direct
        // reads remain compatible when the entry is hidden.
        featureFlag: 'research_portfolios',
      },
      {
        id: 'portfolio-coalitions',
        label: 'Coalitions',
        path: null,
        availability: 'gap',
        note: 'Shown to preserve the approved Portfolio information architecture; no route exists yet.',
      },
    ],
  },
  {
    id: 'engagement-manager',
    label: 'Engagement',
    path: '/engagement',
    availability: 'existing',
    children: [
      {
        id: 'engagement-meetings',
        label: 'Meetings',
        path: '/engagement/meetings',
        availability: 'existing',
      },
      {
        id: 'engagement-library',
        label: 'Meeting Library',
        path: '/engagement/meeting-library',
        availability: 'existing',
      },
      {
        id: 'engagement-outreach',
        label: 'Outreach',
        path: '/engagement/outreach',
        availability: 'existing',
      },
      {
        id: 'engagement-reports',
        label: 'Reports',
        path: '/engagement/reports',
        availability: 'existing',
      },
    ],
  },
  { id: 'workspace', label: 'Workspace', path: '/workspace', availability: 'existing' },
  {
    id: 'strategies',
    label: 'Strategies',
    path: '/strategies',
    availability: 'existing',
    meFeature: 'strategyPlanner',
    // Rail sub-navigation (design handoff 2026-08-16): Strategy library ·
    // Context library · Agent review · Execution runs. Same NavFlyout
    // mechanism as Directory/Intelligence above — nothing new to build.
    // The handoff also specs a badge count on each of the last three; that
    // needs a live-data source polled from the rail regardless of which page
    // is open, which no route in this manifest has today (it is deliberately
    // static, data-layer-free — see the file's own header comment). Left out
    // rather than half-built; counts already surface inside each screen.
    children: [
      { id: 'strategies-library', label: 'Strategy library', path: '/strategies', availability: 'existing' },
      { id: 'strategies-context', label: 'Context library', path: '/strategies/context', availability: 'existing' },
      { id: 'strategies-agent-review', label: 'Agent review', path: '/strategies/agents/proposals', availability: 'existing' },
      { id: 'strategies-execution-runs', label: 'Execution runs', path: '/strategies/agents/runs', availability: 'existing' },
    ],
  },
  {
    id: 'directory',
    label: 'Directory',
    path: '/directory',
    availability: 'existing',
    // Closed by the Directory vNext split (Figma 941:2860): all four list
    // surfaces are now first-class registered routes over the same canonical
    // records. `/directory` remains the backward-compatible entry point.
    children: [
      {
        id: 'congressional-staff',
        label: 'Congressional Staff',
        path: DIRECTORY_ROUTES.congressionalStaff,
        availability: 'existing',
      },
      {
        id: 'committee-staff',
        label: 'Committee Staff',
        path: DIRECTORY_ROUTES.committeeStaff,
        availability: 'existing',
      },
      {
        id: 'department-of-war',
        label: 'Department of War',
        path: DIRECTORY_ROUTES.departmentOfWar,
        availability: 'existing',
      },
      {
        id: 'state-legislators',
        label: 'State Legislators',
        path: DIRECTORY_ROUTES.stateLegislators,
        availability: 'existing',
      },
      {
        id: 'state-committees',
        label: 'State Committees',
        path: DIRECTORY_ROUTES.stateCommittees,
        availability: 'existing',
      },
    ],
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    path: null,
    availability: 'existing',
    note: 'The legacy /intelligence route redirects to Data Explorer; vNext uses the existing child routes directly.',
    children: [
      { id: 'data-explorer', label: 'Data Explorer', path: '/explorer', availability: 'existing' },
      { id: 'legiwatch', label: 'LegiWatch', path: '/legiwatch', availability: 'existing' },
      {
        id: 'program-elements',
        label: 'Defense Budget',
        path: '/program-elements',
        availability: 'existing',
      },
      {
        id: 'funding-opportunities',
        label: 'Funding Opportunities',
        path: '/intelligence/opportunities',
        availability: 'existing',
        featureFlag: 'funding_opportunities',
      },
      {
        id: 'district-nexus',
        label: 'District Nexus',
        path: '/intelligence/district-nexus',
        availability: 'existing',
        featureFlag: 'district_nexus_v2',
      },
    ],
  },
  { id: 'settings', label: 'Settings', path: '/settings', availability: 'existing' },
];

export const VNEXT_ROUTE_GAPS = VNEXT_ROUTE_MANIFEST.flatMap(
  (route) => route.children ?? [],
).filter((route) => route.availability === 'gap');

/**
 * Applies the same deny-by-default feature-gate behavior used by the canonical
 * shell. The result is presentation metadata only; registered routes and API
 * authorization remain authoritative and are never recreated here.
 */
export function visibleVNextRoutes(
  routes: readonly VNextRouteDefinition[],
  context: VNextRouteVisibilityContext,
): VNextRouteDefinition[] {
  return routes.flatMap((route) => {
    if (route.featureFlag && !context.featureFlags?.[route.featureFlag]) return [];
    if (route.meFeature && !context.meFeatures?.[route.meFeature]) return [];

    const label =
      (context.tenantSlug && route.tenantLabels?.[context.tenantSlug]) || route.label;
    const children = route.children ? visibleVNextRoutes(route.children, context) : undefined;

    return [{ ...route, label, ...(children ? { children } : {}) }];
  });
}
