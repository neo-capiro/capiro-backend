# Objective automation reconciliation

This is a design and allocation checkpoint, not an implementation or qualification claim. It reconciles the coordinator's uploaded 891-line/47,936-byte plan with the current source. The backend source owner read the complete uploaded plan; this draft uses that requirement reconciliation and independently inspected backend code. Proposed tables, migrations and operation contracts below are not frozen APIs.

## Source baseline

| Surface | Exact source | Meaning |
|---|---|---|
| Backend | `4945791dfc8e755a2abaddfa60cdcf670ee20712`, tree `779e88e505d00cfed6aaf160c74b7fc2b333ac13` | Current application baseline; both services use Node22.23.3 Bookworm after the one-line Strategy correction. Source acceptance does not qualify images or runtime. |
| Frontend | `4e1421054df0d32c564f7c9bc75cbd5e5366b428`, tree `b855b9f779ad18332dd19caefc2986310786beca` | Existing explicit finish/recovery/current-output receiving behavior. |
| Standalone Meri | `f0befe1e486cfda644f1f6170cf3d9d671e5158f`, tree `fb58adeccde7c5c7c48a5562ac3108b888a6d17e` | Owner-supplied runtime baseline, runtime HOLD. It does not establish the proposed closed three-operation workload contract. |

## Requirement, current behavior and evidence gap

Paths in this table are relative to the backend root. Anchors refer to the baseline above.

| Requirement | Already present | Remaining gap |
|---|---|---|
| Ready confirmation durably starts work | `apps/api/src/clients/objectives/objectives.service.ts:182–203` saves status and a revision in one transaction. | No work outbox. Already-ready returns at194. Browser finish is the current orchestration trigger; closing the browser can prevent later submission. |
| Exact Objective/version authority | `packages/shared/src/client-objective-destination.ts:76–99` and `apps/api-strategy/src/meri/objective-generation-admission.ts:16–61` check current authorized source and immutable saved ready fields. | Background workload delegation and ongoing authority require a separately reconciled contract. Preserve stale/version/wall checks. |
| Atomic Strategy and job outcome | `apps/api-strategy/src/meri/meri.service.ts:361–430` invokes persistence hooks inside the Strategy/version transaction; `apps/api-strategy/src/meri/objective-generation-completion.ts:41–118` fences claim/attempt/deadline and completes the exact receipt. | Preserve this implemented seam. A statement that Strategy and Objective job completion still use separate transactions is stale. Planner remains a subsequent transaction. |
| Automatic Strategy→Planner | `apps/api-strategy/src/meri/draft-job-worker.service.ts:262–307` runs the durable Objective generation job. | It stops at Strategy completion. No durable automatic Planner continuation exists. Do not substitute another browser POST. |
| One current generated Strategy/project per Objective | `apps/api-strategy/src/meri/objective-generation.types.ts:261` hashes tenant/actor/request UUID; job uniqueness is tenant/requestKey. | Request deduplication is not Objective cardinality. New UUIDs/actors can produce further jobs. `apps/api-strategy/src/meri/meri.service.ts:365` creates a fresh Strategy; no canonical Objective target exists in `SpStrategy`. |
| Durable Planner creation/recovery | `apps/api-strategy/src/planner/planner.service.ts:341–717` validates exact generation receipt/version/revision, writes canonical outputs/private receipt atomically, and reprojects current availability on replay. | New materialization UUIDs create new outputs. Receipt/output IDs are actor/request scoped (`apps/api-strategy/src/planner/strategy-materialization.ts:132,207`). No canonical Objective project identity or regeneration merge exists. |
| Preserve human edits | `apps/api-strategy/src/planner/planner.service.ts:434–492,577–587` reads current output versions/memberships and does not rewrite them during replay. | Replay preservation is not regeneration. New drafts generate new node IDs (`apps/api-strategy/src/meri/meri.service.ts:304–315`); safe updates need stable identity, ownership and conflict rules. |
| Complete dependency graph | Materializer validates full saved graph before exclusions (`apps/api-strategy/src/planner/strategy-materialization.ts:321–411`); actions/milestones become tasks, decision/gate/risk remain linked context. | Earlier writer slices60 nodes/edits, filters invalid dependency indexes and clips titles300 (`apps/api-strategy/src/meri/meri.service.ts:289,308–313,536,912,986`). Validate or explicitly repair the whole result before persistence; do not silently claim lossless coverage. Consequential approval/context dependencies must block clean review/execution. |
| Safe current navigation | Materialization GET reports available/archived/unavailable under current source/output authority. Frontend receiving/deep-link behavior already exists. | Ordinary Strategy routes still have a client-wall gap: controller TenantGuard+flag and tenant-scoped list/by-ID (`apps/api-strategy/src/strategy/strategy.controller.ts:39`; `apps/api-strategy/src/strategy/strategy.service.ts:62–128`). Repair current client admission for list/detail/version/node/report/export paths before advertising editable links. |
| Authorized government context | Existing owner inventory, saved-field binding, Directory observation, history coverage and postmodel recheck are real; see GOVERNMENT-COVERAGE.md. | Rich records fail the1600/24000 limits; generic mail/outreach projections omit meaningful content. Compact critical inventory and authorized evidence retrieval need a new reviewed context contract. |
| Autonomous enrichment/fact updates | Existing CRM fill/review owners retain their own records and statuses. | Accepted/pending/rejected facts and required extension tasks are not integrated into this workflow. `review_ready` is not factual acceptance. |

## Product invariants to reconcile first

Keep requested Objective revision separate from applied Strategy and Planner revisions. A pending revision must never relabel old outputs as newly applied. Historical attempts/receipts remain immutable. Routine regeneration retains canonical Strategy/project identity; replacement is an explicit operation with audited lineage and reviewed semantics.

One canonical generated project does not impose a global project limit. Preserve manual projects, explicit groups, multi-group work and multihoming. Distinguish that product invariant from the current per-request grouping API before any contract changes.

Preserve actual current authorization, ethical walls, nonactivation defaults, truthful partial states and immutable source/result hashes. A project being prepared or a plan being review-ready does not mean approved, activated or executed. No arbitrary task cap is introduced.

## Ownership and status

This checkpoint changes documentation only. No production, shared contract, schema, migration, lockfile, runtime, qualification or frontend file is changed by this branch. The backend source owner reviewed the draft against the pinned application sources before publication.

The coordinator's separate Core lane owns Objective service/revision work and a new helper/tests: ready revision and unique `(tenant, client, Objective, revision, purpose)` work intent in one transaction, dispatch disabled, no HTTP/model/bearer. Schema and the proposed migration `20281015010000_client_objective_work_intents/migration.sql` require exact-path approval; that path is currently unconfirmed. The name is a proposal, not permission to create or execute it.

`strategy_client_permission` owns the separately allocated shared canonical permission helper and ordinary Strategy route repair. `core_workload_authority` is design-first for current Core service identity/delegation audiences, a15-minute decision bound and24-hour absolute intent bound, all for review and without credentials. Those bounds are proposed design inputs, not an accepted wire contract.

Meri coordinator `01a13ca1` owns only the isolated `packages/contracts/strategy-operations-candidate` schemas/tests lane; Fable owns standalone runtime, and Meri0011 remains S1 only. Do not publish wire shapes from the unpublished6d54 Meri proposal. Frontend may prepare existing-behavior tests without inventing an automation API. Shipping retains native/image/composer/transport/worker-role/execution lanes.

The next deliverable is the smallest safe automatic end-to-end path in INCREMENTAL-PLAN.md. Advanced fact updates, three-way regeneration merge and analytics remain future work. No deployment, provider call, migration execution or paid qualification is implied.

## Concrete allocation and contract checkpoint

| Slice | Allocated paths/boundary | Remaining decision |
|---|---|---|
| Core ready intent | `apps/api/src/clients/objectives/objectives.service.ts`, new `objective-work-intent.ts` and focused tests in the same directory, on a dedicated successor from4945 | Schema and exact `apps/api/prisma/migrations/20281015010000_client_objective_work_intents/migration.sql` allocation still requires coordinator confirmation. No dispatch. |
| Ordinary Strategy permission | Shared canonical client-authority helper/export and its Objective-admission reuse; Strategy controller/service, nodes, versions, reports, current-plan export and focused tests | Independent review; no global TenantGuard change. Alternate assistant/agent surfaces remain separately inventoried. |
| Core workload authority | Design inventory only; current client/member/revision checks and distinct generation/Planner audiences | Named service-identity verification and durable delegation storage are unresolved. Shared-secret possession alone is insufficient. |
| Typed Meri contract | Isolated `packages/contracts/strategy-operations-candidate/` schemas/tests/distribution proposal | No public package export, runtime wiring or new workload authority for assistant/document. Typed-result storage and retention need their own allocation. |
| Public composite receipt | No new public DTO, route, schema or registry allocated by this checkpoint | Preserve current Objective response and strict generation/materialization receipts. Define requested/applied revisions, canonical IDs, authority-redacted history, pending/partial/review states and discovery before frontend contract fixtures. |

The source design accepts stable canonical Strategy/project IDs for routine regeneration, explicit replacement only, and immutable typed-result custody in Meri with backend correlation/fencing. It does not freeze the still-proposed wire fields or approve a new runtime mount. The uploaded plan was read in full in windows1-300,301-600,601-891; the read content totals891 lines and47,936UTF-8 bytes. This is a content-read receipt, not a claimed raw Library file hash.
