# Allocated implementation checkpoint

Coordinator01a0ff18 explicitly approved proposal42d8142092aa49740526667fd1a58c86ec6c1e61:
POST/GET `/strategy-api/planner/strategy-materializations`, private kind
`strategy_materialization_receipt` in existing JSON storage, existing
planner.controller.ts/planner.service.ts, new strategy-materialization.ts and
its service/HTTP tests, and necessary legacy coverage in planner.spec.ts.
No migration/schema/index/shared-package/lockfile/Meri protocol change.
Frontend owner independently owns receiving; this checkout changes no frontend.
This allocation supersedes the proposal's initial unallocated status; reviewed
CONTRACT.json remains unchanged. Source-only checkpoint, not runtime acceptance.

One tenant Planner write transaction acquires the canonical advisory lock, then
job FOR SHARE, Strategy FOR SHARE, named version FOR SHARE, and shared Core
authority locks. The exact completed actor-owned generation receipt, named
immutable Meri version and current Objective revision/client authority gate all
new writes and replays. Current node archive state is read under the Strategy
parent lock used by canonical writers. There are no model/network/link-service
calls under these locks. The existing15s transaction bound is preserved; lock
contention/timeouts surface as503 with same-request recovery, never no-write proof.

All saved nodes and edges are classified/validated before writes, including
cycles involving archived/context nodes. Server UUIDs bind canonical project
defaults and prevalidated task data/dependencies. A private project row/event
helper is shared with the old public create path; existing persistTask owns
derived deadlines and task events. No rules, invitations, assignments, recurrence,
inbox recipients, approval subtype, meeting or provider action is created.
Project health remains canonical on_track, privacy private, view list: this is
existing project behavior, not an invented draft/activation field.

Projects, tasks, audit and private deterministic actor-scoped receipt commit in
the same transaction. Receipt retains the exact source snapshot/digest, input
fingerprint, original grouping, output creation identities and all edge/context/
exclusion classifications. Same-request replay reauthorizes the source and reads
current output ACL/client/archive/version/memberships without rewriting content.
Ordinary human regrouping preserves original IDs and original membership lineage.
Unavailable IDs are redacted; partial output is never complete plan success.

Reviewed successor: strict string-only kind/subject/status validation rejects
array/object coercions before writes. Recovery rebuilds the entire immutable
creation projection against the locked saved snapshot and original archive
witness, including every node/group/edge/count and private deterministic
actor/request/group/node output UUID. It compares all fields before projecting
current outputs; malformed receipts fail503. Human output edits remain separate.
This changes only private receipt JSON and server identity allocation; the
reviewed public contract is unchanged.

Current evidence:49 focused service fixtures passed;9 new HTTP tests passed with
local loopback permission;35 legacy Planner service tests passed. Six actual
service projections matched the reviewed strict JSON schema and semantic checks. Synthetic rollback
models and loopback HTTP are not PostgreSQL concurrency/RLS/grants qualification.
Full Strategy semantic typecheck passed before the review fixes and is repeated after final edits; full Core and
native qualification remain separate unproven gates. The old planner.http.spec.ts and strategy/objective-destination.controller.spec.ts
test modules needs a narrow guard dependency setup update because the newly
allocated methods use StrategyPlannerGuard; coordinator allocation for that extra
test file was requested before editing it. No production module change is needed.

Independent exact-diff acceptance, final source pin and bounded final test report
are pending at this checkpoint. Accepted Objective1bc48 source/workload remains
unchanged and independently queued for native qualification by the sole AWS owner.
