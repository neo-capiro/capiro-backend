# `query_action_items` result-envelope mapper — local acceptance

Base commit: `ac2ad4a4325161a271befe0e604dc6c68e6e60dd` (Phase2 integration checkpoint).
Scope: additive, dormant success observer and source/coverage mapper; no dispatch wiring, response-shape change, deployment, database, or live-source activity.

## Source contract checked

`MeriToolsService.queryActionItems` resolves any explicit `clientId` through `ensureClientVisible`, then calls the tenant-scoped `ActionRecommendationReadService.list` with optional status, sort, and bounded limit. The read service always enforces the authenticated tenant and `visibleClientWhere(ctx)` ethical-wall predicate in both its page and count queries; a selected client adds a client predicate. The tool does not expose page or due-date filters, so the service defaults to page 1 and no due-date filter. Action cards each carry a client attribution in the legacy payload, while omitting `clientId` can return cards for multiple visible clients in the tenant.

The response's `total` is the query's count, `returned` is the page length, `pageLimit` is the selected limit, and `paginationComplete` is computed as `data.length >= total`. The mapper treats only mutually consistent, positively identified payloads with `returned === actions.length`, `returned <= total`, a valid limit, and a matching pagination flag as verified. Equal returned/total counts establish exhaustive coverage of the handler query; smaller returned counts establish only a partial page. `generatedAt` is the response clock and is not action-source freshness.

## Local acceptance criteria

- Mapper is opt-in and is not connected to `execute`, schema exposure, planner, or model output.
- Exact legacy payload object is retained and returned. A rejected call propagates the exact original error value; observer failure cannot affect successful results.
- Observation identifies authenticated tenant scope and grant-filtered visibility, and distinguishes a selected-client query from all caller-visible clients in the tenant. It records whether an explicit client filter was applied plus the applied status value. It does not copy client or tenant identifiers into metadata.
- The source is `action_recommendations`; the family is `action`. No due-date filter is claimed because this tool has no due-date query input; action-card deadlines are row data, not an applied filter.
- Only consistent `returned === total` payloads with `paginationComplete === true` are complete. A count-consistent short page is partial. Contradictory or unidentified payloads stay unknown; a full page alone never proves more results exist.
- Even an exhaustive empty result is `succeeded`, not `not_found_within_scope`: this observer does not bind the fully resolved client identity, status semantics, tenant and user visibility context, and query version into the envelope sufficiently to support a model-facing absence claim.
- No `observedAt` is inferred from `generatedAt`; actual action-source freshness remains unknown.
- Focused mapper tests pass and repository diff passes whitespace checks.

## Residual gates

This is a dormant local contract, not live response adoption or factual acceptance. Before wiring it into a runtime, bind the resolved query and visibility policy to an immutable source observation, confirm status-filter validation semantics, prove the same-tenant grant behavior with a database-backed cross-user fixture, and review compatibility, aliases, and action-source freshness. No deployment or production data was used.
