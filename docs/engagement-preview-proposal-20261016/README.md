# Inactive Engagement preview integration proposal

The proposal supplies the nine exact manual-plan operation bindings, a method/path filter with negative cases, an audit that pins the existing actor/client authority, and a read-only catalog preflight with an offline assessor. It changes no application source. The reviewed manual-plan implementation remains [PR27 at exact `016e79b5`](https://github.com/neo-capiro/capiro-backend/pull/27); its [wire contract](https://github.com/neo-capiro/capiro-backend/blob/016e79b585c14f20d13669e13c987c01e3dd29dd/docs/engagement-manual-plans-20261015/WIRE.md) is unchanged, SHA256 `64181558d22ccd71bf1b09f5644a2431e591567cd2b77913f9a6471b7004e8e2`.

Every addition is under this documentation directory in the separate branch `proposal/engagement-plan-preview-20261016`, based on `016e79b585c14f20d13669e13c987c01e3dd29dd`. The files are executable proposal examples and offline checks; no production module imports them. No admission map, generated artifact, header emitter, environment flag, target configuration or application entry point is edited. No Meri, Objective schema or shared-contract implementation is included.

## Exact routing boundary

The [candidate module](routing/plan-preview-candidate.mjs) requires a server-owned fixed operation key, its exact uppercase method, and the canonical Core `/api` pathname before separately validated query serialization. It returns routing eligibility only. It does not parse a complete URL, authenticate an origin, decode raw input, select a backend, forward a request or authorize an actor/client. Existing closed schemas, UUID validation and lowercase normalization remain required.

| Fixed operation | Method | Canonical Core pathname | Success |
| --- | --- | --- | --- |
| `engagement.plans.list` | GET | `/api/engagement/plans` | 200 |
| `engagement.plans.detail` | GET | `/api/engagement/plans/:planId` | 200 |
| `engagement.plans.create` | POST | `/api/engagement/plans` | 201 |
| `engagement.plans.update` | PATCH | `/api/engagement/plans/:planId` | 200 |
| `engagement.plans.wave.create` | POST | `/api/engagement/plans/:planId/waves` | 201 |
| `engagement.plans.wave.update` | PATCH | `/api/engagement/plans/:planId/waves/:waveId` | 200 |
| `engagement.plans.wave.reorder` | POST | `/api/engagement/plans/:planId/waves/reorder` | 201 |
| `engagement.plans.review` | POST | `/api/engagement/plans/:planId/reviews` | 201 |
| `engagement.plans.history` | GET | `/api/engagement/plans/:planId/history` | 200 |

The [routing tests](routing/plan-preview-candidate.spec.mjs) compare the real preserved route manifest and reject cross-operation selection, other methods, unsupported sibling operations, broad/nested paths, literal `reorder` as a wave ID, `recommendations` as a plan ID, trailing slashes, raw encoding, dot segments, query/fragment injection and coercible non-string inputs. These are pure matcher tests, not HTTP status or framework dispatch tests.

The seven broader legacy regex strings are retained as evidence in the module and [coordination note](FRONTEND-COORDINATION.md). A generic wave pattern matches the reserved `reorder` path; a generic plan pattern matches `recommendations`. They cannot enforce exact methods or valid IDs. The unchanged legacy `engagementPreviewHeader(url, baseUrl)` helper receives only a URL/base URL from [api-client.ts](https://github.com/neo-capiro/capiro-backend/blob/016e79b585c14f20d13669e13c987c01e3dd29dd/apps/web/src/lib/api-client.ts#L153). Adding seven strings to its map would not establish the contract above. A future owner must decide and review a method-aware fixed-operation call-site interface before any active edit.

The new frontend uses a separate browser RPC `/api/capiro/<exactOperationKey>`, registered descriptors with Core paths excluding `/api`, and server-owned Core base selection. This Core matcher is not a browser RPC admission map. Its existing read-only preview admits only the original three GET contracts (`me`, `clients`, `client by ID`); all nine Plan operations remain **503 `PREVIEW_BACKEND_HELD`**. That three-read source/target binding does not prove that a dedicated preview backend implements manual-plan CRUD. No such binding is proposed here.

## Preserved authorization and preflight

The [authorization audit](authorization/README.md) pins 27 actual baseline sources and checks that additions remain inside this proposal directory. It traces Clerk verification, tenant/membership context, class roles, current actor recheck after lock waits, current client wall grants, aggregate/list/history scope, and actor-scoped replay receipts. The 45 offline checks include 40 in-memory source-removal mutations. They detect source drift; they do not execute authorization or prove current HTTP/Clerk/database behavior. A route match grants no permission.

The [preflight proposal](preflight/README.md) includes a future catalog-only observation inside `BEGIN ... READ ONLY`, transaction-local `search_path = pg_catalog, pg_temp`, one parameter-bound SELECT and ROLLBACK. A future separately authorized collector must execute those four statements in sequence on one connection, establishing the path before SELECT parsing/preparation. There is no connection runner, endpoint or credential input here. No SQL has been parsed or executed by PostgreSQL.

The pure assessor checks PostgreSQL16 role membership, SET/INHERIT/ADMIN paths, current ownership, RLS flags, effective/grantable table and column privileges, and exact four-table coverage. Unsafe privilege profiles are rejected; incomplete or unsupported observations remain UNKNOWN. A PASS is only a necessary point-in-time four-table role/ACL prerequisite. It cannot activate a route, attest snapshot provenance or establish tenant visibility, application authorization, complete database/provider security or deployed migration state.

## Coordination and remaining adoption blockers

Frontend owner `01a13c71-7ff1-7660-a7c8-de25cc94401c` owns the fixed operation descriptors/schemas and registry composition in a separate candidate. It explicitly reports no preview-map/admission claim, confirmed the exact nine tuples and lowercase input/receiving UUIDs, and reports metadata rebound to `016e79b5` with unchanged WIRE. Shipping `01a1383e-0c6b-778e-8893-2359c0da802e` reports no claim on the backend legacy generator or map/consumer and no known conflicting writer. These coordination receipts permit this inactive proposal to proceed; they do not allocate or authorize activation.

Before any future active source or qualification work, the coordinator must resolve these concrete items:

1. Allocate the legacy caller/map and any new-frontend server-preview changes, with the exact method/operation interface and dedicated backend source/target binding. Present source does not supply those active bindings, and all nine Plan operations stay held503.
2. Independently qualify the preflight SQL with PostgreSQL16 when a native slot is allocated. The 22 SQL checks here are lexical. No native parser or execution receipt exists for this new query.
3. Separately authorize and identify any target read, bind its endpoint/database identity, preserve an unedited catalog snapshot and assess current role/ACL posture. No product target was contacted or is pending here. Repeat after relevant migration/grant/owner changes and before any separately approved activation.
4. Run the allocated integration/auth/HTTP/browser checks against the exact chosen runtime source/configuration. Offline matcher, synthetic ACL and source-preservation checks provide no live success or inherited qualification carryover.

The existing implementation's [qualification limitations](https://github.com/neo-capiro/capiro-backend/blob/016e79b585c14f20d13669e13c987c01e3dd29dd/docs/engagement-manual-plans-20261015/QUALIFICATION.json) remain separate: broad aggregate semantic checking exhausted the available heap, and inherited Krisp/Newsletter/generator checks have recorded failures. The seven manual-plan patterns are new integration work, even though other generator debt predates them. This proposal repairs none of those gates and does not declare the whole Engagement feature complete.

Offline results and exact file hashes are in [QUALIFICATION.json](QUALIFICATION.json). No cloud/provider/paid action, credential change, shared database migration, merge, deployment, mobile work or activation occurred.
