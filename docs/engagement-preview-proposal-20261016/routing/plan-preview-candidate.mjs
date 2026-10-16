// INACTIVE SOURCE PROPOSAL. No production module imports this file.
// This is routing eligibility only; it creates no identity, grant or permission.
// Inputs are a server-owned fixed operation, its exact Core method, and the
// canonical /api pathname BEFORE separately validated query serialization.
// Browser RPC paths, complete URLs and raw/encoded paths are not this interface.

const UUID_SHAPE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Structural matching deliberately does not define UUID version/validity policy.
// Existing owner z.uuid normalization and Core ParseUUIDPipe remain mandatory.
const ROOT = '/api/engagement/plans';
const definitions = [
  ['engagement.plans.list', 'GET', ROOT, 'list', 200],
  ['engagement.plans.detail', 'GET', `${ROOT}/:planId`, 'get', 200],
  ['engagement.plans.create', 'POST', ROOT, 'create', 201],
  ['engagement.plans.update', 'PATCH', `${ROOT}/:planId`, 'patch', 200],
  ['engagement.plans.wave.create', 'POST', `${ROOT}/:planId/waves`, 'createWave', 201],
  ['engagement.plans.wave.update', 'PATCH', `${ROOT}/:planId/waves/:waveId`, 'patchWave', 200],
  ['engagement.plans.wave.reorder', 'POST', `${ROOT}/:planId/waves/reorder`, 'reorder', 201],
  ['engagement.plans.review', 'POST', `${ROOT}/:planId/reviews`, 'review', 201],
  ['engagement.plans.history', 'GET', `${ROOT}/:planId/history`, 'history', 200],
];

export const PROPOSED_PLAN_ROUTES = Object.freeze(
  definitions.map(([operationKey, method, path, handler, status]) =>
    Object.freeze({ operationKey, method, path, handler, status }),
  ),
);

export const LEGACY_PLAN_PATTERN_SOURCES = Object.freeze([
  '^/api/engagement/plans$',
  '^/api/engagement/plans/[^/]+$',
  '^/api/engagement/plans/[^/]+/history$',
  '^/api/engagement/plans/[^/]+/reviews$',
  '^/api/engagement/plans/[^/]+/waves$',
  '^/api/engagement/plans/[^/]+/waves/[^/]+$',
  '^/api/engagement/plans/[^/]+/waves/reorder$',
]);

const byOperation = new Map(
  PROPOSED_PLAN_ROUTES.map((route) => [
    route.operationKey,
    {
      ...route,
      pattern: new RegExp(
        `^${route.path.replace(':planId', UUID_SHAPE).replace(':waveId', UUID_SHAPE)}$`,
      ),
    },
  ]),
);

/** No URL parsing, decoding, prefix fallback, method coercion or scope hints. */
export function matchesProposedCorePlanOperation(operationKey, method, canonicalPathname) {
  if (
    typeof operationKey !== 'string' ||
    typeof method !== 'string' ||
    typeof canonicalPathname !== 'string' ||
    /[\s%?#\\]/u.test(canonicalPathname)
  ) return false;
  const route = byOperation.get(operationKey);
  return !!route && method === route.method && route.pattern.test(canonicalPathname);
}
