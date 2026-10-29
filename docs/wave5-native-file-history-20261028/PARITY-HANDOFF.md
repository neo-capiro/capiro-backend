WAVE5 NATIVE FILE HISTORY — PROSPECT DELETED-STATE PARITY (author handoff)
=========================================================================
LOCAL SOURCE AUTHORED — this is author evidence, NOT an independent SOURCE PASS and
not a deployment acceptance. Role: Hermes implementation worker (narrow successor
correction of review finding F1). The original author bytes at
255b1e36fa627aa7e535b462e59ee51dbe22efed and the independent review report were left
untouched; this is a NEW worktree that starts from that frozen head.

--------------------------------------------------------------------------------
1. SHARED POLICY BOOTSTRAP (recorded)
--------------------------------------------------------------------------------
Repository : C:\dev\capiro-agent-ops
Policy SHA : b32b4803933760dc0a93fffdcd8fba30a89c3aac  (git status --porcelain clean)
Read       : BOOTSTRAP.md, AGENTS.md, hermes/OPERATING.md, machine-paths.local.yaml,
             work/hermes-authoring/AGENTS.md (Wave 5 isolated authoring rules).
Inputs     : S/outputs/WAVE5-NATIVE-FILE-HISTORY-HERMES-REVIEW.txt, sha256
             f326648105e271ead10a89eee9af521beeaaff18c7c08d6f2e306a5d79a623a0 (verified
             before reading), finding F1; work/native-file-history-parity-prompt.txt.

--------------------------------------------------------------------------------
2. EXACT GIT STATE — PINS
--------------------------------------------------------------------------------
Checkout : S/work/wave5-native-file-history-parity-20261028   (new, task-owned)
Branch   : codex/wave5-native-file-history-parity-20261028
Parent   : 255b1e36fa627aa7e535b462e59ee51dbe22efed  (tree 2db5e10f7a3c910472111d1c7d24300a200cdaed)
"Parent" is the frozen head this branch was cut from (git worktree add; the review
PASS covers exactly those bytes and they are unchanged in their own checkout).
This branch carries ONE commit; its exact sha/tree are recorded in
S/outputs/WAVE5-NATIVE-FILE-HISTORY-PARITY-AUTHOR-HANDOFF.txt and reproducible with
`git log -1 --format='%H %T'` in this worktree. Not pushed, no PR, no merge, no
amendment of any earlier commit or of the review report.
Dependencies: `node_modules/` and `apps/api/node_modules/` are read-only junctions to
the original 255b checkout (no install, no cache mutation, no lockfile change).

--------------------------------------------------------------------------------
3. EXACT SCOPE — 3 files, nothing else
--------------------------------------------------------------------------------
M apps/api/src/engagement/engagement.service.ts            (+26/-4)
M apps/api/src/engagement/attachments/client-file-history.spec.ts  (+106/-2)
A docs/wave5-native-file-history-20261028/PARITY-HANDOFF.md (this file)
No Prisma/schema/migration/module/shared-authority/registry/lock/package/frontend/
meri-research file is touched; no route, decorator, guard, role, DTO or response field
is added, removed or renamed.

--------------------------------------------------------------------------------
4. WHAT WAS RUN — EXACT COMMANDS AND RESULTS
--------------------------------------------------------------------------------
Node: "C:/Program Files/nodejs/node.exe" (24.22.1). Scratch: C:/ProgramData/Hermes/cache/scratch/w5nfh-parity

A) Owned suites, FINAL bytes (21 = the original 19 + the 2 new cases):
   cd <parity>/apps/api
   node.exe --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand \
     --no-cache --cacheDirectory=<scratch>/jest-cache --runTestsByPath \
     src/engagement/attachments/client-file-history.spec.ts \
     src/engagement/attachments/client-file-history.http.spec.ts
   RESULT: EXIT 0 — Test Suites: 2 passed, 2 total; Tests: 21 passed, 21 total.
   log <scratch>/parity-owned-specs.log

B) Bounded strict transitive TypeScript, recipe from
   S/work/native-file-history-types-bounded.json adapted to THIS worktree in a new
   task-owned config (<scratch>/tsconfig.parity-bounded.json: same shape — extends the
   worktree's apps/api/tsconfig.json, types [node, jest], typeRoots from the junctioned
   node_modules, files = the two owned specs, include []):
   node.exe --max-old-space-size=8192 node_modules/typescript/bin/tsc \
     -p <scratch>/tsconfig.parity-bounded.json --noEmit --pretty false \
     --tsBuildInfoFile <scratch>/tsc-parity.tsbuildinfo
   RESULT: EXIT 0 — log 0 bytes (no diagnostics).
   log <scratch>/parity-bounded-tsc.log

C) Boundedness proof, so (B) cannot be a silent no-op:
   same config plus --listFiles → EXIT 0; 2322 files in the program; 0 references to
   ../api-strategy or ../intel-api; and the program CONTAINS this worktree's
   client-file-history.ts, client-file-history.spec.ts, client-file-history.http.spec.ts,
   engagement.service.ts and engagement.controller.ts — so the changed production file
   is typechecked transitively by (B), not just the specs.
   log <scratch>/parity-listfiles.txt

D) Generated-fixture dependency check (was a fixture refresh needed? No):
   cd <parity>/apps/api && GEN=$(node.exe -p "require.resolve('tsx/cli')")
   cd <parity> && node.exe "$GEN" apps/api/scripts/engagement-phase0-route-manifest.ts > <scratch>/parity-gen.json
   RESULT: EXIT 0, stderr 0 bytes; 112739 bytes written; `cmp` against the committed
   fixture apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json is
   CLEAN and both sha256 start 85ad8a3fe64326af2302.
   Therefore: the committed generated fixture is still exactly this worktree's generator
   output and was NOT refreshed — the parity change is in the service, which the
   controller-driven generator does not read. (tsx resolves through a retained
   exact-lock cache outside this checkout; that is the repo's own test wiring and the
   fixture was not written — stdout mode.)

--------------------------------------------------------------------------------
5. THE CORRECTION (F1) AND ITS VERIFICATION
--------------------------------------------------------------------------------
F1 as reported: prospect versions in lifecycleStatus delete_pending/delete_failed were
released as history metadata, while the existing engagement list hides exactly those
rows; authorizeAttachmentVersion substituted requireProspectScope for
assertProspectAttachmentAccess, whose read mode enforces
{ supersededByAttachmentId: null, lifecycleStatus: { notIn: [delete_pending,
delete_failed] } }. Dropping the superseded condition is REQUIRED for history to work;
dropping the lifecycle condition was a separate, undocumented consequence.

Implemented, in EngagementService.authorizeAttachmentVersion only:
- the per-version current-access re-read (which already ran in BOTH passes) now selects
  `{ id, lifecycleStatus }` instead of `{ id }`;
- for a prospect row (row.prospectId), a re-read lifecycleStatus of delete_pending or
  delete_failed throws the same canonical refusal the prospect read owner throws
  ('Prospect resource not found', NotFoundException). The history release path turns any
  refusal from the canonical owner into 404 CLIENT_FILE_HISTORY_UNAVAILABLE, so the WHOLE
  chain is withheld — never a partial history;
- the doc comment now states the second condition explicitly, which is what F1 asked for.
Because the check reads the row AS RE-READ rather than the chain snapshot, it holds on
both passes: the admission pass refuses before any metadata, count, cursor or display
name is built, and the existing release-time recheck refuses a deletion that starts
between the reconstruction and the release.
Unchanged: tenant + viewer predicate, requireProspectScope, mail/hearing parent checks,
assertHearingRecordDocumentAccess, chain reconstruction/bounds/cursor digest, the
response contract and every original field. Client-file rows are untouched by design, as
in the list, whose prospect branch is the only one that conflates suppression with
visibility.

New/changed checks in the owned spec (all 21 pass):
- positive parity: a superseded PROSPECT version is still released as metadata
  (versionIndex/isOriginal/isCurrent = 1/original, 2, 3 current) — supersession alone
  never suppresses;
- a superseded prospect member with delete_pending refuses the whole history from any
  anchor, with `readiness` and the uploader-name lookup NOT called (nothing assembled);
- a prospect head with delete_failed (the stranded row awaiting the retry sweep) refuses;
- a prospect member with a non-delete non-ready lifecycle (quarantined) is still released
  and disclosed as unusable — suppression is exactly the canonical delete pair;
- a CLIENT-file row with delete_pending is still released (usable:false,
  ATTACHMENT_NOT_READY) — the correction is prospect-scoped, not a blanket filter;
- a deletion that starts between the chain read and the release refuses the page, with
  nothing released.
The harness mock now models the re-read faithfully (it projects exactly the requested
columns and can flip the durable lifecycle after the admission pass), so these refusals
are produced by production code, not by test doubles agreeing with themselves.

--------------------------------------------------------------------------------
6. FINDINGS RECORDED (F2) — source inspection only, no speculative redesign
--------------------------------------------------------------------------------
F2 (query count near the 200-version bound) inspected and bounded, NOT executed:
- reconstructChain runs inside ONE read-only RepeatableRead transaction:
  1 anchor lookup + (N-1) predecessor lookups + 2(N-1) successor/claimant lookups
  = 3N - 1 queries. At the CLIENT_FILE_HISTORY_MAX_VERSIONS = 200 bound that is 599
  queries in that single transaction.
- per-member authorization then opens N `withTenant` transactions (the visibility
  re-read), plus one more per prospect member (requireProspectScope) and one more per
  incoming_mail member (validateAttachmentParents); `assertHearingRecordDocumentAccess`
  costs zero queries unless sourceEntityType = 'hearing_record_brief'; the release pass
  adds min(N, pageSize) transactions and uploaderNames adds 1. At N = 200 that is about
  251 further transactions.
- timeout: `PrismaService.withTenant` accepts opts { timeoutMs, isolationLevel,
  readOnly } and passes transaction options ONLY when timeoutMs or isolationLevel is
  given — it configures NO default timeout/maxWait, so Prisma's own defaults apply
  (interactive transaction timeout 5000 ms, maxWait 2000 ms). The history call site sets
  isolationLevel + readOnly and does NOT raise timeoutMs; the per-member calls pass no
  opts at all. So on a very long chain a transaction timeout could surface instead of the
  intended honest refusal.
- This correction is query-neutral: it adds one column to an existing read and adds no
  query, no transaction and no new bound. Per the brief, no timeout redesign and no
  broad database gate was attempted; proving F2 needs a live database, which this task
  is not authorised to touch.
F3 (informational, disclosure): unchanged and already stated by the review — the
regenerated fixture diff is 167 -> 170 routes and the pre-edit claim outline says "no
route-manifest change" while the fixture DID change. Neither was altered here.

--------------------------------------------------------------------------------
7. INHERITED (NON-OWNED) FAILURE — EXPLICITLY NOT GREEN
--------------------------------------------------------------------------------
apps/api/src/engagement/engagement-route-manifest.spec.ts remains RED in this
worktree, exactly as it was at the base and at the reviewed head, for the inherited
reason the review recorded (its newsletter authoring literal hard-codes 6 signatures
while the source declares 8). It was NOT re-run here (the brief scopes this task to the
owned suites plus the bounded typecheck), it was NOT edited, and no CI-green claim is
made for it. The full API typecheck (473 project-wide diagnostics) also remains NOT RUN
and NOT claimed green in this task.

--------------------------------------------------------------------------------
8. LIMITATIONS AND NOT-RUN (explicit)
--------------------------------------------------------------------------------
- No database, no AWS, no browser/Playwright, no provider/model call, no build, no
  deploy, no push/PR/merge: NOT RUN. Everything here is source plus mocked-Prisma tests.
- No visual/pixel surface changed, so no screenshot or vision-judge step applies; no Meri
  prompt/tool/retrieval/state surface changed, so no Promptfoo/DeepEval run applies.
- Historical version BYTES still have no download path (the existing byte owner remains
  current-version-only). This correction does not add one and MM-11 is NOT closed by it:
  that residual belongs to M5/A5 and stays open.
- F2 was inspected from source, not executed (no DB authorised).
- Only the two owned suites and the bounded strict typecheck were run; the manifest suite
  and the broad API typecheck were deliberately not re-run.
- This is author evidence only: no independent review or acceptance of these bytes exists yet.

--------------------------------------------------------------------------------
9. CLOSEOUT SUMMARY
--------------------------------------------------------------------------------
Delegated work : none; no subagents, no messages. Everything here was performed directly.
Source changed : one existing service method (listAttachmentHistory's per-version
                 authorize owner) and its focused owned spec, plus this handoff.
Exits          : owned suites EXIT 0 (21/21); bounded strict tsc EXIT 0 (empty log,
                 2322-file bounded program, 0 foreign-project refs, owned production
                 file in program); listFiles EXIT 0; generator EXIT 0 with the committed
                 fixture byte-identical (no refresh needed); worktree clean at closeout
                 apart from this single commit.
Requirement    : F1 satisfied with exact list parity for prospect delete_pending /
                 delete_failed, enforced before metadata/counts and again at release,
                 with the chain identity, cursor, metadata contract and all original
                 fields unchanged; F2 recorded with exact query bound and the withTenant
                 timeout default; F3 left as disclosed.
Still open     : independent review of these bytes; M5 Files consumption; deployed
                 acceptance; historical version bytes (M5/A5); the inherited manifest-literal
                 failure; F2's live-database proof.
