# Objectives and layout: serving release versus schema

Read-only observation2026-10-14T20:33Z: preview revision8 still has `CORE_API_BASE_URL=https://os.capiro.ai/api`, Strategy/Workspace on the same existing host, ordinary modefalse for CAPIRO_PREVIEW_READ_ONLY. Core650 advertises RELEASE_SHA/GIT_SHA `1e99f0921b207318c6d2abf03927b5c4daa5768b`. GitHub's complete nontruncated capirov2 tree at that marker contains neither `apps/api/src/clients/objectives/` nor the user portfolio-layout controller/helper/transaction paths. The marker is task metadata, not independent image-byte provenance. Shipping must correlate the actual current image/headers; this review does not duplicate the native image diagnostic.

The current shared HTTPS ALB routes `/api/*` to the existing Core target at priority10; its `os.capiro.ai` frontend rule is priority50. No new successor Core service exists in the preview cluster. The frontend deployment did not replace the shared Core service. This is direct evidence of an old serving-source selection, not proof that a missing database table causes the reported404.

## Exact existing paths

| Surface | Qualified frontend request | Successor controller/module owner | Required schema |
|---|---|---|---|
| Objective list/create/update/transition | Core `clients/{clientId}/objectives`, with existing method/version/query bodies | `apps/api/src/clients/objectives/objectives.controller.ts`; ClientObjectivesModule imported by ClientsModule, which AppModule imports | `client_objectives`, `client_objective_revisions`, their indexes/constraints/RLS/grants |
| Layout read/save | Core `me/portfolio-layout`, GET and PUT | `apps/api/src/users/portfolio-layout.controller.ts`; UsersModule includes PortfolioLayoutController and AppModule imports UsersModule | `user_portfolio_layouts`, `portfolio_layout_order_valid(uuid[])`, owner RLS policy, `set_updated_at()` trigger and existing role privileges |

The ordinary `/api` prefix gives GET `/api/clients/:clientId/objectives` and GET/PUT `/api/me/portfolio-layout`. Frontend PR50's `features/portfolio/objectives/queries.ts`, `features/portfolio/index/layout/api.ts` and the existing Portfolio proxy already use these paths. Core proxy roots clients/me are admitted; CORE_API_BASE_URL includes `/api`. Do not add a new controller, disable parsing, broaden the proxy allowlist or invent a new authentication layer to mask a404.

## Distinguish failures

- Missing mounted route: verify exact serving source/image and native route404, then bind the successor. A healthy `/health` only proves a SELECT1 response; it does not verify these tables/routes.
- Real client denial/not found: ClientObjectivesService.assertClient checks current tenant, nonarchived client and existing clientMemoryAllowed. Its deliberate404 is meaningful; do not remove these checks. The generic frontend404 message does not distinguish this from route absence.
- Empty Objective data: an authorized existing client with no records returns200with an empty array. No Objective seed is required merely to open the list.
- Missing Objective table: the existing Prisma exception filter leaves an unknown/P2021 error as500; schema absence is not the source's intentional404 response.
- No saved layout row: with required schema/authority available, GET returns contractVersion1/version0/default visible catalog. It need not provision a row first. PUT is versioned and current-authorized. Reads may reconcile an existing stale saved catalog, an already-approved ordinary metadata effect.
- Missing layout table or function: portfolioLayoutFailure maps genuine storage/unknown faults to503 PORTFOLIO_LAYOUT_UNAVAILABLE. Do not present route activation as schema qualification.
- No task for the checked client: this is empty data. The existing Strategy Planner create/subtask flow can produce an owned acceptance task under the user's ordinary preview-write approval; no implementation or schema defect follows from absence alone. This source task performs no database mutation, so no task was created here.

## Schema proof and mutation proposal

The source effects are in immutable `20281011010000_client_objectives/migration.sql` SHA256cd6a1f08162b55b04325d7ef017fdabc23d1d28870fd1c6ce863789f70fca5e2 and `20261014050000_user_portfolio_layout/migration.sql` SHA2568058591c5b7e9bc32a215367c73064a74cf8b81da54985f95498e63ab7d3727f. Both have no matching record in the15:29retained ledger capture; that does NOT mean never applied. Layout also has a source allocation-date issue; no rename is authorized by that fact.

`SCHEMA-EFFECT-READ.sql` is a bounded proposed read-only catalog check for the already-approved database owner; it was not executed here. Join its exact current database/schema/role observation to all relevant historical names/checksums, alternate migrations and source effects. Table existence alone is insufficient: check columns/defaults, FK/unique/check constraints, indexes, RLS/owner policies, functions, triggers and privileges. Missing grants or different schema/search_path may fail even when tables exist. Preserve existing controls; do not silently widen role access.

If all effects match, no migration is needed for these endpoints. If demonstrated effects are missing, the database owner must allocate/review the exact additive change and compatibility plan before execution; do not run the entire migration tree, repeat finished newsletter migrations, rewrite checksums, reset, or use resolve automatically. Core650's advertised source is old; applying SQL alone cannot mount its missing controllers.

## Minimal promotion

1. Shipping independently admits the exact successor ARM64 image and ordinary startup tuple.
2. Review and bind the Core-only existing-database source proposal; refresh the existing role/subnet/security-group/secret metadata, hostname/TLS certificate and free early host-rule priority. Keep Core650 and production routing unchanged.
3. Complete the read-only schema/history join; separately authorize only demonstrated missing SQL/privilege effects.
4. Activate the newly named Core service from0to1 after real startup/health/Clerk/role checks with the proposed canonical background controls.
5. Switch only preview CORE_API_BASE_URL to the approved successor origin with `/api`. Current source proposes `https://core-preview.capiro.ai/api`, pending concrete DNS/TLS/routing approval.
6. Verify actual source provenance, one current owned client's Objective list (including empty), a finite draft/version/readiness flow, layout GET plus versioned save/readback/stale rejection and existing permission denials. Shipping can use the existing ordinary-write approval for a finite owned Planner create/read/subtask acceptance flow; it need not wait for a pre-existing task. Do not confuse first connectivity with Active Objective operational prototype coverage.

No signed-in token/private browser session, schema query, migration, data write, credential change, AWS write or deployment was performed by this review. Remote publication of the local source branch was denied by automatic review pending explicit user approval; no push or workaround occurred.
