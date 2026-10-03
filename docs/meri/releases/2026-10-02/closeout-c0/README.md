# C0 baseline reconciliation — 2026-10-02 America/New_York

Observed at `2026-10-03T00:46:27.885143+00:00`. C0 repository reconciliation is complete; live fixture preflight is **BLOCKED (ACCESS/HARNESS)**. C1 is queued, not executed. C0 cannot claim its fully runnable-flow exit while these prerequisites are unavailable.

## Corrected deployment inspection — October 2, 9:15 p.m. EDT

The AWS credential blocker was an agent profile-selection error: the configured `AWS_PROFILE=capiro-dev` works; explicitly forcing empty `default` caused the earlier failure. No extra credentials are needed. [Fresh canonical inspection receipts](profile-correction.json) verify API515, orchestrator105 and WebVNext388 with exit0 and zero writes. Orchestrator105 already serves the qualified coverage image `sha256:85162728a9d268b797e1f264bde9eb129fb4a170304a6547b3da7a9561d628fa`; API/web match the saved identities. This supersedes UNVERIFIED cloud deployment and proposed coverage-promotion statements in the initial snapshot below. Next C1 action is affected behavior verification on the deployed candidate, not another promotion. Per-turn model/tenant flags and original benchmark fixture/journal readback remain unverified.

The missing prior evidence folder/checkpoint is a separate local artifact issue. Recover its current location or original host; do not initialize a replacement aggregate. The operations path map can be restored after verifying host paths; it is not a credential store.

## Source and preserved work

Fetched `origin/main` is `723735ed1f5c562ab10e6077c67261285ea102fd`, unchanged from the attached audit. No production patch was replayed. Task branch `codex/meri-closeout-c0-20261002` is isolated from the main checkout's six unrelated untracked paths and the older dirty worktrees. No reset, cleanup, existing branch switch, active-run mutation or worker dispatch occurred. The local worktree uses the verified repository/workspace path; the missing operations map remains a prerequisite for host-dependent fixture/Hermes execution.

Current private policy is `neo-capiro/capiro-agent-ops@b2b0ce8c2bf03817b81e671d968b7892985b8d06`, read through authenticated GitHub API. The documented `C:/dev/capiro-agent-ops` and its machine map are absent. The bootstrap location is an expected path, not a verified map. No replacement machine map, profile or journal was initialized.

Fresh GitHub PR readbacks confirm [#1904](https://github.com/neo-capiro/capirov2/pull/1904) merged as `b2d99f04d8c485cb4b73a1f02aece9a60b945870`, [#1908](https://github.com/neo-capiro/capirov2/pull/1908) as `23467860e9dde892d0130d7d0d83ef552988b446`, and [#1915](https://github.com/neo-capiro/capirov2/pull/1915) as `52ea6f61dd423ad225f0041306555f4560ee85c9`. These older patches must not be replayed from stale ledger rows. The fetched open-PR list contains no newer File01 coverage/mail closeout candidate; the coverage fix is already in main at `7c04ca368…`.

The closeout attachment is copied byte-for-byte alongside the original contract. The document's example prompt to execute C0–C5 does not widen the user's C0-only request. Existing source, provider/model policy, data and runtime configuration are unchanged.

## Deployment, configuration and rollback

[Fresh public readback](public-readback.json): `/api/me` returns 401 with API release `6be5a560d5addaa1844f0687898c34a249089f76`; `/meri` returns 200. This verifies public reachability and a self-reported API source only. AWS identity inspection exited 1 (`NoCredentials`), so ECS tasks, image digests, effective flags/modes/models, current schema and rollback availability are **UNVERIFIED**.

| Component | Last repository receipt (historical) | Image digest | Configuration / rollback |
|---|---|---|---|
| API | 515; `6be5a560d5addaa1844f0687898c34a249089f76` | `sha256:5e52f9b06658b0462672d070928e0c2afd6ea229b61c3b887371f3f66196c316` | Config `973748a2b134b388a6027df6c5c099055a7e24f7b746eafbaae8cebad077258a`; prior rollback514 image `sha256:9da63160063d9a711b2c7625803919d91803d96284037ecd097c24bedcbdacbd` |
| Orchestrator | 103; same `6be5a560…` | `sha256:4af969e3ce20e39fa789b98470250e0287a39ece24268204b8ec2e9a8a229a6f` | Config `3a4fabd2139e347cd8b45192579f2a3fbaaa6fc3678762b5252f727a4461951b`; prior rollback102 image `sha256:2e5030104ad34d40b1854b755be829c8a822e53c58508baa78f40bc39dd8f670` |
| Web vNext | 388; `78ad5805679a3045b1fc10fb19beafa7f76e4e64` | `sha256:a048aceec01c207b514f76fb447d4fb8bdb5ed17278642480008a1510a12de4c` | Current config/rollback not verified here; preserve existing promotion records |

Historical API/orchestrator [independent readbacks and promotion receipts](../direct-browser-repairs/live-verification/README.md); [web build provenance](../composed-release/web-vnext-build-readback.json). The prior release qualified 451 migration-file hashes and no schema change. C0 does not establish a current database ledger read. Coverage candidate qualification also reports no API/schema/config/provider change and prior-orchestrator compatibility.

Current source defaults in `meriv3-reasoning.ts` use `gpt-6-astra` for fast/standard/deep and derive Max from deep. Environment/BYOK/tenant settings can override them. These are source defaults, not a served effective-model claim. Current effective mode, tool-selection flags and JEV flags require authenticated run/config evidence; none changed in C0.

## Existing claims, budget and first fixture

The sole aggregate is the existing native journal referenced by [shared-spend-v2 activation](../original75-shared-budget-release/oct02-shared-read-budget/shared-spend-v2-activation-execution.json), checkpoint `C:/dev/cap-meri-foundation-evidence/oct02-original-aggregate-operator-v6/shared-spend-v2-checkpoint.json`, hash `7f9e69b4dffb07344337e9cb4c62d8b6b495c54ae956bcc399cffd3b3cd88cb5`. The documented evidence root is absent on this host.

That historical event5 allows a $30 aggregate, concurrency1, new read ceiling $15/500,000 tokens, deadline `2026-10-03T06:08:00Z` (October3, 2:08a.m. EDT); it retains $6 legacy ceilings, UNKNOWN first-attempt billing and reported $24 remaining **at that event only**. A later original01 answer and readback failure are recorded in [saved-answer repair](../original75-saved-answer-repair/README.md). Therefore current active reservation, journal head, remaining amount and subsequent settlement are **UNVERIFIED**, not $24 available. Recover the exact current checkpoint and reopen the same journal; never initialize, refund, extend, resubmit or infer a balance from event5. If the fixed deadline has expired on recovery, record that blocker rather than changing real time or silently extending authority.

Historical first canonical approval committed; its projection and five-source corpus work are retained. Four STARTED fixture claims and original conversations must remain preserved. The six pending case17 proposals/UI slice are separate from original17 acceptance. Current claim states are unavailable here; no reapproval, fixture reset or seed was attempted.

First fixture: original01, Pat as ordinary `standard_user` in existing synthetic T1, Aster selected, canonical approved `MA1-v2` plus the existing five-source corpus. Exact prompt and fixtures remain in `evals/meri/live-v1/cases.mjs` / `fixture.mjs`.

| Preflight criterion | Current evidence / disposition |
|---|---|
| Ordinary authorized actor and selected client | BLOCKED: existing mapping/session/current membership not available on this host; do not elevate or use a different account |
| Canonical source readable and lineage | BLOCKED: archived corpus evidence exists; fresh ordinary-scope source read has not run |
| Governed endpoint reachable | Public `/api/me`401 and `/meri`200 PASS for reachability only; authenticated governed-route admission BLOCKED |
| Provider reservation feasible | BLOCKED: current native journal/checkpoint and active-run reconciliation unavailable; no spend |
| Terminal persisted readback | Existing historical-read repair and local recorder tests present; actual same-run authenticated readback BLOCKED |
| Disposable sink | Read-only case, zero business effects required; existing synthetic guard must be reverified; no new sink or fixture mutation |
| Semantic clock | Frozen contract validated at `2026-09-26T16:00:00.000Z` = September26 noon America/New_York; served clock injection still UNVERIFIED; auth/lease/timeout clocks untouched |

The general package entry `capture:meri-live-read` invokes `capture-cli.mjs`; its general LIVE route remains intentionally fail-closed. Do not try example placeholder config as a real run. Use the already established `memory-read-protocol.mjs` and `memory-read-spend.mjs`/same-journal recovery path described by [SHARED-READ-BUDGET](../../../../../evals/meri/live-v1/SHARED-READ-BUDGET.md). Recover the saved case01 before considering a new submission. Existing authenticated browser QA is the default for ordinary C1 product checks once the already approved target identity and budget are established.

## First C1 action and next release

Owner: lead. First affected workflow: successful scoped task count must retain its supported count without a contradictory generic evidence footer; failed mail reads must state their actual failure. Prior [browser results](../direct-browser-repairs/live-verification/browser-results.json) retain both defects and reload evidence.

1. Restore the configured operations map/host access and read-only AWS identity. Run the existing inspected command `node scripts/meri-release.mjs inspect --service meriv2-orchestrator --profile capiro-dev` and the equivalent API/web-vnext inspections; join actual image/source/config to qualification.
2. Determine whether coverage source `7c04ca368fbccc84d33c720ce7a20b9201bf6e99` is already served. Its qualified image is `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator@sha256:85162728a9d268b797e1f264bde9eb129fb4a170304a6547b3da7a9561d628fa`. [Qualification](../browser-coverage-followup/release-qualification.json): 1,489 tests passed, two pending, 26 offline cases, independent review PASS, live NOT_RUN.
3. If absent, reuse that immutable artifact only after current qualification/config/compatibility and release authority are confirmed; first release is orchestrator-only coverage repair, rollback to the independently verified prior compatible image. C0 authorizes no promotion. If already served, do not redeploy merely to repeat the plan.
4. C1 then checks concise no-tool reply, known/zero task results, known/zero mail results, controlled mail failure and persisted reload. Keep synthetic permission acceptance separate from ordinary read-only smoke. Capture first-useful/terminal timing, tools/outcomes and coverage; observation upper bounds are not p95. Reproduce the mailbox503 at its real boundary before selecting a query/index/adapter repair.

## Qualification and limits

`node evals/meri/live-v1/validate-contract.mjs`: exit0, 75 exact cases, original contract/fixture hashes unchanged ([result](contract-validation.json)). Four existing local Node test files: **38 passed, 0 failed, 0 skipped**, exit0 ([output](local-checks.txt), [exit](local-checks-exit.json)); fixture bytes, contract, recorder failure retention and controlled read definitions only. This is not the 26-case offline product suite, a live run, native journal recovery or release qualification.

Original75 current accounting: **0 accepted; 1 attempted/incomplete (BLOCKED), 74 NOT_RUN**. Prior failures are preserved, not regraded. CD 0/7, CW 0/8, applicable M, mode/JEV variants and human review remain incomplete. File01 stays **01_BLOCKED**. No production implementation, cloud/database write, provider submission, merge or deployment occurred.

Historical documents are retained byte-for-byte as [status](historical-STATUS.md), [ledger](historical-01-requirements.md), and [handover](historical-01-handover.md). [Source reconciliation](source-reconciliation.json) records requirement IDs, file hashes and merged path provenance. Acquisition reconciliation preserves donor pins, original records and conditional dispositions; source presence is not adoption acceptance.

Relative links inside those untouched archives retain their original `docs/meri/implementation/` base. For navigable historical receipts, use the original [status at the audited commit](https://github.com/neo-capiro/capirov2/blob/723735ed1f5c562ab10e6077c67261285ea102fd/docs/meri/implementation/STATUS.md), [ledger](https://github.com/neo-capiro/capirov2/blob/723735ed1f5c562ab10e6077c67261285ea102fd/docs/meri/implementation/01-requirements.md), and [handover](https://github.com/neo-capiro/capirov2/blob/723735ed1f5c562ab10e6077c67261285ea102fd/docs/meri/implementation/01-handover.md).
