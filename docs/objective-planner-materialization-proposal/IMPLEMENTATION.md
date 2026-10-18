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

Final evidence:49 focused materializer service fixtures,9 materializer HTTP
cases,35 legacy Planner service cases,77 legacy Planner HTTP cases and62
unchanged destination/task-create/scope cases pass together:232/232 in8 suites.
Six actual service projections match the reviewed strict JSON schema and
semantic checks;29 proposal checks pass. Full Strategy semantic typecheck passed
at1024MiB after the application review fixes and is repeated after this test-only
setup successor. Native PostgreSQL/RLS/grants and full Core qualification remain
separate unproven gates.

Both independent reviewers accept application commit59fecb49. Coordinator
subsequently allocated only planner/planner.http.spec.ts for the exact reviewed
StrategyFlagsService mock-provider setup patch3deeaa82. It adds only the import
and provider, keeping the real method-scoped StrategyPlannerGuard and all prior
authentication, impersonation, scope, bearer and no-delegation assertions intact.
The new materialization HTTP suite retains real rollout-on/off coverage.
The unchanged Objective-destination HTTP suite already overrides this guard and
passes; no edit there was needed. No production application blob changed after
59fecb49. This documentation/test setup successor closes the prior77-case Nest
DI fixture gate; independent exact successor review follows.

Accepted Objective1bc48 source/workload remains unchanged. Its separately
reviewed native transport request is handed to the sole AWS owner; it does not
qualify this Planner successor. No publication, deployment, live data write,
provider call, migration execution or paid build was performed by this slice.
