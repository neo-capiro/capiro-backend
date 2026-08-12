import { DIRECTORY_ROUTES } from '../../pages/directory/directory-routes.js';

export type VNextRouteAvailability = 'existing' | 'gap';

export interface VNextRouteDefinition {
  id: string;
  label: string;
  path: string | null;
  availability: VNextRouteAvailability;
  featureFlag?: string;
  meFeature?: string;
  children?: VNextRouteDefinition[];
  note?: string;
}

export interface VNextRouteVisibilityContext {
  featureFlags?: Readonly<Record<string, boolean | undefined>>;
  meFeatures?: Readonly<Record<string, boolean | undefined>>;
}

/**
 * vNext navigation contract mapped to routes that already exist in App.tsx.
 * Gaps stay explicit; this file never invents replacement URLs or redirects.
 */
export const VNEXT_ROUTE_MANIFEST: VNextRouteDefinition[] = [
  { id: 'dashboard', label: 'Dashboard', path: '/', availability: 'existing' },
  { id: 'portfolio', label: 'Portfolio', path: '/clients', availability: 'existing' },
  {
    id: 'engagement-manager',
    label: 'Engagement Manager',
    path: '/engagement',
    availability: 'existing',
  },
  { id: 'workspace', label: 'Workspace', path: '/workspace', availability: 'existing' },
  {
    id: 'strategies',
    label: 'Strategies',
    path: '/strategies',
    availability: 'existing',
    meFeature: 'strategyPlanner',
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
        label: 'Program Elements',
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

export const VNEXT_ROUTE_GAPS = VNEXT_ROUTE_MANIFEST.flatMap((route) => route.children ?? [])
  .filter((route) => route.availability === 'gap');

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

    const children = route.children
      ? visibleVNextRoutes(route.children, context)
      : undefined;

    return [{ ...route, ...(children ? { children } : {}) }];
  });
}
