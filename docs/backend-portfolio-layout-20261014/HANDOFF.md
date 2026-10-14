# Saved Portfolio layout: visible native roster contract

Product/test source: `e0adf31652f6987593728028d5b8eae4a1b96390`, tree `ff170e9da7524db0a70b852a48a962b0d31e0a73`. This registered slice is based on private PR8 `afff08b0342985e3a8050a5fb4cd843741a720a5` through the ordinary received preparation checkpoint `4c211c9ce921300befca43c1f4aa30d501011f73`. Original preparation heads and all prior evidence remain preserved. Independent review and root publication are the next gates; this packet does not claim native or deployed acceptance.

The parent resolved catalog policy on 2026-10-14: order the current user's authorized visible nonarchived clients, excluding ungranted walled IDs. The implementation uses the existing `fetchDeniedClientIds` ethical-wall helper with the native user UUID, includes every nonarchived status, and adds no admin bypass, target-membership requirement, guard, permission, service, or competing store. Core's existing Users/Prisma owners contain the source. Existing login, middleware, roles and protected reporting bodies are unchanged.

## HTTP contract

Core mounts authenticated `GET /api/me/portfolio-layout` and `PUT /api/me/portfolio-layout` through the registered UsersModule. Existing `CurrentTenant`, native request provenance and minimum `standard_user` RolesGuard admit the ordinary `standard_user`, `user_admin` and `capiro_admin` roles. Tenant and user always come from the native request owner; request JSON cannot select an actor or tenant. Success headers are JSON and `Cache-Control: no-store`.

Every success has exactly six keys:

```json
{"contractVersion":1,"tenantId":"<native UUID>","userId":"<native UUID>","version":0,"updatedAt":null,"order":["client:<lowercase UUID>"]}
```

`order` is the complete authorized visible nonarchived catalog, with unique lowercase `client:<UUID>` tokens and at most 2,000 entries. Version is a finite integer from 0 through 2,147,483,647. Version zero exists only when no row is persisted and has a null timestamp; persisted versions are positive and have a UTC ISO timestamp.

PUT accepts exactly `{contractVersion:1,expectedVersion,order}`. Expected version is a finite integer from 0 through 2,147,483,646. Body and array own-data snapshots refuse proxies, getters, holes, extra keys, coercion, duplicate tokens and normalization. A successful PUT writes exactly the submitted order and returns exactly `expectedVersion + 1`, including an identical-order save.

| Operation/state | Behavior |
| --- | --- |
| Absent GET | Version 0, null timestamp and UUID-sorted current authorized catalog. No insert or zero-version autosave. |
| Initial PUT expected 0 | Insert version 1 if the complete submitted set equals the current authorized catalog. One initial contender wins; losers conflict. |
| Persisted unchanged GET | Return durable order, version and timestamp unchanged. |
| Permission/roster churn on persisted GET | Remove revoked, ungranted-walled, archived or departed IDs before returning; retain visible survivors in relative order; append newly visible UUIDs sorted; persist one version increment iff the resulting order changed. Removed IDs are never returned as metadata or a replacement order. |
| Stale PUT or catalog/subset mismatch | 409 with a stable version/catalog conflict code; no accepted replacement receipt, merge, expected-version substitution or automatic replay. |
| Catalog exceeds 2,000 | 503 capacity failure, no truncation, mutation or empty-success fallback. |
| MAX version | Unchanged GET may return; an increment required by GET or PUT fails 503 without mutation. |
| Malformed persisted row | 503; never manufacture version zero. |
| Explicit connector-confirmed save abort | P2034 or P2010 carrying SQLSTATE 40001/40P01 becomes 409. The operation is never retried. GET transaction failures become 503. |
| Unknown commit outcome | 503; no callback/request retry and no in-memory success claim. |

A fresh durable GET is the recovery mechanism after an uncertain/lost PUT reply. Frontend may recognize the original attempted save only when the recovered version equals the original expected version plus one **and** the recovered order equals the original attempted order exactly. Permission churn, reconciliation or another writer may prevent that exact match; manual review is then required. Do not advance expectedVersion or replay a PUT automatically.

The GET order also binds the currently authorized catalog set for frontend ordering. The old full tenant profile roster must be aligned with this selected visibility policy; do not infer an authorized set from a failed GET, a visible search/owner subset, or an ACTIVE-only funding rail. An operation has a coherent serializable snapshot; it does not promise an instant globally frozen roster after its transaction commits. Refetch after a catalog conflict and let the user review the current order before a new save.

## Authority and concurrency

The existing `TenantContextMiddleware.readApplicationAuthority(req,ctx)` provides the canonical private WeakMap/current-session proof. The controller snapshots native tenant/user and checks the proof binds that owner before invoking the existing `PrismaService.withSystem` once with Serializable isolation. It neither reconstructs membership selection nor chooses an alternative authority.

Inside that one transaction a tenant/user-namespaced advisory lock serializes this owner's layout operations. Bound SHARE locks cover the native User, all existing actor memberships, their tenants plus the target tenant in sorted order, and existing actor-target impersonation rows. These are lock supersets only. The existing proof rechecks the exact original membership/session/impersonation before and after catalog/layout work, including original revision and expiry. The layout table key and every read/write predicate bind both native tenant and user. Original home membership remains valid for existing administrator impersonation; there is no fabricated target membership.

The catalog locks existing nonarchived clients in UUID order before existing actor ethical-wall grants, matching the canonical roster writer's client-before-grant order. The unchanged wall helper then selects visibility in the same transaction. Conditional UPDATE version predicates and INSERT ON CONFLICT backstop layout CAS. No external catalog writer is required to adopt a new advisory protocol. New/restored catalog rows can be snapshot phantoms; current-row locking and Serializable isolation provide a coherent transaction point, while native scheduling remains unqualified.

The existing proof performs one fresh read-only Clerk session read before the layout transaction and opens a second pooled transaction for each canonical local recheck. No such real provider/database call ran in this source lane. Pool capacity, availability and existing writer lock order require native acceptance. Source defaults and existing login rules are unchanged.

## Source dependencies and overlap

| Owner/pin | Relationship |
| --- | --- |
| Private PR8 `afff08b…` | Required receiving base; its Core wiring/Meetings repairs are preserved. This slice does not retire a runtime or assert new full Core startup. |
| Prepared source `9d562aa…`, received through `4c211c9…` | Six prepared schema/migration/helper/Prisma paths are retained unchanged. This source adds two production files, two meaningful suites and UsersModule registration. |
| Frontend PR29 `247de58…`, `docs/outreach-list-scope-20261014/API-DEPENDENCIES.md` | Six-key wire/CAS/recovery grammar matches. Parent has routed the wall-visible roster policy to frontend; caller/catalog alignment remains its owner. |
| Existing auth/wall/roles sources | Exact unchanged source bodies are bound in the receipt. No Clerk, middleware, tenant guard, role or permission edits. |
| `20261014050000_user_portfolio_layout` | Additive source schema/migration only. A receiving database requires its table, constraints, existing timestamp/RLS functions and qualified role behavior. No migration, generator, database or permission execution occurred. |
| Protected Engagement work and legacy retirement lanes | No import/edit of protected unpublished reporting bodies, no Engagement logic or runtime retirement. Root owns ordinary integration and publication. |

## Verification and limits

Final committed-source attempts 18/19 pass: **110/110** cases in five suites, zero failed/skipped/pending, plus strict/noUnchecked/noEmit types. All **75** preparation case identities survive; **35** new cases cover route/role metadata, native request/context provenance, same-user wall filtering across all admitted roles, native binding, pre/final revoke rollback, initial CAS contenders, identical writes, catalog churn, capacity/exhaustion, explicit abort/no replay and lost-reply durable recovery. Eighteen source/schema paths are hashed before/after both final checks. Schema/model metadata was not generated.

The module suite initializes and closes the actual UsersModule/controllers and native TenantModule, invokes registered Nest HTTP handlers with synthetic responses, and exercises the real middleware proof/guard. Only database and Clerk I/O use inert ports; no socket listens. Its in-memory rollback/serialized callbacks are source controls, not Postgres row locks, SSI, RLS, process-restart persistence, current live Clerk, full Core or deployed acceptance. The JavaScript refusal host is a test fence, not an OS sandbox.

Historical REDs remain losslessly indexed: preparation syntax/literal/proxy replay failures; initial controller type diagnostics (missing sparse type dependency and recursive mock inference); attempt 12's four fixture wall-query routing failures; and attempt 15's Jest 29 parse failure on installed htmlparser2 ESM. The fixture routing was corrected without changing the canonical wall helper. A bounded test adapter delegates only unchanged installed sanitize-html to Node 24's actual loader, and an in-memory TypeScript transformer avoids ts-jest disk cache expansion. No package install or product dependency rewrite occurred. Earlier attempts lacking the final source-binding fields are intermediate evidence, not the final qualification.

No real messages, uploads, provider/model calls, customer writes, credentials/permissions, AWS operations, database/migration execution, network/security changes, main merge or deployment occurred. Native Prisma downloads remain blocked and were not bypassed.
