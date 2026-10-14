# Saved Portfolio layout: visible native roster contract

Combined source: `078c55f805de8599cc413917ef90b7e20f040942`, tree `e7dfea58d4044cd0b26bc1c13b5fda8c17e1522a`. Root ordinarily merged accepted layout candidate `484dc0af7adc41103b189f262113bebfce10074c` with published private draft PR9 head `7239a4a4ace420492d8aace6c85e55773865be38`; PR9 is the layout draft's publication base. Every layout product/test blob remains exact to reviewed source `e0adf31652f6987593728028d5b8eae4a1b96390`, tree `ff170e9da7524db0a70b852a48a962b0d31e0a73`, and every prospect product/test blob remains exact to reviewed source `eeb71e6e45024afd32dbbd3e8158d1184241da68`. The seventeen-path source union is disjoint with no outside source changes. Both original candidates, preparation heads and check history remain preserved. Root and independent review accepted the source and frozen packet `c570bd0465f2ee12bc4736c18ce8e6811854ed6a`, tree `de9be442e2870f77ea86925897c6fd65b0fab5b7`, without blockers. Publication appends exact final acceptance records and this current status through docs only; reviewed heads remain ancestors. This packet does not claim native or deployed acceptance.

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
| Private PR8 `afff08b…` | Common accepted ancestor; its Core wiring/Meetings repairs and prior startup evidence are preserved. No runtime is retired. |
| Private draft PR9 `7239a4a…`, tree `a12f02b…` | Forthcoming layout PR base. Its reviewed prospect source `eeb71e6…` remains exact after the ordinary merge; six source/spec paths are disjoint from layout's eleven. Its historical150-case/strict-emit review is preserved and is not relabelled as this layout rerun. |
| Combined merge `078c55f…`, tree `e7dfea5…` | Parents are accepted layout484 and published prospect723. `COMBINED-RECEIPT.json` proves the exact17-path union, zero overlaps/outside source changes, and new110-case/types qualification. No product edit occurred during combined verification. |
| Root combined Core source check at `078c55f…` | Actual Core init/close reports28 passing checks and both layout routes. Original wrapper HELD and full raw outputs remain intact; a separate parse-only receipt corrects its uppercase/lowercase method comparison. Native/generated-client/deployed acceptance remains unqualified. |
| Prepared source `9d562aa…`, received through `4c211c9…` | Six prepared schema/migration/helper/Prisma paths are retained unchanged. This source adds two production files, two meaningful suites and UsersModule registration. |
| Frontend PR29 `247de58…`, `docs/outreach-list-scope-20261014/API-DEPENDENCIES.md` | Historical six-key wire/CAS/recovery grammar remains preserved. Its old full-roster ordering requirement is superseded by the agreed authorized-catalog receiving contract. |
| Frontend PR33 `8f07bead475a186e470eb0b50f2e4fb03d4c40f5`, `docs/authorized-layout-20261014/RECEIVING-SEMANTICS.md` | Exact source receiving policy matches: actor-bound GET admits the complete authorized nonarchived subset of roster metadata; PUT uses the complete admitted set; exact six-key receipt, CAS, late-response fencing and GET-only exact recovery. Lossless exact document is indexed. Frontend/backend source alignment is established; native/live binding is separate. |
| Existing auth/wall/roles sources | Exact unchanged source bodies are bound in the receipt. No Clerk, middleware, tenant guard, role or permission edits. |
| `20261014050000_user_portfolio_layout` | Additive source schema/migration only. A receiving database requires its table, constraints, existing timestamp/RLS functions and qualified role behavior. No migration, generator, database or permission execution occurred. |
| Protected Engagement work and legacy retirement lanes | No import/edit of protected unpublished reporting bodies, no Engagement logic or runtime retirement. Root owns ordinary integration and publication. |

## Verification and limits

Combined-source attempts 20/21 pass at exact `078c55f…`: **110/110** cases in five suites, zero failed/skipped/pending, plus strict/noUnchecked/noEmit types. All110 raw identities and multiplicities match historical layout attempts18/19, which remain independently accepted at exact `e0adf31…`. All **75** preparation case identities survive; **35** new cases cover route/role metadata, native request/context provenance, same-user wall filtering across all admitted roles, native binding, pre/final revoke rollback, initial CAS contenders, identical writes, catalog churn, capacity/exhaustion, explicit abort/no replay and lost-reply durable recovery. Eighteen source/schema paths are hashed before/after each check pair. `LAYOUT-ACCEPTANCE.md` and `LAYOUT-REVIEW.json` are exact copies of the independent review, which additionally verified the original77-payload/42-lossless packet and all eleven source/spec blobs. Schema/model metadata was not generated.

Final `FINAL-LAYOUT-PACKET-ACCEPTANCE.md`/JSON independently admit frozen c570's97 indexed payloads and49 lossless observations, all1,616 actual Core source mode/blob/SHA bindings and all3,100 recorded cached dependency current hashes, exact harness/lock, both layout routes and clean shutdown. The original failed wrapper remains byte-exact. The reviewer ran no tests or runtime. The final publication follow-up copies that acceptance unchanged, updates this status and regenerates the derived index; product source is unchanged.

The module suite initializes and closes the actual UsersModule/controllers and native TenantModule, invokes registered Nest HTTP handlers with synthetic responses, and exercises the real middleware proof/guard. Only database and Clerk I/O use inert ports; no socket listens. Its in-memory rollback/serialized callbacks are source controls, not Postgres row locks, SSI, RLS, process-restart persistence, current live Clerk or deployed acceptance. The JavaScript refusal host is a test fence, not an OS sandbox.

Root separately ran the existing real Core source fixture at exact combined `078c55f…`; its raw report passes all28 checks, loads1,616 source files/89 modules, captures1,170 registered routes, and reports no unexpected denied I/O, asynchronous errors or remaining timers after close. It loads the actual existing business graph, including the unchanged published Engagement body, and both actual UsersModule/layout-controller sources. The original wrapper returned HELD because it compared uppercase `GET`/`PUT` to the lowercase keys emitted by `Object.keys(route.methods)`. The original wrapper, HELD receipt and complete stdout/stderr remain unchanged. `derive-core-admission.cjs` only decodes/hash-validates that existing report and admits its exact `/api/me/portfolio-layout` rows with `get` and `put`; it reruns no runtime or test. Its ten source/output/harness/route checks pass. This is a correction of the recorded observation, not a product or fixture source change.

The authored schema SHA256 is `a61586db5cf24ad97e6e9a0e3baf0c11aa80263a2e367bfbc95920f41c54cc12`; the unchanged cached Prisma schema SHA256 is `215556bd82b97f0be84d7f97da7f19a5a25bace97dc54b1a550cab2039a740fb`. The Core result qualifies source graph/DI and registered route metadata with inert I/O and transpile/runtime checks. It does not qualify regenerated model metadata, native SQL/RLS/SSI/row locks/pool behavior, providers/current live sessions, process-restart persistence, deployed images or runtime retirement. The new layout uses raw SQL; schema installation was not performed.

Historical REDs remain losslessly indexed: preparation syntax/literal/proxy replay failures; initial controller type diagnostics (missing sparse type dependency and recursive mock inference); attempt 12's four fixture wall-query routing failures; and attempt 15's Jest 29 parse failure on installed htmlparser2 ESM. The fixture routing was corrected without changing the canonical wall helper. A bounded test adapter delegates only unchanged installed sanitize-html to Node 24's actual loader, and an in-memory TypeScript transformer avoids ts-jest disk cache expansion. No package install or product dependency rewrite occurred. Earlier attempts lacking the final source-binding fields are intermediate evidence, not the final qualification.

No real messages, uploads, provider/model calls, customer writes, credentials/permissions, AWS operations, database/migration execution, network/security changes, main merge or deployment occurred. Native Prisma downloads remain blocked and were not bypassed.
