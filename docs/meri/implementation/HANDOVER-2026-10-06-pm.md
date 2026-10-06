# Meri handover, 2026-10-06 (afternoon session, lead agent)

This file continues [HANDOVER-2026-10-06.md](HANDOVER-2026-10-06.md) (the morning session). Read that file's sections 2, 7 and 8 first; they still hold. This file records what changed after it was written: Stage 2 Release B live checks, the research-path defects they exposed, the turn-efficiency work, the bill-data work, and every production change made this afternoon.

Governing documents, in reading order for a new session:

1. [00-Meri-Program-Plan-2026-10-05.md](00-Meri-Program-Plan-2026-10-05.md): what to build and how to test (§5 Stage 2, §8 the real-task list, §9 testing policy).
2. [00-Meri-Deployment-Plan-Opus-5-5-2026-10-05.md](00-Meri-Deployment-Plan-Opus-5-5-2026-10-05.md): how to ship (§2 roll recipe, §2.4 migrations, §2.5 configuration revisions, §4 Stage 2 releases, §7 ask-Neo checkpoints).
3. [STATUS.md](STATUS.md), top block only.
4. [HANDOVER-2026-10-06.md](HANDOVER-2026-10-06.md), then this file.
5. [releases/2026-10-06/README.md](../releases/2026-10-06/README.md): every roll today with revision, rollback, source, digest and live check.

## 1. Where things stand (2026-10-06, about 17:35 UTC)

### 1.1 Served production (cluster `capiro-dev`, account `967807252336`, `us-east-1`)

| Service | Revision | Rollback | Source | Digest | Carries |
| --- | --- | --- | --- | --- | --- |
| `capiro-dev-api` | 615 | 614 | `9ee56613f` | `sha256:9a01d791…` | everything merged to main by 17:13 UTC, including #2115 (bill text) and #2118; secret `LEGISCAN_API_KEY` from the 602→603 configuration revision |
| `capiro-dev-meriv2-orchestrator` | 167 | 166 | `0650f02a2` | `sha256:20aeedb5…` | #2097 (turn efficiency), #2106 (partial receipts), #2115 (bill-text prompt routing) |
| `capiro-dev-web-vnext` | 425 | 424 | `e6ff0250b` | (another workstream's roll, 17:05 UTC) | Release B web (#2069, #2080 to #2083) is an ancestor, so the dark UI is still deployed |
| `capiro-dev-api-admin-migrate` | 99 (read-only `migration-status`) | | | | 98 applied `20281008040000_federal_evidence_passage_search` at 16:56–16:59 UTC |

Tenant flag `meri.jobs` is **on** for capiro-internal (flipped 11:22 UTC; record `C:/dev/main/outputs/meri-stage2-20261006/flags/flag-flip-meri.jobs-true.json`). Off everywhere else.

Other workstreams rolled the API at 594 (`c83a0f44a`), 607 (`34d34c6f8`, Krisp) and 612/613 (`e6ff0250b`), and web-vnext at 419, 420 and 425, between this session's rolls. Every one of them was read by the double ancestry check and was an ancestor of the next candidate; no rebuild was needed this afternoon.

### 1.2 Background work still running when this file was written

- **Federal BILLS backfill** (section 6.1): one-shot ECS tasks in family `capiro-dev-api-federal-evidence-backfill` (registered this afternoon, pinned to the API 600 image), driven by `C:/dev/main/outputs/meri-stage2-20261006/fed-backfill/loop.py`. **Stalled, not finished:** batches 0 to 8 inserted 7,710 packages (1,000 per hour); batch 9 inserted 44 and then one package failed with Prisma's 5-second interactive-transaction timeout ("Transaction already closed … 5000 ms"); batches 10 to 14 each retried the same package, inserted nothing and failed in 22 seconds. The loop exited (its stop condition was a non-zero exit, which the script never returns) and no task is running. Total stored: 7,754 packages. The stuck page is checkpoint cursor `offsetMark=AoJ4iNmjqZ8DMEJJTExTLTExOXMyMzQwaXM=` (the page after `BILLS-119s2340is`), offset 54. Cause not determined: either that package is a very large bill whose persist (hashing, mention extraction) exceeds five seconds on its own, or the new passage-index trigger from migration `20281008040000` makes its insert slow (the trigger computes a `tsvector` per 4,000-character window inside the insert). Batches 5 to 8, after the migration, ran at full speed, so ordinary bills are unaffected.
- **Live checks** (section 4): the bill-text check and T5 run 8 were queued behind the API 615 roll. Their results are in the top block of `STATUS.md`, not here.

### 1.3 Open pull requests owned by this program

Still only the Stage 1 §4.3 deletions, #2032 (orchestrator) and #2035 (API), to merge on or after 2026-10-12 if CloudWatch shows zero `meri_unavailable` refusals outside the drill. Everything this session opened is merged.

## 2. Neo's decisions and approvals this session (do not ask again)

| Time (UTC) | Decision | Status |
| --- | --- | --- |
| ~11:20 | Narrow D4b (`checkVehicleConflation`) to verb forms | Done: #2088, deployed API 596 and orchestrator 161; budget report published, not held (section 4) |
| ~11:20 | Enable `meri.jobs` on capiro-internal and run T5 | Flag on at 11:22; T5 run 8 times (section 5) |
| ~11:20 | Sweeper configuration revision `MERI_JOB_SWEEPER_ENABLED=true` on `capiro-dev-api`, plus the worker-loss check, **after T5 passes** | Not yet done: T5 has not passed. Do it without asking again once a T5 run passes. |
| ~15:00 | Federal bill data: enable the existing sync first rather than build a congress.gov live path; then, told that Package 4 is gated, chose a **one-off BILLS `--full --historical` backfill** for the 119th Congress, with the API flag, recurring rules and outbox drain left off | Running (section 6.1) |
| ~15:00 | State bills: add a live LegiScan fallback | Done: #2098, configuration revision API 602→603 (`LEGISCAN_API_KEY`), codified in #2101. Blocked in practice by the LegiScan quota (section 6.2). |
| ~15:30 | "We need it to work well" (bill-text questions) | Done: #2115, in-bill passage locator and cross-bill text search |
| ~15:55 | Partial private reads: **receipt them for re-check** (not withhold, not keep as is) | Done: #2106, deployed API 609 and orchestrator 165 |
| ~16:40 | Apply migration `20281008040000_federal_evidence_passage_search` | Applied 16:56–16:59 UTC via admin-migrate 98; status 99 reads up to date |

Still needs Neo's OK at the time (deployment plan §7): any further migration apply; Package 4 activation (recurring federal evidence rules, outbox drain, `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED=true` on the API); a LegiScan plan or cadence change (section 6.2); verdicts on T5 and T7 once they pass; the Stage 3 comparison window.

## 3. What this session shipped

All through deployment plan §2: CodeBuild ARM image, `migration-status` on the candidate, evidence PR, `prepare`, two ancestry reads, `promote`, digest readback on every running task. Evidence per roll is under [releases/2026-10-06/](../releases/2026-10-06/).

### 3.1 Code and infrastructure PRs (merged, in order)

| PR | Change | Deployed |
| --- | --- | --- |
| [#2088](https://github.com/neo-capiro/capirov2/pull/2088) | D4b fires only when an authorizing vehicle is the subject of an appropriating verb, or the reverse; noun labels ("HASC and SASC authorization marks and HAC-D appropriations mark") no longer match | API 596, orchestrator 161 (the orchestrator's chat path runs the same auditor) |
| [#2089](https://github.com/neo-capiro/capirov2/pull/2089) | The research plan prompt states the string limits (title 120, step id 64, objective and completionCondition 600); length issues read `_too_long_max_N`; the repair prompt explains them | API 596 |
| [#2091](https://github.com/neo-capiro/capirov2/pull/2091) | Bounded-child correction is format-only: sees the rejection reason and the rejected output, runs with no read capabilities, keeps the rejected turn's reads as evidence; child failures logged with their code | API 598 |
| [#2094](https://github.com/neo-capiro/capirov2/pull/2094) | Child goals cut at the text limit and trimmed (a cut after a space failed the whole run); the job projection checks running and failed runs before an approval-wait step | API 600 |
| [#2097](https://github.com/neo-capiro/capirov2/pull/2097) | Turn efficiency: identical successful reads answered with a pointer (`repeatOf`); "status" about the firm's own work is not a bill-status claim; bill-status and member-vote coverage follow-ups with no identifying argument are skipped; prompt rules on rounds, same-round reads, full pages, no retry of unavailable sources; `callSignature` on tool-step telemetry; heartbeat lease-loss diagnostic log | orchestrator 163, API 602 |
| [#2098](https://github.com/neo-capiro/capirov2/pull/2098) | Live LegiScan lookup for an exact state bill designation the hourly sync has not stored, within a 1,000/month live budget inside the shared 28,000 soft budget; interactive transport (1 attempt, 10s); one-hour miss memory; honest "could not be checked" notes | API 602; key wired by the 602→603 revision |
| [#2101](https://github.com/neo-capiro/capirov2/pull/2101) | Codifies `LEGISCAN_API_KEY` on the API serve task in `compute-stack.ts`; `DRIFT-FINDINGS.md` entry | docs/infra only |
| [#2103](https://github.com/neo-capiro/capirov2/pull/2103) | A correction counts as a re-read only if a tool executed (ledger entry or durable read step), not for progress steps | API 609 |
| [#2106](https://github.com/neo-capiro/capirov2/pull/2106) | Partial owner reads (complete, empty **and partial**) are committed as receipts; the runner declares every re-checkable read in `toolsUsed` so the read-time re-check replays it; only complete or empty reads are visible sources or child evidence handles | API 609, orchestrator 165 |
| [#2114](https://github.com/neo-capiro/capirov2/pull/2114) | The heartbeat retries a lost compare-and-swap (3 attempts) instead of aborting the run; governed context records (`context_plane`) are not reads for the correction guard | API 611 |
| [#2115](https://github.com/neo-capiro/capirov2/pull/2115) | Bill text: `read_bill_text` gains `query` (best passages with the containing section heading and a `readCursor`); `search_congress_bills` gains `textQuery` (Postgres full-text search over stored bill text, grouped by bill with highlighted snippets); migration `20281008040000` adds `federal_evidence_passage` (4,000-character windows every 3,600, GIN `tsvector`, filled by an AFTER INSERT trigger and once for stored revisions, insert-only); pages cut to 9,000 characters because the orchestrator strips any tool result over 12,000 characters to metadata (bill text had never reached the model); prompt routing for bill-text questions | orchestrator 167, API 615 |
| [#2118](https://github.com/neo-capiro/capirov2/pull/2118) | A receipted public-data read (`search_public_web` and the other `PUBLIC_DATA_RESEARCH_TOOLS`) is covered as public data, not refused as an unowned private read | API 615 |

Evidence-only PRs: #2090, #2092, #2093, #2095, #2099, #2100, #2111, #2112, #2116, #2119, #2120.

### 3.2 Production changes outside code

| Change | Record |
| --- | --- |
| Tenant flag `meri.jobs` → true on capiro-internal (11:22 UTC) | `outputs/meri-stage2-20261006/flags/flag-flip-meri.jobs-true.json` |
| Configuration revision `capiro-dev-api` 602 → 603: secret `LEGISCAN_API_KEY` from `capiro/dev/legiscan_api_key`, same image | `outputs/meri-stage2-20261006/config-revision-legiscan/receipt.json`; `infra/cdk/DRIFT-FINDINGS.md`; codified in #2101 |
| Task family `capiro-dev-api-federal-evidence-backfill:1` registered (clone of `capiro-dev-api-sync:10`, API 600 digest, `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED=true` on this family only) | `outputs/meri-stage2-20261006/fed-backfill/td-registered.json` |
| Migration `20281008040000_federal_evidence_passage_search` applied (admin-migrate 98); read-only status re-registered as 99 | `outputs/meri-stage2-20261006/migration-apply-15/`, `migration-post-15/` |

Not changed: `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED` on the API service (still `false`); the Package 4 EventBridge rules (still disabled); `MERI_JOB_SWEEPER_ENABLED` (still unset).

## 4. Live checks this afternoon (all as neo@capiro.ai in capiro-internal, one paid turn at a time)

| Check | Session or conversation | Served | Result |
| --- | --- | --- | --- |
| D4b budget topic (PE 0605231A FY27 vs FY26), `research-check.mjs` | research `e0bd0918` | API 596, orch 161 | **Pass:** report published, 1,254 characters, auditor recorded no finding; the two previous runs on this topic (`e25804d0`, `26489d5d`) were held by D4b. Neo's verdict on the content: pending. |
| Commitments audit prompt (Neo's own prompt, same client as his three runs), `efficiency-check/commitments-check.mjs` | conversation `594a31e5` | orch 163 | 14 model calls, 45 tool calls, 1.12M input tokens, 356s, finished `completed`. Neo's runs: 7 to 12 rounds, 51 to 63 tools, 1.19M to 2.20M tokens, 409 to 450s. No `search_floor_votes` or `list_members`; `read_monday_client_boards` called once instead of twice; `search_emails` 0 instead of 6 to 7. Answer saved at `efficiency-check/run-1/answer.md` (13,427 characters). |
| Live state-bill lookup (OH HB 1), `legiscan-check/state-bill-check.mjs` | conversation `ce2185df` | API 603 | **Blocked by quota:** the tool said the live lookup was skipped because the month's budget is used up (section 6.2). The refusal wording and honesty were correct. A first attempt (`70821b0d`) got HTTP 400 because the stream endpoint rejects `reasoningMode`; no turn ran. |
| T5 runs 2 to 8 | section 5 | 596 to 615 | Not passed yet; run 8 (`cab91bd9`) reached publication with every input covered and failed on the publication-scope proof check |
| Bill-text search, `bill-text-check/bill-text-check.mjs` ("Which 119th-Congress bills say something in their text about critical minerals? … quote it exactly with its section heading, bill number and version") | conversation `7965f93e` | API 615, orch 167 | **Pass:** text search found 23 matching passages and listed six bills (H.R. 9617, H.R. 9086, S. 714, S. 823, H.R. 10681, H.R. 9858) with what each passage addresses; chose S. 714 `rs` (reported in Senate, 2026-02-11) and quoted subsection (o)(1) of section 2 verbatim under its heading, labelled as bill-version language, not enacted law; disclosed that the list is not exhaustive. Answer: `bill-text-check/run-1/answer.md`. Cost: 3 rounds, 14 tool calls (6 `search_congress_bills`, 2 `read_bill_text`, 6 `resolve_entity`), 396k input tokens, 41s. Neo's verdict: pending. Follow-up: the first text-search result was cut by the orchestrator's 12,000-character tool-result cap (the model saw "23 matches, truncated" and re-searched five times); bound `textQuery` output to about eight bills with shorter snippets. |

Paid turns this afternoon: 11. Morning: 9 (see the morning handover).

## 5. T5: eight runs, seven defects

T5 (program plan §8): a delegated two-page office brief as a Word document on the QA client (`ZZ-QA-Meri1651-Test-DoNotUse`), script `outputs/meri-stage2-20261006/t5-deliverable-check.mjs <outDir>`. Pass = job `completed`, the `.docx` downloads as a real Word file, filing returns one client document and the same document on a repeat confirmation. Each run exposed one real defect in the research path, fixed before the next run; none was a test-harness problem.

| Run | Session | Served | Failure | Fix |
| --- | --- | --- | --- | --- |
| 1 (morning) | `b6d8fa73` | API 589 | Plan rejected after one repair: `steps[5].completionCondition_too_long` (limit never stated to the planner) | #2089 |
| 2 | `a71e0ac2` | 596 | Provider budget exhausted: 23 model calls; one bounded child burned 12 on a correction that could never pass (it saw neither its rejected output nor its evidence) | #2091 |
| 3 | `cfac6f20` | 598 | `research_child_goal_invalid` 117 ms in: the joined child goal was cut after a space and the contract rejects edge whitespace; the job also read `waiting_for_user` while running | #2094 |
| 4 | `f82a2d24` | 600 | "Research lease is no longer active" at 60s, cause not visible in logs | diagnostic log added in #2097; real cause found in run 6 |
| 5 | `9c52022a` | 603 | Report written but publication refused: `unreceipted_tool:search_memory` (5) and `read_client_documents` (2), all `partial` reads; both corrections rejected `research_child_correction_read` for progress steps | #2103 (guard), #2106 (partial receipts, Neo's decision) |
| 6 | `fc3b54a9` | 609 | "Research lease changed while reporting progress": the heartbeat's compare-and-swap lost a race to a receipt write and treated it as a lost lease; corrections rejected again because `context_plane` ledger entries counted as reads | #2114 |
| 7 | `a1a36b6f` | 611 | Publication refused: `receipted_unowned_tool:search_public_web` (2); receipted partial public pages were classified as unowned private reads | #2118 |
| 8 | `cab91bd9` | 615 | **Furthest yet.** Every producer input covered (`unsupported={}`), the manifest pinned and logged "governed"; then `The research report producer proof is unavailable` at publication (17:39:24 UTC, 9 min in). Also the first run in which a bounded child succeeded (child 1 failed `research_child_output_schema_invalid`; child 2 returned), so the joined parent+child path ran for the first time on the governed route. | **Open.** See the diagnosis below. |

Run 8 diagnosis, as far as it goes. The message is thrown in four places: `meri-research.service.ts:5111` (guard: `toolsUsed && (!run || !producerInputSha256 || !producerInputMode || mode unsupported)`) and `meri-research-replay-authorization.ts:523/570/583`. The publication-time call is at `meri-research.service.ts:3957` and passes `result.runAuth.run!`, `toolsUsed` and `{ ...producerInput, producerInputManifest }`. Clauses checked and ruled out by reading: the join (`joinResearchProducerInputs`) returns a bare hex sha and a valid mode; `stringArray` accepts an empty `toolsUsed`; `pinResearchProducerInputs` returns the manifest; the two child turns used only `search_memory`, `read_client_documents` and `query_debriefs`, all public research source tools. Clauses still possible at 523: `declared.some(tool => !publicResearchSourceTool(tool))` (the child path declares raw `durable.tool` names, `meri-v3-research-runner.ts:612`, where the parent path filters through `publicResearchSourceTool`, line 169), the fresh `storedRun` read not being `running` with the same id and epoch, or the `governed !== Boolean(manifest)` clause. The session's stored receipts (34, all run `3f8d1d24` epoch 2) include two with the redacted tool name `research_source` and classifier `partial`; those are probably the parent's `search_public_web` pages. **First step for the next session:** add a one-line warn at each of the four throw sites naming the failed clause (and the declared tools), roll, rerun T5; the fix will then be obvious and small. If the clause is the declared-tools one, make `qualifyResearchChildFrame` declare `publicResearchSourceTool(durable.tool)` like the parent does.

Diagnosis pattern that worked every time: `python outputs/meri-stage2-20261006/collect-logs.py <outDir> <startEpochMs> <sessionId>`, then read `logs.json` for `Research run failed`, `Research producer inputs refused`, `Research child failed` and the orchestrator `meriv3.turn` rows (rounds, tools, tokens per turn). The session's `final.json` carries `durableCoordinator.steps` (per-step outcome and `failureCode`).

Known remaining T5 risks, not yet seen to fail a run: the planner puts a read step after the `approval_required` step (for example `verify-approved-document-filing`), which can never run because research never executes approvals; publication is not gated on it, so it only costs refused calls. `search_memory` is always `partial` on capiro-internal (more results exist), so reports will always carry a partial-coverage disclosure for memory.

## 6. Data work

### 6.1 Federal bill text (the backfill)

What Meri reads: `get_bill_status` and `search_congress_bills` read `congress_bill` (synced daily from congress.gov; 117th to 119th; unchanged). `read_bill_text` reads the versioned federal evidence store (`federal_evidence_current` over `federal_evidence_revision`), filled only by `sync-federal-legislative-evidence` (GovInfo BILLS), which ships dark under the defense-budget Package 4 gate ([docs/defense-budget/package-4/README.md](../../defense-budget/package-4/README.md), [package-3/README.md](../../defense-budget/package-3/README.md)). That store was empty: the dry run found no checkpoint and every batch has inserted 100% new rows. The legacy `bill_text` table used by the PE extractor is separate and not read by Meri.

What the backfill does: bills only, 119th Congress only, `--full --historical` (no alerts, no outbox rows), 1,000 packages per task, resumable from `federal_evidence_checkpoint` source `govinfo-federal:full:BILLS:119`. Inserted: 7,754 (batches 0 to 9), then stalled on one package (section 1.2). Batch 4 had recorded a different, one-off error: a package whose 5-second transaction waited 163 seconds on the table lock held by migration `20281008040000` (trigger creation plus the one-time fill). No GovInfo 429s on the API log group (the client's own limit is 1,000/hour).

To unstick it: (1) find the package: run one `--cap 1` batch with the persist error logged with its package id (the script does not log it today), or decode the cursor and list that page from GovInfo; (2) if the text is huge, raise the interactive transaction timeout in `persistFederalEvidenceSnapshot` (`apps/api/src/program-element/federal-evidence/persistence.ts`, `$transaction` options) or move the passage indexing out of the insert path for texts above a size (a new migration replacing the trigger body, Neo's OK to apply); (3) rebuild the backfill task family on the fixed image (`fed-backfill/register_td.py` clones the live API image) and rerun `loop.py`. The 7,754 stored packages are complete and indexed; `read_bill_text` and the text search work on them now.

After it completes: `read_bill_text` and the new text search cover every 119th-Congress bill version stored at that time. New versions do not arrive until Package 4's recurring BILLS rule is enabled (Neo's OK, and the Package 3 gate is still open) or a non-historical reconciliation run is approved (it requires the completed full baseline first). Committee reports, prints, public laws and the Congressional Record are not included.

### 6.2 State bills (LegiScan)

The live lookup (#2098) is deployed and wired, but LegiScan refuses every call: the key's real plan limit is 10,000 queries per month, exhausted since early October ("10,021 of 10,000; limit resets November 1st"). Our quota code assumes 30,000 (`LEGISCAN_HARD_CAP`) with a 28,000 soft budget, and the internal count (28,003) disagrees with LegiScan's. The hourly sync jobs (`capiro-dev-sync-legiscan-bills`, `-masterlist`) have logged `INGESTION_SKIP reason=quota` and masterlist errors for all eight priority states since then, so state bill data is frozen until November. A task chip (`task_3de743b5`, "Fix LegiScan quota: key capped at 10k/month") carries the investigation; the decision on a paid tier or reduced cadence is Neo's. Do not create additional LegiScan keys (their terms suspend access).

### 6.3 Bill-text search (#2115), how to use it

- "What does H.R. 2004 say about X?": `read_bill_text` with `billId` and `query` returns up to six 1,000-character passages, each with the `SEC.` heading that contains the match and a `readCursor`; `cursor` reads on. Classified `partial`, receipted and re-checked.
- "Which bills mention hypersonics?": `search_congress_bills` with `textQuery` (web-style: `"phrase"`, `or`, `-exclude`) returns bills grouped with highlighted passages and a `readCursor` each.
- Both are deterministic for a given stored text, so the read-time re-check reproduces them.
- The index fills itself for every new BILLS revision through the trigger.

## 7. Turn efficiency (#2097), what was measured

Fleet, last three days before the fix: 193 turns; the 14 turns with 20 or more tool calls used 31% of all input tokens. Worst patterns: `read_chat_attachments` 61 times in one turn, `scrape_web_page` 36, `search_funding_opportunities` 15, and the email list → thread → search pattern of the commitments audit. Root causes in the audit turn: no reuse of identical reads within a turn; the word "status" (about commitments) classified as a bill-status claim, which made the coverage pass run `search_floor_votes` and `list_members` with empty arguments; prompt guidance that pushed exhaustive reads with no rule against repeating a call.

Since orchestrator 163 (14:30 UTC): 20 turns, 172 tool steps with a `callSignature`, zero exact repeats within a turn, zero `deduplicated` dispatches. The gain in the audit rerun came from the misfire fix and the prompt rules; the dedupe is a guardrail. `read_chat_attachments` fan-out (61 calls) is not addressed: it pages at 5,000 characters per read by design.

## 8. How to ship (this afternoon's tooling, all under `C:/dev/main/outputs/meri-stage2-20261006/`)

| Tool | Use |
| --- | --- |
| `roll-svc.sh build <roll> <buildDir>` / `ship <roll> <buildDir> "<change>"` with `SVC=api\|meriv2-orchestrator\|web-vnext` | Build from `origin/main` in CodeBuild (ARM), smoke, push by SHA; ship = evidence PR, qualify, prepare, ancestry read twice, promote, wait for old tasks, read back every running task. Uses the release checkout `C:/dev/main/meri-c1-20261002`; never edit there. |
| `migration_status.py <buildRoot> <outDir>` | Read-only `migration-status` on the candidate image (admin-migrate family latest stays read-only). Run before every API roll. |
| `migration_apply.py <buildRoot> <outDir>` | `migrate` on the candidate image (deployment plan §2.4, Neo's OK first). Follow with `migration_status.py`. |
| `config_revision.py <service> <outDir> [KEY=VALUE…] [secret:NAME=ARN…]` | Deployment plan §2.5; now handles secrets. Refuses on any unexpected diff or if the service moved. Record in `DRIFT-FINDINGS.md` and `compute-stack.ts`. |
| `flag-flip.mjs <flag> <true\|false> <outDir>` | Tenant flag flip with before/after readback (capiro-internal only; `meri.jobs` only). |
| `t5-deliverable-check.mjs <outDir>` | T5. `collect-logs.py <outDir> <startEpochMs> <sessionId>` afterwards. |
| `research-check.mjs <outDir>` with `RESEARCH_TOPIC` | One Deep Research run on the QA client. |
| `efficiency-check/commitments-check.mjs <outDir>` | Neo's commitments audit prompt, one turn; compare with the orchestrator `meriv3.turn` log row. |
| `legiscan-check/state-bill-check.mjs` | Live state-bill lookup turn (needs LegiScan quota). |
| `bill-text-check/bill-text-check.mjs <outDir>` with `BILL_TEXT_PROMPT` | One bill-text turn. |
| `fed-backfill/run_once.py <label> <args…>`; `fed-backfill/loop.py` | One sync task with log capture; the batch loop. |

Hazards added this afternoon (append to the morning handover's section 8):

- `release_helper.py evidence` runs `meri-release.mjs inspect` for all three services and fails while **any** service has a rollout in progress, including another workstream's web-vnext roll. Wait until every service has exactly one deployment (the chain commands used today poll for that). On failure, delete the leftover `codex/meri-<roll>-evidence-*` branch in the release checkout before retrying.
- The orchestrator shows the model at most 12,000 characters of a tool result and strips a larger result to metadata (`projectMeriToolEvidence`). Any tool that returns bulk `text` must stay under that with its identity fields; `read_bill_text` pages are now 9,000 characters for this reason.
- A migration that creates a trigger on `federal_evidence_revision` and fills from it holds the table for minutes; the backfill's 5-second interactive transactions time out meanwhile. Apply such migrations between batches, or move the fill out of the migration transaction.
- The chat stream endpoint rejects `reasoningMode` in the body with 400; the conversation is created first, so a 400 leaves an empty conversation.
- Bash heredocs with certain quoting fail to parse in this harness (`unexpected EOF`); write patch scripts to files with the Write tool and run them.
- Prettier: many files on main are not prettier-clean. Running `prettier --write` reformats whole files and bloats the diff; check `git show origin/main:<file> | prettier --check` first and reapply minimal edits if a file was reformatted.
- PGlite specs need `node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand <spec>`.
- `tsc --noEmit` for apps/api currently reports one error in `src/engagement/krisp/krisp-notetaker.service.spec.ts` (another workstream) besides the known LegiWatch one.

## 9. Next steps, in order

1. **T5 run 8 failed at publication** (section 5, diagnosis there). Add clause-level logging at the four `producer proof is unavailable` throw sites, roll the API, rerun T5 (`t5-deliverable-check.mjs`), fix the named clause, roll, rerun. Once a run passes: apply the sweeper configuration revision (`config_revision.py capiro-dev-api <outDir> MERI_JOB_SWEEPER_ENABLED=true`, already approved), record it in `DRIFT-FINDINGS.md` and `compute-stack.ts`, and run the worker-loss check on the next API roll (deployment plan §4: start a job on the QA client, promote, confirm it resumes under a new epoch and finishes). Then T7 (steer mid-run, close, reopen, finish, then Stop). Then ask Neo for verdicts on T5 and T7, and run the Release F Playwright flows (program plan §5.8). If run 8 failed: diagnose as in section 5, one fix per PR, roll, rerun.
2. **Backfill:** stalled at 7,754 packages on one package (sections 1.2 and 6.1). Identify it, fix the timeout or the trigger cost, rebuild the task family on the fixed image, rerun `loop.py`, and change the loop to stop when a batch inserts nothing. Then one `read_bill_text` turn on a long bill (the NDAA, if stored) to confirm the locator at scale.
3. **LegiScan:** start the task chip `task_3de743b5`; bring Neo the tier-or-cadence decision. Until then the live lookup refuses on quota and the state sync is stalled.
4. **2026-10-12:** merge #2032 and #2035, roll both services, one live turn each, then update `01-handover.md` and `STATUS.md`.
5. **Carry-overs:** `search_congress_bills` `textQuery` results can exceed the orchestrator's 12,000-character cap and get stripped to metadata (seen in the bill-text check; bound the result to about eight bills with shorter snippets, as `read_bill_text` pages were bounded in #2115); parallel reads within one plan step still serialize (`research_step_attempt_in_flight`); research after a chat reply is still refused (assistant turns and summary); the PE $0-request data defect (cases 20 and 21); the per-turn input-token tail; the read-step-after-approval plan shape (section 5); `read_chat_attachments` fan-out.

Prompt to start the next session:

> Read `docs/meri/implementation/HANDOVER-2026-10-06-pm.md` (and the morning file it points to), then the program plan, the deployment plan and the top of `STATUS.md`. Continue Stage 2 at the afternoon handover's section 9 step 1. Ship only through deployment plan §2, test as program plan §9 says, run live checks only as neo@capiro.ai in capiro-internal one paid turn at a time, and ask me only at the deployment plan §7 checkpoints. Write `STATUS.md` at the end.

## 10. Every document this session produced or changed

- This file and [HANDOVER-2026-10-06.md](HANDOVER-2026-10-06.md) (morning; unchanged this afternoon).
- [STATUS.md](STATUS.md): new top block for the afternoon.
- [releases/2026-10-06/README.md](../releases/2026-10-06/README.md): afternoon rolls table and live checks; evidence folders `s2-plan-limits`, `s2-d4b-orch`, `s2-child-correction`, `s2-child-goal`, `s2-efficiency-orch`, `s2-efficiency-legiscan`, `s2-partial-receipts-orch`, `s2-partial-receipts`, `s2-heartbeat-race`, `s2-bill-text-orch`, `s2-bill-text-public` (each written by the evidence PRs listed in section 3.1).
- [infra/cdk/DRIFT-FINDINGS.md](../../../infra/cdk/DRIFT-FINDINGS.md): "LegiScan key on the API serve task (2026-10-06)".
- [apps/api/prisma/migrations/20281008040000_federal_evidence_passage_search/migration.sql](../../../apps/api/prisma/migrations/20281008040000_federal_evidence_passage_search/migration.sql).
- PR bodies #2088 to #2118 (section 3.1) hold the per-change rationale and test lists.
- Working files, not in the repo: `C:/dev/main/outputs/meri-stage2-20261006/` (section 8), including every build readback, ship log, migration log, flag record, configuration revision receipt, live-check stream and answer, and the backfill logs.
- Memory note for the lead agent: `meri-deployment-plan-2026-10-05.md` in the agent's memory directory points here.
- Task chip: `task_3de743b5` (LegiScan quota).
