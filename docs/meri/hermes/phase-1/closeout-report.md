# Phase 0 / Phase 1 closeout report

**Verdict: NOT READY FOR PHASE 2.**

**Phase 0: CLOSED.** **Phase 1: NOT CLOSED** — required gates remain FAILED, INCOMPLETE or BLOCKED.

Production pilot activation status, reported separately as required: **not activated, not requested, and not authorized by anything in this closeout.** All three gate keys remain closed in every environment and no deployed resource was created, modified or configured at any point.

| | |
|---|---|
| Branch | `feat/meri-hermes-phase-0` |
| Implementation commit under test | **`5b6f04a8d`** (+ `3de42668c`, a CI-config-only fix) |
| Report commits | `07df2cbf4`, `4f907a5b0`, `933c2d180`, `58fb25a5c`, `9e55236e5`, `fdf66fc2d`, `fb2ee7e92`, and this file |
| Verification environment | Local Windows host; fixture Postgres `capiro` in docker `capiro-postgres`; pinned worker `meri-hermes-worker:v2026.9.14-meri` (amd64). **No AWS resource was touched.** |

> **Read this before quoting any number below.** No single verification run covers the final committed revision in full. The strongest runs (11 suites / 77 tests exit 0; e2e 31/31 exit 0) were taken against `5b6f04a8d` **minus** two spec files that a later, unfinished lane added. The most recent full run, which includes them, was **13 suites / 91 tests with one failure**. Details in §3.

---

## 1. Phase 0 — CLOSED

| # | Requirement | Status | Evidence |
|---|---|---|---|
| P0-1 | Pinned build, contracts, state map, ledger, inventory, measurements, harness and evidence paths verified; original evidence preserved and corrections appended | **PASS** | `checks-report.md` "Corrections appendix"; original text untouched above it |
| P0-2 | ISO2's `409 NOT_ROUTED_TO_HERMES` corrected; real closed-gate behaviour documented and cited to production-code tests | **PASS** | Correction C1; `meri-hermes-isolation.spec.ts`, `meriv3-runtime.proxy.spec.ts` |
| P0-3 | D6c per-conversation session key retained; isolation shown between two conversations of one user *and* between users | **PASS** | Correction C2; `PROBE-session-isolation.json`, ISO1, D2c |
| P0-4 | Explicit skill creation distinguished from automatic learning; the short probe is not a pass; deferred capabilities assigned to real milestones | **PASS** | Correction C3 (2B), C5 (per-item milestone table) |
| P0-5 | Stale claims corrected (in-memory run store, count of open decisions, "all §G items are Phase 1") | **PASS** | Correction C4, C5 |
| P0-6 | Already-settled decisions recovered and recorded, not re-asked | **PASS** | `decisions.md` §1, with provenance separated into explicit choices vs adoption-by-non-objection |
| P0-7 | Pilot identities recorded; real ids deferred to an authorized lookup; synthetic identities used locally | **PASS** | `decisions.md` §3, `pilot-configuration.md` |
| P0-8 | Inventory labelled as schema declarations, not distinct business tables | **PASS** | Correction C7.1 |
| P0-9 | Immutable evidence index | **PASS** | `evidence-index.md`; `SHA256SUMS.txt`, 179 files, manifest digest `3f17214d…2956a`, `sha256sum -c` verifiable |
| P0-10 | Compatibility re-checked where affected | **PASS** | Pin unchanged; live recheck reproduced `run_steer: true` and `/v1/skills` HTTP 500 — `evidence/pinned-build-recheck/` |

**Additional Phase 0 finding, recorded rather than waived:** correction **C7.2** — the inventory classifier **fails open**. Absence of scope evidence yields the *most permissive* scope (167 of 266 `global_reference` models arrived that way); `scope: client` is structurally almost unreachable (97 models carry `clientId`, 96 are classified `tenant`, exactly 1 of 549 is `client`), so restricted-client policy is inexpressible; and `--check` compares baseline membership only, so a widened scope or a removed read path passes silently. **Phase 2A's "unclassified migration fails CI" criterion is not met by `--check` as written.** Not a Phase 1 blocker — nothing in Phase 1 depends on it.

---

## 2. Phase 1 — requirement matrix

Status vocabulary: **PASS** (asserted and evidenced), **FAIL** (asserted and did not hold), **INCOMPLETE** (not implemented, or implemented without its evidence), **BLOCKED** (cannot be exercised here).

### 2.1 Durable coordination, admission and recovery

| # | Requirement | Owner | Code | Evidence | Status |
|---|---|---|---|---|---|
| C-1 | Durable run/event/interaction store replacing the in-memory prototype | backend | `meri-hermes-prisma-run-repository.ts`; migrations `…010000`, `…020000`, `…030000` | repository spec; applied to fixture DB only | **PASS** |
| C-2 | Atomic admission, single-writer per conversation, request-fingerprint idempotency | backend | advisory lock + partial unique index | cross-replica spec | **PASS** |
| C-3 | Cross-replica event delivery and terminal state without sticky sessions | backend | `watch()` ordered durable polling | cross-replica spec, two independent instances through Postgres | **PASS**, scope-limited — proven **instance-to-instance, not process-to-process** |
| C-4 | Gap-free replay→live handoff | backend | cursor-based `watch()` | concurrent-production test | **PASS** |
| C-5 | Recovery after event pruning; deleted deltas cannot truncate the answer | backend | `output_seq` snapshot; prune never crosses it | pruning test | **PASS** |
| C-6 | Unresolved clarifications survive their run; approval on a terminal run refused | backend | discovery endpoint + repository method | terminal-interaction test | **PASS** |
| C-7 | Fresh-tab/device discovery without a client-side pointer | frontend | `GET conversations/:id/active`; `sessionStorage` pointer **deleted** | chat vitest 37 files / 359 tests, exit 0 | **PASS** |
| C-8 | Durable dispatch; admission-then-crash cannot lose a run; ambiguous startup reconciled before new work | backend | `dispatchStatus` + `reconcileStuckDispatches`, wired | reconcile test | **PASS** |
| C-9 | Publication fencing — a consumer that lost its lease cannot keep writing | backend | `RunWriteFence` on `append()`/`update()` | ownership-and-finalization spec | **PASS** |
| C-10 | Atomic finalization — only the winning transition publishes | backend | `transitionTerminal()` first, in-transaction | 3 concurrent finalizers → exactly one assistant message + one terminal event | **PASS** |
| C-11 | **Two-replica HTTP test: submit via A, reconnect+Stop via B, terminate A** | backend | — | not performed | **INCOMPLETE** — C-3 is the nearest evidence and is explicitly weaker |
| C-12 | Automatic recovery of an orphaned run by a **production caller**, proven by killing the owning process | backend | `sweepStaleConsumers()` | Correctness lane proved it by SIGKILLing a real `tsx` child; a second, **unfinished** lane's `meri-hermes-maintenance.worker.spec.ts` currently **fails** | **FAIL** — see §3 |
| C-13 | Idle-worker sweeper production caller | platform | `sweepIdleWorkers()` exists, caller unfinished | failing test | **INCOMPLETE** |
| C-14 | Concurrent first-use cannot provision competing workers for one scope | platform | not implemented | — | **INCOMPLETE** |

### 2.2 Governed application integration

| # | Requirement | Evidence | Status |
|---|---|---|---|
| G-1 | Real application graph: real auth boundary, real Context Plane gateway, durable repository, real broker, **real Hermes turns** | `meri-hermes-full-application.e2e.spec.ts`, 31/31 exit 0 against the pinned worker. Substituted, and labelled: Clerk session verification (external SaaS), `sanitize-html` (ESM/jest), and the literal whole-`AppModule` import (exceeds jest's default heap) — the real `AppModule` spine + real `MeriModule` subgraph is booted instead | **PASS**, with disclosed substitutions |
| G-2 | Permitted retrieval, personal ownership, tenant isolation, restricted-client denial, provenance/coverage, both `enforce` and dark lifecycles, no ungoverned fallback, proposed ≠ saved | seven assertions, all proved | **PASS** |
| G-3 | F-1: authorization re-resolved **before results are released** | `assertStillAuthorizedBeforeRelease()`, one shared primitive on the result-returning paths | **PASS** |
| G-4 | F-2: fenced session binding invalidated; next attempt rebuilds context | `invalidateSessionBinding()` clears `sessionId` **and** bumps `sessionEpoch` (clearing the id alone is insufficient — the key names the transcript) | **PASS** |
| G-5 | Authorization rechecked on status, replay, artifacts, interaction answers, publication | C1–C6 at HTTP level | **PASS** |
| G-6 | Worker credential binding, rotation, expiry; stale/mismatched calls rejected | D1–D4 | **PASS** |
| **G-7** | **Ticket #6 accepted** | — | **NOT ACCEPTED** — blocked by A1/A2/A6 below |

### 2.3 Authorization defects found during closeout review — all verified in source

Surfaced by the Phase 2 orchestration session's read-only review and each re-verified here before recording. Full detail in `phase-2-handoff.md` §1.1.

| # | Defect | Status |
|---|---|---|
| A1 | A **revoked or expired** client grant still authorizes a walled client — `authorizedClientIds` filters on `userId` only, ignoring `status`/`expiresAt`/`revokedAt` | **FAIL — open** |
| A2 | No downstream net: `fetchDeniedClientIds()` is equally lifecycle-blind (shared memory-system code, predates Hermes) | **FAIL — open** |
| A3 | `assertTool` allow-list **fails open**: `policy.allow.length &&` short-circuits on `allow: []`, permitting every tool, inverting its own documented contract | **FAIL — open** |
| A4 | Tool budget is not a cap: `brokerCalls` read from an entry snapshot, written as a plain `SET` rather than an atomic increment | **FAIL — open** |
| A5 | `MUTATING_TOOLS` is a hand-maintained two-element set, so future write tools are permitted by default on `readOnly` runs | **FAIL — open** |
| A6 | The F-1 guard has a fail-open fallback (`?? run`) that validates the stale entry-time snapshot | **FAIL — open** |
| A7 | Zero test coverage for `tool_not_allowed`, `tool_denied`, `read_only_run`, `tool_budget_exhausted` | **FAIL — open** |
| A8 | **A Hermes answer emits no citations**, while V3 answers do — P1-08 requires "emits supported progress/citations". Data exists at the broker boundary (`sourceId`, provenance) but is never translated into the UI's citation contract | **FAIL — open** |
| A9 | No untrusted-content handling on the Hermes path (bounded today; load-bearing once Phase 2 admits MCP/mail/web) | **open, informational** |

### 2.4 Worker platform

| # | Requirement | Status |
|---|---|---|
| W-1 | Fargate worker fleet construct: ARM64, EFS per scope, constrained egress, scoped IAM, alarms | **PASS (code)** — `cdk synth` exit 0, construct spec 9/9. Design finding: ECS `RunTask` overrides have **no `volumes` field**, so an EFS access point is fixed at task-definition registration; implemented as one task-definition family per scope |
| W-2 | Worker lifecycle service: provision, readiness, heartbeat, idle teardown | **PASS (code)**, AWS SDK mocked |
| W-3 | **Pinned ARM64 image built** | **INCOMPLETE** — build path fixed and demonstrably arm64, aborted at 200 MB free; image not produced |
| W-4 | Repeatable image/registry CI | **PASS (authored)** — never executed; ECR repository does not exist |
| W-5 | Bundled-skill license review (58 upstream skills) | **INCOMPLETE** |
| W-6 | **V1–V7 real-Fargate validation** | **BLOCKED** — no authorized isolated environment; `capiro-dev` is production |

### 2.5 Experience, capacity, CI

| # | Requirement | Status |
|---|---|---|
| E-1 | Stop / detach / reconnect, 11 run states, snapshot recovery | **PASS** (vitest 37/359 exit 0) |
| E-2 | Clarification + native approval cards; Run once / Deny only; expiry; monotonic resolution | **PASS** |
| E-3 | Steering: capability verified real (`run_steer: true`) but no UI | **PASS as an explicit disabled capability statement**; MW-09 remains an open UI ticket |
| E-4 | Disable/Stop contradiction resolved — Stop and read-only status/events survive the kill switch on ownership alone | **PASS** |
| E-5 | Closed-gate/non-pilot routing unchanged; admitted failure stays visible | **PASS** (2 suites / 15 tests exit 0) |
| E-6 | Artifact through the **configured object store**, not a substitute | **INCOMPLETE** — `MeriHermesArtifactStorageService` constructs `new S3Client({ region })` with no endpoint override, so it cannot address MinIO; only SDK-mocked coverage exists. The repo already has the pattern (`{ endpoint, forcePathStyle: true }`) and MinIO harnesses |
| E-7 | Browser evidence of the end-to-end experience | **INCOMPLETE** |
| E-8 | Rollback rehearsal | **INCOMPLETE** (documented, not exercised) |
| **S-1** | **Distributed budgets with atomic reservations** | **INCOMPLETE — never implemented** |
| **S-2** | **Tenant fairness, bounded queues, noisy-tenant test** | **INCOMPLETE — never implemented** |
| **S-3** | **Profile-write coordination for parallel same-user conversations** | **INCOMPLETE — never implemented** |
| S-4 | Bounded DB/tool budgets with application headroom | **INCOMPLETE** |
| CI-1 | Real-Hermes e2e split out of the default suite | **PASS** — default run no longer collects it; `test:e2e*` scripts and `jest.e2e.config.cjs` added |
| CI-2 | A runner that actually executes the CDK construct tests | **PASS** — baseline was 15 of 21 suites failing with "must contain at least one test" and **0 node:test assertions executed**; now run by a dedicated runner and wired into CI |
| CI-3 | e2e CI job configured with values that pass | **PASS (fixed here)** — the job had all four load-bearing values set to the configuration we measured *failing* |
| CI-4 | `src/app.module.spec.ts` (the repo's DI-cycle smoke test) runs | **INCOMPLETE** — dies at collection on ESM `htmlparser2`; needs `htmlparser2|sanitize-html` in `transformIgnorePatterns`. Pre-existing |
| V-1 | **Local DB-backed verification environment** | **BLOCKED** — see §3 |

---

## 3. Why the verification numbers do not converge

Two independent problems, both recorded rather than smoothed over.

**The Recovery lane never finished.** The orchestrating workflow ran four agents; two completed (Correctness, CI) and **two failed on a session limit** (Recovery, Capacity). The Recovery lane had already written `meri-hermes-maintenance.worker.spec.ts` before it stopped, so the committed tree contains a spec for an implementation that was never completed. That spec fails (`sweepIdleWorkers` reclaimed 0, expected ≥1). **It is recorded as C-12 FAIL / C-13 INCOMPLETE, not as a flake.** The Capacity lane produced nothing at all, which is why S-1…S-4 are INCOMPLETE.

**The local Docker engine collapsed four times.** `capiro-postgres` and the pinned worker go with it each time. The first collapse followed genuine memory exhaustion (200 MB free, caused partly by an arm64 build I started and partly by leaked jest workers another agent left thrashing at ~3.8 GB each). Subsequent collapses happened at **4.4 GB and 13.2 GB free**, so this is engine instability, not resource pressure. Attempts to re-run the failing maintenance spec in isolation returned `PrismaClientInitializationError: Can't reach database server` for all of its tests — infrastructure noise, not a diagnosis. **The one failure therefore remains unresolved and unattributed**, and the e2e tier is currently unrunnable on this host.

Consequently: the strongest green runs (11 suites / 77 tests exit 0; e2e 31/31 exit 0) predate the two specs the unfinished lane added, and the only run that includes them shows 13 suites / 91 tests with one failure. **No run covers the final committed revision in full.**

**A correction of my own, recorded because I enforced the opposite on others.** I reported `tsc --noEmit --rootDir .` as exiting 1 and told two agents their reported 2 was wrong. They were right for the command they ran: `--noEmit --rootDir .` exits **2**, plain `--noEmit` exits **1**, with byte-identical diagnostics. The Phase 2 session had already hardened my incorrect value into an entry gate that would have failed honest work. What is stable: exactly one diagnostic, pre-existing and unrelated, non-zero either way.

---

## 4. Blockers, in the order they must be cleared

1. **A1–A8** — eight verified authorization/experience defects, all open. A1/A2 are the most serious: revocation, the property the restricted-client story is sold on, does not hold in the envelope builder *or* in the downstream wall probe.
2. **S-1…S-4** — the entire scaling obligation is unimplemented.
3. **C-12/C-13/C-14** — recovery wiring unfinished and currently failing; provisioning race open.
4. **V-1** — local verification environment unstable; required before any of the above can be re-proved.
5. **W-3/W-6** — arm64 image unbuilt; real-Fargate validation **BLOCKED** on an authorized isolated environment. The ask is itemized in `deployment-validation-and-rollback.md`.
6. **E-6/E-7/E-8** — object-storage, browser and rollback evidence outstanding.

## 5. Next implementation step

Restore a stable local Docker engine, then, in order: fix A1–A6 with the regression tests A7 demands; complete C-12/C-13/C-14; implement S-1…S-4; add A8 citations; then re-run the full suite **and** the e2e tier last, against one single revision, and replace §3 with a converged result.

**Do not begin Phase 2.** Ticket #6 is **not accepted**; its precondition is A1/A2/A6 clearing. Nothing in this closeout authorizes production activation, tenant-allowlist expansion, or any change to `capiro-dev`.
