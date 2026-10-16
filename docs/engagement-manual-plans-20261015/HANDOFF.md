# Manual Engagement plan/wave candidate

This isolated backend increment implements the accepted bounded manual contract from [f41be177](https://github.com/neo-capiro/capiro-backend/blob/f41be1774131d5a51ed5eaaafdcdade4f50781e3/docs/proposed-engagement-contract-20261015/contract-proposal/PROPOSAL.md). It is a source candidate, not a deployed feature. Frozen shipping source `cd3c51e940f14e1b2a1040b0ffa445e85d68b332`, PR53, PR54, PR55, the separately sealed frontend shipment and Fable's Meri work remain unchanged.

[WIRE.md](WIRE.md) contains all nine routes, closed request/response shapes, error semantics, bounds and exact implementation-file hashes. [REVIEW.md](REVIEW.md) records application source review; [TRUNCATE-REVIEW.md](TRUNCATE-REVIEW.md) records the independent ACL successor review; [QUALIFICATION.json](QUALIFICATION.json) records the final observed checks and limits. [PREVIEW-PATTERNS.md](PREVIEW-PATTERNS.md) gives the seven new path patterns and the separate frontend integration ownership.

## Behavior and ownership

- A plan has one immutable client. A client can have multiple plans and multiple active plans. Child waves use the parent aggregate version; there is no independent wave version or execution-state enum.
- Explicit draft/active/archive/restore commands retain history. Every actual aggregate change increments once; authorization and expected version are checked before an ordinary no-op. Stale child writes and stale no-ops conflict.
- Plan/wave creation reconciles the actor/client/command/requestId and normalized payload hash. Original receipt/version is separate from the current aggregate. Current access precedes receipt lookup. Other uncertain mutations are re-read without automatic replay.
- Manual review records a future reviewer-supplied deadline and a V+1 receipt. `current` means the explicitly reviewed aggregate version, not externally verified business freshness. Activation and every subsequent aggregate change invalidate that basis; expiry never changes lifecycle.
- Existing current tenant/membership/Clerk identity, standard-user floor and exact unwalled-or-current-client-grant access remain. There is no account-assignment model, creator/admin bypass or new permission vocabulary. Read/list/history transactions retain current authorization through their return.
- Office references retain existing targetId and officeKey snapshots. Reads revalidate scope and identity; archive/rekey/rescope/merge produces unavailable references without following names or exposing the new scope. Wave references must be a subset of the plan. This increment does not create an office picker or modify target writer semantics.
- List pages explicitly distinguish incomplete pagination from complete authorized summaries. Global summary coverage is returned clients; it does not enumerate clients with zero plans. Selected-client zero counts require a successful authorized read. Failed reads never become No plan.

There is no provider, job, send, booking, availability, ranking, default-age formula or Meri implementation. Frontend binding belongs to its separately allocated feature; generic 409/reload remains supported without changing gateway-errors/http or shared DTO owners.

## Coordinated source changes

The Objective owner reviewed the exact four-model Prisma hunk before shared schema editing. Only Tenant/Client `engagementPlans[]` backrefs are added to existing models; no Objective/User backrefs or Objective operational tables are changed. The public exact Objective revision authority is reused unchanged. Merge these schema additions fieldwise with the Objective hunk, never replace the whole schema.

Reserved source migration: `20281015040000_engagement_plans`, distinct from the Objective owner's `20281015030000_client_objective_operational_links`. The frozen migration inventory's latest entry was `20281012060000_federal_register_effective_evidence`; no 40000 collision existed there. Coordination also checked the independently allocated 30000 reservation. Four new tables have scoped keys, immutable identities, retained receipts/revisions and structural constraints. The candidate limits direct app privileges on these new tables; complete review metadata is constrained. No existing role, credential, tenant grant or security configuration is changed.

The coordinator allocated this exact additive fence hunk in report-targets.ts:

```ts
// Plan bindings share the existing owner fence; existing writers keep their order.
export { lockTargets as lockEngagementReportTargets };
```

The private function body and all existing callers are unchanged. Plan transactions take that same target fence, then client, current actor/grant, then aggregate. There is no replacement mutex or reordering of existing target writers. Module registration and controller discovery add only the plan controller/service. The primary manifest has 144 routes: nine additive plan routes and the same 135 current baseline-generated routes.

Canonical generation also reconciles inherited shipping-artifact metadata drift: 112 source-line fields and the existing attachments handler's prospectId parameter. The seven old controllers are byte-identical to the frozen source. No existing method/path/controller/handler or route permission is broadened. The preview artifact is unchanged; its existing failing gate is not bypassed.

## Qualification and practical limits

Qualification uses exact frozen dependencies installed into an isolated task runtime, Node 24.19.0, real Jest and a fresh PostgreSQL 16.14 cluster listening only on 127.0.0.1:60009. Native service tests use actual PrismaService, the frozen generated client, raw stores, canonical access helpers and existing target writers. They apply only this candidate SQL to guarded disposable fixture databases, not the full migration history or a live/shared database. Schema validation is read-only. This is not deployed-role, live JWT, full AppModule/provider, production-schema or migration-chain qualification.

Retained attempts include pre-test sandbox cache EPERM, an absent reserved database guard, sequential compiler diagnostics and full/transitive semantic compiler OOM failures. Final changed-source semantic checking uses actual source and dependency types and reports its exact target set; it does not claim imported baseline body or full-backend semantic acceptance. Jest transpilation and source semantic checks are separate evidence.

Five Krisp preview-route failures and two Newsletter controller omissions are inherited at the frozen source and remain explicit. The preview CLI stops on Krisp before artifact comparison; independent derivation confirms the frozen preview artifact already drifted. This feature additionally introduces seven plan path patterns absent from the preview map; those are separate feature integration work requiring the frontend owner's coordination. No permission/exclusion change or generated-preview repair hides either category.

The initial PR27 checkpoint `9a151f4` missed TRUNCATE in the documented `arwdDxt` default table ACL. Its 79-check fixture seeded only CRUD, so that historical result did not qualify TRUNCATE protection. The successor retains the failing regression and repairs only these four new tables. Ordinary row-level security and UPDATE/DELETE history triggers do not protect against TRUNCATE.

The identical final regression executable reports 15 expected failures before repair and 28/28 passing checks after repair. All ten app-role TRUNCATE forms then deny with SQLSTATE 42501. The successor structural fixture passes 79/79 checks after full default grants, and the combined focused run passes 158/158, including all 18 native service cases on the repaired SQL. Ten strict source/test targets have zero diagnostics; the fresh bounded offline rerun passes 25/25. Evidence, the failed old-sentinel attempt and safe fresh-database preparation are retained in the qualification receipt.

Table ACL qualification requires the documented hardened role posture: the migration owner owns the tables; the app neither owns them nor reaches owner or TRUNCATE-bearing roles through inheritance or SET ROLE. The frozen runbook's reverse grant (app to master) gives the app no master privileges. A direct app revoke cannot cure unsafe owner membership, another privileged parent role or PUBLIC grants. Native negative controls demonstrate those unsupported postures; they are not passing production-role evidence. No deployed posture was inspected. A future authorized target preflight must check effective privileges, ownership, inherited roles and SET-able roles before adoption; this source increment changes none of those broad roles. Run that preflight after any blanket grants: replaying the frozen runbook's `GRANT ALL ON ALL TABLES` would restore the privileges this migration revokes. PostgreSQL ACL revocation is not a permanent deny rule.

Automatic approval review denied dependency-junction setup. No junction was created or retried; the completed alternative uses environment module lookup and a runtime-owned compiler resolver. Initial Prisma engine setup touched an existing engine cache before its cache location was corrected; subsequent engine work stayed task-local. Neither changed credentials, schemas, production configuration or running application state.

All runtime logs, failed attempts, dependency receipts, denial and engine-cache records remain in task-root implementation-runtime. The committed qualification summary hashes its supporting evidence. The historical CRUD-only fixture is preserved in [evidence/migration-constraints.executed.cjs](evidence/migration-constraints.executed.cjs). The [successor structural fixture](evidence/migration-constraints-after-truncate.executed.cjs) and [matched TRUNCATE fixture](evidence/migration-truncate-regression.executed.cjs) record the repaired-source proof. These executed snapshots contain task-local paths and database guards rather than portable test entry points. The owned native cluster stopped cleanly after qualification; its data and logs remain retained. No AWS/provider/paid action, live migration, merge or deployment occurred.
