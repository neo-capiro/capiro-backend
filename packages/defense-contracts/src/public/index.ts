/**
 * Phase 8 Session 1 public defense API contract.
 *
 * Paths intentionally omit the deployment prefix (`/api`). Routing layers own that
 * prefix; this contract owns only the stable controller-visible route.
 */
export type DefenseHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type DefenseAuthRole = 'standard_user' | 'capiro_admin';

export interface DefensePublicRouteDefinition<
  TId extends string = string,
  TMethod extends DefenseHttpMethod = DefenseHttpMethod,
  TPath extends string = string,
> {
  readonly id: TId;
  readonly method: TMethod;
  readonly path: TPath;
  readonly minimumRole: DefenseAuthRole;
}

function defineRoute<
  const TId extends string,
  const TMethod extends DefenseHttpMethod,
  const TPath extends string,
>(
  id: TId,
  method: TMethod,
  path: TPath,
  minimumRole: DefenseAuthRole = 'standard_user',
): DefensePublicRouteDefinition<TId, TMethod, TPath> {
  return { id, method, path, minimumRole };
}

/**
 * Strangler route manifest for the routes currently registered by:
 * - ProgramElementController
 * - BudgetLinesController
 * - ProgramsController
 *
 * Session 1 does not move or register these routes. The parity verifier compares
 * this list with the live controller decorators at the frozen source SHA.
 */
export const DEFENSE_PUBLIC_ROUTES = [
  defineRoute('programElements.admin.reconciliationQueue.list', 'GET', 'program-elements/admin/reconciliation-queue', 'capiro_admin'),
  defineRoute('programElements.admin.dataIssues.list', 'GET', 'program-elements/admin/data-issues', 'capiro_admin'),
  defineRoute('programElements.admin.dataIssues.resolve', 'POST', 'program-elements/admin/data-issues/:id/resolve', 'capiro_admin'),
  defineRoute('programElements.admin.reconciliationQueue.resolve', 'POST', 'program-elements/admin/reconciliation-queue/:id/resolve', 'capiro_admin'),
  defineRoute('programElements.admin.reconciliationQueue.approve', 'POST', 'program-elements/admin/reconciliation-queue/:id/approve', 'capiro_admin'),
  defineRoute('programElements.deltas.needsAttention', 'GET', 'program-elements/deltas/needs-attention'),
  defineRoute('programElements.list', 'GET', 'program-elements'),
  defineRoute('programElements.summary', 'GET', 'program-elements/summary'),
  defineRoute('programElements.alerts.emailPreference.get', 'GET', 'program-elements/alerts/email-pref'),
  defineRoute('programElements.alerts.emailPreference.put', 'PUT', 'program-elements/alerts/email-pref'),
  defineRoute('programElements.detail', 'GET', 'program-elements/:peCode'),
  defineRoute('programElements.intelligence', 'GET', 'program-elements/:peCode/intelligence'),
  defineRoute('programElements.timeline', 'GET', 'program-elements/:peCode/timeline'),
  defineRoute('programElements.narrative', 'GET', 'program-elements/:peCode/narrative'),
  defineRoute('programElements.bills', 'GET', 'program-elements/:peCode/bills'),
  defineRoute('programElements.billActions', 'GET', 'program-elements/:peCode/bill-actions'),
  defineRoute('programElements.contractors', 'GET', 'program-elements/:peCode/contractors'),
  defineRoute('programElements.projects', 'GET', 'program-elements/:peCode/projects'),
  defineRoute('programElements.procurementLines', 'GET', 'program-elements/:peCode/procurement-lines'),
  defineRoute('programElements.sources', 'GET', 'program-elements/:peCode/sources'),
  defineRoute('programElements.related', 'GET', 'program-elements/:peCode/related'),
  defineRoute('programElements.programs', 'GET', 'program-elements/:peCode/programs'),
  defineRoute('programElements.provisions', 'GET', 'program-elements/:peCode/provisions'),
  defineRoute('programElements.opportunities', 'GET', 'program-elements/:peCode/opportunities'),
  defineRoute('programElements.positions', 'GET', 'program-elements/:peCode/positions'),
  defineRoute('programElements.pbComparison', 'GET', 'program-elements/:peCode/pb-comparison'),
  defineRoute('programElements.deltas.list', 'GET', 'program-elements/:peCode/deltas'),
  defineRoute('programElements.watch.set', 'POST', 'program-elements/:peCode/watch'),
  defineRoute('programElements.dataIssues.list', 'GET', 'program-elements/:peCode/data-issues'),
  defineRoute('programElements.dataIssues.create', 'POST', 'program-elements/:peCode/data-issues'),
  defineRoute('budgetLines.movement', 'GET', 'budget-lines/movement'),
  defineRoute('budgetLines.graph', 'GET', 'budget-lines/graph'),
  defineRoute('budgetLines.watchlistSignals', 'GET', 'budget-lines/watchlist/signals'),
  defineRoute('budgetLines.capabilities.list', 'GET', 'budget-lines/capabilities'),
  defineRoute('budgetLines.capabilities.recommendations', 'GET', 'budget-lines/capabilities/:slug/recommendations'),
  defineRoute('budgetLines.capabilitySearch', 'GET', 'budget-lines/capability-search'),
  defineRoute('budgetLines.actions', 'GET', 'program-elements/:peCode/actions'),
  defineRoute('budgetLines.relationships', 'GET', 'program-elements/:peCode/relationships'),
  defineRoute('budgetLines.incumbents', 'GET', 'program-elements/:peCode/incumbents'),
  defineRoute('programs.admin.matchQueue.list', 'GET', 'programs/admin/match-queue', 'capiro_admin'),
  defineRoute('programs.admin.matchQueue.resolve', 'POST', 'programs/admin/match-queue/:id/resolve', 'capiro_admin'),
  defineRoute('programs.admin.duplicateAliases', 'GET', 'programs/admin/duplicate-aliases', 'capiro_admin'),
  defineRoute('programs.admin.merge', 'POST', 'programs/admin/merge', 'capiro_admin'),
  defineRoute('programs.admin.aliases.list', 'GET', 'programs/admin/:programId/aliases', 'capiro_admin'),
  defineRoute('programs.admin.aliases.create', 'POST', 'programs/admin/:programId/aliases', 'capiro_admin'),
  defineRoute('programs.admin.aliases.update', 'PATCH', 'programs/admin/aliases/:id', 'capiro_admin'),
  defineRoute('programs.admin.aliases.delete', 'DELETE', 'programs/admin/aliases/:id', 'capiro_admin'),
  defineRoute('programs.list', 'GET', 'programs'),
  defineRoute('programs.detail', 'GET', 'programs/:id'),
] as const;

export type DefensePublicRoute = (typeof DEFENSE_PUBLIC_ROUTES)[number];
export type DefensePublicRouteId = DefensePublicRoute['id'];

export const DEFENSE_PUBLIC_ROUTE_BY_ID: Readonly<Record<DefensePublicRouteId, DefensePublicRoute>> =
  Object.freeze(
    Object.fromEntries(
      DEFENSE_PUBLIC_ROUTES.map((route) => [route.id, route]),
    ) as Record<DefensePublicRouteId, DefensePublicRoute>,
  );

export type DefensePathParameters = Readonly<Record<string, string | number>>;
export type DefenseQueryValue = string | number | boolean | null | undefined;
export type DefenseQuery = Readonly<
  Record<string, DefenseQueryValue | readonly DefenseQueryValue[]>
>;

export interface DefenseRouteRequest<
  TParams extends DefensePathParameters = DefensePathParameters,
  TQuery extends DefenseQuery = DefenseQuery,
  TBody = unknown,
> {
  readonly params?: TParams;
  readonly query?: TQuery;
  readonly body?: TBody;
}

export interface ProgramElementCatalogQuery extends DefenseQuery {
  readonly service?: string;
  readonly budget_activity?: string;
  readonly q?: string;
  readonly page?: number;
  readonly limit?: number;
  readonly mode?: string;
  readonly has_data?: boolean;
  readonly watched?: boolean;
  readonly line_type?: string;
  readonly capability?: string;
  readonly divergence_threshold?: number;
  readonly status?: string;
  readonly deltaType?: string;
  readonly fy?: number;
  readonly minScore?: number;
}

export interface ProgramElementDeltaQuery extends DefenseQuery {
  readonly deltaType?: string;
  readonly fy?: number;
  readonly limit?: number;
}

export interface PaginationQuery extends DefenseQuery {
  readonly page?: number;
  readonly limit?: number;
}

export interface ProgramElementDataIssueQuery extends PaginationQuery {
  readonly status?: string;
}

export interface CreateProgramElementDataIssueBody {
  readonly issueType: string;
  readonly description: string;
  readonly fy?: number | null;
  readonly fieldName?: string | null;
  readonly suggestedSourceUrl?: string | null;
}

export interface ResolveProgramElementDataIssueBody {
  readonly resolution: string;
  readonly notes?: string | null;
}

export interface SetProgramElementWatchBody {
  readonly watching: boolean;
}

export type PeAlertEmailMode = 'off' | 'daily' | 'daily_plus_critical';

export interface SetPeAlertEmailPreferenceBody {
  readonly mode: PeAlertEmailMode;
}

export type ProgramMatchDecision = 'accept' | 'reject' | 'quarantine';

export interface ProgramMatchResolutionBody {
  readonly decision: ProgramMatchDecision;
  readonly notes?: string;
}

export interface CreateProgramAliasBody {
  readonly alias: string;
  readonly aliasType: string;
  readonly source?: string;
}

export interface UpdateProgramAliasBody {
  readonly alias?: string;
  readonly aliasType?: string;
}

export interface ProgramMergeBody {
  readonly keepProgramId: string;
  readonly mergeProgramId: string;
}

export interface DefensePage<T> {
  readonly data: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
}

export interface DefenseOperationResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly status?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Generic response boundary used until each legacy response is promoted to a named DTO. */
export type DefensePublicResponse =
  | Readonly<Record<string, unknown>>
  | readonly unknown[]
  | string
  | number
  | boolean
  | null;

export function buildDefenseRoutePath(
  route: Pick<DefensePublicRouteDefinition, 'path'>,
  params: DefensePathParameters = {},
): string {
  return route.path.replace(/:([A-Za-z0-9_]+)/g, (_token, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') {
      throw new TypeError(`Missing defense route parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}
