# MF09 current-owner dependencies and minimal placement proposal

Inspection bases: Core `58f8639a305fe80d5d47bfb900835b3536f765a8` (ordinary merge of backend-import `0f067ed82acfa44b73dd4fc4c0ac21e5c731fe1d`), Meri main `405c9705542cd8475af4a56fe2208172dc9a1ed6`. This is a proposal and negative inventory, not an implemented composition. R's Step2 direct-model draft preserves public submit/stream DTOs; its new run-owner work is not a management receiver.

## Existing owners

| Behavior | Current source owner | Missing connection |
|---|---|---|
| Fresh identity, title search, metadata and command receipt | Core `apps/api/src/meri/meri.controller.ts`, `meri.service.ts`, `conversation-management/{list,service,contract}.ts` | Optional `MERI_CONVERSATION_MANAGEMENT_PORT` has no ordinary Nest provider. List reports unavailable; change refuses503. |
| Current run and first/next input serialization | Meri `apps/control/conversations/postgres-store.mjs`, `lifecycle/journal.mjs`, `next-run-journal.mjs`, `service.mjs` | No current-main management operation holds the same lock while Core commits metadata. An unfenced run read is insufficient. |
| Suppression, serving exclusion, authoritative ledger and recovery | Meri `apps/control/retention/{suppression,postgres-journal,startup,reconciliation}.mjs` | Runtime startup lacks managed-chat ownership/suppression composition; no public management receiver is assumed. |
| Thirty-day scheduled facts | Core `conversation-management/retention.ts` | Existing trusted purger must consume the content-free immutable binding/status/revision/deadline. No public route; interactive membership/client-wall checks intentionally remain in the separate metadata reader. |
| Permanent row/object deletion | Meri `apps/control/retention/{data-classes,inventory,inventory-source,purge,postgres-journal,reconciliation}.mjs` | Whole-conversation row deletion is incomplete, including Meri rows and Core metadata. Existing purger only; no second scheduler or claim table. |

## Exact serialization dependencies

Meri `postgres-store.mjs:tx` uses `pg_advisory_xact_lock(hashtextextended($1,0))` with `${tenantId}:${conversationId}`. It is shared by current input acceptance and run mutation. Its existing `beforeConversation` path first takes the shared `meri_retention_transition:${tenantId}:conversation:${conversationId}` lock. Initial/next admission then checks and locks the actual conversation/run rows. Terminal state must come from this canonical owner under the same serialization, never browser state or an earlier HTTP read.

Retention `postgres-journal.mjs:withTransition` takes the exclusive session advisory lock `meri_retention_transition:${subjectKey}` across its ledger append and projection. Current suppression/release each acquire it themselves. Serving takes the corresponding shared lock; recovery has its own shared/exclusive barrier. A management implementation must preserve **retention transition → Meri conversation → Core conversation row** order, avoid reacquiring a held session lock on another pooled connection, and preserve commit/unlock uncertainty. The historical callback-wrapper chain is not a deployment solution.

Core `manageConversation` owns its tenant transaction and `clio_conversations ... FOR UPDATE`, then fresh membership, immutable owner/binding, current client wall, request-digest replay and metadata revision. Trash calls canonical suppression before metadata commit; uncertainty stays suppressed. Restore commits an exact request receipt before release, and an old retry cannot release a later Trash. Archive retains history and must prevent new admission while archived. Rename may use the same serialization without requiring terminal state. These product semantics remain binding while placement is resolved.

## Permanent-deletion limits on current main

The canonical inventory enumerates conversation, runs, events, lifecycle, completion, successors and selected output data. However `postgres-journal.mjs:rowWhere/rowTarget/preflightRows` only supports `sdkSession`, `artifactVersions`, and the separately gated `memory_proposal_contexts` target. Other row classes fail `RETENTION_ROW_CLASS_UNSUPPORTED` before effects. Core `clio_conversations` is not in that inventory or deletion routing. A final Core delete alone would not complete the feature.

Migration `apps/control/conversations/migrations/0010_retention.sql` ties `retention_subjects` to an existing `meri_conversations.conversations` row. A newly bootstrapped Core chat without a Meri run cannot use that subject as-is. Do not manufacture a Meri conversation/run to bypass this constraint. The proper empty-chat identity and its canonical deletion behavior need an explicit schema decision, with historical applied migrations unchanged.

The existing purger already owns policy, legal holds, object retention, liabilities, shared references, suppression generation, exact inventory/target planning, per-effect revalidation and unknown-result readback. Scheduled deletion must not require the departed owner's interactive membership or client visibility. A changed immutable binding, restored status, revision/deadline, policy, hold or generation must still stop deletion. Restore is permitted only before the canonical thirty-day deadline; a blocked purge must not extend that window.

## Proposed bounded implementation sequence

1. Root/R choose the actual deployment placement that can execute the existing run/retention locks and Core metadata transaction together. Keep Core as metadata writer and use one canonical run/suppression owner. Do not add a remote callback fence, duplicate SQL terminal predicate, Prisma wrapper package or new public authority DTO to pretend this is connected.
2. Implement that concrete command composition and current admission status check in their existing owners. Preserve503 until the real connection exists. Qualify terminal versus active races, rename, owner/wall revocation, archive versus next input, exact retry and unknown commit/release before enabling it.
3. Extend the existing retention inventory and row-purge owner for the actual retained rows and Core deletion, using its existing ledger and recovery. Specify exact FK/trigger order and empty-chat identity before allocating a migration. Core's existing deletion-only, content-stripping bootstrap/management receipt tombstones must remain valid.
4. Root rehearses actual schema and lock contention with synthetic PostgreSQL. Required failures include active-run races, expiry boundary, restore versus purge, changed suppression generation, departed owner with unchanged retention policy, legal hold, missing target/unknown delete readback, direct forged tombstones and duplicate request replay. No browser test or fake port substitutes for this qualification.

No retention source, schema, migration, runtime flag, new table or deletion effect is changed by this proposal. Public metadata authorization remains unchanged.
