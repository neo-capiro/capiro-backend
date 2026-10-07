# Meri program: finish plan, second edition (written 2026-10-07, about 13:45 UTC)

For the next lead agent. This replaces [HANDOVER-2026-10-06-finish-plan.md](HANDOVER-2026-10-06-finish-plan.md) as the single starting point. [00-Meri-Program-Plan-2026-10-05.md](00-Meri-Program-Plan-2026-10-05.md) (what to build) and [00-Meri-Deployment-Plan-Opus-5-5-2026-10-05.md](00-Meri-Deployment-Plan-Opus-5-5-2026-10-05.md) (how to ship) still control. Section 1 says where the program is now, section 2 what the rules are, section 3 what remains in order, section 4 the open-source register items that are added to the plan and the ones that are not, with the reason for each, section 5 tooling, section 6 hazards.

Every fact below was read from main (`66973cd53`), the live task definitions and CloudWatch between 11:40 and 13:40 UTC on 2026-10-07. The session handovers ([2026-10-07](HANDOVER-2026-10-07.md), [evening](HANDOVER-2026-10-06-evening.md), [pm](HANDOVER-2026-10-06-pm.md), [morning](HANDOVER-2026-10-06.md)) hold how each shipped piece was tested; read the one for a piece before you touch it.

## 0. Prompt to start the next session

> Read `docs/meri/implementation/HANDOVER-2026-10-07-finish-plan.md`, then the program plan §0, §8 and §9, the deployment plan §2 and §7, and the top block of `STATUS.md`. Continue at section 3 of this file, in order. Ship only through deployment plan §2 with the tooling in section 5. Test as program plan §9 says: typecheck and focused specs per PR, one live check on capiro-internal per user-visible change, as neo@capiro.ai, one paid turn at a time, state-changing setup only on client `ZZ-QA-Meri1651-Test-DoNotUse`. Ask me only at the checkpoints in section 2.3. Write `STATUS.md`, the day's release record and a session handover at the end of every session.

## 1. Where the program stands

### 1.1 By stage and release

| Piece | Plan reference | State |
| --- | --- | --- |
| Stage 1: one runtime, kill switch, Hermes decommission, capture harness removal | program §4 | **Done**, `01_READY_FOR_02` ([01-handover.md](01-handover.md)). One step remains: merge #2032 (rebased to `bbab4d2b8`, mergeable) and #2035 on or after 2026-10-12 (section 3.9). |
| Stage 2 Release A: jobs foundation | deployment §4 row A | **Done**, behind tenant flag `meri.jobs` (on for capiro-internal only). |
| Stage 2 Release B: delegate, steer, stop, resume | deployment §4 row B | **Done and verified live** (T5 run 12, T7 in the browser). Sweeper on. Neo's verdicts on T5 and T7 are pending. |
| Release C: Word, Excel, PowerPoint deliverables with read-back | program §5.3 | **Done and verified live** (T6 rerun, T12 rerun). Neo's verdicts pending. The T4 rerun with a PPTX input has not been run. |
| Release D: approvals inside jobs | program §5.4 | Not started. Section 3.3. |
| Release E: scheduled and proactive work | program §5.5 | Not started. Section 3.4. |
| Release F: four Playwright flows | program §5.8 | Not started; a working headless flow exists outside the repo. Section 3.5. |
| §5.6 client writing profile | program §5.6 | Conditional; no trigger yet. |
| `02-handover.md`, `02_READY_FOR_03` | program §5.8 | Not written. Section 3.6. |
| Stage 3: Claude as a second provider, comparison, decision | program §6 | Not started. Section 3.7. |
| §5.7 Congressional drafting (T16 to T18) | program §5.7 | Not started; gated on §5.8 passing. Section 3.8. |

### 1.2 Real-task verdict ledger (program §8; done means 18 tasks with Neo's verdict)

| Task | State |
| --- | --- |
| T1, T2, T3, T4, T15 | **Pass** (Neo, 2026-10-05, [review page](https://claude.ai/artifact/TSUzMTxNxPh71L8duExZQU)) |
| T5 | Automatic checks pass: run 12 `a31f24a0` (completed, 13,849-byte .docx, filed once as `f92efe3e`, repeat returned the same document, no auditor finding). Brief is 1,570 words for "two pages"; the length guidance in #2156 shipped after that run. **Verdict pending.** |
| T6 | Automatic checks pass: rerun `1f84c6ee` (eight named sheets, filed once as `4daf7fa6`; HASC and SASC marks equal the request for 0604234N and 0604269N; SAC-D not recorded). **Verdict pending.** |
| T7 | Automatic checks pass in the browser at 1440×900: `2e542eed` (delegate, "House version only" mid-run at goal revision 1, tab closed, reopened, completed) and `adaacd76` (Stop, cancelled in 5 s). Screenshots in `outputs/meri-stage2-20261006/t7-check-3/`. **Verdict pending.** |
| T12 | Automatic checks pass: rerun `0f4a4df2` (8 slides, filed once as `1d66e52c`). One provenance slide remained; fixed by #2166, live since API 642, not rerun. **Verdict pending.** |
| T8, T9 | Need Release D. |
| T10, T11, T13 | Need Release E. |
| T14 | Stage 3. |
| T16, T17, T18 | Drafting, after §5.8. |

Verdicts Neo has not yet given on work that passed its automatic checks earlier: the D4b budget report (research `e0bd0918`), the commitments audit answer (conversation `594a31e5`), the bill-text answer (`7965f93e`), and the two Stage 2 research reports (`5d29ceb1`, `d3934ccd`). Ask for all of them in one message with the T5/T6/T7/T12 verdicts. The files are `outputs/meri-stage2-20261006/t5-check-12/deliverable.docx`, `t6-check-2/deliverable.xlsx`, `t12-check-2/deliverable.pptx`; they were sent to Neo on 2026-10-07.

### 1.3 Served production (cluster `capiro-dev`, account `967807252336`, `us-east-1`)

| Service | Revision | Source | Rollback | Notes |
| --- | --- | --- | --- | --- |
| `capiro-dev-api` | **644** | `f40dbebff` | 643 | Carries everything through #2177 and `MERI_JOB_SWEEPER_ENABLED=true` (configuration revision 632, codified #2157). |
| `capiro-dev-meriv2-orchestrator` | **173** | `88c71b410` | 172 | Carries #2132, #2152, #2181. |
| `capiro-dev-web-vnext` | **458** | `2c2560260` | 457 (registered 12:21 UTC) or 456; the planner team's roll, so confirm with them | Rolled by the planner team at 12:51 UTC from a main commit that contains `66973cd53` (so Meri's #2147, #2167, #2168, #2170). |
| `capiro-dev-api-admin-migrate` | latest is read-only `migration-status` | | | Schema up to date on every candidate (458 migrations). |
| `capiro-dev-api-federal-evidence-backfill` | 2 | `006eb59d2` image | | One-off BILLS backfill family. |
| `capiro-dev-api-meri-memory-probe` | none active | | | Throwaway read-only probe family; every revision is deregistered after its run. |

Flags and env: tenant flag `meri.jobs` on for capiro-internal only; sweeper on; `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED` off on the API (on only in the backfill family); Package 4 EventBridge rules disabled; `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` unset (telemetry goes to CloudWatch as JSON events). `meri_unavailable` since the T15 drill (2026-10-05 20:45 UTC): **0** at 04:30 UTC on 2026-10-07.

### 1.4 Open pull requests owned by the program

| PR | What | State | Rule |
| --- | --- | --- | --- |
| [#2032](https://github.com/neo-capiro/capirov2/pull/2032) | Stage 1 §4.3 orchestrator: delete the V2 `/chat` loop, move the V3 shared contract to `meriv3/shared/` | Rebased onto main 2026-10-07 (`bbab4d2b8`), MERGEABLE, orchestrator tsc and 184 focused tests green | Merge on or after 2026-10-12 if `meri_unavailable` stays 0 (section 3.9) |
| [#2035](https://github.com/neo-capiro/capirov2/pull/2035) | Stage 1 §4.3 API: delete the V1 loop and the V2 chat client | MERGEABLE | Same date and condition |

Everything else the program opened is merged (the 2026-10-07 session merged 16 PRs: #2143, #2146, #2147, #2149, #2152, #2156, #2157, #2160, #2166, #2167, #2168, #2170, #2174, #2177, #2181, #2183).

### 1.5 Background work in flight

- **Federal BILLS backfill** (119th Congress, `--full --historical`): 19,754 bill versions stored through batch 27; batches 28 and 29 inserted 1,000 each (batch 29 finished 13:18 UTC, status still `running`). `outputs/meri-stage2-20261006/fed-backfill/loop2.py` stops on `completed` or two empty batches. If the host session ended, run `python loop2.py <next batch>` from that folder.
- **Reviews `69250800`** (T5 run 10, D2 hold) and **`e3ea216c`** (T5 run 11, D2 false positive since fixed by #2152) are pending in Reviews. Leave them to a reviewer; never approve to pass a task.

## 2. Rules that do not change

### 2.1 Decisions already made (never re-ask)

Program plan §0 (D1 to D10) and §11, plus the decision tables in the [morning](HANDOVER-2026-10-06.md) §2, [pm](HANDOVER-2026-10-06-pm.md) §2 and [2026-10-07](HANDOVER-2026-10-07.md) handovers. The ones you will touch:

- Done means real tasks with Neo's verdict; automatic checks only for safety (D5). Do not build graders, repeat runs, capture kits or release-qualification kits (D6, §9).
- Build around V3; `meriv3/` changes only through additive modules, injection seams, or a fix for a measured defect, each verified with one live turn on capiro-internal (D3, §3 rule 1).
- OpenAI stays default; Claude is a second provider compared on real tasks; no fine-tuning without a measured gap (D2).
- Second reviewer for approval tasks is the synthetic account `qa+clerk_test-portfolio-v2-b4e7c829f2c0@capiro.ai` (D9), through env `MERI_RUNNER_SECOND_IDENTITY` in `evals/meri/simple/auth.mjs`. Action proposals are owner-only in code, so D9 cannot apply to T8 without an authorization change (section 3.3).
- Sweeper: on since 2026-10-07 (approved after the T5 pass). Do not turn it off without Neo.
- Federal bill data: one-off historical BILLS backfill only; the API flag, recurring rules and outbox drain stay off until Neo says otherwise.
- LegiScan: do not create additional keys; the tier-or-cadence decision is Neo's (task chip `task_3de743b5`).
- Open-source reuse under program §3 rule 8 only; section 4 of this file records what is adopted and what is not.

### 2.2 Standing constraints

Program plan §0 last paragraph: no Hermes restart; approvals, journal history, failed runs, tenant boundaries and authorizations preserved; paid turns one at a time; state-changing setup only on the QA client; no external effect approved during testing except delivery to the tester's own mailbox; production changes with side effects need Neo's OK at the time.

### 2.3 Ask-Neo checkpoints that remain (deployment §7)

| When | Ask |
| --- | --- |
| Now, one message (section 3.1) | Verdicts on T5, T6, T7, T12 and the five earlier items (section 1.2) |
| Now | Decision: document-listing re-check withholding earlier reports (section 3.2 a) |
| Now | Decision: attempt allowance for steered runs; replaces the 2026-10-07 "steering late in a run" question, whose diagnosis was wrong (section 3.2 b) |
| Before Release D | Who approves proposals (owner, or four-eyes as an authorization change); where approval steps may sit in a job plan (section 3.3) |
| Each Stage 2 release | Verdicts on its tasks (T8, T9 for D; T10, T11, T13 for E) |
| Any migration | OK to apply (none is planned for D to F; Stage 3 has none) |
| Any production flag flip or configuration revision not already approved | OK at the time |
| Before Release E | How a scheduled run executes with nobody signed in (section 3.4) |
| Package 4 activation (recurring BILLS rule, outbox drain, `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED` on the API) | Decision |
| LegiScan plan or cadence | Decision |
| Stage 3 | The tenant-scoped model setting for the comparison (section 3.7); then OK for the window; then the default model |
| 2026-10-12 | Record program §4.3 step 4 (`MERIV2_*` env) as satisfied by audit (section 3.9) |
| §5.7 | Schema validation approach (section 3.8) |
| PE data repair | OK to re-pick request winners on production rows after the SELECT (section 3.10) |
| Approving review `69250800`, `e3ea216c` or any held report | Reviewer's call, never the agent's |

### 2.4 Per-PR and per-release policy

Program §9 and deployment §2. In practice: fresh worktree from `origin/main` with a private pnpm store (the shared store is corrupted); prebuild `packages/shared`, `defense-domain`, `defense-contracts`, `auth`, `meriv2-core`, `strategy-verifier`, then `prisma generate`; `tsc --noEmit` with `NODE_OPTIONS=--max-old-space-size=8192`; the focused specs; every fix proven by a test that fails without it; one PR per defect; evidence PR, `migration-status` on the candidate, two served-commit reads (ancestry or content containment), promote, digest readback on every running task.

## 3. Work remaining, in order

Each item says where to start in the code (line numbers read on `66973cd53`), what to build, what done looks like, and what goes to Neo. Starting points come from four read-only readers run for this plan; their full output, with more line references than are copied here, is `outputs/meri-stage2-20261006/finish-plan-2/continuation-remaining.json`.

### 3.1 Verdicts and decisions: one message to Neo

Send one message, with the three files attached (`t5-check-12/deliverable.docx`, `t6-check-2/deliverable.xlsx`, `t12-check-2/deliverable.pptx`), asking for:

1. Verdicts on T5, T6, T7, T12 and the five earlier items in section 1.2.
2. The two decisions in section 3.2.
3. The two Release D decisions in section 3.3 and the Release E identity decision in section 3.4, so neither release waits on him later.
4. The Stage 3 model-override mechanism (section 3.7) and the `MERIV2_*` reading (section 3.9), which are smaller.

Put the recommendation first in each decision. Then start section 3.2's no-decision fix and Release D's planner fix (section 3.3 step 0), which need no answer.

### 3.2 Two decisions that are open now

**(a) Document-listing re-check withholds earlier reports.** Unchanged from [HANDOVER-2026-10-07.md](HANDOVER-2026-10-07.md) §3.2: `read_client_documents` listings are re-checked by the hash of the whole listed page (`apps/api/src/meri/meri-research-replay-authorization.ts:167-186`, exact equality at `:431`, refusal log `:945-951`), so any upload to a client withholds every earlier report that listed that client's files. Recommendation: a subset re-check (every file the report saw is still there with the same identity) plus a "new files added since this report" notice. One caveat the reader found: listings page at 25, so a new upload can push an old file off the page; the subset re-check must re-read by the saved ids, or with a page large enough to cover them. Tests: `meri-research-replay-authorization.spec.ts`, `meri-research-durable-replay.spec.ts`.

**(b) Steered jobs that end partial. The 2026-10-07 diagnosis was wrong; replace that decision with this one.** HANDOVER-2026-10-07 §3.1 says a steer sent while the run is finalizing "finds the budget spent" (4,000,000 tokens and $25) and recommends refusing steers once a run is finalizing. Three independent checks of the logs and code for this plan found otherwise:

- **The limit that ran out was provider attempts, not tokens or dollars.** For session `0b61fbff` (conversation `2e305a8e`), `meri.research.budget.settled` in `/capiro/dev/api` shows attempts reaching **0** while more than 2 million tokens and about $20 remained; the next orchestrator requests finalized `partial` and `meri.research.terminal` reported `partial`. `CLIO_RESEARCH_MAX_PROVIDER_ATTEMPTS` is not set on API task definition 644 or in `compute-stack.ts`, so the code default of **23 per session** applies (`apps/api/src/config/config.schema.ts:701`, `meri-research.service.ts:4559-4562`), and `admitResearchProviderBudget` carries it across goal revisions (`meri-research-tool-budget.ts:250-279`). The first run's bounded children spent about 10 attempts in about 60 s; the revised run's children used the remaining 13 before its main turn.
- **The steer was not late.** `steer-check.mjs` steers after a fixed 60 s; all three steer checks and the passing T7 browser run (`2e542eed`, steer at 71 s) steered during evidence gathering. `2e542eed` completed and `0b61fbff` (steer at 64 s) went partial; the difference is how many attempts the first run's children had used, not the stage.
- **"Finalizing" is mislabelled.** `FINALIZING_STAGES` (`apps/api/src/meri/meri-job.ts:55-60`) includes `RESEARCH_OBSERVER_STATUS.preparingReport`, and that note is the fallback for every progress note not in the fixed list (`research-observer-projection.ts:196-203`), including `Running two bounded read-only evidence reviews…` (`meri-research.service.ts:2959`). The job therefore shows `finalizing` for most of evidence gathering. The handover's recommended option (b), refusing a steer while finalizing, would have refused the steer that passed T7. **Withdraw it.**

Do now, without a decision: make `finalizing` truthful. Either remove `preparingReport` from `FINALIZING_STAGES` (`meri-job.ts:59`) or add the `:2959` note and any other gather-phase notes to the fixed vocabulary (`research-observer-projection.ts:10-36`); add a `meri-job.spec.ts` case that a run in its bounded evidence reviews projects `executing` (today the spec covers only `writingReport` and `savingReport`, `:32-33`). One API PR; live check: one delegated job on the QA client, and the Running jobs rail shows "Working" during gathering.

Decision for Neo (options):
- (i) Give each goal revision its own **attempt** allowance at the re-plan site (`meri-research.service.ts:4848-4861`), keeping tokens and dollars session-wide. A steer mid-gather can then finish; spend stays bounded by $25 and 4M tokens. **Recommended**: attempts are not dollars.
- (ii) Set `CLIO_RESEARCH_MAX_PROVIDER_ATTEMPTS` explicitly, and higher, through a deployment §2.5 configuration revision.
- (iii) Keep the current behavior and document that a steer after about the first minute may end partial.

With (i), add a regression in which a steer at 60 s followed by the resumed run completes. A guard that refuses a steer during true synthesis (`writingReport`, `checkingReport`, `savingReport`, set at `meri-research.service.ts:3578`, `:3819`, `:3892`) is optional afterwards; no run has yet shown a steer lost in that window. Tell Neo this when asking for the T7 verdict: T7 passed, and the partial outcome is a separate budget question.

### 3.3 Release D: approvals inside jobs (program §5.4; T8, T9)

**What exists.** A research plan may carry `approval_required` steps (they must name a side-effecting capability, `apps/api/src/meri/meri-research-plan.ts:210-224`), but research never executes or proposes them: the research loop and the V3 `allowedReadCapabilities` are read-only (`meri-research.service.ts:3008-3020`, `:3097-3102`), and nothing in the research path imports `MeriActionProposalService`. The coordinator admits such a step as `waiting_for_approval` (`meri-research-coordinator.ts:737-742`) and it stays there forever; `nextExecutableStepIndex` even lists `waiting_for_approval` as ready (`:768-772`, fallback `ready[0]` at `:792`), which can steer a read into `research_step_requires_approval_reconciliation` (`:283`). `projectMeriJobStatus` checks `complete` (`meri-job.ts:120`) before approval (`:129`). The planner bug is confirmed in evidence: `t5-check-3/final.json` has read step `verify-approved-document-filing` depending on approval step `propose-word-document`. The chat path already proposes writes correctly (`apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts:3597-3640`; `send_email` is WARN in `packages/meriv2-core/src/assurance/policy-pack.ts:145`).

**Two decisions for Neo before the build:**

1. **Who approves a proposal, including T8's send?** In code, approval is owner-only and runs as the approver: `owned()` filters `userId = ctx.userId` (`meri-action-proposal.service.ts:887-895`), the fingerprint binds the user (`:1061-1070`), `approvedBy = ctx.userId` (`:1136`), execution runs as the approver (`:1157`). A second reviewer gets 404, and a send would leave from the approver's mailbox. The D9 second reviewer exists only for shared memory candidates (`memory-candidate.service.ts:625-628`). Options: (A) the owner approves in the Approvals tab, matching the code and the policy pack (`fourEyesRequired: false` governs pack publication, not actions); program plan §8 drops T8 from the second-reviewer list and keeps D9 for T3 and T18. (B) Build four-eyes for WARN proposals; that changes approval authority (reviewer lookup outside the owner filter, fingerprint, which mailbox sends) and is an authorization change under the hard guardrails. **Recommended: A.**
2. **Where may an approval step sit in a job plan?** (A) Only as a final step (nothing depends on it): the proposal is posted when the report is saved, the job shows "Waiting for you", and the decision settles the step without resuming model work. This fixes the read-after-approval bug at the planner and needs no schema, enum or orchestrator change. (B) Mid-plan approvals: a new run status in the API and web parsers, a resume-after-decision path under a new epoch, and drafting the payload mid-loop. **Recommended: A**; no §8 task needs a read that depends on an executed effect.

**Build order (assuming A and A; no migration, no orchestrator change, behind `meri.jobs`):**

0. *Planner fix (no decision needed).* In `validateGraph` (`meri-research-plan.ts:480-500`) reject any step whose `dependsOn` includes an `approval_required` step (issue `step_depends_on_approval:<id>:<dep>`; the existing repair retry fixes the plan); add "an approval step must be a final step" to the planner prompt (`:282`); add an `allowApprovalSteps` admission option, false for kind `audit` (set in `researchPlanAdmissionContext`, `meri-research.service.ts:4655`), and an audit prompt block next to the deliverable one (`meri-research.helpers.ts:86`); drop `waiting_for_approval` from the ready outcomes in `nextExecutableStepIndex`. Tests: `meri-research-plan.spec.ts` (`:165-220`), `meri-research-plan-admission.integration.spec.ts`, `meri-research-coordinator.spec.ts` (fixture `:55-75`).
1. *Post the card and stop.* Add a propose-only option to `MeriActionProposalService.create` (`meri-action-proposal.service.ts:593`): today PASS maps to immediate execution (`:623-628`, `:728-770`), so a job must never reach `create` without it. In `finishResearch` (`meri-research.service.ts:3725`), before the terminal compare-and-swap (`:4163-4185`), for each current-revision approval step whose dependencies completed: one bounded no-tool drafting call, `tools.validateSideEffectingInput`, `proposals.create` inside `withMeriToolExecutionControl` with `conversationId = handoff.conversationId`, idempotent by fingerprint (index `meri_action_proposal_tenant_fingerprint_idx`), and `proposal:<id>` written into `step.operationRefs` in the same compare-and-swap. The run is then terminal and makes no model calls. `projectMeriJobStatus`: a complete run with a current-revision `waiting_for_approval` step carrying a proposal ref projects `waiting_for_user`; legacy steps without a ref stay `completed` (t5-check-12 has one).
2. *Settle on decision.* A pure `settleDurableResearchApprovalStep` in the coordinator that needs no lease and uses only existing outcomes and event types (the web parser drops a snapshot with an unknown enum, `apps/web/src/components/chat/meri-durable-research.ts:145-164`, `~:250`): succeeded → completed; dismissed, expired, blocked → cancelled with `approval_*` failure codes; failed_terminal → cancelled; outcome_unknown → uncertain_effect. Call it with a compare-and-swap at read time from `getCoordinatorSnapshot` (`:1314`), `getSession` (`:486`) and `listSessions` (`:338`); execution stays in `approveAndExecute`. Web: "Approval needed" with a link to the Approvals tab in `MeriDurableResearchControls.tsx` (`:43`), and a proposal refetch when the job becomes `waiting_for_user` (`useMeriChatController.ts:3522`).
3. *Rejection* records the outcome; with final-only approval steps nothing else is left to run, so "continue with the safe steps" holds trivially. One coordinator spec.
4. *T8.* First run T8 once as a plain chat turn: it may already pass on the chat path (WARN card). Add T8 to `evals/meri/simple/program-tasks.mjs` (only T1 to T4 exist, `:11`) and a precondition in `run-cases.mjs` `approve_proposal` (`:94`): exactly one proposed `send_email`, `preview.fields.to` equal to the tester and no cc or bcc (`meri-action-preview.ts:96-100`), no sent receipt before approval; otherwise dismiss and fail.
5. *T9.* Add T9 (Neo's prompt is in `efficiency-check/commitments-check.mjs`). No web path launches kind `audit` (only `delegateJob`, deliverable kind, `useMeriChatController.ts:1639`); run it through `POST /api/clio/research` with `kind: 'audit'`, or add a launch. Check: no `create_task`/`update_task` proposal for the conversation, statuses limited to the three. Do not bind the `commitments_audit` procedure to the audit job: the one real T9 run (`594a31e5`) already used the three statuses and made only reads, and the binding's allow-list (`meri-procedure-runtime.ts:10-20`, `:85-100`) would drop `search_memory` and `read_monday_client_boards`, which that run used. Bind it only if a T9 job run shows a fourth status or raises a write proposal, and then extend `PROCEDURE_CAPABILITY_TOOLS` first.

**Done when** T8's email arrives only after approval in Meri, nothing sends before, and T9 completes with no task created; Neo passes both. Regression specs to extend are listed in the reader output (API: plan, admission, coordinator, job, research service, proposal service and HTTP spec, sweeper; web: durable research controls, snapshot parser, Approvals tab, Running jobs).

### 3.4 Release E: scheduled and proactive work (program §5.5; T10, T11, T13)

**What exists, and how scheduled work authenticates today.** No token is stored. The hourly tick (`apps/api/scripts/run-clio-scheduled-tasks.ts:306`; live rule `capiro-dev-run-clio-scheduled-tasks`, ENABLED, `cron(15 * * * ? *)`, logging `due:0` every hour) reads due rows under `withSystem`, rebuilds the owner's context from an active membership before every effect (`meri-schedule-execution-boundary.ts:218-329`), and runs its own bounded **non-V3** Anthropic loop over `MeriToolsService` (6 rounds, 1,500 output tokens, read-only allow-list), writing results to the inbox (`clio_proactive_alerts`, type `scheduled_task`). `generate-meeting-briefings.ts` and the MeetingPrepJob worker use the same service-identity pattern. V3 cannot run that way: `meri-v3-research-runner.ts:417` requires a bearer token, and the orchestrator's delegated guard (`meri-tenant.guard.ts:57-115`) stops at tool execution (`api-tool-executor.repo.ts:120-123`).

**Decision for Neo: how a scheduled run executes when nobody is signed in.**
- (A) Stored delegated grant (encrypted per-user credential or a minted Clerk token per run): full V3 quality unattended; an auth change, new secret store, likely a migration.
- (B) Service identity for V3, extending the delegated orchestrator path through the API tool route: one runtime, no stored token; an auth change across two services needing a security review.
- (C) Keep the existing non-V3 runner as the scheduled path, as a recorded limitation, and fix it: failure and partial alerts, a terminal `kind: 'scheduled'` job row per occurrence, pause, resume and run-now, weekday and timezone anchoring. No auth change, no migration, already live; scheduled briefs are shallower and a second bounded loop sits next to V3.
- (D) Notify-to-open: the tick creates a queued `kind: 'scheduled'` job and an inbox item; it runs in V3 when the user opens it. Nothing is waiting at 8 a.m.

**Recommended: C now, plus D's "Open in Meri for a full run" link on each result**; record the limitation in `02-handover.md`; keep B as the follow-up if Neo judges the scheduled briefs too shallow at the T10 verdict. A and B fall under the no-auth-change guardrail.

**Build order (C):**
- E1. *Schedule correctness.* `computeNextRunAtAnchored` (`meri-schedule.helpers.ts:152-178`) anchors only a UTC minute of day and steps from today, so a weekly run lands on the creation weekday and 8 a.m. ET drifts with DST: T10 ("every Monday at 8") fails as worded. Add weekday and IANA time zone to the anchor and the `schedule_task` schema (`meri-tools.service.ts:1694-1721`), bump the schedule fingerprint version, and show owner, cadence and next run in the proposal preview (`meri-action-preview.ts:19`).
- E2. *Controls.* `pause_scheduled_task`, `resume_scheduled_task`, `run_scheduled_task_now` (sets `next_run_at` to now for the next tick), all through proposals; register in `packages/meriv2-core/src/registry/tool-execution-metadata.ts:42` (`STANDING_AUTOMATION`), the gateway task pattern (`meri-semantic-tool-gateway.ts:183-194`), and the receipt reconciliation that `schedule_task` uses.
- E3. *Honesty and visibility.* The runner returns partial text and finishes `ok` on a provider error or the round cap, and a failed run posts nothing while `next_run_at` has already advanced (`run-clio-scheduled-tasks.ts:218-227`, `:303`, `:507-508`, `:576`, `:615`, `:722`). Add a `partial` terminal status (also in the SQL `CASE` in `advanceScheduledTaskExecution` and the Postgres kill and restart specs) and a failure alert; never record a failed run as "no change". Link each occurrence to a terminal `kind: 'scheduled'` session (`createSession`, `meri-research.service.ts:560`, needs `meri.jobs`, already on for capiro-internal). `generate-meeting-briefings.ts` dedupes by status only, with no unique key, and skips meetings after a missed day; fix both when T13 touches it.
- E4. *T11.* No Meri tool follows or tracks a bill. Add `track_bill`/`untrack_bill` over `TrackerService.trackBill` (`apps/api/src/tracker/tracker.service.ts:352-386`; import `TrackerModule` into the Meri module; call `ensureClientVisible` first, since `trackBill` has no wall check), one confirmation, with a receipt in the conversation. Check parity with the intel-api twin the web actually uses (`intel-api/src/tracker/tracker-board.service.ts:1584`) before choosing the owner. Moves stay on `detect-tracker-alerts` ("watches keep their owners"), which does not write the Meri inbox today.
- E5. *T13.* `create_meeting_brief` submits a durable MeetingPrepJob (calendar meeting, attendees, notes, debriefs, mail threads, tasks, client memory, Monday) but does not read client documents; extend the gateway meeting pattern (`meri-semantic-tool-gateway.ts:178-182`) with `find_contacts`, `read_client_meetings` and `read_client_documents`. `create_meeting_brief` is an internal write; whether that is "no effect" is part of Neo's verdict.
- E6. Live checks on the QA client (T10: create with one confirmation, run now, inbox, pause; T11; T13), then Neo's verdicts. Do not adopt Hermes `todo_tool`, `background_review` or `delivery_queue` (section 4).

### 3.5 Release F: Playwright flows (program §5.8)

Nothing in `apps/web` resolves Playwright today (`apps/web/package.json:51`; `playwright-core` 1.63.0 is in the lockfile only through `apps/api-strategy`); vitest includes only `src/**` (`apps/web/vitest.config.ts:8`), so an `e2e/` folder is not picked up. Build: `@playwright/test` pinned at 1.63.0 (the lockfile's `playwright-core` version) in `apps/web` devDependencies; `apps/web/playwright.config.ts` (`testDir: 'e2e/meri'`, one worker, no retries, no web server, base URL `https://os.capiro.ai`, Chromium from the local cache); an `e2e:meri` script that is never wired into turbo or CI; a fixture that imports `evals/meri/simple/auth.mjs` (`withTestAccount` `:43`, `withSecondReviewer` `:48`) instead of copying the Clerk code; four specs. Port `outputs/meri-stage2-20261006/t7-browser.mjs` for the steer, close, reopen and stop flow: drop its cross-worktree import (`:8`) and hard-coded Chromium path (`:16`), replace fixed sleeps with polling on the job read, and assert `goalRevision` 0 → 1 (every live run shows one increment). The approval-gate flow needs Release D and the schedule flow needs Release E, so land the harness with flows 1 and 2, and add 3 and 4 in the D and E PRs. Each flow is one paid job; never two at once; never in CI.

### 3.6 `02-handover.md`

Write it with `02_READY_FOR_03` when all four traits have a passing task and no open fail on walls, approvals or truthfulness; otherwise `02_BLOCKED` with the exact blocker. Record: the scheduled-run limitation if section 3.4 option C is chosen; that H4 progressive discovery is on main but served only with `MERI_SEMANTIC_TOOL_GATEWAY_ENABLED` (the orchestrator is in legacy mode); the steering budget decision from section 3.2. Update `STATUS.md`.

### 3.7 Stage 3: Claude as a second provider (program §6; deployment §5)

**Corrections to the 2026-10-06 plan, verified on main:**
- The three `provider: 'openai'` literals in `meriv3-assistant.service.ts` are now at **1279, 2606 and 4309**. Two more are in `apps/api/src/meri/meriv3-proxy.service.ts` (`:511`, `:859`).
- **The admin model endpoint rejects any Claude id.** `POST /api/capiro-admin/tenants/:tenantId/ai-credential/model` accepts only `provider === 'openai'` with `modelOverride: 'gpt-6.1-sol'` or `restoreDefault` (`capiro-admin.controller.ts:317-332`, service `:855-857`); tenant overrides are provider-bound (`ai-credential-resolver.service.ts:155`) and applied only with a tenant key (`openai-responses.client.ts:339-341`). The comparison window needs a new mechanism (decision below).
- **Cost does not come from `meri.api.turn.finalized`**: its usage is deliberately empty and its provider is hard-coded. Take cost from `meri.orchestrator.turn.finalized` or `meri.provider.attempt.finalized` in `/capiro/dev/meriv2-orchestrator`, latency from `durationMs`. For cost per completed job, emit `chargedCostMicros`, `chargedTokens` and `chargedAttempts` on `meri.research.terminal` (`meri-research.service.ts:2611-2622`) in PR 3-3; that is a native telemetry addition, not an OpenTelemetry adoption.
- The Research Director critic and synthesis finalization run **inside** `OpenAiResponsesClient.complete` (`openai-responses.client.ts:607-760`). Unless PR 3-1 lifts them into a provider-neutral wrapper, T5 and T12 on Claude would skip finalization.
- The V3 OpenAI client does not stream (`:484-495`); the V3 input is in Responses item format (developer messages, `function_call`/`function_call_output`, `input_image`, replayed output items at `meriv3-assistant.service.ts:1852`). The adapter translates both ways, carries raw Anthropic content blocks (thinking included) in an opaque output item that is replayed unchanged, and drops thinking blocks when Jev passage selection rebuilt the input (`jev/passage-selector.ts:835`).
- `prepareAnthropicRequest` normalizes only `claude-sonnet-5` (`packages/shared/src/ai-model-policy.ts:86`, `:105`). For `claude-opus-5-5` it passes the body through: no effort default and no handling of a forced `tool_choice` (`consumeForcedFirstTool`, `openai-responses.client.ts:344-356`). Re-check the Opus 5.5 constraints in the deployment plan §5.1 against the current API reference before writing 3-2.
- `AI_PRICING` has `claude-sonnet-5` but not `claude-opus-5-5`, and `computeAiCostUsd` ignores cache-read discounts (`packages/shared/src/index.ts:3737-3758`).
- The existing Anthropic call in `request-scoped-llm.client.ts:518-656` has no Retry-After handling; reuse the exported `parseRetryAfterMs` (`openai-responses.client.ts:40`) for 429 and 529.
- The run budget already supports `anthropic_messages` in both services (`meriv3-run-budget.ts:38`, `:542-574`); no change.
- The CDK puts `ANTHROPIC_API_KEY` on the orchestrator task definition (`compute-stack.ts:1414`); the live task definition was not read for this plan. Read it before roll 8.

**Order.** 3-1: rename `OpenAiResponsesResult` (`meriv3.types.ts:156`) to a provider-neutral result, add a `MeriV3ModelClient` interface, optionally lift research finalization; no behavior change; gate: orchestrator typecheck and every `openai-responses.*.spec.ts` and `meriv3-assistant.service.spec.ts` unchanged. 3-2: `meriv3/anthropic-messages.client.ts` (streamed, prompt-cache helpers, platform `ANTHROPIC_API_KEY` only, never the request's OpenAI key, `anthropic_messages` budget kind, Retry-After), `prepareAnthropicRequest` extended for Opus 5.5 with a shared spec, the Opus 5.5 price; specs against recorded responses (refusal, 429 with Retry-After, tool round trip, streamed thinking echoed unchanged, forced-tool mapping, developer-message mapping, and `stop_reason: max_tokens` with a partial `tool_use` mapping to a non-completed status with no function calls). 3-3: provider chosen from the model id in `meriv3-reasoning.ts:43`, both clients and a selector from `meri.module.ts:65`, the assistant and its three subclasses (`meriv3-managed-mcp-assistant.service.ts:146`, `meriv3-retrieval-assistant.service.ts:173`, `meriv3-clean-assistant.service.ts:351`) depending on the interface, literals replaced, `meterRound` passing `anthropic`; dark until a tenant setting names a Claude model. 3-4: `03-handover.md` with the comparison record and decision.

**Decision for Neo: how capiro-internal alone points at a Claude model.** (A) A narrow tenant-scoped Meri model setting with an allowlist (`gpt-6-astra`, `gpt-6.1-sol`, `claude-sonnet-5`, `claude-opus-5-5`), set through a new capiro-admin route and forwarded in the governed context; a Claude id always uses the platform key; no credential storage or decryption touched. (B) Widen the credential model endpoint to Anthropic credentials (BYOK storage and decryption path; near the guardrail). (C) Change the orchestrator's `MERIV3_MODEL` for the window (moves all six tenants). **Recommended: A.** Also ask whether to add `claude-sonnet-5-5` to the comparison, and whether 3-3 may fix the two `apps/api` provider literals (an API roll).

**Live checks.** Roll 8 (orchestrator, dark): one T1 turn reports `provider: 'openai'` and an unchanged model. Comparison window (Neo's OK once): for each model run T5, T6, T9, T12 and T13 once (twenty paid tasks, one at a time), then reset to `gpt-6.1-sol`. T9 needs Release D, so the comparison cannot finish before D ships. Expect about 340,000 input tokens per turn until program §4.6 lands. Never `cdk deploy Capiro-dev-Compute`.

### 3.8 §5.7 Congressional drafting (T16 to T18), after §5.8 passes

**What exists.** Base snapshots are immutable `federal_evidence_revision` rows (migration `20280924030000_federal_legislative_evidence`, `:7-36`; view `federal_evidence_current` at `:200`); `read_bill_text` already pins `revisionId`, `versionHash` and `textHash` (`meri-tools.service.ts:3874-4060`). Gaps: for XML packages `extracted_text` is the raw XML (`govinfo.service.ts:314`), and the existing parser is not order-preserving (`:171-175`), so no exact-text tree exists; DTD versus USLM is not recorded. No `diff` (jsdiff) direct dependency, no schema validator, no vendored USLM or bill DTD, no drafting module or redline UI. `ClioArtifact` versions (`schema.prisma:2152`, `parentArtifactId` plus `metadata`) can carry `DraftPackageRevision` without a new table. #2035 rewrites `meri.service.ts` (6,777 to 2,308 lines); take line numbers after it merges.

**First three PRs.** (1) `apps/api/src/meri/drafting/draft-source.ts`: resolve a revision to a `DraftSource` (raw hash, format detected from root element or DOCTYPE), parse XML order-preserving with entities and external DTD fetch disabled, build nodes with provision ids, ancestor paths and reversible offsets; vendor the pinned bill DTD and USLM files only as local-resolver assets and record DRAFT-1 and DRAFT-2 in `01-source-acquisition.md` in the same PR; tests DR-01, DR-02, DR-04, DR-05, an XXE fixture, an unknown-schema fixture. (2) `drafting/draft-apply.ts`: the four bounded operations with base hash, ancestor path, expected text hash and match count checks (zero matches fail, duplicates return an ambiguity finding); `diff` as a direct dependency at the jsdiff pin for the redline only, never `applyPatch` (DRAFT-3); amount, fiscal year and numbering checks; tests DR-09 to DR-12, DR-16, DR-19 (T17 is met here). (3) The package revision on the artifact chain, one API tool that returns operative text, resulting text, redline and findings, an approval bound to the artifact hash that sends and files nothing, and the review panel; tests DR-20, DR-24, DR-26, T16, T18.

**Decision for Neo (small).** USLM and bill-DTD validation: (a) order-preserving parse plus structural checks, with the pinned schema files as resolver assets, and full XSD/DTD validation deferred until a T16 to T18 task fails without it; (b) a native or WASM validator in `apps/api`; (c) validation in the Python document lane. **Recommended: (a)**; the output must still say that schema success does not certify legal effect. Blockers: §5.8 has not passed; the backfill is not finished; the recurring BILLS, CRPT, CPRT and PLAW rules are disabled (`infra/cdk/lib/ingestion-schedule.ts:74-114`), so there is no public-law evidence and enactment is always "unknown" (DR-03).

### 3.9 2026-10-12: the Stage 1 deletions

#2032 (head `bbab4d2b8`) and #2035 (head `034a306cc`) were OPEN, MERGEABLE and CLEAN on 2026-10-07. Main has moved under both: `meriv3-assistant.service.ts` changed after #2032's base (#2181), and #2035's base `2b529f026` predates the Release A to C changes to `meri.module.ts`, `meri.service.ts`, `config.schema.ts` and `meriv3-runtime.proxy.ts`. Rebase #2035, re-verify #2032, re-run `tsc --noEmit` for `apps/api` (8 GB heap) and the orchestrator, `scripts/check-context-plane-new-bypasses.mjs`, `app.module.spec.ts` and the focused specs in each body. Precondition: zero `meri_unavailable` outside the drill since 2026-10-05 20:45 UTC. After both rolls: one T1 turn on each service; `POST /meri-api/chat` and `/meri-api/chat/stream` return 404 on the orchestrator; `GET /api/clio/status` and new conversations say `runtime: 'meriv3'`; the `meriv2.fullChat` admin flag returns 400; Deep Research unchanged; `meri_unavailable` stays 0 the week after. Then update `01-handover.md` and `STATUS.md`.

**`MERIV2_*` env (program §4.3 step 4).** Every `MERIV2_*` key on API 644 (`MERIV2_ENABLED`, `MERIV2_ACTION_PROPOSALS_ENABLED`, `MERIV2_ORCHESTRATOR_URL`, `MERIV2_CONTROL_METRICS`, `MERIV2_CONTEXT_PACKET_V2`) and orchestrator 173 (`MERIV2_WORKSPACE_BASE_URL`, `MERIV2_PORT`, `MERIV2_API_BASE_URL`, `MERIV2_LOG_LEVEL`, `MERIV2_TIMEOUT_MS`, `MERIV2_CONTEXT_PACKET_V2`) still has a reader on main after both PRs (for example `tenant-flags.ts:54`, `meri-action-proposal.service.ts:451`, `main.ts:11`). Removing them would break V3 traffic, proposals and the narrow assistants. Recommendation for Neo: record step 4 as satisfied by audit and remove nothing. The V1 `CLIO_*` keys #2035 deletes are not set on the live API, so no task-definition change is needed. Step 5 (retire the meriv2 release scripts) is in neither PR.

### 3.10 Data and operations

- **Worker-loss check** (deployment §4 note; still not proven). On the next API roll, start a job longer than about 5 minutes just before promote with `worker-loss-check.mjs`; the load balancer drains old targets for up to 300 s. Do this before Release D rolls, since D touches the resume path. This is also the evidence the LangGraph gate asks for (section 4).
- **Backfill.** Batch 29 finished at 13:18 UTC on 2026-10-07 (1,000 inserted; status still `running`). When `loop2.txt` prints `DONE`, record the final count, then run one `read_bill_text` turn on a long bill. New versions need Package 4's recurring rule (Neo's decision).
- **LegiScan.** Unchanged: the real limit is 10,000 queries a month (resets November 1); `LEGISCAN_HARD_CAP` assumes 30,000. Neo decides tier or cadence (`task_3de743b5`); then fix the constant.
- **PE $0-request defect** (PE 0603203F FY27 stores $0.0M; HASC restates $72,149,000). It is a native lineage defect, not table extraction: the R-2 cost row's other years parsed correctly, committee sources can never own `request` (`program-element-field-ownership.ts:41`, `:86-88`; `reconciliation.service.ts:219-232`), and a later same-authority zero from another document can displace a non-zero winner (`reconciliation.service.ts:219-226`). PR 1 (no decision): a SELECT-only script modeled on `audit-llamaparse-pe-units.ts` listing every PE and year with request 0 and a non-zero request observation (0603203F FY2027 named), plus a model-facing guard in `renderPeFundingForModel` (`packages/shared/src/index.ts:2357-2366`) and `getTimeline` (`program-element-read.service.ts:1198-1226`) so a $0 request beside non-zero marks is shown as unverified and never used for "above or below the request". PR 2: the write-time rule (a same-authority zero from a different document does not displace a non-zero winner; it goes to the review queue). Re-picking winners on production rows is a data write: SELECT first, approved count, Neo's OK. T2 and T6 wording must be re-checked once the guard is live.
- **Package 4** stays off until Neo decides.

### 3.11 Carry-overs (fix when a task hits them, one PR each)

| Item | Start | Fix sketch |
| --- | --- | --- |
| Parallel reads in one step serialize | `meri-research-coordinator.ts:294-295`; 409 at `meri-research.service.ts:2112-2124` | Bounded concurrent reservations per step keyed by provider call id, or queue instead of 409 |
| Research after a chat reply refused | `meri-research-producer-inputs.ts:243-247`; throw at `meri-research.service.ts:3950-3957`; `meri-research-handoff.ts:77-82`, `:110-112` | Stop sending assistant prose and the summary as producer input, or pin assistant message ids plus body hash as a governed class |
| `read_chat_attachments` fan-out | `meri-chat-attachment-read.service.ts:224-229` (5,000-character default page) | Page toward about 10,000 characters, steer the model to `query`, cap calls per attachment per turn |
| Per-turn input-token tail | `meriv3-run-budget.ts:10-17`, `:589-602` | `maxTurnInputTokens` with an honest partial, behind a tenant flag (program §4.6 step 3) |
| Deliverable title | `meri-job-deliverables.ts:63-65`; `meri-research.service.ts:575`, `:2808`; render `meri-job-deliverables.service.ts:89` | Store no title when none was given so the render uses the plan title |
| Stale "Waiting for you" | `meri-job.ts:122-123`, `:129-130`; `MeriRunningJobs.tsx:42-45` | Check `interrupted` before approval; apply the age window to `waiting_for_user`; read the "Critical Minerals" session first to confirm which case it is |
| Bounded children fail `schema_invalid` | `meri-research.service.ts:4290-4293` (parity split), `:4334` (no handles), `:4395-4398` (only the final code logged); `meri-v3-research-runner.ts:343-392` | The split can give one child only identifier-bound tools, so it reads nothing and cannot pass. Reviewers split 2 to 1 on whether fixing it improves a task (the parent re-reads every step; a working second child costs about 3 more attempts). Do it only after the T5, T6 and T12 verdict runs, and only if a run fails on attempts or a child's finding would have changed a deliverable: give both children the whole allowed set, fail fast when no handle exists (existing code), log the first rejection code with 300 characters of the reply |
| Sources footer: consulted versus discovered | `meri-research.helpers.ts:311-325`; `citationRowsOf` in `packages/shared/src/index.ts:3243-3320` has no branch for `scrape_web_page` or `read_bill_text` | Quote verification of those sources already works (D2 checks the whole ledger). Do this only if Neo's T5, T6 or T12 verdict fails the file because quoted bill or page text has no numbered source or version: one citation per envelope (url or bill id and version), version and section printed in the footer |
| `scrape_web_page` failures logged as bare 502 | `apps/meriv2-orchestrator/src/meri/api-tool-executor.repo.ts:251` | Fold into the next PR touching that file: append the upstream message to the warning; optionally one sentence in the tool description (`packages/shared/src/index.ts:4540`) pointing congress.gov bill pages to the native bill tools |

Closed since the 2026-10-06 plan: the `search_congress_bills` overflow (#2149) and the `meri-research-durable-replay.spec.ts` mock (fixed on main in `b096ee172` and `fd90d351d`; run the spec once to confirm).

### 3.12 Register addendum (docs only, any time)

`01-source-acquisition.md` was last changed on 2026-10-03 (`30b670895`). Write a dated 2026-10-07 addendum rather than editing history, from section 4 below. Statements now false on main:
- H4 "candidate-held", "absent from current integration", "omitted from the current notice" (lines 56, 75, 88-90, 112; `acquisitions/governed-tool-selection.md` lines 1 and 7). `9a651d5fa` and `25a609b26` are on main and `THIRD_PARTY_NOTICES` lines 45-54 list H4. Add: served only with `MERI_SEMANTIC_TOOL_GATEWAY_ENABLED`; the orchestrator runs in legacy mode.
- H5 "served binding candidate `5a1985ce9` … is absent" (lines 57, 94); it is on main.
- H3 "candidate held; repair active" (line 25) conflicts with "not-yet-implemented" (line 55): make it one row, retained-equivalent natively for stable ids, ledger, quote checks and consulted gating, with the footer gap in section 3.11.
- T1 "not-yet-implemented" (lines 26, 62): native joined telemetry and a dark OTLP export path are on main.
- Coordinator, UI and children "not integrated/reviewed" (line 27): native equivalents shipped; "ordered steering … not adopted" (line 69) stays true as a donor classification.
- O1 "mandatory gaps remain" (line 58): complete-call rejection and call-id correlation are native with specs; strict arguments are deliberately off (`openai-responses.client.ts:251-254`).
- D1 Docling "conditional, not activated" (lines 66, 104): Docling already exists on main as an optional engine of the defense-budget parser (`apps/defense-budget-parser`, `docling>=2.5,<3` extra, `docling_engine.py` with tests, routed from `apps/api/src/defense-budget/parser-router/route-planner.ts`). Record it.
- "Original acceptance remains 0/75, CD0/7, CW0/8" (line 15) is superseded by the T1 to T18 ledger.
- Missing: any entry after 2026-10-03, the register outcome in section 4, and DRAFT-1 to DRAFT-5 (add with the §5.7 PRs).

## 4. The open-source register: what is added to the plan and what is not

Method: eleven readers assessed every register cluster against main (`66973cd53`) and the 2026-10-06 and 07 live results. Each "add" recommendation (six) went to three reviewers with different lenses (small architecture, evidence, product value) and survived only if fewer than two refuted it; each "do not add" (five) went to an advocate told to argue for adding it. **Every add was refuted by at least two of three reviewers, and every do-not-add was upheld.** No register item is added to the plan as new work. What the readers found that is real went into section 3 as native fixes.

| Register item | Disposition on main | In this plan? | Why, and what would reopen it |
| --- | --- | --- | --- |
| H1 Hermes tool-loop guardrails | Adapted, on main | Kept, no new work | Run budget, no-progress detection and settled-read dedupe are wired with specs. Its loop detection cannot bound distinct successful reads (the attachment fan-out), which belongs to section 3.11. |
| H2 Hermes context compaction | Adapted (API, cross-turn) | Kept, no new work | No in-turn pruning, but about 90% of T9's input was cache reads, so pruning could cost more than it saves. Reopen if one request's input passes 272,000 tokens on a T5 or T9 step after program §4.6. |
| H4 Hermes progressive tool discovery | Adapted, on main, served dark | Kept, no new work | Orchestrator runs in legacy mode, so `tool_search` never reaches the model. Reopen if shadow telemetry shows a §8 task's required tool cut from the 20-schema surface. Register text is stale (section 3.12). |
| H5 Hermes firm procedures (C&D) | Adapted, on main | Kept; no binding for T9 | The T9 run already met its criteria; the binding would drop two tools that run used (section 3.3 step 5). |
| H3 grounded citations | Retained-equivalent natively for ids, ledger, quote checks, consulted gating | Conditional native fix only (section 3.11) | Refuted 2 to 1: D2 already verifies quotes against every ledger entry, and the claim-ledger re-check never runs on the research surface. Reopen on Neo's verdict. |
| O1 OpenAI tools guidance | Retained-equivalent | No | Complete-call rejection and call-id correlation are native with specs; `strict: false` is deliberate with server-side validation; no run shows an argument-shape failure. Reopen if a §8 run shows a schema-violating read-tool argument (then validate read-tool inputs server-side) or the Stage 3 comparison shows malformed calls. |
| T1 OpenTelemetry and GenAI conventions | Native telemetry on main, OTLP export dark | No | Logs Insights joins browser, API, orchestrator and provider events today; an exporter needs new infrastructure with no consumer. The cost-per-job event (section 3.7) is native. Reopen if a failure cannot be localized from the joined events. |
| E1 Promptfoo pin | Root-only pin, no consumer | No | Touches no task. Retire the pin with the offline suite. |
| E2 Playwright | Release F dependency | Already in the plan (section 3.5) | Not new work; refuted only as a request to pull Release F forward. |
| L1 LibreChat approval patterns | Study only | No | Every safety property holds natively with specs in `meri-action-proposal.service.ts`. Reopen if a Release D regression resumes the wrong step or executes twice. |
| G1 LangGraph (§9.4 gate) | Conditional, trigger not met | No | It would replace the parts that work (coordinator, epoch lease, sweeper, web resume) and cannot remove the user-token constraint. Reopen after Release D or E on two defect PRs rooted in coordinator state, or a conclusive worker-loss run that loses a committed read or re-executes an effect. |
| R1 pgvector RRF, R2 retrieval harness | Conditional | No | No run shows a recall-cap miss or a held-out exact-source miss. |
| W1 Firecrawl | Conditional | No | About 40% of `scrape_web_page` steps fail (mostly congress.gov), but the model already sees the upstream status, retries are bounded, and run 12 sourced the facts elsewhere. Only the log line in section 3.11. |
| D1 Docling, G3 ODBA | Docling exists as an optional parser engine; ODBA not adopted | No | The PE $0 defect is native lineage, not table extraction (section 3.10). Reopen only if the SELECT shows the PB cell was lost in parsing; then re-run the pages through the existing Docling engine. ODBA stays out. |
| Steering (`interrupt_control`) | Retained-equivalent natively | No | Ordered, persisted, boundary-applied steering is native and verified live. The open issue is the attempt cap and the mislabelled status (section 3.2). |
| Children delegation schema | Retained-equivalent natively | Conditional native fix only (section 3.11) | Hermes's lenient extraction would not fix the observed failure (the child has no evidence to cite) and would surface unvalidated text. |
| `todo_tool`, `background_review`, `delivery_queue` | Not adopted; native equivalents | No | The step list is already a coordinator projection; no task needs proposed procedures; Postgres-fenced receipts beat a SQLite queue. Release E's real gaps are native (section 3.4). |
| DRAFT-1 to DRAFT-5 (USLM, bill DTD, jsdiff, xmldiff, `unitedstates/congress`) | Not yet adopted | Return with §5.7 (section 3.8) | Record pins in the same PRs that use them. |

The full assessments, votes and conditions are in `outputs/meri-stage2-20261006/finish-plan-2/workflow-results.json` and `continuation-challenges.json`.

## 5. Tooling and how to ship

All under `C:/dev/main/outputs/meri-stage2-20261006/` unless noted. The release checkout is `C:/dev/main/meri-c1-20261002` (a detached worktree; never edit there). `C:/dev/main/meri-plan-read` is a read-only detached worktree at `66973cd53` used to write this plan; remove it with `git worktree remove` when you no longer need it. Code work happens in a fresh worktree per PR with a private pnpm store (the 2026-10-07 session used `C:/dev/main/.pnpm-store-meri-s2`).

| Tool | Use |
| --- | --- |
| `roll-svc.sh build <roll> <buildDir>` / `ship <roll> <buildDir> "<change>"` with `SVC=api\|meriv2-orchestrator\|web-vnext` | Deployment §2 end to end: CodeBuild ARM image from `origin/main`, smoke, push by SHA; ship = evidence PR and merge, qualify, prepare, two served-commit reads (ancestry, falling back to content containment), promote, wait for old tasks, read back every running task. `REL_DATE` and `REL_TAG` set the release folder. |
| `roll-svc-resume.sh` | The tail of `roll-svc.sh` from the qualify step, for when `gh pr merge` returned 502 but the evidence PR merged. |
| `migration_status.py <buildRoot> <outDir>` / `migration_apply.py` | Read-only `migration-status` on the candidate image (before every API roll); `migrate` only with Neo's OK. |
| `config_revision.py <service> <outDir> [KEY=VALUE…] [secret:NAME=ARN…]` | Deployment §2.5 configuration revision; refuses on an unexpected diff or if the service moved. Record in `infra/cdk/DRIFT-FINDINGS.md` and codify in `infra/cdk/lib/compute-stack.ts`. |
| `flag-flip.mjs <flag> <true\|false> <outDir>` | Tenant flag flip with readback (capiro-internal only). |
| `memory-probe/run_probe.py <apiRevision> <outDir> [probe.js]` (`PROBE_IMAGE=`) | One-off read-only Node script inside the API image as `capiro_app` through the throwaway family `capiro-dev-api-meri-memory-probe` (deregistered after each run). The read-only database path for any diagnosis below (provider ledger of a session, `clio_firm_skills` rows, PE zero-request SELECT). |
| `deliverable-check.mjs` (`DELIVERABLE_FORMAT`, `T5_TOPIC`, `DELIVERABLE_TITLE`), `t5-deliverable-check.mjs` | T5, T6, T12: one paid deliverable job, then download, main-part check, filing and repeat filing. Then `collect-logs.py <outDir> <startEpochMs> <sessionId>`. |
| `steer-check.mjs <outDir> [message]` | Steering through the API, the same request the web sends; one paid job. It steers after a fixed 60 s, so it measures a mid-gather steer, not a late one. |
| `worker-loss-check.mjs <outDir>` | Start a job, then promote; waits for the sweeper's `interrupted` plus `readyToStart`, then resumes as the web does. |
| `t7-browser.mjs <outDir> probe\|steer\|stop\|both` (`VIEWPORT_H`) | Headless Chromium (`playwright-core`, Chromium from the ms-playwright cache) signed in with a single-use Clerk ticket; `probe` costs nothing. The seed for Release F. |
| `research-check.mjs` (`RESEARCH_TOPIC`), `bill-text-check/bill-text-check.mjs`, `efficiency-check/commitments-check.mjs`, `legiscan-check/state-bill-check.mjs` | One paid turn each. Run the research check after any research-adjacent change. |
| `session-read.mjs <researchId> <out> [timeoutMs]`, `job-by-conversation.mjs <conversationId>`, `review-read.mjs`, `review-get.mjs` | Read-only session, job and review reads. |
| `fed-backfill/loop2.py <firstBatch>`, `run_once.py`, `register_td_v2.py <apiRevision>` | The BILLS backfill loop (resumable) and its task family. |
| `evals/meri/simple/` (repo) | Acceptance runner: Clerk sign-in token for neo@capiro.ai, `MERI_RUNNER_SECOND_IDENTITY` for the synthetic reviewer, automatic safety checks; `program-tasks.mjs` lists the tasks (T8 and T9 entries are still to be added with Release D). |
| `finish-plan-2/` | The register assessment behind section 4: `workflow-results.json` (11 assessments, 18 refutation votes, 1 advocate challenge), `continuation-challenges.json` (the other 4 challenges), `continuation-remaining.json` (the 4 starting-point readers behind section 3), and the drafts. |

Records per session: `STATUS.md` top block; `docs/meri/releases/<date>/README.md` with a row per roll (revision, rollback, source, digest, live check); a `HANDOVER-<date>[-part].md`; the lead agent's memory note `meri-deployment-plan-2026-10-05.md` in `C:/Users/neoma/.claude/projects/C--dev-main/memory/`.

## 6. Hazards, consolidated

The deployment plan §0.2 and §9 and every session handover's hazards section still apply. These are the ones that cost time, plus what writing this plan turned up:

- **Diagnoses written into handovers can be wrong.** The 2026-10-07 handover says a late steer "finds the budget spent" (tokens and dollars); the logs show the provider attempt cap ran out (section 3.2). Before you build on a handover's stated cause, re-read the log line it rests on.
- **The job status `finalizing` is not the end of a run.** `meri-job.ts:55-60` counts the fallback note `Reviewing evidence and preparing the report…` as finalizing, and that note covers most of evidence gathering. Do not key any behavior on `finalizing` until the section 3.2 (b) projection fix ships.
- **`CLIO_RESEARCH_MAX_PROVIDER_ATTEMPTS` is unset** on the API task definition; the code default is 23 per session, carried across goal revisions. Tokens (4,000,000) and dollars ($25) are rarely the limit that trips.
- **Other workstreams roll the same services.** Read the served SHA twice, the second time immediately before `promote`; if the candidate does not contain it, rebuild from main. The planner team moved main four commits past `66973cd53` while this plan was written.
- **`gh pr merge` can return 502 while the merge lands**; check the PR state and use `roll-svc-resume.sh`. Delete leftover `codex/meri-<roll>-evidence-*` branches before retrying an evidence step.
- **`release_helper.py evidence` fails while any of the three services has a rollout in progress**, including another workstream's.
- **Heredocs and encodings.** Heredocs mangle `\n`, `\b`, `\u0000` and some apostrophes; Python on this host opens files as cp1252 unless told `encoding='utf-8'` (it turned `§` into `Â§` in a workflow script during this plan). Write source edits with the Edit tool.
- **Long Bash commands** keep running past their 600 s timeout while later steps in the same command still execute; check the log's `EXIT` line. Use `run_in_background`, not `&`.
- **Workflow runs cannot be resumed from another session**; the journal lives under the session that ran it. Save results to `outputs/` as you go, as `finish-plan-2/` does.
- **Jest:** `meri-research-durable-replay.spec.ts` and `meri-remaining-source-families.spec.ts` need plain `jest` with `NODE_OPTIONS=--max-old-space-size=8192`; PGlite specs need `--experimental-vm-modules`; `tsc` for `apps/api` needs the 8 GB heap.
- **React tests:** `await screen.findByRole(...)` inside `act()` deadlocks; find first, then click inside `act`. The workspace reads `window.location`, so tests need the router-location probe.
- **The pnpm store** `C:\Users\neoma\AppData\Local\pnpm\store\v3` is corrupted; install with `--store-dir <private dir>`.
- **Prettier:** many files on main are not prettier-clean; check `git show origin/main:<file> | prettier --check` before `--write`.
- **Migrations:** `apps/api` migration timestamps run about two years ahead on purpose; never renumber. Triggers on `federal_evidence_revision` hold the table for minutes; apply between backfill batches.
- **The orchestrator strips any tool result over 12,000 characters to metadata.**
- **The stream endpoint rejects `reasoningMode` in the body with 400.**
- **`capiro-dev-api-diag` without a command override flips a tenant flag.** Never run it bare.
- **`memory_items` FORCE ROW LEVEL SECURITY:** read memory under `withTenantUser`.
- **Every V3 turn needs the user's Clerk session token.** The sweeper and scheduled jobs cannot run V3 turns by themselves (section 3.4).
- **`pkill` does not kill Windows processes**; use `taskkill /PID <pid> /T /F`.
- **Paid turns:** one at a time.
