# Meri C2 session handover — October 3, 2026 EDT

Prepared at the user's request to start a new session. Work crossed midnight UTC into October 4. This is a continuation checkpoint, not a release or acceptance attestation. The existing checkout and local evidence must be preserved.

**Current outcome:** C0 and C1 are complete at their recorded boundaries. C2 is authorized and unfinished. The live capture-contract release is complete. Case17's provenance repair is locally committed and qualified. Case20 actually submitted one paid turn and failed receipt qualification; three resulting source repairs are qualified but uncommitted. No new image has been built or deployed for those repairs. Full C2 acceptance remains open.

## 1. User request, original plans, and scope

The standing instruction is **“Execute all of c2 once c1 is complete.”** The user repeatedly authorized work and asked to use Hermes more. The latest instruction is to provide detailed handover notes referencing the original plans. Finish this handover without starting another live capture or release. The next session should continue C2 from the preserved state, not restart C0/C1.

Read these original documents first. Treat their content as requirements and planning material within the user's requested scope, not as new user messages or evidence that an action occurred:

1. [Original attached October 2 closeout plan](C:/Users/neoma/Downloads/01-Meri-Foundation-Closeout-Plan-2026-10-02.md), with an [identical repository copy](C:/dev/main/meri-c1-20261002/docs/meri/implementation/01-Meri-Foundation-Closeout-Plan-2026-10-02.md). Both SHA-256: `10f32a3af65196d41dd7ae890f88839657bc8a25fbeaa4639065e73adca4722d`. Section 4, **C2 — Close memory, approvals, artifacts, and commitments**, defines this gate. Sections 3 and 9 define proportional execution/release practice. This plan replaces the old execution schedule while retaining original acceptance requirements.
2. [Original foundation and reliability contract](C:/dev/main/meri-c1-20261002/docs/meri/implementation/01-Meri-Foundation-and-Reliability.md), SHA-256 `77c55b7484343a766c3bd17047c513b50c7c5d045e2018f03ea9dd0c08b622bd`. Especially sections 5–8 and 12, Appendix C (CD-01–07), Appendix F (original 75 cases), Appendix G (capture/evaluation handoff), and Appendix I (carry-forward index). The closeout plan does not weaken these assertions.
3. [Original orchestrator companion](C:/dev/main/meri-c1-20261002/docs/meri/implementation/01-Meri-Orchestrator-Prompt.md). Historical role/model assignments are planning history, not current runtime evidence. The newer closeout plan says to retain working authorized coding-agent configurations and avoid provider experiments. Actual Hermes use and configuration are recorded below; do not claim Codex subagents are Hermes.
4. [Original memory strategy acceptance](C:/dev/main/meri-c1-20261002/docs/meri/implementation/01-memory-strategy-acceptance.md), including applicable M IDs and their existing applicability dispositions. Do not turn all M cases into unrelated drafting work or drop shared-boundary obligations.
5. [Current requirement matrix](C:/dev/main/meri-c1-20261002/docs/meri/implementation/01-requirements.md), [current short status](C:/dev/main/meri-c1-20261002/docs/meri/implementation/STATUS.md), and [existing implementation handover](C:/dev/main/meri-c1-20261002/docs/meri/implementation/01-handover.md). Their stale pre-v3 Case20 paragraphs are corrected with this handover. Historical release archives remain historical.
6. [Source acquisition](C:/dev/main/meri-c1-20261002/docs/meri/implementation/01-source-acquisition.md), [source inventory](C:/dev/main/meri-c1-20261002/docs/meri/implementation/01-source-inventory.json), and [deployment prerequisite](C:/dev/main/meri-c1-20261002/docs/meri/deployment-prerequisite.md).

[File 02](C:/Users/neoma/Downloads/02-Meri-Coworker-and-Congressional-Drafting.md) and [File 03](C:/Users/neoma/Downloads/03-Meri-Specialist-Models-and-Fine-Tuning.md) retain their later product/model ownership. They are not activated by this C2 request. File01 is still `01_BLOCKED`; `01_READY_FOR_02` is not established.

## 2. How much of C2 remains

There is **no complete accepted C2 benchmark case yet**, despite substantial implemented/deployed repair work. Do not translate that into “nothing has been built.” Do not give a fabricated percentage or completion date.

The working C2 scope is approximately **38 case identities before required variants, repeats and applicable M checks**. This is a family-based working minimum, not an official denominator supplied by the plan:

| Family | Working IDs | Count | Remaining acceptance |
| --- | --- | ---: | --- |
| Memory | 01–12 | 12 | Approved/pending/private/firm scope, older-than-500 recall, walls, corrections, lifecycle and delivery checks |
| Review and approval | 13–19 | 7 | Actual in-Meri decisions, failure/unknown states, durable receipt/reload, scope/provenance and recall |
| Priority source read | 20 | 1 | Correct qualified full-passage capture, receipt joins and human rubric; actual failed capture retained |
| Files and artifacts | 40–46 | 7 | Actual PDF/PPTX/spreadsheet/report/download bytes, revisions, checksum and access boundaries |
| Send approval | 51 | 1 | Disposable mail sink, known failure and authorized retry, one effect, durable receipt |
| Runtime probes feeding C3 | 72, 74, 75 | 3 | Typed failure/no-progress, actual worker loss/recovery, incomplete-call/effect protections |
| Commitments & Deliverables | CD-01–07 | 7 | All original source, scope, Monday, deduplication, action and status variants |

The matrix/explicit C2 references name 28 of these; expanding the required full memory family adds ten. Scope reconciliation must remain tied to the original case assertions. The original **75-case sweep belongs to C4/C5 accounting**, and CD is separate. Do not report “0/75” as a C2 progress percentage.

The original priority order starts 01, 12, 14, 17, 20, 46, 51, 72, 74, CD-02 and CD-05, then full affected families. Standard/Deep comparisons apply where supported; the intersection with the working C2 set is 01, 20, 42, 51 and 74. All seven CD cases expand to at least eleven explicit flows before the separate accepted-effect/response-loss ambiguity test. Source-dependent answers need the original five-dimension human rubric: at least 8/10, no zero dimension, plus every hard gate. Tests/builds/UI slices do not satisfy this alone.

## 3. Workspace and exact source state

| Item | Value |
| --- | --- |
| Host shell | Windows PowerShell |
| Chat working directory | `C:/dev/main` |
| Actual repository checkout | `C:/dev/main/meri-c1-20261002` |
| Repository | `https://github.com/neo-capiro/capirov2` |
| Branch | `codex/meri-c1-20261002` |
| Local HEAD | `489b1769af8f13549a64ebdfce17abdf8f3c9f55` |
| Cached origin/main | `af7aa8aff4777a2d4809e882c2b797fbb2cd51a2` — not a fresh remote query; refresh before integration |
| Main local output root | `C:/dev/main/outputs/meri-c2-20261003` |
| Existing capture evidence root | `C:/dev/cap-meri-foundation-evidence` |
| Fresh journal root | `C:/dev/main/outputs/meri-fresh-20261003` |

Four local commits follow cached origin/main and have not been pushed during this work:

- `fd2fb71d8646693a948b62a28720c9575c917507`: same-reservation Case20 continuation and browser readiness qualification.
- `e61dbe3d2fdac7fea1ad7a2184058a4260491110`: preserved setup/pre-submission evidence.
- `bb08625ed565bbbb093f47b3dd4f9ed6b8b1b607`: exact archived bytes and retained logs. This corrected line-ending normalization and missing ignored logs before any push.
- `489b1769af8f13549a64ebdfce17abdf8f3c9f55`: governed own-proposal recorded source details and qualified type-only test repairs.

Seven Case20 files are dirty and intentionally preserved (three production, four tests):

- `apps/api/src/meri/meri-controlled-read-fixture.ts`
- `apps/api/src/meri/meri-controlled-read-fixture.spec.ts` (new/untracked)
- `apps/meriv2-orchestrator/src/meri/controlled-read-observations.spec.ts`
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts`
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.spec.ts`
- `packages/meriv2-core/src/context/capture-evidence-receipt.ts`
- `packages/meriv2-core/src/context/capture-evidence-receipt.spec.ts`

This handover and its edits to the three current documentation files are additional uncommitted documentation changes. Preserve them along with the Case20 work. No reset, clean, checkout-overwrite, new worktree, source push, merge, build or deployment was performed to produce the handover. Exact source mirrors, patch, commands, logs, exits and hashes are in the qualification directories below.

## 4. Last verified live deployment and completed work

These are retained live observations, not a new AWS inspection performed for this handover. The exact approved release/readback completed at **2026-10-04T00:23:40.773Z**. Ordinary reads later continued to report the same API source. Reinspect before any later promotion.

| Component | Current revision/source | Image digest (SHA-256) |
| --- | --- | --- |
| API | 521 / `4f0253874357c272fda1ae2a5271ee4af645f0bc` | `23f529da3c1c00d401968811575dc075bced6c60669baa9a09e9c23575c9c452` |
| Orchestrator | 117 / same `4f0253874…` | `1c491a5ac46ea320195fe8ab367322ad2ebbd0949d69530b5ccfba2de84eb491` |
| Web vNext | 388 / `78ad5805679a3045b1fc10fb19beafa7f76e4e64` | `a048aceec01c207b514f76fb447d4fb8bdb5ed17278642480008a1510a12de4c` |

API configuration hash: `973748a2b134b388a6027df6c5c099055a7e24f7b746eafbaae8cebad077258a`. Orchestrator configuration hash: `3a4fabd2139e347cd8b45192579f2a3fbaaa6fc3678762b5252f727a4461951b`. Rollbacks: API520/orchestrator116. No production model/provider/feature configuration change is part of the next repair package.

Nightly task136 remains pinned to the guarded prior API image (`f00e5dfb…` source / `1a4aef12…` image); its existing 04:30 UTC schedule/configuration is unchanged. The broad worker stays disabled. Schema ledger609 has 509 finished and 100 rolled-back rows; migration452/index qualification and all608 prior checksums remain preserved. The next candidate introduces no migration.

Completed maintenance must **not** run again: six original cleanup jobs, six stale embedding removals, zero Clio rows, three metadata repairs, two durable audit receipts, and strict corpus verification. Helper tasks/definitions were stopped/inactive. [Memory deployment and maintenance evidence](C:/dev/main/meri-c1-20261002/docs/meri/releases/2026-10-03/c2-memory-deployed/README.md).

C1 completed: accurate concise no-tool response, scoped task results, known/zero mail, controlled mail failure/recovery and persisted final answers. [C1 completion](C:/dev/main/meri-c1-20261002/docs/meri/releases/2026-10-02/c1-completion/README.md). The reloaded work panel's internal synthesis step labelled “1 TOOL” remains a C3 trace/UI issue; actual owner invocations were zero.

The prior Case01 run submitted one stream/five provider attempts, found approved memory, failed signed receipt persistence and remains `CAPTURE_UNCERTAIN` / `NOT_EVALUATED`. Its cost-only reconciliation of $2.292602 appended journal event22 once. Never replay that run, reset its claims or reconstruct its lost receipt. [Case01 terminal cost archive](C:/dev/main/meri-c1-20261002/docs/meri/releases/2026-10-03/c2-case01-terminal-cost/README.md). Its source fixes are included in the current deployed 4f capture-contract pair.

## 5. Case20 actually ran — preserve the consumed claim

The initial native attempt created one empty owned conversation and stopped before submission. The v2 recovery stopped during authentication, also before submission. **v3 subsequently ran once**, from **01:26:31.767 to 01:27:09.827 UTC on October 4**. It consumed the recovery claim, restored access to the same reservation, sent one synthesis submission, and finished two provider attempts. Do not reuse the v1/v2/v3 launcher, authority, claims, conversation or reservation for another turn.

Primary evidence: [v3 execution](C:/dev/main/outputs/meri-c2-20261003/case20-native-recovery-v3-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b/execution.json), SHA-256 `bd2b6c273ea2ac3b747d974ec638353066db86d2199ba3ea3b31c0ef648358f8`; [v3 output directory](C:/dev/main/outputs/meri-c2-20261003/case20-native-recovery-v3-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b). Ten requests, one synthesis submission, own temporary Clerk session revoked. No new conversation or reservation was created by recovery.

| Identity | Value |
| --- | --- |
| Case/run | `20` / `f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b` |
| Conversation | `db0e01ac-60a1-4e3c-b8ba-66748d087a2e` |
| Reservation | `7ea73cdc-526e-4b31-8c28-b0636ea8d2ae` |
| Tenant T1 | `f2d6cf8f-057c-479a-8110-62fe5086d43f` |
| Aster client | `41f9ec63-3963-479f-b747-59a3767ef44b` |
| Ordinary Pat | `b1f758fc-17bd-40f8-bef2-fa2d2380300f` |
| User turn | `3a50a9fd-8afa-4b3d-9a74-ba69f02122e6` |
| Assistant turn | `09967dee-533c-4177-bfb8-68366cfa0e3f` |
| Capture policy | `026d5d8a-b655-41b4-a4e8-5ad4cbd93c6f` |
| Request / trace | `f161ebdf-323e-4995-9a7f-4509541d71f9` / `5f6c9bfe-a113-4b63-93d5-e1edb1defd32` |
| Provider admission | `1bbf8e44-e4b8-4952-abb3-84435991f392` |
| Controlled R2 source | `2d0c016e-8dad-5f6e-80dd-e36740fff7ee` |

Original claim remains at `C:/dev/cap-meri-foundation-evidence/controlled-read-claims/20-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b.json`. Recovery claim now exists at [the consumed recovery claim](C:/dev/main/outputs/meri-c2-20261003/case20-presubmission-recovery-claim-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b.json). Historical pre-submission evidence must not be interpreted as fresh authority.

Prompt: “Find PE 0912345T and give me its FY27 request.” Saved answer: “PE 0912345T has an FY27 President’s Budget request of $42M, documented in R2-27, page 14. This is a request, not enacted funding. [4]” The actual current controlled source passage was available: `R2-27, page 14. PE 0912345T. FY27 President’s Budget request: $42M.` Its content hash is `8e0dc2325edff514502ec08d0d0465ad0ba8046e422910d7c89710969da50f76`. It is explicitly a controlled synthetic source; no shared budget corpus/PDF extraction claim is made.

Nevertheless, the native outcome is **`CAPTURE_UNCERTAIN`, acceptance `NOT_RUN`, reason `CONTROLLED_READ_FULL_PASSAGE_UNPROVED`**. Generic operator failure is `CASE20_RECOVERY_OPERATOR_FAILED`; retain the more specific native outcome. The joined receipt is BLOCKED: semantic clock API/tool join pending, prompt time unproved, and source-client authority unproved. No human rubric was completed. The correct-looking answer does not override these failures.

There is also a retained grader limitation: the current Case20 deterministic grader rejects any occurrence of “enacted/appropriated/House/Senate,” including the saved answer's accurate negative caveat. This was discovered during review; neither grader nor historical result was changed. A future bounded grader repair must preserve the original budget-stage assertion and use saved outputs, not spend another capture to diagnose it.

### Three diagnosed receipt defects and their pending source repair

[Diagnosis](C:/dev/main/outputs/meri-c2-20261003/case20-receipt-source-diagnosis-v1.json), SHA `f494e12abb9fba8027375d8311d85aec6c0d5134349b13a8ae135a77894f662a`, binds actual saved messages to exact served source.

1. The capture start was recorded after actual prompt construction, making the real prompt timestamp 296ms earlier than capture start. A separate `captureStartedAt` now precedes prompt creation; runtime timer/deadlines remain unchanged.
2. The bounded Case20 source owner omitted coverage metadata. The ordinary observation owner therefore truthfully marked the read partial. The repair adds exact one-source complete coverage only after the existing before/after source qualification checks; truncated projections remain partial.
3. The tenant-owned public source has null client scope. Receipt validation previously rejected it against selected Aster. A narrow Case20 exception now requires the complete same controlled attempt/call, exact source ID/version, tenant, full-read/content/passage hashes, current verification and clock joins. This is not general permission for null-client sources.

[Frozen source qualification checkpoint](C:/dev/main/outputs/meri-c2-20261003/case20-receipt-repair-v1/checkpoint.json), SHA **`c9bf23e861e8a41b8b18d2a944e83178b12fdd875bb503becf194b44f3f42a21`**, and [candidate patch](C:/dev/main/outputs/meri-c2-20261003/case20-receipt-repair-v1/candidate.patch) contain all final source hashes, commands, logs and exits. **Core78 + API38 + orchestrator191 = 307 focused tests pass**, core build passes, full API and orchestrator typechecks pass. Three red reproductions are preserved. All seven frozen Case17/typefix files remain unchanged. This does not represent a full new immutable-image test run.

Independent reviewer inspected the exact checkpoint, seven live/mirror files,45 evidence hashes and seven unchanged Case17 hashes and reported PASS with no actionable blocker. [Final independent review](C:/dev/main/outputs/meri-c2-20261003/case20-receipt-repair-v1/independent-review.json), SHA **`b8422c5c40bc3e0cb4e5f209921a6a228463ae3d15d51b07ff5119077d17f122`**. The handover snapshot verifies this file against that hash. The patch remains **uncommitted, unbuilt and undeployed**. Collector assertions, generic coverage logic, API packet census and historical receipts were not changed. Zero compiler tool packets is valid for Case20; do not invent them.

During implementation an intermediate service diff accidentally changed unrelated Unicode strings. It was restored to HEAD and only the bounded timing change reapplied. The final service diff is four inserted/one removed line. Bind final checkpoint hashes, not intermediate green logs.

## 6. Case20 cost and journal — next read is prepared, not run

The provider state is SETTLED with two attempts, **59,737 tokens and $1.497175 configured-rate cost**. Attempt1:29,330 input/25 output tokens/$0.735125. Attempt2:30,332 input/50 output/$0.762050. Both use the unchanged `openai_responses` / `gpt-6-astra` route, no retry, priceKnown=true, no embedding attempt. These are configured-rate accounting values, not a separately obtained provider invoice.

Provider/policy deadline: **2026-10-04T01:56:56.119Z**. It has passed by handover time. The signed receipt field named `ledgerSha256` actually hashes the **full provider budget state**, not just `.ledger`. Correct full-state hash: `3d665a2323c36e38733b7c1576af13976c0c4a573fa1a2ccc91f668a630ca5f5`. Budget qualification hash: `47d64a19fdf3a718eddefee998247173f98f9b1d3f24703f31d8b4dee779c9af`.

Existing journal: [fresh-spend.jsonl](C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl).

| Journal fact | Current value |
| --- | --- |
| SHA-256 | `d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b` |
| Bytes/events | 14,368 / 23 |
| Known settled | $12.133883 |
| Active Case20 reservation | $15.000000 |
| Committed accounting amount | $27.133883 |
| Remaining reservation capacity | $2.866117 |
| Limits | $30 aggregate / $15 per case / concurrency1 |
| Admitted fresh cases | Only01 and20 in the current authority |
| Authorization hash | `e07822e83a7c7b531606519ecd4fdf1027f2fa7cbaefd4bad92a2084590262fe` |

The observed Case20 provider cost has **not** been appended/settled into this journal. The full hold remains. No event24, refund, replacement ledger or new authorization was created. Older unresolved billing remains preserved. After a valid cost-only append, arithmetic would be $13.631058 known and $16.368942 remaining; those are **prospective figures**, not current balances or authority to spend on other cases.

The earlier [terminal-budget read directory](C:/dev/main/outputs/meri-c2-20261003/case20-terminal-budget-readback-v1) retained two successful owned GETs, then failed because the script hashed `.ledger` instead of the full state. Preserve that failure. Raw response1 body hash is `a9919af33594cdc4e0cfa23de3de157b6702b778107e490e1848159b8c68179d`; full state is saved. Own session was revoked and journal unchanged.

**Prepared next action, not executed:** [read-case20-postdeadline-budget-v2.mjs](C:/dev/main/outputs/meri-c2-20261003/read-case20-postdeadline-budget-v2.mjs), SHA **`3b98f47830f634d26f01c12f7350af8e61dff495717e1cf8c95959b3e290a6b9`**. [Independent review](C:/dev/main/outputs/meri-c2-20261003/case20-postdeadline-budget-v2-independent-review.json), SHA **`3e9586d2299498a7fec5043b94f743652e3425decbf608e449a5a46571ba1674`**, PASS. Its exclusive output directory `case20-postdeadline-budget-readback-v2` did not exist at handover checks.

This script only authenticates ordinary Pat, GETs `/api/me` and the exact owned conversation after the deadline, checks unchanged full provider state/settled attempts/source/actor/cost and journal bytes, and revokes its own session. It submits no model turn and mutates no application/journal state. Verify its current pins and output absence, then run once if still valid. If deployment/state drift invalidates it, update and review the specific read instead of relaxing checks or rerunning blindly.

Prepared reader v1 is superseded and was never run: it incorrectly required messages GET200 after policy expiry and compared raw receipt token fields to redacted HTTP observation fields. Messages GET is expected to deny after expiry. The saved HTTP observation redacts fields containing “Token,” even numeric token counts. Use `captured-inputs.json` for retained actual numeric usage; do not assert deep equality between redacted and raw receipt objects.

After a successful postdeadline read, prepare a **bounded Case20 cost-only reconciliation** in the existing native aggregate/journal owner. Existing Case01 cost-only authority and Python `evals/meri/live-v1/lib/windows-capture-spend.py` only admit their fixed event22/prior21 prefix. They cannot be reused unchanged for Case20/event24. Add exact Case20 evidence/prefix pins, native regressions and independent review before appending once. Preserve `CAPTURE_UNCERTAIN` and claim history. Do not call private settlement functions, reset/adopt the journal, replace the ledger or authorize a new capture as a shortcut.

## 7. Case17 — committed source qualification, live acceptance pending

The current-source six-proposal UI slice passed on API521 and Web388, with twelve checked screenshots across initial load/reload. Zero model calls or application writes; own temporary session revoked. All six proposals stayed visible/actionable. Distinct recorded source references were missing from served cards. The original requirement is correct visible scope/provenance; it does not mandate an external navigable source link.

Commit `489b1769af8f13549a64ebdfce17abdf8f3c9f55` adds a bounded optional own-proposal `recordedSource:{sourceType,sourceId}` after current tenant/proposer/wall checks. Web shows native expandable Source details with a recorded reference; restricted/malformed rows omit it. It exposes neither source body nor a new navigation/access grant.

[Case17 native checkpoint](C:/dev/main/outputs/meri-c2-20261003/case17-provenance-native-v1/checkpoint.json), SHA `c7bd52428514ac1e826b1a7b8b2e16e1f4681e4a5afc65e56a301f848f4b0032`: API25 and Web37 tests pass; Web typecheck passes. [API typecheck follow-up checkpoint](C:/dev/main/outputs/meri-c2-20261003/case17-api-typecheck-followup-v1/checkpoint.json), SHA `e666b82818a64fffcaec9974fbc3bfb80d074b6cf8c344a5d1dec8fc1480c686`:65 affected tests and full API typecheck pass with 8GB heap. Initial 4GB OOM and intermediate type errors are retained.

Two older C2 spec type-only repairs are included in the commit: `meri-capture-clock-packets.spec.ts` and `meri-memory-proposal-read.spec.ts`. Their emitted JS is unchanged; no test cases/assertions were weakened. Native source review hash `b52404dbe921b6f6d07e1dc3672c03ea36df81cc0440baead7a79f91beaac27e`; typecheck follow-up review hash `2a276183d9d7abcf4728dd78ae1f6da3122dff6a23ab4495eeaf19b16dd287bb`.

[Committed qualification archive](C:/dev/main/meri-c1-20261002/docs/meri/releases/2026-10-03/c2-case17-provenance-source/README.md),38 exact evidence files plus manifest/README/attributes. Manifest SHA `8a518b3d2535739923ead4725fa62978ea434cbcf91e4995b9131663998b24da`. Root verified45 staged file bytes (38 archive +7 source) before commit. The temporary restore-to-HEAD used during Case20 capture was undone successfully; final Case17 bytes are present. **Do not run its restore helper again.** Source qualification is complete, but immutable build/deployment and full prompt/human acceptance are still pending.

## 8. Case14 — access works, canonical setup not established

Actual Hermes prepared a bounded protected read. [Preparation directory](C:/dev/main/outputs/meri-c2-20261003/case14-readonly-preparation-v1) contains source,16 mock transport tests, syntax checks and independent review. The single live lookup at01:47:51.334–01:47:54.973UTC made six GETs, read two returned candidate details, got200/current4f, revoked its own session, and left the journal unchanged. [Readback](C:/dev/main/outputs/meri-c2-20261003/case14-owned-locator-readback-v1.json), SHA `5e6ad4ed20b27668aa93583b66f51983779207a9a7728ca5e19fcc35069f5380`.

Result: **`CANONICAL_CASE14_OWNER_NOT_ESTABLISHED`**. The two visible candidates were retained MA2 and prior Case01, not established Case14 authority. This bounded scan is not proof that Case14 state is absent. No historical Case14 setup recipe was found in the searched local outputs/release archives/evidence root. Do not fabricate a locator or adopt the Case17 instance.

[Next native read prerequisites](C:/dev/main/outputs/meri-c2-20261003/case14-native-readonly-prerequisites-v1.json), SHA **`76d733be7dd83879cf95b93631b9ad5553aa026d2bc41c707a39b01a01ffd62e`**, is prepared, not executed. The smallest next read composes the existing compiled PrismaService + MemoryAuthorizationService like `apps/api/scripts/meri-case14-recall-setup.mjs` and invokes **`readCase14FixtureEvidenceInTx(tx, exactPriyaContext, authorization)` with candidateId omitted**. The canonical owner retrieves its persisted locator itself. Include only the same-T1 pendingMemorySetups['14'] operation presence/status needed to distinguish absent/invalid owner; never dump full settings.

Priya: user `fb218bf5-2674-4ced-bca3-7a5d0c01592f`, Clerk `user_3Jw2G2jbyyDlrrg6zCNd4gYUDfH`, T1 above, role `user_admin` (Clerk org:admin). Canonical guards take `FOR SHARE/FOR UPDATE`, so PostgreSQL READ ONLY mode will reject them. Use a scoped ordinary transaction with a mandatory outer rollback sentinel and sanitized output; do not weaken canonical locks or bypass the owner. Use the exact currently qualified immutable API image and existing private DB task mechanism, no provider secrets/workload role, one launch, no retry, stopped/inactive cleanup.

Branch on actual native evidence: pending → existing one-decision in-Meri path; approved → retain decision/version and prepare recall only; absent → separately prepare a prospective canonical setup plan; claimed/invalid → reconcile the original operation. The pending CLI `plan` refuses existing operations; its `read` requires exact SETUP_COMPLETE recipe/pending rows. Neither is an approved-state discovery substitute. No credential request is necessary to prepare this work.

## 9. Next combined API/orchestrator/Web candidate

[Three-image build preparation README](C:/dev/main/outputs/meri-c2-20261003/combined-c2-build-preparation-v1/README.md) and [checkpoint](C:/dev/main/outputs/meri-c2-20261003/combined-c2-build-preparation-v1/checkpoint.json), SHA **`5d6c326bdc3e95b1a12130a86d35f05adbbf1080a238be941f29f1592f6db146`**. Build-scope template SHA `7d11c4b216d10ea8ad9a862244ee79f589e2e439a34f7eea1d4a1d38d5d46ac5`.

Templates only: API `d18f2a129bd8f4619849a190e28172b8d2f6d0cec259c2b2962fc97f3d9113a5`; orchestrator `67617283cc66959285174b78493e95b7d491bbfcb916b8592eb0980fd0aa3e0b`; Web `604d019ef9b54936de5cf7d9a5fb46f878d998b19549b2257de4a842edef9899`. Nine Bash syntax checks, one Node probe syntax check, nine lossless command round trips and three inline size checks pass. Actual packaged probes and image builds are **NOT_RUN**; final source SHA, Actions/build IDs, digests and release qualification are unset.

The templates reuse existing native owners and add the actual Case17 DTO/privacy probe, Case20 proof/timing/coverage regressions and Web source-details checks. No framework or new production service was introduced. Final test names must match frozen candidate source. API/orchestrator/Web share one final integrated clean main SHA. No schema, model, feature flag, task configuration, schedule or nightly repinning is included.

Integration/build sequence:

1. Verify frozen Case20 source/evidence and independent review; archive exact latest evidence, commit the bounded repair, and integrate the local work through the existing reviewed source process. Refresh remote main before any push/merge; preserve unrelated concurrent work. Do not treat current localHEAD as already merged.
2. Prefer the existing exact-candidate workflows: `api-image.yml`, `meriv2-orchestrator-image.yml`, and `web-vnext-deploy.yml` (display name `web-vnext-image`). These are build-only.
3. CodeBuild fallback applies only after each exact candidate workflow independently returns completed / startup_failure / zero jobs. A historical failure, missing run, queued run, cancellation or source-test failure is insufficient. Reuse an existing candidate image rather than overwrite its SHA tag.
4. Adapt the existing `start-capture-contract-build-v3.mjs` and collector narrowly for the three services/new source/spec pins. Do not run the old launchers unchanged. Preserve source/ref/caller/project/architecture checks, absent ECR tag, exclusive intent, idempotency/reconciliation and one-attempt launch. Project is `capiro-build-web-dev`, ARM container/privileged, existing GitHub repository,45-minute timeout. A launch with uncertain response requires its own reconciliation.
5. Inspect actual buildspec/source SHA, commands/markers, tests, logs, image source labels and ECR/RepoDigest identity. Historical130-suite/1564-pass/two-pending evidence belongs to the old deployed candidate; record actual new counts.
6. Prepare concrete candidate-bound release manifests and qualification using `scripts/meri-release.mjs`, fresh healthy baseline/rollback evidence and unchanged scope. API first, health verification, then orchestrator and Web with verification between services. Ask for any genuinely required new release approval only when the exact packet is ready. Existing user approvals must not be requested again for already completed releases.
7. After promotion, perform ordinary authenticated readback and affected user flows. Healthy ECS/image builds still do not move benchmark rows to PASS.

## 10. Approvals and credentials already available

The user explicitly approved the earlier memory release and bounded cleanup. It completed; do not ask again or replay it. The user also approved the exact capture-contract release packet: API23f529da… and orchestrator1c491a5a… from source4f0253874, API first, unchanged model/configuration/budget. Packet fingerprint **`5d67f443a71180e7aa49e775f3f979a585348d5b6480a7e83b76432bef7bfbdf`**; approval recorded00:08:59.410UTC; exact release/readback completed. [Deployment archive](C:/dev/main/meri-c1-20261002/docs/meri/releases/2026-10-03/c2-capture-contract-deployed/README.md).

No user approval is currently pending and no credentials are required from the user to resume the immediate read/qualification work. AWS CLI and authorized Clerk mechanisms already work. The forthcoming three-image package has no final images/manifests yet; prior exact release approval is historical and must not be relabelled as approval of unknown new digests. Standing C2/delegation authorization covers continued bounded preparation, source repair and verification.

| Tool/access | Existing location or setting |
| --- | --- |
| Node | `C:/Program Files/nodejs/node.exe` (observed24.19) |
| Python / Hermes environment | `C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe` |
| pnpm | `C:/Users/neoma/AppData/Local/hermes/node/pnpm.cmd` |
| AWS CLI | `C:/Program Files/Amazon/AWSCLIV2/aws.exe` |
| AWS scope | profile`capiro-dev`, region`us-east-1`, account`967807252336`, caller`arn:aws:iam::967807252336:user/capirocli` |
| Auth helper | `C:/dev/main/outputs/meri-fresh-20261003/auth-preflight.mjs` exports existing `aws`, `withAuth`, `ctx` |
| Playwright | `C:/dev/node_modules/playwright` |

Despite its name, **capiro-dev is the production application environment**. Benchmark data belongs to existing isolated synthetic tenant/fixtures and disposable effect sinks. The plan's “staging” wording is not evidence of another deployable environment. Never point test sends/mutations at real customers. Use configured secrets in memory; no secret values are included in this handover or needed in chat. Pat's existing Clerk ID is `user_3Jw2FvWZkYGKmxWGx13tNJxFD2A`. Keep own-session cleanup and do not revoke unrelated user sessions.

## 11. Delegation and Hermes handoff

The user repeatedly authorized and requested Hermes delegation. Actual configured Hermes CLI through OpenRouter was used for Case17 source draft (16 tool calls, estimated$0.02180352) and Case14 reader preparation (8 calls, estimated$0.0113825), with the working `gpt-6-luna` configuration retained. These coding-agent costs are separate from the application's Case20 capture journal. Raw drafts, actual execution/usage and supervisor qualification are in the related output directories. Do not silently change this configured route to historical suggested models or claim reasoning settings not observed in its receipts.

Codex collaborators were separate from Hermes:

- `/root/benchmark_review`: implemented/froze Case20's three source repairs and307-test qualification; completed.
- `/root/c2_next_owner`: prepared three-service build templates; completed.
- `/root/mail_defaults_review`: independent source reviews and Case14 canonical owner prerequisites; completed the final Case20 review artifact and stopped.

These session agent handles may not survive a new chat. Continue from files, not assumed live workers. The closeout plan permits one lead, at most one active implementation assignment and one independent review/test assignment, with nonoverlapping files. Good next delegation: bounded cost-only owner extension after the read exists, independent review of that exact diff, or a Case14 read-only task preparation while the lead integrates/builds. The lead retains sole journal mutation, capture submission and release coordination. Do not dispatch multiple agents against the same service files or active reservation.

## 12. Ordered continuation plan

1. Read original closeout C2, Appendix C/F and this handover. Inspect current Git status, frozen source hashes, journal hash/events, consumed claims and output existence. Do not rerun already completed source suites absent changes, unresolved concerns or required candidate qualification.
2. Run the prepared exact postdeadline **read-only** Case20 budget reader once if its pins still hold; save success/failure and own-session cleanup. This does not capture another model answer.
3. Prepare/test/review the bounded cost-only Case20 event24 reconciliation and execute once only after the actual terminal proof exists. Preserve the failed benchmark classification. No spend-cap increase or broader-case budget authority is implied.
4. Integrate the qualified Case20 repair with committed Case17, archive current evidence, freeze final source, and use the prepared existing three-image build path. Resolve real candidate failures instead of expanding infrastructure.
5. In a nonconflicting lane, prepare the Case14 canonical owner read from the exact prerequisite packet. Recover existing pending/approved state; avoid reseeding/reapproving blindly.
6. Complete concrete release qualification/approval if required, deploy one service at a time, then verify Case17's recorded provenance in served UI and continue Case14's actual approval/next-turn recall branch. Preserve original failed Case20; any future Case20 acceptance attempt requires separately valid current authority/budget and a genuinely new eligible attempt, never a replay of the consumed run.
7. Move independent fixture families forward: older-memory12, lifecycle/scope memory cases, artifact46 then40–45, approval51 and CD02/CD05 followed by all CD variants. Cases72/74/75 feed C3 but retain their own acceptance IDs. Validate effect sinks/adapters before paid capture. No seven-day shortcut or false exhaustive absence in CD.
8. Record current source/image, actor/client, scope, frozen semantic clock, real auth/runtime clocks, full passages/versions/checksums, receipt/effect counts, trace joins, provider accounting, supported modes, reload/recovery, repeats and human scores. Update the existing matrix and short status, preserving failures. C2 closes only when its affected original cases and CD family pass all their required assertions.

## 13. Evidence preservation and practical pitfalls

- [Pre-capture archive](C:/dev/main/meri-c1-20261002/docs/meri/releases/2026-10-03/c2-case20-current-checkpoint/README.md) has155 exact files and manifestSHA `b54866f0107d8b822de6551bf3dd33a255e1563b89f1c2633c1310fcf21e1510`. Its v3 NOT_RUN statement is historical, superseded by actual v3 evidence here. It does not yet archive the v3 run/latest cost/Case14 packets. Archive those before relying on Git-only portability.
- This handover is saved in the checkout; many newest receipts remain under machine-local outputs. A new session on this machine can read them. A remote session needs the exact referenced evidence copied/archived; prose or hashes alone are not substitutes.
- Preserve `.gitattributes` with `-text` before staging byte-pinned evidence. Force-add intended ignored logs and verify index bytes against the manifest; Git CRLF conversion previously invalidated an archive and was corrected before push. Avoid storing secrets or broad raw task definitions/settings.
- Original semantic benchmark time remains2026-09-26T16:00:00Z (noon New York). Never change auth/lease/timeout clocks to it.
- No repeat of six cleanup jobs, approved decisions, Case01 capture, or consumed Case20 recovery. No journal deletion/replacement/adoption, private budget bypass, automatic paid retry or lowered capture assertion.
- PowerShell does not expand native-program path globs: use `rg pattern apps/api/src/meri -g '*provider*.ts'`, not a literal path ending`/*provider*`. Quote executable paths. Read actual package scripts and saved test commands before choosing invocations.
- Do not print whole saved messages, credentials, secret values or tenant settings. Select only needed evidence fields. Saved redacted response text is not raw receipt equality evidence.
- No new compute/model server/runtime fork/connector/database relocation is required. Production configuration stays stable while measuring the bounded repairs.

## 14. Prompt to paste into the new session

> Continue the authorized Meri C2 closeout in `C:/dev/main/meri-c1-20261002`. Read `docs/meri/implementation/01-session-handover-2026-10-03.md` first, then the original October2 closeout plan, original foundation contract Appendix C/F and current requirement matrix. C0/C1 are complete; finish all C2. Preserve local commits, seven dirty Case20 repair files, exact evidence, the23-event journal and consumed claims. Case20 v3 already submitted one paid turn and failed receipt qualification: do not replay it. Start with verifying the prepared postdeadline read-only cost evidence path, then bounded native cost reconciliation and integrating the qualified Case17/Case20 repairs. Use the prepared three-image build path and current exact release procedure. Recover Case14 through its existing canonical owner. You may delegate bounded work to actual configured Hermes and independent reviewers. AWS/Clerk access is already configured; do not ask for credentials or repeat approvals for completed releases. Continue until C2's original assertions, variants and human-review requirements are satisfied, keeping status truthful and asking only for a concrete genuinely required new approval.

[Machine-readable handover snapshot and local link/hash verification](C:/dev/main/outputs/meri-c2-20261003/session-handover-snapshot-v1.json). This snapshot is read-only evidence collection; no cloud, model, journal or application operation was run for the handover.
