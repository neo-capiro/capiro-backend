# A2 source contracts, 2026-10-23

Base: `db96ad310fa1c3cc43278ff9c2d59e750581bac3`. This branch contains source changes only. No database, provider, AWS, deployment or live acceptance actions ran. It is not full A2 completion.

## ST06 invitations and ST20 recipient acknowledgement

Commit `1ca9246a6f27e96fe2902a42fa1e239c97dbe94d` bounds Clerk pending invitation enumeration at 100 records/page and 50 pages. Incomplete, changing-total, duplicate, wrong-organization or nonpending observations refuse before mutation. List, resend and email deduplication share the same complete observation. Resend preserves only bounded first/last names and server tenant metadata; returns original and replacement identity. Ambiguous provider revocation/create failures return 503 rather than inviting a blind replacement retry. Provider calls in tests are mocks.

Recipient reads require current active/invited membership, return at most 100 unarchived pending messages in createdAt/id order. Acknowledge locks current membership, broadcast and exact recipient, rechecks eligibility, and returns `ok`, `broadcastId`, and the first `acknowledgedAt`. Duplicate explicit acknowledgement preserves that timestamp. Archive and recipient revocation remain authoritative. Opening/dismissing the frontend inbox never acknowledges.

## PF16 ordinary attachments

POST `/clients/:clientId/files/batch-moves` accepts only `{schemaVersion:1, requestId, clientId, folder, files:[{id,expectedRevision}]}`. IDs are canonical lowercase UUIDs; 1–100 distinct files sorted by ID; folder is a trimmed label of at most 120 characters or null. It is not a folder entity, storage copy, or inherited ACL. SHA-256 of the canonical fixed-order command binds request reuse.

The existing `requireOwnerClient` checks current identity/membership, locks the client, repeats membership after waiting and locks the current wall grant. The batch takes a tenant/actor/request advisory lock, then all attachment rows in deterministic ID order. Every selected row must be the same tenant/client with no prospect binding and pass its existing `all`/uploader/restricted-viewer rule. Missing or denied rows yield one generic unavailable response without inaccessible metadata. All revisions are checked before any write. Changes and the aggregate immutable receipt commit in one transaction. Same-key/different-digest conflicts; replay/readback repeats current client/file authorization and returns the original receipt without repeating the move.

`20281023040000_client_file_batch_move` is reserved source, **not executed**. Its attachment trigger increments `metadata_revision` on every actual row-column change; it covers current `viewer_mode`, `viewer_user_ids`, uploader, lifecycle and filing writers in `client-files.controller.ts` and `engagement.service.ts`, as well as ordinary folder updates. Current ordinary attachment ACL is row metadata (`attachment-viewer-access.ts`); no linked ordinary ACL table was found. Membership and client wall relations are separately held by the existing owner locks. The receipt table has forced tenant RLS, composite client FK, unique tenant/actor/request key, SELECT/INSERT application grants and no application UPDATE/DELETE grant. The source preserves all single-file handlers.

GET `/clients/:clientId/files/batch-moves/:requestId` returns the complete historical receipt only with current authorization. Deleted/inaccessible files keep recovery unresolved; absence is not proof the command failed. A response-lost frontend command never becomes an automatic new request.

## PF16 hearing-backed document gap — still incomplete

Hearing documents remain fail-closed in the new batch path. This is an implementation gap, not an approved scope reduction.

The existing API owner `engagement/hearing-record-document-access.ts` reads `legiwatch_record_document` with exact Clerk owner, current active member, tenant, attachment, client and brief. The immutable row already contains series/version/content_hash/source_hash. It calls the separate intel-api `hearing-record-retrieval.controller.ts` `document-access` seam. That owner invokes `HearingRecordWorkflowService.brief`: feature authorization, client wall, decrypted content integrity, folder IDs/versions/client references, current source/run, latest brief series version and approval. The response repeats exact brief/client/event/content/source identity.

These existing hashes and folder versions are reusable identity evidence, **not** an authorization reservation. `brief()` reads and releases multiple `actor()` transactions; its `lockContext` completes before the HTTP reply. There is no receipt or lock lifetime extending through the attachment batch commit. A successful HTTP read can therefore race access revocation, folder change or source supersession. Calling it once before moving files would weaken the current boundary.

The minimum owner prerequisite is an exact authorization-and-commit protocol that retains those same checks through the batch commit, binds actor/tenant/client/attachment IDs, expected attachment revisions, document hashes/folder versions and the batch request/digest, and returns an attributable historical receipt with current-access readback. The current `sourceBoundary` global shared commit lock/event lock and `lockContext` membership/client/folder locks are potential building blocks only. Existing hearing order begins membership→client, while the current attachment owner uses client→membership; any composition must first reconcile lock order and audit all relevant writers.

Production owners are separate services. No hypothetical in-process participant has been added, and this increment does not implement a distributed grant. Co-location versus a durable cross-owner reservation/commit design requires an actual architecture allocation. Existing `read`/`distribute` purposes cannot be silently repurposed into a batch-write grant. No policy relaxation or cross-service credential exposure is proposed.

## Evidence and outstanding gates

38 tests pass across pending-invitations, tenant-admin.invitations, tenant-admin.safety, admin-broadcasts.service and client-file-batch suites with synthetic provider/transaction ports. Six mutation controls were killed: organization wall, preserved name, fresh membership, stale attachment revision, hearing boundary, request-key digest conflict. Restored sources passed again. These are service-boundary tests; the synthetic rollback fixture is not evidence of PostgreSQL atomicity or real lock contention.

Required root disposable PostgreSQL gate: migration/schema validation and repeat application, real all-or-none rollback, stale revisions including ACL writers, revoked membership/client walls, current archive/ack contention, same-request concurrent replay/conflict, RLS/FK/grants, revision overflow fail-closed, and generated Prisma/type/build compatibility. Native Core typecheck is not claimed because the shared dependency junction has no generated Prisma client and must not be mutated by this lane. Independent exact-head review remains required.

PF18 conversion and remaining PF13/Mail contracts remain separate open work. Hearing authorization and selected prospect transfers remain explicitly unfinished.
