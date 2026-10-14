# Selected Objective Files and Calendar receiving contract

Neo approved the existing eligible saved Workspace revisions and Planner occurrences on 2026-10-14. This supersedes the pending choice in PR15's historical handoff. The scope is reversible Objective navigation; general Portfolio attachments, Meetings and authoritative rule effective-date coverage keep their existing owners and behavior.

Base/source for every canonical owner check is draft PR15 `65c4918042df0930d4ff46abd6994fbdd27538c5` / tree `dca652322832da9f77334192fdb9a70421b19bc6`. No production owner, schema, migration, provider, auth, membership, shared task or protected Engagement path changes. This draft adds an exercised receiving reference and one runnable consolidated qualification packet, not a new API/service/store or another auth layer. `receiver.mjs` is a reference exercised by this packet; frontend composition is its own receiving change, not claimed implemented or deployed here.

## Exact existing reads frontend can connect

Use the normal existing authenticated frontend API client and Workspace/Strategy origins unchanged. Every open, reload, retry, history navigation and session/client replacement must resolve the selected owner again. Observations and hashes are not capabilities. Do not fall back to an unbound read after failure. The caller's ordinary request admission discards responses and errors from superseded selections; it does not authorize a tenant or resource.

| Selected source | Existing transport and receipt |
| --- | --- |
| Files: eligible saved Workspace revision | `GET /workspace-api/drafts/:draftId/versions/:versionId/objective-destination?clientId=<UUID>&objectiveId=<UUID>&objectiveVersion=<positive int32>`. Existing frontend client owner `workspace`, relative path `drafts/...`. Both path UUIDs are required. Response includes `draftId`, `versionId`, `clientId`, exact saved `snapshot`, canonical `snapshotHash`, `hashFormat=workspace-snapshot-canonical-json-v1`, `savedAt`, `authorId`, `authorKind`, bounded `contentSkeleton`; `destination={kind:workspace_saved_revision,resourceId:versionId,draftId,clientId,objectiveId,objectiveVersion,objectiveRevisionId}`. There is no mutable destinationVersion. |
| Calendar: Planner start/due occurrence | `GET /strategy-api/planner/tasks/:id/objective-destination` with the same three query selectors. Existing frontend client owner `strategy`, relative path `planner/tasks/...`. Response is `{destination:{kind:planner_task,resourceId:taskUUID,clientId,objectiveId,objectiveVersion,objectiveRevisionId,destinationVersion:currentTaskVersion},task:<existing ACL-filtered PlannerTask>}`. `task.id/version` must agree with destination. Keep the selected task version; a changed version requires refreshing and reselecting before opening the corrected occurrence. |

Queries accept exactly the three scalar Objective selectors. No caller tenant, actor, source kind, revision UUID, hash or URL claim establishes authority. Existing guards, current membership/Clerk-to-native mapping, client wall, same-client Objective revision and each resource owner's permissions remain unchanged. Both controllers return `Cache-Control: private, no-store`.

Workspace eligibility is the existing staging-compatible subset: manual draft, exact immutable saved version and parent, nonnull saved/current canonical client agreement, current owner/collaborator read/export rights, no prospect or immutable source-action origin, existing snapshot/literal-content bounds. It is not all Workspace files. Render the selected saved snapshot, never live text. Use the existing public `canonicalWorkspaceSnapshot` producer plus SHA256 for integrity comparison; do not hash only the contentSkeleton or substitute a new serializer. If a selection already records a snapshotHash, compare it too. Opening creates, restores, stages, generates and sends nothing.

Planner occurrences use presentation IDs `planner:<taskUUID>:start` or `:due`; their backend resourceId remains the task UUID. They are not persisted resources or recurrence forecasts. `startOn`/`dueOn` remain validated civil `YYYY-MM-DD` dates. Optional `startTime`/`dueTime` are `HH:mm` paired with the returned IANA `timeZone`; a timed record without a valid zone is unavailable, not silently UTC. Date-only values stay civil. Coincident start/due dates collapse to due; a missing date creates no occurrence. Date-kind is `planner_start` or `planner_due`, provenance `planner_task`. Neither is a rule effective date, publication date, comment end, hearing or Meeting association. Use existing Planner time conversion for rendering timed instants; the reference keeps source date/time/zone unchanged and does not introduce DST policy.

The locally inspected frontend snapshot `02c02d95bdf3949662b9123f425271c6491ffdab` has a due-only Calendar feed keyed `planner:<taskUUID>` and a task parser that omits version. That is receiving work: retain the current returned task version and the chosen occurrence selector in Objective navigation. Existing general feed keys/features need not change. This local snapshot is not a claim about the latest deployed preview. Normal ApiClient already uses same-origin login and no-store; it exposes HTTP status on errors, so frontend should handle the existing 409 through that status. The backend's `OBJECTIVE_VERSION_CONFLICT` body remains unchanged. Do not introduce a second API/auth client.

Unavailable current scope is 404; only an otherwise authorized same-client stale Objective is 409 `OBJECTIVE_VERSION_CONFLICT`; malformed input is 400. Infrastructure/permission/deadlock failures propagate. The reference's `DESTINATION_CHANGED`, `OCCURRENCE_UNAVAILABLE`, `SAVED_REVISION_CHANGED` and `INVALID_RECEIPT` are local presentation consistency failures, not new server responses or permissions.

## Runnable consolidated source qualification

From this Git worktree, with already installed TypeScript and Nest dependencies:

```sh
CAPIRO_QUALIFICATION_TOOL_ROOT=/path/to/existing/apps/api node --test --test-reporter=tap docs/objective-files-calendar-receiving-20261014/qualification.test.mjs
```

The local default tool root is the retained receiving API checkout. No install, download, generated output, native client, HTTP server or provider is invoked. The harness reads exact Git source from the pinned base, compiles actual shared Objective/wall/saved-revision helpers and Planner validation/scheduling, and selects the real VersionsService/PlannerService methods plus task/project ACL projection by AST. Native transactions/stores and adjacent actual-minute lookup are synthetic; DTO decorators, guards, full DI, HTTP and the complete application graph are outside this acceptance. Consumed Git blobs/SHA256s and TypeScript version appear in the raw receipt output.

Attempt01 failed because the synthetic `$queryRawUnsafe` adapter incorrectly passed its rest parameters as a string. The original harness, source hashes and full raw output are preserved. Attempt02 corrected that fixture and passed 36/36. Attempt03 strengthened late-error admission, added one adversarial case and passed 37/37 with zero skipped cases. These are source/synthetic checks, not native PostgreSQL/RLS/MVCC/concurrency or browser acceptance. All earlier source/evidence/heads remain preserved.

## Native owner gate and overlap

| Owner/dependency | Disposition |
| --- | --- |
| Core Objective PR2362 and existing immutable revision migration | Reused persistence/revision authority; matching already-applied native artifact still required. No new table/model. |
| Workspace saved-version immutability and existing revision owner | Existing eligible closure unchanged. Native trigger/SELECT privilege/cascade and wall revocation qualification remain its gate. |
| Planner canonical task/project owner | Existing tenant advisory-lock path and ACL-filtered task projection retained. No duplicate occurrence model or association writer. |
| General Portfolio Files, Meetings, effective rule dates | Unchanged independent features. This selection grants no global source/client association or effective-date coverage. |
| Protected Engagement, retained legacy runtime/shared tasks | No body/ref/source edits. No process retirement claim; finite required consumers still prevent broad deletion. |
| Frontend | Connect these two existing reads through its normal API client; add receipt/admission/reopen composition and focused browser acceptance in its own worktree. No deployment claimed. |

Minimal native continuation remains four owner steps: pin exact source/tree, compiled entrypoint/native ABI/generated Prisma/schema fingerprint; read back already-applied schema/immutability/ordinary grants/RLS in the admitted fixture; qualify only selected owner seams for revocation/cascade, locks, stale revisions, replay and infrastructure propagation; verify actual serving image/origin and authenticated owned HTTP flow. The inherited client wall writer can delete grants before its client update while these readers lock client before grant, producing a fail-closed deadlock; retain that case and fresh-read behavior in native acceptance. Do not run schema, AWS, customer writes or full provider bootstrap here. The blocked ordinary Prisma download remains blocked without bypass.

Workspace capacity required the new source-only packet worktree to be relocated byte-exact into writable `/tmp`, retaining its `/workspace` alias and original/new Git refs. Its checkout was deliberately created without a full index; committed manifest/Git bytes, rather than a whole-checkout status, establish packet custody. No other worktree, source, evidence, migration, cache or borrowed store was removed.
