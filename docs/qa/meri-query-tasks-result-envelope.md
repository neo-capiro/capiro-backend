# `query_tasks` result-envelope mapper — local acceptance

Base commit: `836fc9d8cfd27941c7f4fe7c2c4627c7f5714e75` (Phase2 integration worktree HEAD).
Scope: additive, dormant success observer and source/coverage mapper; no dispatch wiring, response-shape change, deployment, database, or live-source activity.

## Source contract checked

`MeriToolsService.queryTasks` normalizes status/due-date/limit, resolves an explicit client filter through `ensureClientVisible`, and calls `EngagementService.listTasks` with authenticated `TenantContext`. The engagement query filters by tenant, applies an optional resolved client ID, applies wall/visibility predicates before `take`, restricts clientless tasks to creator or owner, and filters linked meetings/mail/contacts by their ownership/client visibility conditions. The existing `engagement-task-wall.spec.ts` pins the important Prisma query predicates.

The API emits `returned = tasks.length`, `pageLimit = limit`, `total = tasks.length` and `paginationComplete = true` only when `tasks.length < limit`; when the page is full, `total = null` and `paginationComplete = false`. The endpoint has no cursor. Thus a full page is partial, never complete. `generatedAt` is response-generation time and is not source freshness.

The source mapper does not claim per-user ACL parity, infer authorization from `readOnly`, emit tenant/user/client identifiers in metadata, or alter handler policy. For positively identified `query_tasks` payloads it records the authenticated-tenant category and whether the server applied an explicit resolved client filter, while explicitly noting that the resolved query filters are not recorded in the envelope. Unidentified payloads receive unknown scope and no handler visibility claim. The query-shape tests are not a database-backed cross-user policy acceptance test.

## Local acceptance criteria

- Mapper is opt-in and not connected to `execute`, schema exposure, planner, or model output.
- Exact legacy payload object is retained and returned. A rejected call propagates the exact original error value; observer failure cannot affect successful results.
- Only mutually consistent, positively identified `query_tasks` short pages are complete for pagination of the handler's actual query. Even an empty verified short page is `succeeded`, not `not_found_within_scope`: resolved status/open-only/due-date and selected-client filters are not all bound into the envelope, so no scoped absence claim is justified.
- Any full page is partial with unknown matched count and no definite continuation claim; a full page does not prove that another row exists. Contradictory metadata stays unknown.
- No `observedAt` is inferred from `generatedAt`; source freshness remains unknown.
- API focused tests pass and repository diff passes whitespace checks.

## Residual gates

This is a dormant local contract, not live response adoption or factual acceptance. Before wiring it into a runtime, bind all server-resolved query filters (including selected client identity in a privacy-safe, unambiguous form) to the handler result before making any no-match claim; prove the intended same-tenant cross-user visibility policy with a database-backed fixture and retain the query wall behavior; review model-visible compatibility, permission/alias parity, and actual source freshness (currently unavailable). The envelope does not establish that full-page results are complete, that omitted records do not exist, or that a user may access all same-tenant client tasks. No deployment or production data was used.
