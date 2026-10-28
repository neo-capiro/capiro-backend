# MM-11 / WS-24 — original-version READ through the Core engagement attachment owner

Author handoff (Hermes implementation worker). LOCAL SOURCE AUTHORED — author evidence only,
NOT an independent SOURCE PASS and not a deployment acceptance. The reviewed metadata history
(255b1e36) and its reviewed F1 parity delta (803284ae) are untouched; this is a new isolated
successor that adds the missing read capability to the SAME already-admitted route.

## 1. Shared policy bootstrap

- Policy repo `C:\dev\capiro-agent-ops`, HEAD `b32b4803933760dc0a93fffdcd8fba30a89c3aac`, clean.
- Read: `BOOTSTRAP.md`, `AGENTS.md`, `hermes/OPERATING.md`, `machine-paths.local.yaml`,
  `work/hermes-authoring/AGENTS.md` (Wave 5 isolated authoring rules).
- Inputs read before editing: `outputs/WAVE5-NATIVE-FILE-HISTORY-PARITY-HERMES-REVIEW.txt`
  (sha256 `f0c05bbae53eafffe430bec8d93d51528bba5c88f1909e97ad267381ca231742`, finding F5: a
  historical version still had no download path), the W5-01 brief MM-11/WS-24 requirements,
  `apps/api/AGENTS.md` + the Wave 4/5 repo AGENTS rules, and the strict bounded typecheck
  recipe `work/native-file-history-types-bounded.json`.

## 2. Exact git state

- Checkout `S/work/wave5-native-file-history-read-20261028`, branch
  `codex/wave5-native-file-history-read-20261028`.
- Base / parent of this commit: `803284ae5b3afff0aca9fc4e08cc7c71bf45f14a`
  (tree `0c08016c94946c2f280a95f2ee79512ed82622cd`).
- Dependencies: `node_modules/` and `apps/api/node_modules/` are read-only junctions into the
  untouched 255b author checkout (`wave5-native-file-history-hermes-20261028`). No install, no
  lockfile change, no shared cache mutation.
- Preserved untouched: `255b1e36fa627aa7e535b462e59ee51dbe22efed`, `7042cfd3ffc9fb20d6d20bd3d123a05a4bf6ff49`,
  `00157db64f5e149ebbad4bd9f2c15b9231abf5ff`, `00f6d045a0fd2abb60f7735a453655ce3aef903b`, the
  803/255b worktrees and every review/report artifact.
- Author `Codex <codex@openai.com>` per command. The exact hash/tree of this commit are recorded
  in `outputs/WAVE5-NATIVE-FILE-HISTORY-READ-AUTHOR-HANDOFF.txt`.

## 3. Scope of this commit

```
M apps/api/src/engagement/attachments/client-file-history.ts        60 insertions, 6 deletions
M apps/api/src/engagement/attachments/client-file-history.spec.ts   116 insertions, 7 deletions
M apps/api/src/engagement/engagement.service.ts                     22 insertions, 6 deletions
A docs/wave5-native-file-history-20261028/READ-HANDOFF.md           new file, 178 lines
```

Correction successor commit on top of it (measured with `git diff --numstat 078901c9`, source files
only; this document is updated in place and is not double-counted):

```
M apps/api/src/engagement/attachments/client-file-history.ts        99 insertions, 6 deletions
M apps/api/src/engagement/attachments/client-file-history.spec.ts   213 insertions, 4 deletions
M apps/api/src/engagement/engagement.service.ts                     23 insertions, 1 deletion
M docs/wave5-native-file-history-20261028/READ-HANDOFF.md           updated in place
```

`078901c904ad255540c0ace64047c80afc07852b` is preserved as an ancestor (no amend, no rebase); the
exact head/tree of both commits are recorded in the two author handoffs under `outputs/`.

- `engagement.controller.ts` was **traced and deliberately not changed**: `@Get('attachments')`
  already declares `historyOf` / `historyCursor` / `historyPageSize`, refuses list filters, and
  returns the service result verbatim, so no route, guard, param or projection had to move.
- No Prisma/schema/migration/module/shared-authority/public-package/registry/lock/frontend/generated
  file changed. The tracked generated route fixture was NOT modified (proved by regeneration, §4D).

## 4. What was run — exact commands and exits

Node `C:/Program Files/nodejs/node.exe` (24.22.1). Scratch: `C:/ProgramData/Hermes/cache/scratch/w5nfh-read`.

A) Expected old-assertion witness, before the spec update — **not a baseline of unchanged
behaviour**: the implementation had already changed, so this run is the OLD assertion failing on
the NEW code. It is kept to show the read capability was real and that exactly one superseded
invariant moved:
`cd <read>/apps/api && node.exe --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --no-cache --cacheDirectory=<scratch>/jest-cache --runTestsByPath src/engagement/attachments/client-file-history.spec.ts src/engagement/attachments/client-file-history.http.spec.ts`
**EXIT 1 — 20 passed, 1 failed**, the only failure being the old
`releases metadata only: … no signed read …` assertion (`JSON.stringify(page)` now matches
`downloadUrl|previewUrl`). No other test moved; no locator was present in that payload.
log `<scratch>/suites-before.log`.

B) Owned suites on the read-capability bytes (`078901c9`): **EXIT 0 — 2 suites, 23/23 tests**
(21 pre-existing + 2 new). log `<scratch>/suites-final2.log`.

B2) Owned suites during the correction, kept honestly: the first successor run was **EXIT 1 —
26 passed, 3 failed**, and the second **EXIT 1 — 28 passed, 1 failed**; both were defects in the
new TEST harness fidelity, not in the production recheck (a chain read handed back a live row
object, so the simulated drift rewrote the snapshot it was compared against; and one simulated
digest equalled the fixture's). Verbatim witness text from those runs:

```
● … › keeps the explicit historical window: an anchor reaches its own chain only
  NotFoundException: Attachment history is unavailable
  at reconstructChain (src/engagement/attachments/client-file-history.ts:429:40)
  — the second chain's fixture rows still carried a cross-chain forward link, so the
  walk saw two predecessors (a fork) and refused, exactly as designed.
● … › refuses the whole page when the version key, digest, ownership or readiness moves while it is signed
● … › withholds every version when a single released row disagrees, never a partial chain
  Error: expected the request to be refused
  — no refusal, because the mock returned the live row the drift hook had rewritten.
```

Both were fixed in the harness only; the production recheck code was not changed to make them
pass. Final: **EXIT 0 — 2 suites, 29/29 tests** (23 + 6 new). log `<scratch>/suites-correction.log`.

C) Bounded strict transitive TypeScript (recipe `work/native-file-history-types-bounded.json`
adapted to this worktree in a new task-owned config `<scratch>/tsconfig.read-bounded.json`:
extends this worktree's `apps/api/tsconfig.json`, `types [node, jest]`, typeRoots from the
junctioned `node_modules`, `files` = the two owned specs, `include []`):

```
node.exe --max-old-space-size=8192 node_modules/typescript/bin/tsc -p <scratch>/tsconfig.read-bounded.json \
  --noEmit --pretty false --tsBuildInfoFile <scratch>/tsc-read-final2.tsbuildinfo
```

**EXIT 0 — log 0 bytes.** log `<scratch>/tsc-read-final2.log`.
Re-run on the SUCCESSOR bytes with the SAME recipe: **EXIT 0 — log 0 bytes**
(`<scratch>/tsc-correction.log`).

D) Boundedness proof (so C cannot be a silent no-op): same config plus `--listFiles` → EXIT 0,
2422 files, **0** references to `../api-strategy` or `../intel-api`, and the program contains this
worktree's `engagement.service.ts`, `attachments/client-file-history.ts`,
`client-file-history.spec.ts`, `client-file-history.http.spec.ts` and `engagement.controller.ts`.
log `<scratch>/listfiles.txt`. Re-run on the SUCCESSOR bytes: EXIT 0, 2422 files
(2322 `.ts`), **0** foreign-project references, and the program still contains this worktree's
`engagement.service.ts`, `attachments/client-file-history.ts`, `client-file-history.spec.ts` and
`engagement.controller.ts`. log `<scratch>/listfiles-correction.txt`.

E) Generated-fixture dependency check (no refresh needed): the repo's own generator
(`apps/api/scripts/engagement-phase0-route-manifest.ts`) → EXIT 0, stderr 0 bytes, 112739 bytes,
`cmp` vs the committed fixture CLEAN and both sha256 `85ad8a3fe64326af2302945018004ebbb4779956f2232e866bbc6347c72e7673`.
The fixture was NOT refreshed. (The generator's `tsx` resolved from a shared pnpm store outside this
worktree — read-only execution, no repo or cache write.)

F) **NOT RUN, explicitly:** `eslint` and `prettier` are not present in this dependency set
(`node_modules/eslint`, `node_modules/prettier` do not exist) and no install is permitted, so no
lint/format gate was claimed. Long lines introduced here were manually kept within the repo's
`printWidth: 100` for code; `.prettierrc.json` was not edited. The broad `apps/api` typecheck
(473 diagnostics, dominated by sibling-project classes) was NOT re-run.

## 5. The change

The gap: `EngagementService.listAttachments` is deliberately current-only
(`supersededByAttachmentId: null`) and that is what makes `supersedeAttachment` look like a delete
to every ordinary reader — so a superseded version's row, key and stored object survived with **no
read surface at all**.

The remedy reuses the existing canonical signed-read owners instead of adding a byte endpoint:

1. `client-file-history.ts` now selects `s3Key` — for ONE purpose: minting that version's own
   signed link. It is never projected, never returned, never accepted from a caller, so a version
   can never be pointed at another object.
2. `ClientFileHistoryOwner` gains `links(row)`, implemented in `EngagementService.listAttachmentHistory`
   with the SAME two owners the list uses for a readable row:
   `createAttachmentDownloadUrl(row.s3Key)` and `createAttachmentPreviewUrl(row.s3Key, row.contentType)`.
   Both keep their own controls: `null` when no bucket, and `null` preview outside
   `INLINE_PREVIEWABLE_CONTENT_TYPES` (pdf/png/jpeg/gif/webp); `expiresIn: 300`; forced `attachment`
   disposition for downloads, allowlisted `ResponseContentType` for inline previews.
3. Minting happens **only after** the page's release-time current-access recheck, **only** for this
   page's own rows, and **only** for a version whose readiness verdict says it may be used. A
   suppressed, revoked, quarantined, blocked or being-deleted version keeps the no-link state
   (`downloadUrl: null`, `previewUrl: null`) and the signing owner is never even asked.
4. Nothing else changed: chain reconstruction and its bounds, per-member authorization, cursor
   digest/binding, page-size validation, refusals, ordering and every other projected field are
   byte-for-byte the reviewed behaviour. The current-only predicate on the ordinary list is NOT
   weakened; no raw S3 bridge, no second store, no storage VersionId, and no extraction/provider/
   model/indexing call rides this read.

### 5.1 Correction (successor commit): the released version is verified AFTER it is signed

The `078901c9` release order was: authorize every member → authorize the page → **mint each usable
version's own signed URLs** → project. Two awaits (`uploaderNames`, `Promise.all` signing) sit
between the page recheck and the response, and the per-version owner re-read only
`id`/`lifecycleStatus` while comparing ownership against the ORIGINAL row it was handed. So a
version revoked, deleted, quarantined, re-keyed or re-parented DURING the signing window could
still be released with a working bearer URL.

The successor adds one narrow, explicit final phase, `owner.recheck(row)`, run for every row of the
page AFTER every signing call has completed:

1. the SAME canonical current-access owner (`authorizeAttachmentVersion`, unchanged) — so a
   revocation, a deletion and a prospect `delete_pending`/`delete_failed` suppression refuse again
   here, at the last possible moment before release;
2. then ONE identity re-read of the durable row through the same canonical
   `tenant + attachmentViewerWhere(actor)` predicate, selecting only the columns a released read
   depends on (`CLIENT_FILE_HISTORY_IDENTITY_SELECT`): the version's own `s3Key` and
   `calculatedSha256`, its ownership/parentage and chain position (`source`, `sourceEntityType`,
   `sourceEntityId`, `prospectId`, `clientId`, `meetingId`, `mailMessageId`,
   `supersededByAttachmentId`) and its readiness inputs (`lifecycleStatus`, `scanStatus`).

`sameVersionIdentity` compares that identity with the row the page authorized and withholds the
WHOLE page (`404 CLIENT_FILE_HISTORY_UNAVAILABLE`) on any disagreement or refusal. It is deliberately
narrow: `fileName`, `folder`, `byteSize`, `createdAt` and the uploader label are NOT identity, and a
change there never refuses a page — the capability's identity is the object key + digest +
ownership the URL actually addresses, not display metadata. Readiness agreement is decided on
`lifecycleStatus` + `scanStatus` (a pure function of those plus the owner's `scanRequired`), which is
why a quarantine or scan-state change inside the window refuses.

Unchanged by the correction: the route, the response shape (no new field — §6 is still exact), the
canonical signing owners and their inherited `expiresIn: 300` lifetime, the current-only list
predicate, the no-link states, every refusal code, the cursor contract and the chain bounds. No new
endpoint, store, registry, schema, package or revocation platform was added; nothing is repaired,
rewritten or recomputed (no digest is ever manufactured), and the final phase performs no write, no
byte read and no extraction/provider/model/indexing call.

Cost: one canonical access read plus ONE narrow projection read per released version (≤ page size, so
≤ 50 each), inside the same read-only snapshot the metadata pass already uses. The added tests prove
the positive case (an unchanged historical original is still released, with the final phase visibly
run) and the negative cases (key, digest, source identity/kind, parent ownership, chain position,
lifecycle, scan state, revocation and physical deletion during the signing window all withhold the
whole page — including when only the LAST of four rows disagrees).

## 6. Receiving shape for the M5 Files consumer

`GET /api/engagement/attachments?historyOf=<attachmentId>[&historyCursor=<opaque>][&historyPageSize=1..50]` → 200:

```
{ attachmentId, originalId, headId, versionCount, pageSize, offset, hasMore, nextCursor,
  versions: [ { attachmentId, versionIndex, isOriginal, isCurrent, fileName, contentType, byteSize,
                createdAt, folder, uploadedByUserId, uploadedByName, source, sourceEntityType,
                sourceEntityId, contentHash, lifecycleStatus, scanStatus, usable,
                downloadUrl: string|null,      // NEW — signed read of THIS version's own bytes
                previewUrl:  string|null,      // NEW — inline preview, allowlisted types only
                blockedReason?, scanDisclosure?, supersededByAttachmentId } ] }
```

Every version keeps its own identity: its own attachment UUID, its own `calculatedSha256`, its own
stored object (the link is minted from that version's key — never the head's). Only the exact
engagement attachment UUID is a version identity; no `s3Key`, bucket, storage VersionId or other
locator is ever projected.

## 7. Current authorization semantics (unchanged, restated)

Reconstructed chain → **every member** authorized → cursor/digest/offset → page slice → **page
re-authorized (release-time recheck, including prospect `delete_pending`/`delete_failed` parity)**
→ links minted for usable rows → **final post-signing recheck of every released row (canonical
current access + version-identity agreement, §5.1)** → projection. Per-version authorization is the
existing owner stack:
tenant + `attachmentViewerWhere(actor)` re-read for the exact row; `requireProspectScope` for a
prospect row (with the canonical prospect read-mode deletion suppression); `validateAttachmentParents`
for an `incoming_mail` row (mail visibility + client wall); `assertHearingRecordDocumentAccess` for a
hearing-record document. Refusals: 404 `Attachment not found` (hidden/foreign/unknown anchor),
404 `CLIENT_FILE_HISTORY_UNAVAILABLE` (any member failing current access, suppression, missing/
branched/cyclic/over-bound chain), 409 `CLIENT_FILE_HISTORY_CURSOR_STALE`,
400 `CLIENT_FILE_HISTORY_CURSOR_INVALID` / `CLIENT_FILE_HISTORY_PAGE_SIZE_INVALID`.

## 8. Limitations and disclosures

- **MM-11 is NOT closed by this commit.** This is the Core engagement-attachment slice: bounded
  version list + per-version re-authorization + a signed read of a selected version. M5 still owns
  the Files consumer, A5 owns Core clio attachment-read-v2 / Meri upload and native paths, and
  MM-12 custody / MM-13 adapter remain A5-owned.
- The read is a **time-limited signed URL to the exact version's stored object** (`expiresIn: 300`),
  exactly like the existing list read for current rows: within that window a later revocation cannot
  retroactively invalidate an already-minted URL. Core never reads the bytes itself and mints no
  storage locator; the client fetches the object directly, subject to the bucket policy.
- F4 (review finding, materially narrowed by §5.1): signing is still not transactional with the
  authorization read. A revocation, deletion, quarantine or identity change landing DURING the
  signing window now withholds the whole page, but the interval between the final recheck and the
  client's use of an already-minted URL remains open by construction: a bearer URL cannot be
  recalled, so a revocation inside that residual window is caught by the next request, not
  retroactively. This change deliberately does not add a revocation platform.
- The historical window itself is unchanged and still explicit: history is the ONE chain containing
  the anchor (bounded by `CLIENT_FILE_HISTORY_MAX_VERSIONS` = 200 and a page size of 1..50). Two
  documents that merely share a client or a folder are separate chains and never mix.
- Type evidence is bounded, not whole-repo: the bounded program (§4C/D) is the touched evidence.
  The 473-diagnostic full `apps/api` typecheck remains a separate, unre-run limitation.
- Lint/format gates are NOT RUN (dependencies absent) — see §4F.

## 9. Evidence locations and next action

- Author handoff for the read capability (commit `078901c9`):
  `outputs/WAVE5-NATIVE-FILE-HISTORY-READ-AUTHOR-HANDOFF.txt`.
- Author handoff for this correction (successor commit, exact head/tree and checks):
  `outputs/WAVE5-NATIVE-FILE-HISTORY-READ-CORRECTION-AUTHOR-HANDOFF.txt`.
- Claim written before the edits: `work/hermes-authoring/native-file-history-read-CLAIM.txt`.
- Logs: `C:/ProgramData/Hermes/cache/scratch/w5nfh-read/{suites-before,suites-final2,suites-correction,tsc-read-final2,tsc-correction}.log`,
  `listfiles.txt`, `listfiles-correction.txt`, `read-gen.json`, `read-gen.err`,
  `tsconfig.read-bounded.json`, `mkjunctions.cjs`.
- Next action: A5 coordinates independent review of this candidate and the final source union; the
  M5 Files consumer should bind the two new per-version fields from §6.
