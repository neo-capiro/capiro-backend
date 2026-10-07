# Stage 2 releases, October 7, 2026 (UTC)

Finish-plan handoff §3.1 to §3.4, worked in order from 23:00 UTC on October 6. Every roll went through deployment plan §2 with `roll-svc.sh`:

1. CodeBuild ARM image from `origin/main`, then a smoke test.
2. Read-only `migration-status` on the candidate image.
3. Evidence PR, qualify and prepare.
4. Two reads of the served commit, then promote.
5. Wait for the old tasks to stop, then read back every running task's digest.

No migration was applied. Every API candidate read "Database schema is up to date!" (458 migrations), except one transient case described under Operations.

## Rolls

| Roll | Code | Revision | Rollback | Source | Digest | Live check |
| --- | --- | --- | --- | --- | --- | --- |
| [s2-orch-d2](s2-orch-d2/README.md) | Plain roll: the chat auditor picks up #2132 (D2 matches decoded tool text) | orchestrator 169 | 168 | `5231b9a48` | `sha256:9f9aac40…` | **Pass.** Chat turn `42e8ef8a` found six bills by stored text and quoted S. 2550 `rs` §3 verbatim. Not held. |
| [s2-memory-releasec](s2-memory-releasec/README.md) | #2143 governed memory join; #2146 Release C API (with LegiWatch #2133/#2140, Krisp #2142) | API 629 | 628 | `e3b25d2db` | `sha256:04316cab…` | **Pass.** Run 10's report opens in 6.5 s, down from 133 s. T5 run 11: 16 `search_memory` calls, 1.5 s max, down from 386 s in all. |
| [s2-releasec-web](s2-releasec-web/README.md) | #2147 Release C web (with planner #2141) | web-vnext 442 | 441 | `d6efc8adc` | `sha256:c7d70e42…` | Covered by T7 |
| [s2-d2-billtext](s2-d2-billtext/README.md) | #2149 bill-text paging; #2152 D2 skips a labeled own query | API 631 | 630 | `16631b296` | `sha256:2bdab129…` | **Pass.** T5 run 12 published, downloaded and filed. |
| [s2-orch-d2-query](s2-orch-d2-query/README.md) | #2152 for chat | orchestrator 171 | 170 | `16631b296` | `sha256:e3db64c1…` | With T7 |
| configuration revision | `MERI_JOB_SWEEPER_ENABLED=true` (approved for after a T5 pass) | API 632 | 631 | `16631b296` | `sha256:2bdab129…` | Both replicas logged `meri_job_sweeper_enabled` at 00:59:32, with no sweep failures |
| [s2-deliverable-prompt](s2-deliverable-prompt/README.md) | #2156 plan and research know they are a deliverable job (with planner #2155) | API 634 | 633 | `f5abab182` | `sha256:3a427ec5…` | **Pass.** T12 had no "could not create"; T6 rerun had none. Worker-loss attempt 1 was inconclusive (below). |
| [s2-deck-layout](s2-deck-layout/README.md) | #2160 deck: provenance subtitle, compact sources with notes, fitted text | API 636 | 635 | `ca8c114ef` | `sha256:03e72d89…` | T12 rerun: 8 slides, down from 16 |
| [s2-deck-provenance](s2-deck-provenance/README.md) | #2166 provenance read by position | **not promoted** | | `3471cac58` | `sha256:8ec41c49…` | The gate refused: meeting-prep had rolled API 640 from branch commit `5f7d600da`. #2166 shipped in the next row. |
| [s2-workspace-nocancel](s2-workspace-nocancel/README.md) | #2170 workspace no longer cancels new research; #2168 add menu below the top bar; #2167 copy | web-vnext 448 | 447 | `9db60a09f` | `sha256:a8f37de7…` | **Pass.** "Delegate this" is clickable at 1440×900, and the delegated job ran instead of being cancelled. |
| [s2-plan-log](s2-plan-log/README.md) | #2166; #2174 planner-reply shape log (with meeting-prep #2169) | API 642 | 641 | `4f0139e22` | `sha256:e3b777df…` | The steering reproduction logged the cause (below) |
| [s2-plan-coverage-note](s2-plan-coverage-note/README.md) | #2177 a re-plan strips a trailing coverage note (defensive; not the cause) | API 644 | 643 | `f40dbebff` | `sha256:d78e1a82…` | Steering run `886e0f30` still failed: the suffix was not a coverage note |
| [s2-replan-surface](s2-replan-surface/README.md) | #2181 a re-plan inside the research stream runs on the research surface | orchestrator 173 | 172 | `88c71b410` | `sha256:1630d16b…` | **Re-plan passes:** steering run `0b61fbff` applied "House version only" and started the revised run. That run ended partial because the provider budget refused it with HTTP 409 (steered late, see T7) |

Other workstreams rolled in between: API 625, 627 and 640, and web-vnext 435, 439, 440 and 446. Every candidate contained what was served when it was promoted (see Operations).

## search_memory: cause and fix (#2143)

- **The probe.** A read-only probe ran the compiled adapter inside the API 625 image, with the real `withTenantUser` and Titan embeddings, as `capiro_app`, on capiro-internal. It ran from a throwaway task definition family that was deregistered afterwards.
- **Cause.** `context_embeddings` has FORCE ROW LEVEL SECURITY, and PostgreSQL pushes a join clause below a policy only when every function in it is leakproof. On production, `texteq` and `uuid_eq` are leakproof and `uuid_out` is not. So `ce.source_id = mi.id::text` could never use the unique index. The planner, estimating one eligible row, rescanned about 10,800 embeddings for each of 404 rows: 4.4M join-filter rejections and 18.9 s.
- **Silent fallback.** The statement also overran Prisma's 5 s transaction. The bare `catch` then reran the read lexically and marked it degraded without logging anything. That is why memory search was "always partial".
- **Fix.** Cast the id once in a MATERIALIZED CTE. The read takes about 70 ms with identical ranks, snapshot and cursor. The transaction budget is explicitly 10 s, and failures now log `governed_memory.read_failed` and `governed_memory.embedding_unavailable`.
- Hypothesis 1 in the handoff, `eligible AS MATERIALIZED` on its own, was measured and did not help (16.8 s).

## Release C (#2146, #2147, #2156, #2160, #2166)

- **Formats.** A deliverable job asks for one docx, xlsx or pptx. All three render from the authorized report, so held and withheld reports produce no bytes. Bytes are read back before they are served or filed: ZIP magic, the container opens, the main part parses, and the part count matches.
- **Excel.** Each table goes on a sheet named after its section, followed by a Report sheet.
- **PowerPoint.** One slide per section. The provenance lines become the subtitle, and the source register is compact, with full entries in speaker notes.
- **Research knows the job.** Research and planning are told the file is rendered from the report (#2156). Before that, T6's workbook denied it existed.
- **Web.** "Delegate this" picks the format from the request wording.

## Real tasks (automatic checks; Neo's verdicts pending)

| Task | Session | Result |
| --- | --- | --- |
| T5 run 11 | `6dfc24cf` | Completed in about 5 min; run 10 took 29. Held by D2 on Meri's own `read_bill_text` query (false positive, fixed by #2152). Download and filing correctly refused. Review `e3ea216c` is pending with the reviewer. |
| **T5 run 12** | `a31f24a0` | **Pass:** completed, a 13,849-byte .docx, filed once as `f92efe3e`, and a repeat returned the same document. No auditor findings. 1,570 words, longer than the two pages asked for. |
| **T6** | `5d71c8d3` | **Pass on the automatic checks** (a 15,424-byte .xlsx, filed once as `07801e89`), but the Report sheet said the workbook "could not" be created. Fixed by #2156. |
| **T6 rerun** | `1f84c6ee` | **Pass:** eight named sheets (Programs, Authorization, Appropriations, Sources, Provenance, Report Language, Not found, Report), filed once as `4daf7fa6`, and no denial. HASC and SASC marks equal the request for 0604234N ($390.26M) and 0604269N ($131.68M). SAC-D is not recorded. |
| **T12** | `6904f9d7` | **Pass on the automatic checks** (148,945-byte .pptx, filed once as `63883922`), but 16 slides for a six-slide request. Fixed by #2160. |
| **T12 rerun** | `0f4a4df2` | **Pass:** 8 slides, filed once as `1d66e52c`. One slide was still provenance, fixed by #2166. |
| T7, first browser run | `ad24b023` | Fail. The workspace cancelled the delegated job 28 ms after creating it (fixed by #2170), and "Delegate this" sat under the top bar at 960 px (fixed by #2168). |
| T7, steer | browser `4b03e4f2`, API `072dd25d`, `886e0f30` | Fail. Every steering re-plan failed `plan_must_be_strict_json`, because it ran on the chat surface (fixed by #2181). |
| T7, late steer | `0b61fbff` | The re-plan passed, but the revised run ended partial: the provider budget refused it (HTTP 409) because the steer came while the first run was finalizing. Decision for Neo in the handover. |
| **T7** | browser, `2e542eed` (steer, close, reopen) and `adaacd76` (stop) | **Pass.** Run at 1440×900 on API 644, orchestrator 173 and web 448. Delegated; "House version only" sent mid-run (goal revision 1, re-planned, constraint applied); tab closed while the run continued; reopened; completed at 04:25:40. Second job: Stop showed "Stopping…" and "Cancel requested. Waiting for the worker to confirm termination", and it read cancelled 5 s later. Screenshots in `t7-check-3/`. |

T6 names 0604234N and 0604269N, the program elements on L3 Harris's relevance list, because the QA client has none and state-changing work stays on the QA client.

## Operations

- **Ancestry gate.** API 625, 627 and 640 were other workstreams' branch commits. `roll-svc.sh` now also accepts a served commit that is not an ancestor, but only when its whole off-main delta reverse-applies to the candidate's tree. The check uses a temporary index and runs twice, immediately before promote. It refused `3471cac58` against 640 and passed `e3b25d2db` against 627 and `4f0139e22` against 640.
- **Worker-loss check, attempt 1 (API 634): inconclusive.** The load balancer drains an old target for up to 300 s, which kept the job's stream on the old task until the 5.5-minute research finished. A roll only interrupts a job whose research runs more than about five minutes past deregistration.
- **Migration ledger.** Another workstream's `apps/api-strategy` deploy failed `20260908090000_watch_mission_purpose` at 23:23 (column exists) and marked it applied at 23:33. `migration-status` from `apps/api` reported it failed at about 00:00 and read up to date again by 00:35. A direct ledger read showed all 458 `apps/api` migrations applied throughout.
- **Backfill.** Batches 16 to 20 inserted 1,000 each, so 12,754 bill versions are stored. The loop continues.
- **`meri_unavailable` since the 2026-10-05 drill:** 0, by a Logs Insights count at 04:30 UTC.
- **Probe family.** `capiro-dev-api-meri-memory-probe` holds one-off read-only probes on the API image (`outputs/meri-stage2-20261006/memory-probe/run_probe.py`). Each revision is deregistered after its run.
