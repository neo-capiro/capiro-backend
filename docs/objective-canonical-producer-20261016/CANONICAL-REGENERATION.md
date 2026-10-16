# Private canonical regeneration reconciliation

This module is a pure preparation kernel. It does not authenticate a workload,
load or validate an immutable application receipt, allocate output IDs, open a
transaction, write Planner rows, or establish a committed result. Its
`receiptVersion: 3, phase: "planned"` output is a proposed owner receipt payload;
it must not be returned as an application ACK before the real owner has applied
the plan and checked actual returned IDs and versions in the same transaction.

## Allocated first scope

`planCanonicalRegeneration` supports an advancing Objective revision and
canonical binding version. Tenant, client, Objective, canonical plan, epoch,
Strategy and project identities remain unchanged. Deliberate regeneration of
the same Objective revision remains a separate operation-identity/head-policy
decision; the kernel refuses it. Existing v2 receipt interpretation, public
manual materialization, public error/issue dictionaries and public schemas are
unchanged by these new files.

The receiving owner must reconstruct the paired previous application ACK and
owner receipt from the stored canonical head. It must verify both hashes and
all source identities before supplying their references and baselines. A
project row by itself, a model result or a caller-selected task mapping is not
that evidence. An existing row without paired creation evidence is a collision.

## Inputs and identity

The pure input contains the full current and previous canonical tokens, the
server-derived next owner receipt ID, the paired prior receipt references,
last machine-applied source baselines, cumulative node/task mappings, currently
locked Planner rows, proposed saved-source fields, the complete saved-source
graph, and the complete current tenant task ID/dependency graph. The latter is
not a permission-filtered page. Authorization and visibility must be resolved
by the existing owners; a boolean posted by a caller cannot stand in for them.

For an existing source node, the historical task ID always wins and
`newTaskId` must be null. New source nodes require an explicit server-resolved
new task ID not present in the cumulative mapping or current tenant graph.
The owner should use the existing common ID resolver for this allocation and
the resulting complete map for row creation, immutable results and checking.
Matching by title, array position or similar prose is prohibited.

The cumulative task index includes inactive/removed source nodes. Removing a
node does not delete, archive, reassign or change its task. Readding the exact
source-node ID reuses its prior task ID; an unavailable or archived mapped task
causes refusal rather than a clone or automatic restoration. Routine upstream
Strategy regeneration must therefore preserve actual node IDs for retained
work. Replacing every node with a fresh UUID is not task identity preservation.

## Three-way rules

For each source-owned field, compare the observed Planner value with the last
machine-applied baseline. If they are equal, use the new saved-source value and
advance the baseline. If they differ, preserve the observed value and retain
the prior machine baseline. A model proposal converging to the human value
does not silently reset that baseline. If a person later restores the exact
machine baseline, the ordinary equality rule applies again; no new generic
human ownership or approval lifecycle is introduced here.

Source-owned fields are project name/description, task name/description, the
task subtype/start/due date cluster, and the entire dependency array. Human
time or recurrence data protects the whole source date/subtype cluster even
when its old dates still equal the baseline. Task execution status, approval,
assignee, parent, recurrence, times, time zone, memberships and positions,
custom values, tags and other manual fields are copied unchanged. Existing
tasks are never automatically re-added to the default project after a person
removes or regroups them. New tasks receive the existing normal creation
defaults and default-group membership from the real owner, not from this pure
module.

Field witnesses contain baseline, proposal, observed and applied hashes plus
the resolution. Current raw human field values are not duplicated in those
witnesses. Output row data is a separate private proposed write input and must
not be copied wholesale into an external ACK or public issue. The next task
index retains the source-owned baseline values needed for future comparisons.

## Dependencies and truthful accounting

The full saved-source graph is validated, including context and archived
source edges. The complete resulting Planner task graph is then checked after
human-field preservation, task-ID reuse and new-task additions. Missing
references or cycles refuse the whole proposed application before any writes.
No edge is silently discarded, changed into an approval or rewritten to break
a cycle. A source edge has an explicit `applied` witness. If a retained human
dependency field leaves a proposed task edge unapplied, the actual owner refuses
the whole application with 422 before writes. Context and archived source edges
remain explicit and have `applied: false`; no new edge disposition is invented.

Counts separately identify created, updated, reused and retained tasks. The
existing canonical project is not counted as newly created. `createdVersion`
means the original row creation version; `beforeVersion` and `appliedVersion`
describe this application. Unchanged rows are not written or version-bumped.
The real receiving/ACK owner validates against these application witnesses
rather than requiring every current version to equal one. The ACK keeps its
closed schemaVersion-1 shape and original creation versions. Only the private
canonical result admits the two agreed reconciliation issues; public manual
result and decoder semantics remain unchanged.

## Actual owner source integration

The passed-transaction canonical owner now accepts an optional checked paired
predecessor. With a predecessor it locks the actual canonical project and
historically mapped tasks, requires current editor access/client identity,
prepares and validates every update before the first write, and applies
project/task version CAS mutations through the existing owner helpers. New
nodes use the common deterministic ID resolver; reused nodes use the cumulative
index. Execution state is explicitly preserved and recurring-successor creation
is disabled for these writes. The three private generation-kind deny entries
and the public/manual materializer remain intact.

An unapplied proposed task dependency is an agreed 422 refusal before writes;
it is not exported as a new edge disposition. Only canonical v3 results admit
`HUMAN_EDITS_PRESERVED` and `PRIOR_WORK_RETAINED`, with the agreed safe messages.
The public/manual issue union is unchanged. Counts report zero newly created
projects and only genuinely new task rows.

The stored v3 witness excludes current project/task row data and the complete
tenant graph. Its checker reconstructs source/result IDs, original creation
versions, application version algebra, source groups, counts, issues, edges,
cumulative index and next machine baselines against the checked predecessor.
Observed human-value hashes, membership observation and the complete merged
graph hash are transaction witnesses. Their truth comes from actual locked
owner reads and the pure merge's complete-graph validation at application;
hashes alone cannot independently recover or prove those private values. The
root receiving owner must also establish the actual prior application-ACK
pairing; an owner-receipt hash is not a replacement for that ACK.

Historical v3 lookup follows the private owner receipt/hash chain with cycle
refusal and the historical receipt owner's ID namespace. It does not require
an old Objective revision to remain current. The receiving owner remains
responsible for independent current read authority and output redaction.

## Receiving and qualification gates

The real owner must retain its Planner gate and established job/Strategy/saved
version/Core authority lock order, lock existing project/task rows, verify
current editor access and client identity, and evaluate this plan against one
consistent locked state. Before writes and again before receipt/head release,
it must perform the existing fresh canonical/consent/claim/DB-clock fences.
Apply all validated patches through the existing owner persistence helpers in
that same transaction. Do not call public methods that open a nested
transaction or run rules. Preserve task status exactly so updating source
fields cannot trigger completion or recurring-successor transitions.

Any failed row/version check or receipt/head write must roll back the complete
application. Verify every actual returned row version against this plan before
creating the owner receipt and immutable application ACK. Keep previous
receipts append-only. Live workload verification remains independently
disabled until its actual trust binding is approved.

The accompanying focused Node tests are source fixtures only and were authored
without execution. They do not establish semantic TypeScript, Nest DI,
PostgreSQL locking/RLS/ACL, browser, provider, live trust or runtime acceptance.
