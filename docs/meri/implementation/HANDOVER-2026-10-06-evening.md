# Meri handover, 2026-10-06 (evening session, lead agent)

This file continues [HANDOVER-2026-10-06-pm.md](HANDOVER-2026-10-06-pm.md). That file's sections 2, 6, 8 and 9 still hold except where this file says otherwise. Read it first for the decisions table, the tooling and the hazards.

The session worked handover §9 step 1 (T5). T5 run 8's refusal turned out to be four defects in a row, each hidden behind the one before it. All four are fixed and deployed, and T5 now publishes. Two new blockers stand between T5 and a pass: `search_memory` takes 18 to 36 seconds per call, and one D2 hold. The federal backfill had stalled and has been fixed and restarted.

## 1. Where things stand (2026-10-06, about 22:30 UTC)

| Service | Revision | Rollback | Source | Digest | Carries |
| --- | --- | --- | --- | --- | --- |
| `capiro-dev-api` | 623 | 622 | `006eb59d2` | `sha256:7286985d…` | everything on main at 006eb59d2: #2124, #2125, #2126, #2128, #2132, #2134, #2136, plus LegiWatch #2122 |
| `capiro-dev-meriv2-orchestrator` | 167 | 166 | `0650f02a2` | `sha256:20aeedb5…` | unchanged this session; does **not** yet carry #2132 (D2 matcher) for chat |
| `capiro-dev-web-vnext` | 431 | | | | other workstreams' rolls (427 from `0732f2511` at 20:28 UTC, then 431) |
| backfill family `capiro-dev-api-federal-evidence-backfill` | 2 | 1 | `006eb59d2` | same image as the API | #2136 transaction timeout |

API rolls this session: 617 (`8f77a5785`, about 19:48 UTC), 621 (`f3e360155`, about 20:44 UTC) and 623 (`006eb59d2`, about 22:12 UTC). LegiWatch rolled API 619 (`0732f2511`) at 20:21 UTC; it contained the 617 fixes, and the second ancestry read made the 621 candidate include it. No migration was applied. `migration-status` was read-only on every candidate and reported the schema up to date.

Unchanged: `meri.jobs` is on for capiro-internal only. `MERI_JOB_SWEEPER_ENABLED` is still unset, because T5 has not passed. `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED` is still off on the API service.

## 2. T5: runs 8 to 10, six defects

| Run | Session | Served | Outcome | Cause | Fix |
| --- | --- | --- | --- | --- | --- |
| 8 (pm) | `cab91bd9` | 615 | "producer proof is unavailable" | (a) The V3 runner lists a tool once per read (`read_client_documents` ×10). `stringArray` in the publication proof, and in the saved-report proof on every read, rejects duplicates. The joined parent+child path deduplicated, so only the parent-only path failed. (b) The run was parent-only because its one good child was dropped by its own re-check: "version changed". | #2124 (each tool declared once, plus clause-level logs at every proof refusal) |
| 8, behind (b) | | | | `search_memory`'s saved result crossed HTTP (ISO date strings); the in-process re-check returns `Date`s. `memoryProof` hashed `updatedAt` only when it was a string, so every non-empty memory re-check failed. | #2125 (compare in JSON shape) |
| 8, behind (b) | | | | A `read_client_documents` file listing is receipted and declared, but `documentProof` returned null for listings, so its re-check could never pass. | #2126 (a listing's proof is the identity of the files shown) |
| 9 | `00eb08de` | 617 | All proof clauses passed; a child was admitted; refused at publication | `scrape_web_page` re-read "version changed". The proof hashed the raw HTML bytes and the navigation links. | #2128 (proof binds url, title, type, pages and read text; refusal logs the changed field names) |
| 10 | `ca7158f1` | 621 | **Published** (artifact `53e33739`, message `d7553ece`), **held for review by D2** | D2 flagged `“without regard to the requirements of that section,”` (review `69250800`, pending). `read_bill_text` failed in this run, so the hold may be right. The matcher also had two defects: it matched against JSON-escaped text (a line break is `\n`), and it kept the comma inside the closing quote. | #2132 (matching only; fabricated quotes still flag) |
| 10, after publication | | | The stream ran 29 minutes; the script's follow-up GET timed out | The read-time re-check replayed 40+ owner reads serially, about 6 minutes per check. It runs at publication, again at release, and on every read of the session, conversation or deliverable. | #2134 (each distinct read once, four at a time). **Root cause still open: `search_memory` latency (section 3).** |

Each fix was proven by a test that fails without it. The clause and refusal logs from #2124 and #2128 named the next defect each time; use them.

Paid turns this session: 2 (T5 runs 9 and 10). The pm session ran 11 and the morning 9.

## 3. Open: `search_memory` takes 18 to 36 seconds (blocks T5 and slows every chat turn)

Run 10 made 18 memory searches. The two exact-item lookups took 0.3 s and were classified complete. The other 16 took 17.8 to 20.2 s or 35.6 to 36.7 s and were classified partial: 386 s in all, against under 2.5 s for every other tool. API telemetry confirms the time is spent inside the API (`meri.api.tool.started` → `finalized`, e.g. 20:51:00.8 → 20:51:19.9). The ~36 s calls are two ~18 s reads: `meri-tools.service.ts` re-reads with page size 1 when a page's metadata is over budget.

No timer near 18 s exists on the path. Two hypotheses remain; both need production evidence:

1. **One SQL statement scans every eligible memory.** In `apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts` (statement around lines 166–233), `eligible` is `AS NOT MATERIALIZED` and is used three times. On top of that: per-row `STRING_AGG` and `STRPOS`, per-row RLS policy subqueries (memory_items has FORCE ROW LEVEL SECURITY), and a vector sort over the joined embeddings. If so, the candidate fix is `eligible AS MATERIALIZED` (adapter line 188); only the query plan changes.
2. **Prisma's 5-second interactive transaction plus a silent fallback.** `withTenantUser` (adapter line 141) runs without `timeoutMs`. A slow semantic query then fails at commit with "Transaction already closed", and the bare `catch {}` at lines 328–342 reruns the whole read lexically and marks it degraded. The tell is `stopReason: governed_memory_semantic_projection_incomplete` in `coverage.sources`. If so: pass `{ timeoutMs }` and log the caught error.

First step: run `EXPLAIN (ANALYZE, BUFFERS)` of that statement for a capiro-internal user inside `withTenantUser`, and check the stored receipts' `coverage.sources[].stopReason` for session `ca7158f1`. Both need a read-only database path; this session had none. Then fix, roll, and measure one chat turn and one T5 run.

Measured on API 623 with #2134: reading session `ca7158f1` takes **133 s** (HTTP 200). Before, it took over 6 minutes and never finished within the client timeout. Until the latency is fixed, a report resting on many partial memory reads takes about two minutes to open, and the deliverable download and filing may time out behind the load balancer. The run 10 session reads `complete`, its job reads `completed`, and its body is the hold notice ("Report held for review. Open Reviews before using this deliverable."): the hold is enforced end to end.

## 4. Federal BILLS backfill: stalled, fixed, resumed

- Batches 0 to 9 inserted 7,754 bill versions.
- Every batch from 10 on failed in about 22 s on the same package and inserted nothing. The interactive snapshot transaction (Prisma's 5 s default) waited 20–30 s while migration `20281008040000`'s trigger filled the passage windows of a large bill version.
- `loop.py` stops only on a non-zero exit, so it kept launching no-op tasks. It was stopped at about 21:45 UTC.
- #2136 sets the snapshot transaction to 180 s.
- The family was re-registered as revision 2 on the API 623 image (`fed-backfill/register_td_v2.py`; revision 1's record is kept as `td-registered-1.json`).
- `fed-backfill/loop2.py 16` resumes from the checkpoint. It also stops when two consecutive batches insert nothing and report errors.
- Batch 16 started about 22:16 UTC on revision 2 (ECS task `3c73789d`). The old failure came within about 22 s; at 22:23 UTC the batch was still running with no error, which suggests the package now persists. Not yet confirmed: `fed-backfill/loop2.txt` records each batch's inserted count.

## 5. Neo's decisions and approvals this session

None were needed. Every change fixed a defect inside already-approved work (deployment plan §7 lists nothing else). Two judgment calls to look at:

- **#2126 (document listings):** the read-time re-check now accepts a file listing whose file identities are unchanged. Before, it refused every listing.
- **#2132 (D2, a shared enforce-mode check):** D2 matches against decoded text and ignores punctuation inside the closing quote. Every quoted word must still appear verbatim in a tool result.

Still needs Neo's OK at the time: the same list as the pm handover §2.

## 6. Next steps, in order

1. **`search_memory` latency** (section 3): diagnose with production evidence, fix, roll the API, then measure one chat turn's memory search and reopen session `ca7158f1` (`node outputs/meri-stage2-20261006/session-read.mjs ca7158f1-2598-4a3b-82d2-4f2d88abdb92 <out>` prints the read time).
2. **T5 run 11** after step 1. The run 10 report is held (review `69250800`). Approving a quote the auditor could not find is a reviewer's call; do not approve it to make T5 pass. Run 11 shows whether D2 still holds after #2132. Once a run passes: the sweeper revision and worker-loss check, T7, verdicts, Release F (pm handover §9 step 1, unchanged).
3. **Orchestrator roll** for #2132, so chat's D2 matches research's.
4. **Backfill:** watch `fed-backfill/loop2.txt`; when it prints `DONE`, record the counts in `STATUS.md` and run one `read_bill_text` turn on a long bill.
5. Unchanged from the pm handover: the LegiScan decision (`task_3de743b5`); the 2026-10-12 #2032 and #2035 merges; the carry-overs.

New hazards (append to the pm handover §8):

- `gh pr merge` can return HTTP 502 while the merge lands. `roll-svc.sh` then exits under `set -e` after the evidence PR. Check the PR state. If it merged, resume from the qualify step (`outputs/meri-stage2-20261006/roll-svc-resume.sh`, the tail of `roll-svc.sh`).
- Another workstream can roll the API between your build and ship (LegiWatch 619 today). When the build's candidate does not contain the served SHA, rebuild from main rather than ship. If the evidence step already ran, delete its untracked folder and branch in the release checkout first.
- Python heredocs in this harness turn `\n` and `\u0000` escapes into real characters inside source files. Write source edits with the Edit tool.
- `meri-research-durable-replay.spec.ts` and `meri-remaining-source-families.spec.ts` must run under plain `jest` (not `--experimental-vm-modules`), with `NODE_OPTIONS=--max-old-space-size=8192`.

## 7. Documents and records

- This file; `STATUS.md` top block; release record [releases/2026-10-06/README.md](../releases/2026-10-06/README.md), evening section; evidence folders `s2-producer-proof`, `s2-scrape-evidence`, `s2-recheck-d2` (written by the evidence PRs).
- PRs: #2124, #2125, #2126, #2128, #2132, #2134, #2136 (code); #2127, #2129, #2137 (evidence).
- Working files under `C:/dev/main/outputs/meri-stage2-20261006/`: `t5-check-9/`, `t5-check-10/` (streams, logs, review), `ship-17*.txt`, `ship-19.txt`, `ship-21.txt`, `build-17` to `build-21`, `migration-status-17` to `-21`, `session-read.mjs`, `review-read.mjs`, `review-get.mjs`, `roll-svc-resume.sh`, `fed-backfill/register_td_v2.py`, `fed-backfill/loop2.py`.
