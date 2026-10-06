# Meri program: handoff to finish the plan (written 2026-10-06, about 23:00 UTC)

For the Opus 5.5 lead agent. This file is the single starting point for everything that remains in [00-Meri-Program-Plan-2026-10-05.md](00-Meri-Program-Plan-2026-10-05.md) (what to build) and [00-Meri-Deployment-Plan-Opus-5-5-2026-10-05.md](00-Meri-Deployment-Plan-Opus-5-5-2026-10-05.md) (how to ship). Those two files still control; this one tells you where the program is, what is left, in what order, and what each remaining step starts from in the code. The session handovers ([morning](HANDOVER-2026-10-06.md), [pm](HANDOVER-2026-10-06-pm.md), [evening](HANDOVER-2026-10-06-evening.md)) hold the detail of how each shipped piece was tested; read them when you touch that piece.

Every fact below was read from main (`70b7da278`), the live task definitions and CloudWatch at about 22:55 UTC on 2026-10-06. Other workstreams (LegiWatch, Krisp, funding opportunities) roll the API and web-vnext several times a day; re-verify the served revisions before acting.

## 0. Prompt to start the next session

> Read `docs/meri/implementation/HANDOVER-2026-10-06-finish-plan.md`, then the program plan §0, §8 and §9, the deployment plan §2 and §7, and the top block of `STATUS.md`. Continue at section 3 of the finish-plan handoff, in order. Ship only through deployment plan §2 with the tooling in section 4. Test as program plan §9 says: typecheck and focused specs per PR, one live check on capiro-internal per user-visible change, as neo@capiro.ai, one paid turn at a time, state-changing setup only on client `ZZ-QA-Meri1651-Test-DoNotUse`. Ask me only at the deployment plan §7 checkpoints listed in section 2.3. Write `STATUS.md`, the day's release record and a session handover at the end of every session.

## 1. Where the program stands

### 1.1 By stage and release

| Piece | Plan reference | State |
| --- | --- | --- |
| Stage 1: one runtime, kill switch, Hermes decommission, capture harness removal | program §4 | **Done**, `01_READY_FOR_02` ([01-handover.md](01-handover.md)). One step remains: merge #2032 and #2035 on or after 2026-10-12 (section 3.10). |
| Stage 2 Release A: jobs foundation, migration | deployment §4 row A | **Done**, dark behind tenant flag `meri.jobs` (on for capiro-internal only since 2026-10-06 11:22 UTC). |
| Stage 2 Release B: delegate, steer, stop, resume | deployment §4 row B | **Shipped** (API #2068, #2072; web #2069, #2080 to #2083). **T5 not yet passed** (section 3.2). T7 not run. Sweeper still off. |
| Release C: Word, Excel, PowerPoint deliverables with read-back | program §5.3 | Not started. A job can only produce `docx` today. |
| Release D: approvals inside jobs | program §5.4 | Not started. |
| Release E: scheduled and proactive work | program §5.5 | Not started. |
| Release F: four Playwright flows | program §5.8 | Not started. `@playwright/test` is not in the repo. |
| §5.6 client writing profile | program §5.6 | Conditional; no trigger yet. |
| `02-handover.md`, `02_READY_FOR_03` | program §5.8 | Not written. |
| Stage 3: Claude as a second provider, comparison, decision | program §6, deployment §5 | Not started. |
| §5.7 Congressional drafting (T16 to T18) | program §5.7 | Not started; gated on §5.8 passing. |

### 1.2 Real-task verdict ledger (program §8; done means 18 tasks with Neo's verdict)

| Task | State |
| --- | --- |
| T1, T2, T3, T4, T15 | **Pass** (Neo, 2026-10-05, [review page](https://claude.ai/artifact/TSUzMTxNxPh71L8duExZQU)) |
| T5 | Ten runs. Run 10 (`ca7158f1`) published but was held for review by D2 and is slow to open. No verdict. Section 3.2. |
| T7 | Not run (after T5). |
| T6, T12 | Need Release C. |
| T8, T9 | Need Release D. |
| T10, T11, T13 | Need Release E. |
| T14 | Stage 3. |
| T16, T17, T18 | Drafting, after §5.8. |

Verdicts Neo has not yet given on work that passed its automatic checks: the D4b budget report (research `e0bd0918`), the commitments audit answer (conversation `594a31e5`, `outputs/meri-stage2-20261006/efficiency-check/run-1/answer.md`), the bill-text answer (`7965f93e`, `bill-text-check/run-1/answer.md`), and the two Stage 2 research reports from the morning (`5d29ceb1`, `d3934ccd`). Ask for them with the next batch of verdicts, not separately.

### 1.3 Served production (cluster `capiro-dev`, account `967807252336`, `us-east-1`)

| Service | Revision | Source | Notes |
| --- | --- | --- | --- |
| `capiro-dev-api` | **625** | `41aead03c` | LegiWatch's roll at about 22:45 UTC. It contains `006eb59d2` (Meri's API 623 and everything before it). 624 is the same SHA as 623, re-registered by LegiWatch's tooling. Rollback for Meri's purposes: 624. |
| `capiro-dev-meriv2-orchestrator` | **167** | `0650f02a2` | Unchanged since the pm session. Does **not** carry #2132 (D2 matcher) for chat; section 3.3. |
| `capiro-dev-web-vnext` | **431** | | Other workstreams' rolls. Release B web (#2069, #2080 to #2083) is an ancestor. |
| `capiro-dev-api-admin-migrate` | latest is a read-only `migration-status` revision registered by `migration_status.py` | | Keep the family's latest read-only (deployment §2.4). Schema was up to date on every candidate today (458 migrations). |
| `capiro-dev-api-federal-evidence-backfill` | **2** | `006eb59d2` image | One-off BILLS backfill family. Revision 1 is the API 600 image. |

Flags and env: tenant flag `meri.jobs` on for capiro-internal only; `MERI_JOB_SWEEPER_ENABLED` unset (approved, pending a T5 pass); `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED` off on the API service (on only in the backfill family); Package 4 EventBridge rules disabled; secret `LEGISCAN_API_KEY` on the API task (codified #2101). CloudWatch count of `meri_unavailable` since the T15 drill (2026-10-05 20:45 UTC): **0** as of 22:55 UTC today.

### 1.4 Open pull requests owned by the program

| PR | What | State now | Rule |
| --- | --- | --- | --- |
| [#2032](https://github.com/neo-capiro/capirov2/pull/2032) | Stage 1 §4.3 orchestrator: delete the V2 `/chat` loop, move the V3 shared contract to `meriv3/shared/` | **CONFLICTING** against main | Rebase before 2026-10-12; merge on or after that date only if `meri_unavailable` stays at zero outside the drill (section 3.10) |
| [#2035](https://github.com/neo-capiro/capirov2/pull/2035) | Stage 1 §4.3 API: delete the V1 loop, `streamMessageViaMeriV2`, routing helpers, `installRawPhase19Adapters`, `meriv2.fullChat`, six `CLIO_*` keys | MERGEABLE | Same date and condition |

Everything else the program opened is merged.

### 1.5 Background work in flight when this was written

- **Federal BILLS backfill** (119th Congress, `--full --historical`): 7,754 bill versions stored in batches 0 to 9; batches 10 to 15 failed on one large bill version (5 s transaction against the passage trigger). Fixed in #2136 (180 s), family re-registered as revision 2, and `outputs/meri-stage2-20261006/fed-backfill/loop2.py 16` resumed at about 22:16 UTC. Batch 16 (ECS task `3c73789d`) was still running at 22:54 UTC, well past the old failure point, which means the stuck package persisted and the batch is inserting. Each batch is 1,000 packages and takes about an hour. `loop2.txt` records each batch's inserted count and stops when the full checkpoint reads `completed` or two batches insert nothing. If the host session ended, run `python loop2.py <next batch>` from that folder; it resumes from the checkpoint.
- **Review `69250800`** (run 10's held brief) is pending in Reviews. Leave it to a reviewer.

## 2. Rules that do not change

### 2.1 Decisions already made (never re-ask)

Program plan §0 (D1 to D10) and §11, plus the decision tables in the [morning](HANDOVER-2026-10-06.md) §2 and [pm](HANDOVER-2026-10-06-pm.md) §2 handovers. The ones you will touch:

- Done means real tasks with Neo's verdict; automatic checks only for safety (D5). Do not build graders, repeat runs, capture kits or release-qualification kits (D6, §9).
- Build around V3; the orchestrator `meriv3/` changes only through additive modules, injection seams, or a fix for a measured defect, each verified with one live turn on capiro-internal (D3, §3 rule 1).
- OpenAI stays default; Claude is a second provider compared on real tasks; no fine-tuning without a measured gap (D2).
- Second reviewer for approval tasks is the synthetic account `qa+clerk_test-portfolio-v2-b4e7c829f2c0@capiro.ai` (D9). The runner supports it through env `MERI_RUNNER_SECOND_IDENTITY` (`evals/meri/simple/auth.mjs`, pattern `qa+clerk_test-*@capiro.ai`).
- Sweeper configuration revision `MERI_JOB_SWEEPER_ENABLED=true` on `capiro-dev-api` plus the worker-loss check: approved, to be done **after a T5 pass** without asking again.
- Federal bill data: one-off historical BILLS backfill only; the API flag, recurring rules and outbox drain stay off until Neo says otherwise.
- LegiScan: do not create additional keys (their terms suspend access); the tier-or-cadence decision is Neo's (task chip `task_3de743b5`).

### 2.2 Standing constraints

Program plan §0 last paragraph: no Hermes restart; approvals, journal history, failed runs, tenant boundaries and authorizations preserved; paid turns one at a time; state-changing setup only on the QA client; no external effect approved during testing except delivery to the tester's own mailbox; production changes with side effects need Neo's OK at the time.

### 2.3 Ask-Neo checkpoints that remain (deployment §7)

| When | Ask |
| --- | --- |
| Each Stage 2 release | Verdicts on its tasks (T5 and T7 for B; T6, T12 for C; T8, T9 for D; T10, T11, T13 for E) |
| Any migration | OK to apply (none is planned for C to F; Stage 3 has none) |
| Any production flag flip or configuration revision not already approved | OK at the time (the sweeper revision is already approved) |
| Package 4 activation (recurring BILLS rule, outbox drain, `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED` on the API) | Decision |
| LegiScan plan or cadence | Decision |
| Stage 3 comparison window on capiro-internal, and the default model afterwards | OK, then decision |
| Approving review `69250800` or any held report | Reviewer's call, never the agent's |

### 2.4 Per-PR and per-release policy

Program §9 and deployment §2. In practice: fresh worktree from `origin/main` with a private pnpm store (the shared store is corrupted); prebuild `packages/shared`, `defense-domain`, `defense-contracts`, `auth`, `meriv2-core`, then `prisma generate`; `tsc --noEmit` with `NODE_OPTIONS=--max-old-space-size=8192`; the focused specs; every fix proven by a test that fails without it; one PR per defect; evidence PR, `migration-status` on the candidate, two ancestry reads, promote, digest readback on every running task.

### 2.5 Open-source rule (program §3 rule 8)

Before writing code that open source could replace, check [01-source-acquisition.md](01-source-acquisition.md). Adopted and kept: Hermes H1, H2, H4, H5 (notice in root `THIRD_PARTY_NOTICES`). Returning to scope with §5.7: USLM schemas and the bill DTD, jsdiff, xmldiff (conditional), `unitedstates/congress` fetch patterns. Conditional with recorded triggers: Docling, LangGraph, pgvector RRF, retrieval harness, GovCon playbooks. Study only: LibreChat approval patterns (relevant to Release D; our proposals already exist). Each adoption records URL, pinned SHA, license, exact slice, destination and the regression that proves it. Register inconsistency to clean up when you next edit that file: its "current consolidation checkpoint" marks H4 integrated while its license paragraph says H4 is absent from the notice; the notice does list H4.

## 3. Work remaining, in order

Each item: why it is next, where to start in the code, what done looks like, the live check, and whether Neo is asked.

### 3.1 `search_memory` latency (blocks T5 and slows every chat turn)

**Fact.** In T5 run 10, partial `search_memory` reads took 17.8 to 20.2 s or 35.6 to 36.7 s each in the API (16 calls, 386 s); exact-item lookups took 0.3 s. API telemetry (`meri.api.tool.started` to `finalized`) places the time inside the API. The 36 s calls are two 18 s reads: `apps/api/src/meri/meri-tools.service.ts:3448` re-reads with page size 1 when a page's metadata is over budget. The report re-check replays these reads (now once per distinct read, four at a time, #2134), so opening a report that rests on many memory reads still takes about two minutes (133 s measured on 623 for session `ca7158f1`).

**No timer near 18 s exists on the path.** Two hypotheses, both needing production evidence:

1. One SQL statement scans every eligible memory. `apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts`: the statement at lines 166 to 233 has `eligible_base AS NOT MATERIALIZED` (167) and `eligible AS NOT MATERIALIZED` (188), and `eligible` is used three times; per-row `STRING_AGG` and `STRPOS`; `memory_items` has FORCE ROW LEVEL SECURITY with an owner-aware policy (see memory note `memory-items-forced-owner-rls`); the semantic part sorts by vector distance over the joined embeddings. Candidate fix: `eligible AS MATERIALIZED` at line 188 (plan only; rows, ranks and cursor unchanged).
2. Prisma's 5 s interactive transaction plus a silent fallback. `withTenantUser(` at line 141 runs without `timeoutMs`; a slow semantic query then fails at commit ("Transaction already closed") and the bare `catch {` at line 328 reruns the whole read lexically and marks the source degraded (`stopReason: governed_memory_semantic_projection_incomplete`). Candidate fix: pass a `timeoutMs` and log the caught error.

**Start.** (a) Read the stored receipts for `ca7158f1` and check `coverage.sources[].stopReason` and `sourceStatus` on the slow `search_memory` results (the sealed results are `internal_research_safe_read_result` artifacts; the receipts are in the session's `durableStepReceipts`). (b) Run `EXPLAIN (ANALYZE, BUFFERS)` of the adapter's statement as a capiro-internal user inside `withTenantUser`. This needs a read-only database path; this session had none. Options: a one-shot ECS task on the API image running a small script (the pattern of `migration_status.py`), or the diag family with an explicit command override (never run `capiro-dev-api-diag` without an override; its default command flips a tenant flag). (c) Fix the confirmed cause, add the embedding budget and the fallback to a log line so the next regression is visible, roll the API, and measure: one chat turn's `search_memory` steps (`meri.tool.step.finalized` `durationMs` in the orchestrator log) and `node outputs/meri-stage2-20261006/session-read.mjs ca7158f1-2598-4a3b-82d2-4f2d88abdb92 <out>` (prints `elapsedMs`).

**Done when** a partial memory search takes about as long as a complete one (under 2 s) and a report with 40 receipts opens in under 15 s. No Neo question unless the fix needs a configuration revision.

### 3.2 T5 to a pass, then the sweeper, then T7

**T5.** `node outputs/meri-stage2-20261006/t5-deliverable-check.mjs <outDir>` (one paid job on the QA client; pass = job `completed`, the `.docx` downloads with `PK` magic, filing returns a document id once and the same id on repeat). Afterwards `python collect-logs.py <outDir> <startMs> <sessionId>`; it now prints the proof-clause, child-proof and re-check refusal lines, which named the defect every time today. History: ten runs, eleven defects fixed ([pm §5](HANDOVER-2026-10-06-pm.md), [evening §2](HANDOVER-2026-10-06-evening.md)). Known remaining risks: D2 may still hold the brief (the matcher fix #2132 is live on the API; whether the model's quotes are real depends on `read_bill_text` succeeding, which failed in run 10 because the bill was not stored; the backfill fixes that); the planner puts a read step after the approval step (never runs; harmless); `search_memory` is always partial on capiro-internal (a partial-coverage disclosure is expected). If the job completes but the brief is held, that is a publication pass with a content hold: record it as such, run the deliverable download and filing checks anyway (they run only when the job is `completed`; the script already does), and ask Neo whether a held brief counts for T5 or whether the quote must be verified first.

**Sweeper (approved).** After a T5 pass: `python outputs/meri-stage2-20261006/config_revision.py capiro-dev-api <outDir> MERI_JOB_SWEEPER_ENABLED=true` (deployment §2.5; refuses on any unexpected diff). Record in `infra/cdk/DRIFT-FINDINGS.md` and codify in `infra/cdk/lib/compute-stack.ts` in the same PR as the next code change. The sweeper (`apps/api/src/meri/meri-job-lease-sweeper.ts`) runs every 60 s on every replica, reclaims leases expired for more than 60 s past the 120 s lease, moves `running` to `interrupted` with `readyToStart: true` and `cancel_requested` to `cancelled`. It cannot resume execution itself (every V3 turn needs the user's session token); the web resumes once when the conversation is open (#2083).

**Worker-loss check (deployment §4 note).** On the next API roll after the sweeper is on: start a T5 job on the QA client, promote, confirm the job resumes under a new lease epoch when the conversation is reopened and finishes. Record it in the day's release record.

**T7.** Start T5 again; mid-run send "House version only"; close the tab; reopen; watch it finish; then start another and press Stop. Steering increments `goal_revision` and a step from an older revision cannot publish (exists for research; check it holds for the deliverable kind). Stop shows `cancel_requested` until the run confirms `cancelled`. This one is a browser check as neo@capiro.ai (the Playwright sign-in recipe is in memory note `playwright-prod-auth-os-capiro`), one paid job each. Then ask Neo for the T5 and T7 verdicts.

### 3.3 Orchestrator roll for #2132

The chat auditor runs the same D2 from `@capiro/meriv2-core` (`apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts:1360` and `:3855`); the orchestrator is a workspace consumer, so a plain roll from current main picks the fix up. `SVC=meriv2-orchestrator bash roll-svc.sh build <roll> orch-build-6` then `ship`. Live check: one chat turn on capiro-internal that quotes a bill passage (reuse `bill-text-check.mjs`) and is not held. Do it with the next orchestrator change if one is near; otherwise on its own.

### 3.4 Release C: deliverables (program §5.3; T6, T12, T4 rerun with PPTX input)

**Where things are.** `apps/api/src/meri/meri-job-deliverables.ts:11` `RELEASE_B_DELIVERABLE_FORMATS = ['docx']` and the request parser that refuses anything else; `meri-job-deliverables.service.ts` renders a Word document from the authorized report at read time (held and withheld rules apply; nothing derived is stored) and files it with key `meri-job:<id>:<index>`; `meri-job-deliverables.controller.ts` routes `GET /api/clio/research/:id/deliverables/:index/docx` and `POST …/file`. `meri-docgen.service.ts` already builds Word (`docx`), Excel (`exceljs`) and PowerPoint (`pptxgenjs`) from a normalized spec; `run_analysis` (three call sites in `meri-tools.service.ts` around 2314 to 2409) produces artifacts in chat today. Filing confirmation lives in `apps/meriv2-orchestrator/src/meri/chat/client-filing-confirmation.ts` (`enforceClientFilingConfirmation`); #2032 moves it to `meriv3/shared/`, so land Release C's orchestrator-side change, if any, after that merge or rebase accordingly.

**Build.** Extend the format union to `xlsx` and `pptx`; add per-format render routes (or one route with the format in the path); keep the rule that the file is rendered from the authorized report so held and withheld reports never produce bytes; read the produced bytes back (ZIP magic and a parse of the container) before the job reports delivery; deliverable titles from the request. For Excel the plan's task is a House-versus-Senate marks comparison for a client's program elements: the research path already reads `get_program_element` and `get_pe_budget_timeline` (receipted since #2063); the spreadsheet is a spec from that evidence. For PowerPoint, a six-slide quarterly update. Keep the response contract (program §2 of file 01 annex §8.1): conclusion, client implication, evidence, labeled judgment, next action, gaps. The orchestrator strips any tool result over 12,000 characters to metadata, so a deliverable spec passed through a tool must stay under that or be built API-side from the report.

**Done when** T6 (Excel) and T12 (deck) run through "Delegate this" on the QA client, the files download as real Office files, file once, and Neo passes them; plus T4 rerun with a PPTX input now that the WAF exception exists. No migration. Expect the research path to surface new defects, as T5 did; one PR per defect, clause logs first.

### 3.5 Release D: approvals inside jobs (program §5.4; T8, T9)

**Where things are.** Proposals and approvals exist as product: `apps/api/src/meri/meri-action-proposal.controller.ts`, `meri-action-proposal.service.ts`, `meri-approval.service.ts` (self-approval blocked; approval binds to the payload hash); web `MeriApprovalsTab.tsx`, `MeriApprovalNotice.tsx`. Research plans already carry an `approval_required` step (T5's `propose-word-client-file`), and today research never executes approvals: the job projection reads running and failed runs before an approval-wait step (#2094), and the planner sometimes puts a read step after the approval step, which never runs. Reviews (`apps/api/src/reviews/reviews.controller.ts`: `POST :id/assign|approve|reject`) are a separate queue for held reports; do not conflate them with action proposals.

**Build.** When a job step wants an effect (send mail, create a task, file externally, publish): the job enters `waiting_for_user`, posts the existing proposal card in the thread, and stops consuming model calls; approval resumes the job under the same lease rules (a new epoch is fine); rejection records the outcome and the job continues with the remaining safe steps. The second reviewer approves through the product UI or `evals/meri/simple/` with `MERI_RUNNER_SECOND_IDENTITY`. For T8 the only allowed delivery is to the tester's own mailbox (pre-approved by Neo). For T9 (commitments audit) the audit kind must create no task; Neo's own commitments prompt and the measured run are in `outputs/meri-stage2-20261006/efficiency-check/`.

**Done when** T8's email arrives only after approval inside Meri, nothing sends before it, and T9 completes with statuses limited to completed, in progress, no record of action, and no task created; Neo passes both. Program §5.4 also lists xlsx and pptx inputs and outputs end to end; the inputs are done (Stage 1), the outputs come from Release C.

### 3.6 Release E: scheduled and proactive work (program §5.5; T10, T11, T13)

**Where things are.** `ClioScheduledTask` (`apps/api/prisma/schema.prisma:2470`: `scope`, `name`, `prompt`, `intervalMinutes` at least 60, `toolAllowList`, `enabled`, `lastRunAt`, `nextRunAt`), `apps/api/src/meri/meri-schedule-execution-boundary.ts` (lease, heartbeat, three attempts, durable and notification receipts), `meri-schedule.helpers.ts`, `meri-briefing-schedule.helpers.ts` with `scripts/generate-meeting-briefings.ts`. Job kind `scheduled` already exists in `MERI_JOB_KINDS` (`meri-job.ts:17`) but nothing creates it. LegiWatch follows and digests have their own owner and scheduler; Meri subscribes through their services.

**Build.** A scheduled tick creates a job with `kind: 'scheduled'` so results show in the same progress and inbox views; creating, pausing and cancelling a schedule from Meri goes through a proposal (one confirmation) showing owner, cadence and next run; delivery through the existing notification receipts; a failed or partial run is never recorded as "no change". The hard constraint from Stage 2: a scheduled job cannot run V3 turns without a user session token (the sweeper has the same limit). Check how `meri-schedule-execution-boundary.ts` and `generate-meeting-briefings.ts` authenticate today before designing the tick; if they use a service identity for a non-V3 path, the scheduled job needs either a stored delegated grant or a documented limitation, and that is a design decision to put to Neo with options, not to invent.

**Done when** T10 (schedule on the QA client, one triggered run, inbox result, pause), T11 (LegiWatch follow created through Meri and visible in the conversation) and T13 (meeting prep from calendar, notes and documents, no effect) pass with Neo's verdicts.

### 3.7 Release F: Playwright flows (program §5.8; deployment §4 row F)

Add `@playwright/test` to `apps/web` devDependencies (only `playwright-core` exists today, under `api-strategy`; `apps/web` tests are vitest). Four flows under `apps/web/e2e/meri/`: delegate and deliver; steer, close, reopen, stop; approval gate; schedule. Sign in through a Clerk sign-in-token ticket for the runner identity (memory note `playwright-prod-auth-os-capiro`: mint on the `/capiro/dev/clerk/secret-key` instance, `page.goto('https://os.capiro.ai/sign-in?__clerk_ticket=<token>')`, single use). Run once per release that touches a trait, never as a CI gate (CI is intentionally broken; never deploy through it).

### 3.8 §5.6 writing profile

Only if Neo judges a Stage 2 draft off-voice. A governed memory item plus up to five exemplar documents; no new tables unless memory items and document links cannot carry it.

### 3.9 `02-handover.md`

Write it with `02_READY_FOR_03` when all four traits have a passing task and no open fail on walls, approvals or truthfulness. Otherwise `02_BLOCKED` with the exact blocker. Update `STATUS.md`.

### 3.10 2026-10-12: the Stage 1 deletions

Precondition: zero `meri_unavailable` refusals outside the drill since 2026-10-05 20:45 UTC (Logs Insights on `/capiro/dev/api`, filter `meri_unavailable`; 0 rows at 22:55 UTC today; alarm `Capiro-Meri-Unavailable` also tracks it). #2032 is **conflicting** with main: rebase it in a fresh worktree, re-run the orchestrator typecheck and its focused specs, and re-check that the four V3 importers of `chat/chat-prompt.ts` and `chat/client-filing-confirmation.ts` resolve to `meriv3/shared/`. #2035 is mergeable; its body lists the behavior changes to check (status `runtime: 'meriv3'`, admin flag 400 for `meriv2.fullChat`). Merge both, roll both services, one live turn each (T1 prompt), then update `01-handover.md` and `STATUS.md`. Remove `MERIV2_*` env from the task definitions in that roll and record it (program §4.3 step 4).

### 3.11 Stage 3: Claude as a second provider (program §6; deployment §5)

Six PRs, one dark orchestrator roll, a comparison window, a recorded decision. Exit `03_COMPLETE`.

**Seams, verified on main today.** `apps/meriv2-orchestrator/src/meri/meriv3/openai-responses.client.ts` (with `openai-responses.retry-after.spec.ts`: Retry-After is honored), `meriv3-reasoning.ts`, `meriv3-run-budget.ts`, `meriv3-pricing.ts`; the three `provider: 'openai'` literals in `meriv3-assistant.service.ts` are at lines **1272, 2599 and 4302** (the plan's numbers are stale); `apps/meriv2-orchestrator/src/meri/request-scoped-llm.client.ts` already calls `https://api.anthropic.com/v1/messages` with thinking-delta parsing; `prompt-cache.helpers.ts` next to it; `prepareAnthropicRequest` at `packages/shared/src/ai-model-policy.ts:86`; the admin endpoint `POST /api/capiro-admin/tenants/:tenantId/ai-credential/model` at `apps/api/src/capiro-admin/capiro-admin.controller.ts:298`.

**Order (deployment §5.1).** 3-1 rename `OpenAiResponsesResult` to a provider-neutral type, no behavior change; 3-2 `anthropic-messages.client.ts` with the same `complete(params)` contract and unit specs against recorded responses (a refusal, a 429 with Retry-After, a tool call, a streamed thinking block); 3-3 client selection by model id in `meriv3-reasoning.ts`, the client interface provided from `meri.module.ts`, `provider` reported from the client (the only V3 edit, dark until a tenant policy names a Claude model); 3-4 the comparison record. Before writing 3-2, read the `claude-api` skill's model-migration notes; the adapter constraints in deployment §5.1 (adaptive thinking only for Opus 5.5, `output_config.effort` mapping, no forced tool choice, no prefill, echo thinking blocks unchanged, stream everything, `stop_reason: 'refusal'` surfaced honestly, Retry-After on 429 and 529, usage fields and prices) were verified on 2026-10-05 and must be re-checked against the current API reference.

**Roll 8** (orchestrator, dark): one live turn still reports `provider: 'openai'`. **Comparison window** (deployment §5.3): first verify whether the credential model endpoint accepts a Claude id on the tenant's OpenAI credential and that a tenant OpenAI key is never sent to Anthropic (the platform `ANTHROPIC_API_KEY` is expected); if the credential is provider-bound, add a tenant-scoped model override read by `meriv3-reasoning.ts` in 3-3. Ask Neo once for the window; for each of `gpt-6-astra`, `gpt-6.1-sol`, `claude-sonnet-5`, `claude-opus-5-5` run T5, T6, T9, T12 and T13 once (twenty paid tasks), record verdict, cost and latency from `meri.api.turn.finalized`, set the model back to `gpt-6.1-sol`. Decision per surface in `03-handover.md`; a HOLD is a complete outcome; a new default is a §2.5 configuration revision plus CDK codification with Neo's OK. Fine-tuning stays on hold.

### 3.12 §5.7 Congressional drafting (T16 to T18), after §5.8 passes

Scope and order in program §5.7; contracts in [02-Meri-Coworker-and-Congressional-Drafting.md](02-Meri-Coworker-and-Congressional-Drafting.md) §8.6 (line 483; `DraftSource`, `DraftOperation`, `DraftPackageRevision`, `DraftFinding` type definitions from line 529) and the DR-01 to DR-30 cases as the reference specification; drafting source acquisitions in its §9.6 (line 848). It may run alongside Stage 3 (API domain layer and web workbench versus the orchestrator provider seam). Record the result as an addendum to `02-handover.md`; it does not gate `02_READY_FOR_03`. The bill text store from the backfill is the base-snapshot source for federal amendments (`federal_evidence_current` over `federal_evidence_revision`, read by `read_bill_text`); the exact-text anchors must be taken from the stored version text, never from a model summary. First open-source adoptions under rule 8: USLM schemas and the bill DTD for validation, jsdiff for the local revision diff; record pins and slices in `01-source-acquisition.md` in the same PR.

### 3.13 Data and operations

- **Backfill completion.** When `loop2.txt` prints `DONE`, record the final count in `STATUS.md` and the day's release record, then run one `read_bill_text` turn on a long bill (the FY27 NDAA, if stored) to confirm the in-bill locator at scale. New bill versions do not arrive until Package 4's recurring BILLS rule is enabled (Neo's OK; Package 3 gate) or a non-historical reconciliation run is approved. Committee reports, prints, public laws and the Congressional Record are not included.
- **LegiScan.** The key's real limit is 10,000 queries per month (exhausted since early October; resets November 1). Our quota code assumes 30,000 (`LEGISCAN_HARD_CAP`) with a 28,000 soft budget and disagrees with LegiScan's count. The hourly state syncs log `INGESTION_SKIP reason=quota`; the live lookup (#2098) refuses honestly. Bring Neo the tier-or-cadence decision; fix the cap constant to match the plan he picks. Task chip `task_3de743b5`.
- **PE $0-request data defect** (cases 20 and 21; program §1.3 items 1 and 2): PE 0603203F stores a $0.0M FY27 request against a $72,149,000 source row, and many PE rows store a $0 request, so the model declines to cite them. Production data normalization, not repaired. Neo said his validation will take a while; do not wait on it, but a Release C spreadsheet (T6) will hit it, so plan the fix into Release C.
- **Package 4** stays off until Neo decides.

### 3.14 Carry-overs (fix when a task hits them, one PR each)

- `search_congress_bills` `textQuery` results can exceed the orchestrator's 12,000-character tool-result cap and get stripped to metadata (seen in the bill-text check); bound to about eight bills with shorter snippets, as `read_bill_text` pages were bounded in #2115.
- Parallel reads within one plan step still serialize (`research_step_attempt_in_flight`).
- Research after a chat reply is still refused (assistant turns and summary in the handoff).
- The planner's read-step-after-approval plan shape (never runs; costs refused calls).
- `read_chat_attachments` fan-out (61 calls in one turn; pages at 5,000 characters by design).
- Both bounded children fail `research_child_output_schema_invalid` in most runs; one child succeeded in runs 8 to 10. Worth a look at the child output contract when Release C makes children do more.
- `meri-research-durable-replay.spec.ts`: two mail-scope tests fail on main because the spec's mock `tx` lacks `$executeRaw` (`mail-query-deadline.ts`, 2026-10-02). Fix the mock.
- Per-turn input-token tail (program §4.6 measured a 188,500-token median; the tail is not trimmed).

## 4. Tooling and how to ship

All under `C:/dev/main/outputs/meri-stage2-20261006/` unless noted. The release checkout is `C:/dev/main/meri-c1-20261002` (a detached worktree; never edit there). Code work happens in a fresh worktree per PR; this session's was `C:/dev/main/meri-s2-producer-proof` with store `C:/dev/main/.pnpm-store-meri-s2`.

| Tool | Use |
| --- | --- |
| `roll-svc.sh build <roll> <buildDir>` / `ship <roll> <buildDir> "<change>"` with `SVC=api\|meriv2-orchestrator\|web-vnext` | Deployment §2 end to end: CodeBuild ARM image from `origin/main`, smoke, push by SHA; ship = evidence PR and merge, qualify, prepare, two ancestry reads, promote, wait for old tasks, read back every running task. |
| `roll-svc-resume.sh` | The tail of `roll-svc.sh` from the qualify step, for when `gh pr merge` returned 502 but the evidence PR merged. |
| `migration_status.py <buildRoot> <outDir>` | Read-only `migration-status` on the candidate image. Run before every API roll. |
| `migration_apply.py <buildRoot> <outDir>` | `migrate` on the candidate (Neo's OK first), then `migration_status.py`. |
| `config_revision.py <service> <outDir> [KEY=VALUE…] [secret:NAME=ARN…]` | Deployment §2.5 configuration revision; refuses on an unexpected diff or if the service moved. Record in `DRIFT-FINDINGS.md` and `compute-stack.ts`. |
| `flag-flip.mjs <flag> <true\|false> <outDir>` | Tenant flag flip with readback (capiro-internal only). |
| `t5-deliverable-check.mjs <outDir>` | T5. Then `collect-logs.py <outDir> <startEpochMs> <sessionId>`. |
| `research-check.mjs` (`RESEARCH_TOPIC`), `bill-text-check/bill-text-check.mjs` (`BILL_TEXT_PROMPT`), `efficiency-check/commitments-check.mjs`, `legiscan-check/state-bill-check.mjs` | One paid turn each. |
| `session-read.mjs <researchId> <out> [timeoutMs]` | Read-only; prints the session state and how long the read (and its re-check) took. |
| `review-read.mjs <artifactId> <out>`, `review-get.mjs <reviewId> <out>` | Read-only: the pending review for a held report and its findings with spans. |
| `fed-backfill/loop2.py <firstBatch>`, `run_once.py`, `register_td_v2.py <apiRevision>` | The backfill loop (resumable), one task with log capture, re-register the family on a newer API image. |
| `evals/meri/simple/` (repo) | The acceptance runner: Clerk sign-in token for neo@capiro.ai, `MERI_RUNNER_SECOND_IDENTITY` for the synthetic reviewer, automatic safety checks. |
| `scripts/meri-image-build.mjs`, `scripts/meri-release.mjs` (repo) | What `roll-svc.sh` wraps. |

Records per session: `STATUS.md` top block; `docs/meri/releases/<date>/README.md` with a row per roll (revision, rollback, source, digest, live check) and the evidence folders the evidence PRs write; a `HANDOVER-<date>[-part].md`; the lead agent's memory note `meri-deployment-plan-2026-10-05.md` in `C:/Users/neoma/.claude/projects/C--dev-main/memory/`.

## 5. Hazards, consolidated

Deployment plan §0.2 and §9, the morning handover §8, the pm handover §8 and the evening handover §6 each list hazards; the ones that cost time today, plus the new ones:

- **Other workstreams roll the same services.** LegiWatch rolled API 619 between Meri's build and ship today, and 624/625 after Meri's 623. Read the served SHA twice, the second time immediately before `promote`; if the candidate does not contain it, rebuild from main rather than ship. Never force.
- **`gh pr merge` can return 502 while the merge lands**; `roll-svc.sh` exits under `set -e` after the evidence PR. Check the PR state; if merged, resume with `roll-svc-resume.sh`. On any evidence-step failure, delete the leftover `codex/meri-<roll>-evidence-*` branch and untracked folder in the release checkout before retrying.
- **`release_helper.py evidence` fails while any of the three services has a rollout in progress**, including another workstream's. Wait for one deployment per service.
- **Heredocs in this harness** mangle `\n`, `\u0000` and some apostrophes. Write source edits with the Edit tool; write scripts with Write.
- **Jest:** `meri-research-durable-replay.spec.ts` and `meri-remaining-source-families.spec.ts` need plain `jest` (not `--experimental-vm-modules`) with `NODE_OPTIONS=--max-old-space-size=8192`; PGlite specs need `--experimental-vm-modules`; `tsc` for `apps/api` needs the 8 GB heap too.
- **The pnpm store** `C:\Users\neoma\AppData\Local\pnpm\store\v3` is corrupted; install fresh worktrees with `--store-dir <private dir>`.
- **Prettier:** many files on main are not prettier-clean; check `git show origin/main:<file> | prettier --check` before running `--write`, or the diff bloats.
- **Migrations:** `apps/api` migration timestamps run about two years ahead on purpose (a sort ratchet); never renumber. A migration that creates a trigger on `federal_evidence_revision` and fills from it holds the table for minutes; apply between backfill batches.
- **The orchestrator strips any tool result over 12,000 characters to metadata.** Bulk-text tools must stay under that with their identity fields.
- **The stream endpoint rejects `reasoningMode` in the body with 400**, leaving an empty conversation.
- **`capiro-dev-api-diag` without a command override flips a tenant flag.** Never run it bare.
- **`memory_items` FORCE ROW LEVEL SECURITY:** inside `withTenant`, a user's own `visibility='user'` rows are invisible; read memory under `withTenantUser`.
- **Every V3 turn needs the user's Clerk session token.** Background work (sweeper, scheduled jobs) cannot run V3 turns by itself (section 3.6).
- **`pkill` does not kill Windows processes**; use `taskkill /PID <pid> /T /F`.
- **Paid turns:** one at a time. Today: morning 9, pm 11, evening 2.

## 6. Effort and sequencing

Rough, by the plan's own PR counts: Stage 2 remainder about 10 to 11 PRs (Releases C to F plus `02-handover`), Stage 3 about 6, the Stage 1 deletions 2 already open, drafting unsized by the plan. About 17 planned PRs plus drafting. The caveat that matters: the plan counted Release B as 4 to 6 PRs and it took about 25 (every T5 run exposed a real defect in the research path); Releases C to E run through the same path, so expect defect PRs on top of the planned ones. Do not run two paid live checks in parallel, and do not start Release D's effect path before Release C's deliverable steps exist (deployment §4 sequencing notes).

Suggested order for the next session: 3.1, 3.2 (T5 pass, sweeper, worker-loss check, T7, verdicts), 3.3, then 3.4. Keep 3.10 on the calendar for 2026-10-12 and 3.13's backfill and LegiScan items in the background.
