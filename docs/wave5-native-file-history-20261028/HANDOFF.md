# Wave 5 — native file history (Core engagement-attachment slice): author handoff

Role: Hermes implementation worker (not reviewer, not orchestrator). Source-only work.
Base `00f6d045a0fd2abb60f7735a453655ce3aef903b`, tree `f03e00817d5dad63152da65638af0bd9985c454f`,
branch `codex/wave5-native-file-history-hermes-20261028`. HEAD/tree of this candidate: the commit that
adds this file (exact values recorded in the S handoff, `S/outputs/WAVE5-NATIVE-FILE-HISTORY-HERMES-AUTHOR-HANDOFF.txt`).
PR198 and every other branch are excluded from this source.

## What this slice is

The missing native workspace / client-file history: a bounded, read-only, **metadata-only** version
chain over Core's EXISTING supersession owner — `engagement_attachments.superseded_by_attachment_id`,
written today only by `EngagementService.supersedeAttachment`, which keeps the old row, its stored bytes
and its KB index and sets `old.supersededByAttachmentId = new`. No new table, no migration, no second
Files store, no parallel history record.

One version = one engagement attachment row. The ONLY version identity released is that row's exact
attachment UUID. It is deliberately **not** an S3 object `VersionId` (the attachment owner addresses
bytes by bucket + s3Key and never pins a storage version, so no storage version or locator is accepted,
derived or returned) and **not** a generated-artifact id (a different namespace that simply does not
resolve against `engagement_attachments`).

Already source-implemented elsewhere and intentionally NOT duplicated here: the generated-artifact /
public document-access library + history and publication paging. MM12 custody and MM13 adapter remain
A5-owned; the M5 Files consumer owns its own consumer path.

## Route / response contract

    GET /api/engagement/attachments?historyOf=<attachmentId>[&historyCursor=<opaque>][&historyPageSize=<1..50>]

No new route, no manifest/registry change, no decorator change — history mode rides the existing list
route and is entered only when `historyOf` is present. List mode (`?clientId=`, `?mailMessageId=`,
`?unlinked=true`, ...) is unchanged. History mode refuses (400) any list filter rather than silently
ignoring it, so one request means one query and a cursor stays bound to one exact chain.

200 body: `attachmentId, originalId, headId, versionCount, pageSize, offset, hasMore, nextCursor,
versions[]` where each version is
`attachmentId, versionIndex (1 = original), isOriginal, isCurrent, fileName, contentType, byteSize,
createdAt, folder, uploadedByUserId, uploadedByName, source, sourceEntityType, sourceEntityId,
contentHash, lifecycleStatus, scanStatus, usable[, blockedReason][, scanDisclosure],
supersededByAttachmentId`. Order is oldest → newest; the page window starts at the cursor offset;
`versionCount` is the exact resolved chain length (never a partial or estimated total).

Refusals: 404 `Attachment not found` (invisible or unknown anchor); 404
`CLIENT_FILE_HISTORY_UNAVAILABLE` (any member hidden, revoked, foreign, missing, branched, cyclic,
over-bound, or a current-access refusal for any member); 409 `CLIENT_FILE_HISTORY_CURSOR_STALE`
(cursor bound to a different anchor/head/actor/pageSize, or a chain that changed since it was minted);
400 `CLIENT_FILE_HISTORY_CURSOR_INVALID` / `CLIENT_FILE_HISTORY_PAGE_SIZE_INVALID`.

## Invariants (implemented, not aspirational)

1. The anchor is resolved through the canonical viewer predicate (`attachmentViewerWhere`) + tenant, so
   an invisible id and an unknown id are indistinguishable to the caller.
2. The chain is reconstructed with bounded, tenant-scoped reads only. Reconstructed structure is
   decided from the rows: a second predecessor, a repeated member (cycle/self-link), a dangling
   successor, a second claimant of the same successor (fork, refused from every anchor), an over-bound
   walk and a backward/forward disagreement are all honest refusals — never a truncation.
3. Current authorization for EVERY member runs **before** any metadata, count, name or cursor is
   assembled, and the released page is authorized **again** immediately before projection, so a
   revocation between the query and the release withholds the whole history. Access is never inferred
   from an earlier allowed head, and no version's parent/source ownership is rewritten.
4. Authorization reuses the canonical owners (`attachmentViewerWhere`, `requireProspectScope`,
   `validateAttachmentParents` → mail/hearing/client scope, `assertHearingRecordDocumentAccess`) rather
   than duplicated weaker heuristics. Prospect versions are read through `requireProspectScope`, not
   `assertProspectAttachmentAccess`, whose read mode deliberately refuses a non-current row — that
   predicate answers "may I use this file now" and is not a statement about whether the version existed.
5. Metadata only: no bytes, no signed URL, no storage locator, no write, no budget, no model/provider/
   indexing call. The single read-only snapshot is `withTenant(..., { readOnly: true })`. The current
   version stays readable through the existing attachment reads; this surface links them, it does not
   replace or widen them.
6. `listAttachments`, get/download/preview and `supersedeAttachment` are untouched.

## Files

- `apps/api/src/engagement/attachments/client-file-history.ts` (new) — bounded chain walk, cursor
  binding/digest, projection, refusals.
- `apps/api/src/engagement/attachments/client-file-history.spec.ts` (new) — 14 author tests.
- `apps/api/src/engagement/attachments/client-file-history.http.spec.ts` (new) — 5 mounted-route tests.
- `apps/api/src/engagement/engagement.service.ts` (narrow) — `listAttachmentHistory` + the canonical
  per-version `authorizeAttachmentVersion` owner.
- `apps/api/src/engagement/engagement.controller.ts` (narrow) — history query forwarding on the existing
  attachments route.
- `docs/wave5-native-file-history-20261028/native-file-history-claim.txt` (pre-edit claim, for A5).

No Prisma/schema/migration/module/shared-authority/registry/lock/frontend/meri-research edits.

## Checks (author evidence, not an independent SOURCE PASS)

    cd apps/api
    node.exe --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --no-cache \
      --cacheDirectory="C:/ProgramData/Hermes/cache/scratch/w5nfh/jest-cache" \
      --runTestsByPath src/engagement/attachments/client-file-history.spec.ts \
                      src/engagement/attachments/client-file-history.http.spec.ts
    # exit 0 — 2 suites passed, 19 tests passed

    # same invocation, existing directly-affected specs (route surface unchanged):
    #   src/engagement/engagement-route-manifest.spec.ts
    #   src/engagement/runtime/engagement-runtime-route-coverage.spec.ts
    #   src/engagement/attachments/prospect-attachment-access.spec.ts
    #   src/engagement/attachments/prospect-file-copy.http.spec.ts

Node 24.22.1 (`C:/Program Files/nodejs/node.exe`), read-only junctioned caches, no installs.
Two defects were found by these tests and fixed before the candidate: the chain-consistency check
wrongly required the anchor's ancestry to span the whole chain (refusing any mid-chain or old anchor),
and a fork was not detected when anchored upstream of the fork point.

## Remaining acceptance (not this slice)

Frontend/package consumption by M5 Files, current deployed-environment acceptance, and independent
review. This document is author evidence.

## Limitations

- `versionCount` and the full chain require walking the chain; the hard bound is
  `CLIENT_FILE_HISTORY_MAX_VERSIONS = 200` (page size 1..50), above which the request is refused rather
  than sampled. Typical chains are far smaller.
- The cursor digest is a consistency binding, not a capability: it is not a signature (no key material
  is introduced here), so authorization on every page is re-derived from the database regardless of the
  cursor. It also means a cursor cannot be used to prove access.
- ts-jest runs with `diagnostics: false` in this repo, so the suite proves behavior, not types; a bounded
  `tsc` check of the touched files is the separate type witness.
- `uploadedByName` is a display convenience from the canonical `userDisplayName`; it is not an authority
  claim and does not widen who may read a version.
