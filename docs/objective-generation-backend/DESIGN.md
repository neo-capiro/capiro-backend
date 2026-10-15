# Objective generation application transaction design

Initial source: `1ce6c358f0e6ba73dcd1a2b3f95bc69952280ed9`, tree
`e7c519363a6809c5255cf1872ce1f0fdd1d18843`. Dedicated checkout:
`task-6/backend`, branch `feat/objective-bound-strategy`.

The coordinator explicitly allocated narrow edits to the existing Strategy
application writer in `meri.service.ts`. New Meri runtime, generator, provider,
orchestration, Planner, diagnostic, schema, migration and lockfile work is excluded.

## Writer seam

Optional `DraftJobRuntime.persistence` has an awaited external-only
`beforeTransaction()` observation, followed by awaited `beforeWrite(tx)` and
`afterWrite(tx, {strategyId, strategyVersionId})` hooks. Both execute inside the
existing `withTenantUser` transaction. `cutVersion` supplies the exact version ID.
No context compilation, external source observation, generation or provider call
is enclosed by that transaction. Hooks absent preserves the generic draft path.

The before hook locks the tenant/job row FOR UPDATE; validates submitting actor,
source/admission, unique per-claim token, attempt, running status, empty result and
deadline; then reuses current Objective authority and immutable revision checks.
Deadline uses PostgreSQL `clock_timestamp()` after locks, not transaction-start
`NOW()`. The after hook writes receipt and completed status in one checked update.
An affected count other than one throws. Later writer failures roll back receipt,
Strategy, nodes, version and conversations together. `savedAt` is an in-transaction
recorded save time, not a claim about the exact database commit timestamp.

All Objective progress/failure writes fence token AND attempt. A stale claim
cannot publish. Objective jobs skip the worker's separate completion transaction.
A committed receipt wins over an ambiguous returned transaction error; unresolved
durable reads assert no result and never reset a terminal job or blindly regenerate.

## Source-set gate for review

Row locks do not prevent new targets/facilities/notes entering a source set. The
minimum schema-free candidate uses short table SHARE locks over the fixed local
source relations, ordered consistently, with a 1s local lock timeout, inside final
publication only. It re-reads the complete scoped collections and compares their
digests. Existing writers' ROW EXCLUSIVE relation locks conflict even for inserts,
moves and deletes. This has cross-tenant write contention implications; failures
refuse publication rather than weaken coverage. No locks span model calls.

The exact locked relation order is `client_facilities`,
`client_target_recommendations`, `client_targets`, `directory_contact_notes`,
`engagement_connections`, `state_legislator`. The authority helper then locks
tenant/member/user/client/wall/Objective rows, using its existing order. Core
compilation/prechecks take no table SHARE locks. No additional writers are edited.
Grant evidence is the existing `20260502020000_capiro_app_role` migration's DML
and default DML grants, plus explicit directory-note/target/recommendation grants.
Actual database role membership/privilege state is not asserted from source alone.

External Directory and governed history remain observed snapshots. A fresh
post-generation observation through the existing authorized resolver must match
their source digests; it compiles no new packet and substitutes no model input.
The final collection gate also holds mailbox connection authority stable.
**It does not hold mail/outreach/meeting/knowledge/current-plan history contents
stable after that observation.** No atomic snapshot across services or all-history
commit freshness is claimed. This exact narrower history guarantee requires
coordinator contract review before route admission/desktop receiving. The
coordinator explicitly approved this as-of history boundary during this task;
the frontend receiving owner acknowledged it. This is not database/runtime
qualification or frontend integration acceptance.
Authorized history stays within existing governed retrieval permissions.
No raw context is copied to the public receipt or new durable corpus.

## Receipt receiving semantics

The public proposal request is unchanged. The additive receipt field
`context.reobservedAt: string | null` is null until successful publication and
records the post-generation observation timestamp. The frontend receiving owner
acknowledged this additive contract. Context `complete`
means required authorized fields/pages fit the approved packet policy at
compilation, with no optional-exclusion policy invented. It does not mean every
historical source stayed unchanged until the save. Public `context.compiledAt`
identifies the compiled context as-of boundary; `reobservedAt` identifies the later
source recheck; `result.savedAt` is the recorded
save time. Receivers must not label either as proof of all-history commit freshness.
Internal job metadata separately records `historyObservedAt`, `historyCheckedAt`,
the source/history/coverage digests and the non-content coverage manifest. These
internal fields are not a new public wire promise. A result identifies exactly
the committed version, including when the Strategy later has a different head.

The completion update itself checks `clock_timestamp()` again and requires the
persisted receipt result still be JSON null. A zero-row update throws inside the
writer transaction. The receipt is application-enforced append-once; no new
database trigger or migration is introduced.

## Owned files and regression plan

Strategy application: `meri.service.ts`, `draft-job.types.ts`,
`draft-job.service.ts`, `draft-job-worker.service.ts`, `meri.controller.ts`,
`dto/meri.dto.ts`, `strategy-context-plane.client.ts`,
`governed-strategy-meri.factory.ts`, and new Objective admission/completion/types
adapters and focused fixture tests. Core: existing internal Strategy context
controller/service/module plus new scoped Objective context adapter/tests.
Shared Objective authority contract remains unchanged.

Qualify exact saved five-field admission; stale/foreign/revoked scopes; retry
identity and changed-request conflict; per-field/page/budget coverage; claim loss
and same-instance reclaim; deadline expiring during lock wait; concurrent source
insert/move/delete; rollback after receipt; lost commit response; exact version
identity; safe public projection; and legacy generic draft without hooks. Use
non-live deterministic fixtures, one process, bounded memory. Independent final
source review and separate deployment qualification are required.

The route does not activate a Strategy or create Planner work. Next Planner
materialization must consume an exact reviewed saved version and retain Objective
lineage, authority, idempotency, stale/partial outcomes and existing activation
policy. Cardinality and task caps are not established by this slice.
