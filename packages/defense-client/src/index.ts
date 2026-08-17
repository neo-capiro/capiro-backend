/**
 * Transport-injected defense client.
 *
 * This package does not own fetch, auth, retries, tracing, or application bootstrap.
 * The caller supplies a transport that applies those policies. Session 1 keeps a
 * dependency-free route registry so adding the workspace package does not require a
 * lockfile dependency edge; the parity verifier prevents drift from defense-contracts.
 */
export type DefenseClientHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type DefenseClientMinimumRole = 'standard_user' | 'capiro_admin';

export interface DefenseClientRouteDefinition<
  TId extends string = string,
  TMethod extends DefenseClientHttpMethod = DefenseClientHttpMethod,
  TPath extends string = string,
> {
  readonly id: TId;
  readonly method: TMethod;
  readonly path: TPath;
  readonly minimumRole: DefenseClientMinimumRole;
}

function defineClientRoute<
  const TId extends string,
  const TMethod extends DefenseClientHttpMethod,
  const TPath extends string,
>(
  id: TId,
  method: TMethod,
  path: TPath,
  minimumRole: DefenseClientMinimumRole = 'standard_user',
): DefenseClientRouteDefinition<TId, TMethod, TPath> {
  return { id, method, path, minimumRole };
}

export const DEFENSE_CLIENT_ROUTES = [
  defineClientRoute('programElements.admin.reconciliationQueue.list', 'GET', 'program-elements/admin/reconciliation-queue', 'capiro_admin'),
  defineClientRoute('programElements.admin.dataIssues.list', 'GET', 'program-elements/admin/data-issues', 'capiro_admin'),
  defineClientRoute('programElements.admin.dataIssues.resolve', 'POST', 'program-elements/admin/data-issues/:id/resolve', 'capiro_admin'),
  defineClientRoute('programElements.admin.reconciliationQueue.resolve', 'POST', 'program-elements/admin/reconciliation-queue/:id/resolve', 'capiro_admin'),
  defineClientRoute('programElements.admin.reconciliationQueue.approve', 'POST', 'program-elements/admin/reconciliation-queue/:id/approve', 'capiro_admin'),
  defineClientRoute('programElements.deltas.needsAttention', 'GET', 'program-elements/deltas/needs-attention'),
  defineClientRoute('programElements.list', 'GET', 'program-elements'),
  defineClientRoute('programElements.summary', 'GET', 'program-elements/summary'),
  defineClientRoute('programElements.alerts.emailPreference.get', 'GET', 'program-elements/alerts/email-pref'),
  defineClientRoute('programElements.alerts.emailPreference.put', 'PUT', 'program-elements/alerts/email-pref'),
  defineClientRoute('programElements.detail', 'GET', 'program-elements/:peCode'),
  defineClientRoute('programElements.intelligence', 'GET', 'program-elements/:peCode/intelligence'),
  defineClientRoute('programElements.timeline', 'GET', 'program-elements/:peCode/timeline'),
  defineClientRoute('programElements.narrative', 'GET', 'program-elements/:peCode/narrative'),
  defineClientRoute('programElements.bills', 'GET', 'program-elements/:peCode/bills'),
  defineClientRoute('programElements.billActions', 'GET', 'program-elements/:peCode/bill-actions'),
  defineClientRoute('programElements.contractors', 'GET', 'program-elements/:peCode/contractors'),
  defineClientRoute('programElements.projects', 'GET', 'program-elements/:peCode/projects'),
  defineClientRoute('programElements.procurementLines', 'GET', 'program-elements/:peCode/procurement-lines'),
  defineClientRoute('programElements.sources', 'GET', 'program-elements/:peCode/sources'),
  defineClientRoute('programElements.related', 'GET', 'program-elements/:peCode/related'),
  defineClientRoute('programElements.programs', 'GET', 'program-elements/:peCode/programs'),
  defineClientRoute('programElements.provisions', 'GET', 'program-elements/:peCode/provisions'),
  defineClientRoute('programElements.opportunities', 'GET', 'program-elements/:peCode/opportunities'),
  defineClientRoute('programElements.positions', 'GET', 'program-elements/:peCode/positions'),
  defineClientRoute('programElements.pbComparison', 'GET', 'program-elements/:peCode/pb-comparison'),
  defineClientRoute('programElements.deltas.list', 'GET', 'program-elements/:peCode/deltas'),
  defineClientRoute('programElements.watch.set', 'POST', 'program-elements/:peCode/watch'),
  defineClientRoute('programElements.dataIssues.list', 'GET', 'program-elements/:peCode/data-issues'),
  defineClientRoute('programElements.dataIssues.create', 'POST', 'program-elements/:peCode/data-issues'),
  defineClientRoute('budgetLines.movement', 'GET', 'budget-lines/movement'),
  defineClientRoute('budgetLines.graph', 'GET', 'budget-lines/graph'),
  defineClientRoute('budgetLines.watchlistSignals', 'GET', 'budget-lines/watchlist/signals'),
  defineClientRoute('budgetLines.capabilities.list', 'GET', 'budget-lines/capabilities'),
  defineClientRoute('budgetLines.capabilities.recommendations', 'GET', 'budget-lines/capabilities/:slug/recommendations'),
  defineClientRoute('budgetLines.capabilitySearch', 'GET', 'budget-lines/capability-search'),
  defineClientRoute('budgetLines.actions', 'GET', 'program-elements/:peCode/actions'),
  defineClientRoute('budgetLines.relationships', 'GET', 'program-elements/:peCode/relationships'),
  defineClientRoute('budgetLines.incumbents', 'GET', 'program-elements/:peCode/incumbents'),
  defineClientRoute('programs.admin.matchQueue.list', 'GET', 'programs/admin/match-queue', 'capiro_admin'),
  defineClientRoute('programs.admin.matchQueue.resolve', 'POST', 'programs/admin/match-queue/:id/resolve', 'capiro_admin'),
  defineClientRoute('programs.admin.duplicateAliases', 'GET', 'programs/admin/duplicate-aliases', 'capiro_admin'),
  defineClientRoute('programs.admin.merge', 'POST', 'programs/admin/merge', 'capiro_admin'),
  defineClientRoute('programs.admin.aliases.list', 'GET', 'programs/admin/:programId/aliases', 'capiro_admin'),
  defineClientRoute('programs.admin.aliases.create', 'POST', 'programs/admin/:programId/aliases', 'capiro_admin'),
  defineClientRoute('programs.admin.aliases.update', 'PATCH', 'programs/admin/aliases/:id', 'capiro_admin'),
  defineClientRoute('programs.admin.aliases.delete', 'DELETE', 'programs/admin/aliases/:id', 'capiro_admin'),
  defineClientRoute('programs.list', 'GET', 'programs'),
  defineClientRoute('programs.detail', 'GET', 'programs/:id'),
] as const;

export type DefenseClientRoute = (typeof DEFENSE_CLIENT_ROUTES)[number];
export type DefenseClientRouteId = DefenseClientRoute['id'];

export const DEFENSE_CLIENT_ROUTE_BY_ID: Readonly<
  Record<DefenseClientRouteId, DefenseClientRoute>
> = Object.freeze(
  Object.fromEntries(
    DEFENSE_CLIENT_ROUTES.map((route) => [route.id, route]),
  ) as Record<DefenseClientRouteId, DefenseClientRoute>,
);

export type DefenseClientPathParams = Readonly<Record<string, string | number>>;
export type DefenseClientQueryValue = string | number | boolean | null | undefined;
export type DefenseClientQuery = Readonly<
  Record<string, DefenseClientQueryValue | readonly DefenseClientQueryValue[]>
>;

export interface DefenseClientCall<TBody = unknown> {
  readonly params?: DefenseClientPathParams;
  readonly query?: DefenseClientQuery;
  readonly body?: TBody;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface DefenseResolvedRequest<TBody = unknown> {
  readonly routeId: DefenseClientRouteId;
  readonly method: DefenseClientHttpMethod;
  readonly path: string;
  readonly query?: DefenseClientQuery;
  readonly body?: TBody;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly minimumRole: DefenseClientMinimumRole;
}

export interface DefenseTransport {
  send<TResponse = unknown, TBody = unknown>(
    request: DefenseResolvedRequest<TBody>,
  ): Promise<TResponse>;
}

export interface DefenseClientOptions {
  readonly transport: DefenseTransport;
  /** Deployment prefix only; route contracts remain prefix-free. Defaults to `/api`. */
  readonly basePath?: string;
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

function interpolatePath(
  path: string,
  params: DefenseClientPathParams,
): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_token, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') {
      throw new TypeError(`Missing defense client route parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

export class DefenseClient {
  private readonly transport: DefenseTransport;
  private readonly basePath: string;

  constructor(options: DefenseClientOptions) {
    this.transport = options.transport;
    this.basePath = normalizeBasePath(options.basePath ?? '/api');
  }

  route(routeId: DefenseClientRouteId): DefenseClientRoute {
    return DEFENSE_CLIENT_ROUTE_BY_ID[routeId];
  }

  async call<TResponse = unknown, TBody = unknown>(
    routeId: DefenseClientRouteId,
    input: DefenseClientCall<TBody> = {},
  ): Promise<TResponse> {
    const route = this.route(routeId);
    const resolvedPath = interpolatePath(route.path, input.params ?? {});
    return this.transport.send<TResponse, TBody>({
      routeId,
      method: route.method,
      path: `${this.basePath}/${resolvedPath}`,
      query: input.query,
      body: input.body,
      signal: input.signal,
      headers: input.headers,
      minimumRole: route.minimumRole,
    });
  }
}

export function createDefenseClient(options: DefenseClientOptions): DefenseClient {
  return new DefenseClient(options);
}
