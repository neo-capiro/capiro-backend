# Independent Prospect Files / Workspace architecture audit

Audit date: 2026-10-12. Exact source: `b1ac2649e134af560d41bee790cacbd61de01c9b` (preserved PR2393). Worktree: `/workspace/capirov2-prospect-resources`. This is a read-only design and access-path audit, not approval of the author's evolving uncommitted implementation. No implementation, previous branch, frontend or Meri files were edited. No database, migration, compiler, provider, model or deployment was run. Inventories beside this report were generated with `git grep` against the exact source above.

## Assessment

The proposed additive architecture is viable: immutable prospect origin on existing attachment/draft records, one shared current-access policy, durable upload intent, and explicit service checks. A central draft ACL hook is necessary but insufficient. Several routes read or mutate draft-derived information without that hook, and some authorized copy/export consumers would lose the prospect's protected origin. These paths must be covered or explicitly refuse prospect-bound resources before exposing content or invoking providers.

This report identifies requirements for the new scope. Existing uncovered paths are not asserted to be regressions in source that has not yet been implemented. Final source review and adversarial replay remain required.

## Canonical authority and conversion

- `apps/api/src/common/tenant-flags.ts:17,403`: `tenantFeatureEnabled` accepts real booleans only. Business Development uses the flat key `businessDevelopment.enabled` inside `settings.clioFeatureFlags`, default false. Reuse the implementation; do not accept nested objects or string `true`.
- `apps/api/src/memory/memory-wall.helpers.ts`: current client access is wall disabled OR a `client_memory_access` row for the current Core actor UUID. There is no admin/uploader override. This table has no status/expiry column; revocation deletes the row. It is distinct from governed memory grants. Locking the client alone does not protect a grant from deletion.
- `apps/api/src/business-development/business-development.service.ts:927,1391`: conversion locks the prospect first, retains its UUID/history, and links or creates a client. `findOwnedTx` means tenant-owned, not assigned-user-only: it queries tenant and prospect ID, and does not reject dismissed/conflict-excluded history. Do not turn `ownerUserId` into an invented ACL. Resolve the current linked client on every protected use; a past conversion receipt is not present authority.
- Resolve a verified Clerk subject to the current active Core user/membership inside the caller's tenant transaction, including the actual current role. For linked prospects, require a current same-tenant, nonarchived client and the canonical wall decision. Share canonical flag/wall functions rather than duplicating policy.
- `apps/api/src/business-development/bizdev-meri-scope.service.ts` is not a complete resource-access helper: its prospect/feature checks do not establish current linked-client wall access, and its additional Meri-tools flag is not the Files contract.
- `apps/workspace/src/auth/org-tenant-resolver.provider.ts` caches active membership for 30 seconds and tenant mappings for 60 seconds. The new helper must not rely on that membership cache for its current checks. Shared `TenantContext` does not carry the original token org claim, so the helper alone cannot remove the inherited org-mapping cache boundary. Do not claim uncached end-to-end org mapping without separately scoped auth work.

For mutations, use a documented lock order compatible with conversion (prospect before linked-client resolution), then current tenant/membership/wall-grant locks in the same transaction as the resource mutation. Avoid database locks across S3 or provider I/O; recheck after external waits before committing or returning newly derived protected data. Read paths need current checks too, even when cached role/owner resolution previously succeeded.

The remaining policy choice should be explicit: whether dismissed/conflict-excluded prospects permit new resource creation while historical resource reads remain available. Existing BD tenant-wide historical access does not answer that new-write choice. A conservative initial contract can refuse new creation without erasing retained origin or silently inventing owner-only visibility.

## Attachment design and coverage

`apps/api/prisma/schema.prisma:1414` already owns `EngagementAttachment`, including uploader/viewer access, lifecycle, scan/hash state, S3 metadata and separate `sourceEntityType/sourceEntityId/sourceEntityVersion` provenance. Add prospect origin independently; do not repurpose source provenance or populate `clientId` after conversion.

The minimal safe addition is an immutable nullable prospect ID with tenant-safe relation and parent exclusion, plus a durable upload intent. Reserve a recognizable S3 key namespace for prospect uploads. Bind intent to tenant, actor, prospect and exact accepted upload metadata. Commit intent before issuing the capability. Confirm must use that binding and must reject the reserved namespace through legacy confirmation even when callers omit `prospectId`. Persist confirmed attachment ID as a non-cascading tombstone so deletion cannot turn a replay into a new attachment. Validate current scope before S3 reads and again before transaction completion after S3/scan work.

| Exact source path | Required coverage |
| --- | --- |
| `engagement/engagement.service.ts:7502,7535` | Presign and confirmation currently have no durable origin intent. Confirmation reads S3 metadata before parent authorization. Bind/replay the server intent; metadata, actor or prospect changes must fail before object reads. |
| `engagement/engagement.service.ts:7677` | Generic unlinked listing filters only null client/meeting/mail parents. Explicitly exclude prospect rows; otherwise new rows match this legacy list. Never issue download/preview URLs before current prospect and viewer checks. |
| `engagement/engagement.service.ts:7762` | Text extraction currently requires client/meeting parent; preserve fail-closed behavior for unsupported prospect extraction and inspect error/metadata projections. |
| `engagement/engagement.service.ts:8285,8466` | Interactive delete needs current prospect authority plus the retained attachment ACL. Intentional system retention erasure is a separate internal lifecycle path; preserve it without enabling replay resurrection. |
| `engagement/engagement.service.ts:8549` | Supersession currently loads only the old tenant row before linking the new ID. Authorize and verify both rows, same tenant and immutable prospect origin; reject lineage changes. |
| `engagement/engagement.service.ts:8693,9440` | Outbound attachment loading must refuse unsupported prospect rows before bytes/provider dispatch. Final mail-parent assignment occurs after send; relying on a parent-exclusion constraint here would fail too late. |
| `engagement/attachments/outbound-attachment-access.ts` | Existing client mismatch logic alone does not protect prospect attachments whose `clientId` remains null. Explicitly refuse unsupported bound rows. |
| `engagement/outreach-send-intent.service.ts:1189,1283` | Both initial manifest resolution and frozen-manifest revalidation read attachments directly, including system-context paths. Include prospect origin in projections and reject it in both phases before bytes/provider work. |
| `outreach-v3/send/outreach-v3-send.service.ts:437` | Direct attachment preflight must refuse prospect rows before dispatch. |
| `engagement/generation/evidence-source.service.ts:798`; `capabilities/context/outreach-context-reference.service.ts:405` | Independent evidence/context readers must refuse unsupported prospect rows, not rely on EngagementService. |
| `embeddings/client-kb.service.ts:109,292,462,626` | Visible-document, indexing, locked-snapshot and reindex paths require explicit exclusion. Do not auto-index on conversion or use an actorless shared index as current prospect authority. |
| `clients/client-files.controller.ts`; `clients/client-activity.service.ts:121`; `clients/client-profile-fill.service.ts:685,752`; `clients/client-profile-fill-workflow.service.ts:1084,1325` | Client-only metadata/read/update paths must remain unable to select prospect rows. Parent exclusion is central; explicit exclusions defend reader evolution. The legacy activity wall correction belongs to preserved PR2396, not an indiscriminate merge into this base. |
| `knowledge/mailbox/mailbox-knowledge.repository.ts:173` | Raw SQL exposes attachment metadata nested under messages. Preserve parent exclusion and no mail-parent rebinding of prospect origin. |

Other inventoried writers/replayers include `engagement/notetaker/notetaker.service.ts`, `intelligence/alert-memo/hearing-recap.service.ts`, `meri/meri-job-deliverables.service.ts`, and `engagement/synthetic-document-deletion.helpers.ts`. Keep their generated/unbound lineage and internal lifecycle rules intact. Generic parent validators establish existence/ownership but do not currently establish client-wall access; do not treat them as the new prospect policy.

Viewer semantics remain conjunctive: the existing all/restricted/uploader rule still applies, and uploader status never bypasses the current prospect/client wall.

## Workspace architecture and bypass inventory

`apps/workspace/prisma/schema.prisma:1-10` explicitly owns only `ws_*` models. Core users/clients/tenants are ID references without cross-Core ORM models or FKs, and Workspace tables do not use RLS. Keep that boundary. Add immutable `WsDraft.prospectId` outside free-text `client` and JSON config. Authorize through shared Core SQL inside the caller transaction. Only new draft creation may bind it; create origin, draft and initial document atomically. Restoring version snapshots or config must never set, clear or change it.

`collaborators/collaborators.service.ts:55,79,123` is the natural shared access hook: source access runs before the owner shortcut, then owner/active collaborator role applies. Preserve the existing Intel source-action authority as AND, including author/current-source checks; absence of an Intel source action must not bypass prospect scope. `DraftsService.list` and HillDay document selection already call `sourceAccess`, so that hook can cover them. Draft owner/collaborator privileges remain necessary and never grant BD/client-wall membership by themselves.

A small explicit draft-resource access service can avoid the existing Collaborators -> Notifications dependency cycle. Optional-actor internal helpers must fail closed for prospect-bound drafts when no authenticated actor is available; do not infer an actor from owner/config/caller text. Existing normal controller actor plumbing should be retained.

Paths requiring explicit coverage beyond `resolveRole/assertCan`:

| Exact source path (under `apps/workspace/src`) | Gap / bounded action |
| --- | --- |
| `documents/documents.controller.ts:24` -> `documents.service.ts:37` | List returns complete document bodies without actor ACL. Pass actor and resolve parent draft. |
| `comments/comments.controller.ts:18` -> `comments.service.ts:33` | List returns comment bodies, quoted text and replies from a document ID without actor ACL. Resolve document -> draft then apply current scope and role. |
| `drafts/drafts.service.ts:384` | Anonymize-name detection reads derived draft text without actor. Gate before returning derived names. |
| `checks/checks.controller.ts:18` -> `checks.service.ts:123` | Draft checks read config/documents and return title/text-derived details without actor. Gate or explicitly refuse unsupported prospect operation. |
| `document-agent/document-agent.controller.ts:350`; `document-agent-quality.service.ts:213` | Quality read has no actor; fix proposal inserts `WsAgentProposal` directly. Cover read and mutation independently of the agent's normal loader. |
| `edit-lock/edit-lock.service.ts:98,158,178,209` | Status, heartbeat, release and request lack the normal ACL (acquire/takeover do check it). Release may hand the lock to a saved requester; recheck the recipient's current rights or clear that request. |
| `delivery/approval.service.ts:24,78` | Preflight/createRequest read protected state without checking draft ACL, despite accepting actor arguments. Check current scope before idempotency replay/projection as well as new writes. |
| `delivery/share-link.service.ts:63,101,113,185,238` | Create/revoke lack draft gate; public token read/comment intentionally lack tenant auth; tenant-wide index exposes draft titles. Refuse prospect public shares and public token use, and filter/gate indexes. Do not make prospect binding a public token entitlement. |
| `notifications/notifications.service.ts:32,47` | List, unread counts and mark-read results expose denormalized draft metadata without current scope. `WsNotification.draftId` has no FK, so rows survive draft deletion. Missing referenced draft must never be interpreted as ordinary/unbound access. Use durable origin or conservative hiding of missing-draft notifications. |
| `collaborators/collaborators.service.ts:156,270,326` | Invite service relies on controller ACL; accept/decline rely on recipient identity without current source scope. Require current same-tenant member/resource access for prospect recipients and acceptance. Email-only external prospective invites should fail closed pending a policy. Pending invite recipients are not yet active collaborators: design a bounded invitation projection rather than incorrectly requiring active-collaborator status to accept. |
| `generation/memory-promotion.service.ts:20` | Tenant+draft ID reads become firm memory candidates. Refuse prospect promotion; a pending candidate still copies protected origin/content to another scope. |
| `quick-draft/source-resolver.service.ts:534` | Prior-draft import performs role check, then copies content/config into another draft without canonical prospect origin. Refuse prospect sources until a separate lineage-preserving copy contract exists. Free-text client comparison is not authority. |
| `documents/documents.service.ts:50,73` | Meri import chooser/body paths have existing ACL but are cross-surface copies. Refuse prospect imports while unsupported. |
| `quick-draft/generation-run-worker.service.ts:314,359,573` | Worker stages reload draft without current actor check; run status is tenant+run only and exposes sections/errors. Block prospect enqueue and worker execution independently; status needs parent/current actor scope or an explicit refusal. |
| `generation/generation.service.ts:326,786,829,856,1271,1478`; `comments/comments.service.ts:109` | Explicitly reject unsupported prospect generation, direct/retry/apply-generated routes and comment-edit generation before provider work. A normal read ACL alone does not make generation/copy supported. |
| `template-studio/template-studio.service.ts:101` | Blueprint usage counts scan every tenant draft config. Exclude unsupported prospect drafts or authorize the counted set. Blueprint cloning copies a blueprint, not a draft; no draft-copy claim is made here. |

Existing versions (`versions.service.ts:31`), export (`export.service.ts:385`), context, standard document mutations and main document-agent paths largely use parent role checks, but some service actor parameters are optional and their writes follow checks in separate transactions. Review caller transaction plumbing, missing-actor behavior, origin immutability and post-render/current access before output. Do not assume a controller-only check protects an internal call. Public snapshots require their own refusal even if ordinary versions are protected.

The cross-app inventory found no actual direct Core/Strategy ORM reader of Workspace documents; matching Strategy hits were comments. This supports retaining the existing ownership seam rather than introducing a second store or Core Workspace models.

## Final-source adversarial qualification requested

1. False/missing/malformed flags; cached membership revoked or role changed; unknown/foreign Clerk mapping; same-tenant linked client archived/denied; no admin/uploader wall bypass.
2. Conversion or client/grant change after presign and during confirmation I/O; locks released before S3 work and current checks repeated before commit. Preserve original prospect UUID and generic source provenance.
3. Reserved-key legacy confirmation with omitted/changed origin; changed actor/metadata; duplicate/lost response; S3 confirmation replay after attachment deletion returns the tombstoned outcome and never creates a replacement attachment.
4. Generic unlinked/client/mail lists do not leak prospect rows; supersession refuses foreign/mismatched origin; viewer restriction is still applied; every unsupported outbound/evidence/KB path makes zero bytes/provider/model calls.
5. Draft owner and active collaborator independently denied when current prospect/client scope is revoked; foreign/absent actor denied; existing Intel source restrictions remain conjunctive.
6. Document/comment/check/quality/lock/approval/notification paths, including old IDs, existing public tokens, unread counts, deleted drafts, pending/accepted invitations and revoked handoff requesters.
7. Snapshot restore cannot bind/clear origin; exports preserve authorized content/version provenance; prior-draft/Meri/memory imports and generation/worker retries fail before content transfer or providers.

This audit supplies source-path coverage only. Synthetic tests, primary compilation, schema validation and exact diff review belong to the final committed candidate. Native transaction races, RLS and migration execution remain unqualified and prohibited in this review environment.
