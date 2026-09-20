# Phase 0 / Phase 1 closeout report

**Verdict: NOT READY FOR PHASE 2.** (Re-issued 2026-09-20 against the converged revision `56d97272`. The verdict is unchanged, but the reason has changed: it is no longer an unconverged verification or a missing AWS environment — both of those are resolved. It is now V5–V7 resting on a design decision, plus an unreconciled authorization ledger. See §4.)

**Phase 0: CLOSED.** **Phase 1: NOT CLOSED** — V5–V7 blocked by design, E-7 partial, authorization ledger unreconciled.

Production pilot activation status, reported separately as required: **not activated.** All three gate keys remain closed in every environment.

> **CORRECTION (2026-09-20).** This header previously read "no deployed resource was created, modified or configured at any point." **That is no longer true.** Under later explicit operator authorization, during a declared maintenance window, AWS resources WERE created in production account 967807252336 to execute platform gates V1–V3. Nothing pre-existing was modified and no migration has been applied to any deployed database. See `HANDOVER.md` §4 for the full resource inventory and `evidence/fargate-v1-v3/`. The matrix in §2 below predates that work and is stale — V1/V2/V3 now PASS, and C-12/C-13/C-14 were subsequently fixed. **Treat `PHASE-1-STATUS-2026-09-20.md` as the current state of record, then `HANDOVER.md`, then this file.**
>
> **SECOND CORRECTION (2026-09-20, deploy session).** More of the above is now out of date, in the other direction. The branch has since been **deployed to production**: `capiro-dev-api` rev **395** on a fresh arm64 image, and the **5 additive migrations have been applied** to the production database. The statement "no migration has been applied to any deployed database" was true when written and is **now false**. V1–V4 PASS, E-6/E-8/CI-4/C-11 closed. The pilot gate remains closed in every environment and no tenant is routed to Hermes. Rows below are individually corrected; §3 is superseded.

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
| **G-7** | **Ticket #6 accepted** | — | **PENDING** — its two blockers resolved (A1/A2 withdrawn as non-defects, A6 fixed). No outstanding authorization blocker; acceptance now waits only on a converged green run against one revision |

### 2.3 Authorization defects found during closeout review — all verified in source

Surfaced by the Phase 2 orchestration session's read-only review and each re-verified here before recording. Full detail in `phase-2-handoff.md` §1.1.

| # | Defect | Status |
|---|---|---|
| A1 | ~~A revoked/expired client grant still authorizes a walled client~~ | **WITHDRAWN — not a defect.** The review misidentified the model: `Client.memoryAccessGrants` resolves to `ClientMemoryAccess` (six columns, no lifecycle fields), not `MemoryAccessGrant`. Revocation is a hard delete, so no dead row survives. See §3.1 |
| A2 | ~~No downstream net in `fetchDeniedClientIds()`~~ | **WITHDRAWN — same misidentification.** Recorded for future work: that helper family has **58 non-spec callers**, so any real change there is wide-blast-radius |
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
| W-3 | **Pinned ARM64 image built** | **PASS (2026-09-20)** — built and pushed; the `linux/arm64` **platform manifest** `sha256:51b41a3b…` is the digest to pin, not the index (which carries a provenance attestation Fargate can reject). Supersedes the earlier "aborted at 200 MB free" |
| W-4 | Repeatable image/registry CI | **PASS (authored)** — still never executed in CI, but the earlier reason ("ECR repository does not exist") is **no longer true**: `capiro/dev/meri-hermes-worker` exists and holds the pinned image |
| W-5 | Bundled-skill license review (58 upstream skills) | **PASS** — `bundled-skill-license-review.md`. 58 skills: 53 under upstream MIT, 5 self-licensed MIT (one © a **third party**, Siqi Chen, whose notice must be retained). Also found outside the skill set: `plugins/security-guidance/` carries **Apache-2.0** work from Anthropic's `claude-plugins-official`, with NOTICE obligations MIT does not impose. No copyleft, no non-commercial terms. Explicitly **not** a full dependency/SBOM audit |
| W-6 | **V1–V7 real-Fargate validation** | **V1–V4 PASS, V5–V7 BLOCKED.** Supersedes "no authorized isolated environment". V1–V4 were executed on real Fargate in `capiro-dev` under explicit operator authorization — `evidence/fargate-v1-v3/`, `evidence/fargate-v4/`. V5–V7 are blocked by a **design** constraint, not a missing environment: see `v5-v7-blocked-on-resolver-binding.md` |

### 2.5 Experience, capacity, CI

| # | Requirement | Status |
|---|---|---|
| E-1 | Stop / detach / reconnect, 11 run states, snapshot recovery | **PASS** (vitest 37/359 exit 0) |
| E-2 | Clarification + native approval cards; Run once / Deny only; expiry; monotonic resolution | **PASS** |
| E-3 | Steering: capability verified real (`run_steer: true`) but no UI | **PASS as an explicit disabled capability statement**; MW-09 remains an open UI ticket |
| E-4 | Disable/Stop contradiction resolved — Stop and read-only status/events survive the kill switch on ownership alone | **PASS** |
| E-5 | Closed-gate/non-pilot routing unchanged; admitted failure stays visible | **PASS** (2 suites / 15 tests exit 0) |
| E-6 | Artifact through the **configured object store**, not a substitute | **PASS (2026-09-20)** — optional `MERI_HERMES_ARTIFACT_S3_ENDPOINT` added following the `production-parser-verification-context.ts:78` precedent; unset in production so real-S3 behaviour is unchanged. New spec round-trips bytes through a real disposable MinIO container (12.3 s, not a skip). **Proved non-vacuous**: removing the override fails both tests |
| E-7 | Browser evidence of the end-to-end experience | **PARTIAL** — post-deploy the app renders with zero console errors and all assets 200, and `/api/health` is byte-identical before/after. The Hermes **user journey** is unevidenced and stays so while the gate is closed: unauthenticated probes return 401 *before* the gate, so they cannot distinguish "gate closed" (404) from "not signed in" |
| E-8 | Rollback rehearsal | **PASS (2026-09-20)** — **exercised on production**, not documented. With the 5 migrations applied, the service was rolled back to the pre-Hermes revision (`:394`, `c780031cc`) — 2/2, no crash loop, response behaviour unchanged against the migrated schema — then rolled forward. First actual demonstration that additive migrations make rollback safe |
| **S-1** | **Distributed budgets with atomic reservations** | **INCOMPLETE — never implemented** |
| **S-2** | **Tenant fairness, bounded queues, noisy-tenant test** | **INCOMPLETE — never implemented** |
| **S-3** | **Profile-write coordination for parallel same-user conversations** | **INCOMPLETE — never implemented** |
| S-4 | Bounded DB/tool budgets with application headroom | **INCOMPLETE** |
| CI-1 | Real-Hermes e2e split out of the default suite | **PASS** — default run no longer collects it; `test:e2e*` scripts and `jest.e2e.config.cjs` added |
| CI-2 | A runner that actually executes the CDK construct tests | **PASS** — baseline was 15 of 21 suites failing with "must contain at least one test" and **0 node:test assertions executed**; now run by a dedicated runner and wired into CI |
| CI-3 | e2e CI job configured with values that pass | **PASS (fixed here)** — the job had all four load-bearing values set to the configuration we measured *failing* |
| CI-4 | `src/app.module.spec.ts` (the repo's DI-cycle smoke test) runs | **PASS (2026-09-20)** — one negative lookahead in `transformIgnorePatterns` widened to cover `sanitize-html`, `htmlparser2` and the `domhandler`/`domutils`/`entities`/`dom-serializer` chain, keeping `@makegov` and leaving all other `node_modules` untransformed. The suite collects and passes |
| V-1 | **Local DB-backed verification environment** | **BLOCKED** — see §3 |

---

## 3.1 Withdrawn findings — an error in this review, recorded not deleted

**A1 and A2 were wrong, and the mistake was mine.** I escalated them as the most severe items in the set, downgraded the broker boundary partly on them, made ticket #6 conditional on them, and sent them to the Phase 2 session as "the worst of the set."

Two individually-true observations joined by a false inference: `meri-hermes-security.port.ts` really does filter `memoryAccessGrants: { some: { userId } }`, and a model really is named `MemoryAccessGrant` carrying `status`/`expiresAt`/`revokedAt`. But `Client.memoryAccessGrants` resolves to **`ClientMemoryAccess`** (`schema.prisma:905`) — `id, tenantId, clientId, userId, grantedBy, createdAt`, no lifecycle columns. `MemoryAccessGrant` hangs off a *different* relation, `governedMemoryGrants` (`:907`). Revocation on the model actually in use is a hard `deleteMany` replace-set in `ClientsService.setMemoryAccess()`, its only writer, so there is no revoked-but-present row for either layer to miss. The filter I prescribed would not have type-checked.

I connected a relation to a model **by name similarity** and never checked the relation's declared type. The verification I applied to others' claims — read both endpoints, not the label — is the one I skipped on my own. Kept visible rather than deleted, because a closeout that hides its own false positives is worth less than one that shows them.

## 3. Verification — CONVERGED as of 2026-09-20

> The section below this block is **retained as history**. Its premise — that no single run covers the final revision — no longer holds. A converged run exists against one revision, `56d97272`.

| Check | Result |
|---|---|
| `tsc --noEmit` (apps/api) | **exit 0, zero diagnostics** |
| `tsc -p tsconfig.build.json` (what the production image compiles) | **exit 0, zero diagnostics** |
| `jest src/meri/hermes` | **23 suites / 209 tests, exit 0** |
| Routing gate (`meriv3-runtime.proxy`, `meri-hermes-flags`) | **PASS** |

The earlier TS1479 baseline failure is gone — `main` fixed it in `0cbabd46`. The 23/209 figure is the
previous 21/206 plus exactly the two new specs (MinIO ×2, C-11 ×1).

A broader `src/meri` sweep (176 suites / 1881 tests) shows **2 suites / 4 tests failing, both
pre-existing on `main`** and untouched by this branch: `meri-tool-manifest.parity.spec.ts`
(hardcoded `toHaveLength(85)`, actual 99, drifted since `5cb19c399` on 2026-09-06) and
`meri-client-scope-fail-closed.spec.ts`. They are unseen because `ci-pr.yml` typechecks `apps/api`
but never runs its jest.

Note also that the handover's "routing seam (4 specs) — 108 tests" does not reproduce; the recorded
evidence is 2 suites / 15 tests (`evidence/closeout-routing/jest-routing-gate.txt`).

---

## 3 (historical). Why the verification numbers did not converge

Two independent problems, both recorded rather than smoothed over.

**The Recovery lane never finished.** The orchestrating workflow ran four agents; two completed (Correctness, CI) and **two failed on a session limit** (Recovery, Capacity). The Recovery lane had already written `meri-hermes-maintenance.worker.spec.ts` before it stopped, so the committed tree contains a spec for an implementation that was never completed. That spec fails (`sweepIdleWorkers` reclaimed 0, expected ≥1). **It is recorded as C-12 FAIL / C-13 INCOMPLETE, not as a flake.** The Capacity lane produced nothing at all, which is why S-1…S-4 are INCOMPLETE.

**The local Docker engine collapsed four times.** `capiro-postgres` and the pinned worker go with it each time. The first collapse followed genuine memory exhaustion (200 MB free, caused partly by an arm64 build I started and partly by leaked jest workers another agent left thrashing at ~3.8 GB each). Subsequent collapses happened at **4.4 GB and 13.2 GB free**, so this is engine instability, not resource pressure. Attempts to re-run the failing maintenance spec in isolation returned `PrismaClientInitializationError: Can't reach database server` for all of its tests — infrastructure noise, not a diagnosis. **The one failure therefore remains unresolved and unattributed**, and the e2e tier is currently unrunnable on this host.

Consequently: the strongest green runs (11 suites / 77 tests exit 0; e2e 31/31 exit 0) predate the two specs the unfinished lane added, and the only run that includes them shows 13 suites / 91 tests with one failure. **No run covers the final committed revision in full.**

**A correction of my own, recorded because I enforced the opposite on others.** I reported `tsc --noEmit --rootDir .` as exiting 1 and told two agents their reported 2 was wrong. They were right for the command they ran: `--noEmit --rootDir .` exits **2**, plain `--noEmit` exits **1**, with byte-identical diagnostics. The Phase 2 session had already hardened my incorrect value into an entry gate that would have failed honest work. What is stable: exactly one diagnostic, pre-existing and unrelated, non-zero either way.

---

## 4. Blockers, in the order they must be cleared

**Rewritten 2026-09-20.** The original list is preserved at the end of this section.

1. **V5–V7 — blocked by a design decision, not by work.** `MERI_HERMES_WORKER_RESOLVER` has exactly one binding (`meri.module.ts:169`, the ECS lifecycle service), so any API serving a Hermes run must itself hold `ecs:RegisterTaskDefinition` — which AWS cannot scope to a resource — plus `iam:PassRole`, on the role behind all customer traffic. That pair is privilege-escalation capable and the operator declined to grant it. **Do not close this by granting the IAM.** The fix is a second binding for that port. See `v5-v7-blocked-on-resolver-binding.md`.
2. **Authorization ledger unreconciled.** Two records disagree about six broker-path defects (F-1's fail-open `?? run` fallback, F-2, `assertTool` passing every tool on an empty allow-list, non-atomic tool budget, hand-maintained `MUTATING_TOOLS`, and `ContextPlaneRecallPort` ignoring `authorizedClientIds`). The 2026-09-19 ledger says open; a later handover claims A3–A7 landed. **Neither was re-verified during the deploy session.** This is the largest remaining unknown and it gates the Phase 2 verdict.
3. **E-7 partial** — completable only once the gate can be opened for a test tenant with an authenticated session. Downstream of blocker 1.
4. **Production is ahead of `main`** until PR #1708 merges. `capiro-dev-api` rev 395 runs `56d97272`; a deploy from `main` would revert it. The migrations are additive, so no data is at risk, but the code would disappear silently.

**Cleared since the original list:** A1/A2 withdrawn (§3.1); C-12/C-13/C-14 wired; S-1…S-4 implemented; V-1 (local verification environment) stable and converged; W-3 image built and pushed; W-6 for V1–V4; E-6, E-8, CI-4 and C-11 closed.

<details><summary>Original §4 list (2026-09-19), retained</summary>

1. **A3–A8** — six defects. A3–A7 have fixes landed and awaiting verification; **A8 (no citations) remains open**. A1/A2 are **withdrawn** — they were my error, not the code's (§3.1).
2. **S-1…S-4** — the entire scaling obligation is unimplemented.
3. **C-12/C-13/C-14** — recovery wiring unfinished and currently failing; provisioning race open.
4. **V-1** — local verification environment unstable; required before any of the above can be re-proved.
5. **W-3/W-6** — arm64 image unbuilt; real-Fargate validation **BLOCKED** on an authorized isolated environment. The ask is itemized in `deployment-validation-and-rollback.md`.
6. **E-6/E-7/E-8** — object-storage, browser and rollback evidence outstanding.

</details>

## 5. Next implementation step

**Rewritten 2026-09-20.** In order:

1. **Merge PR #1708** — production is running unmerged code, and the branch merges cleanly today.
2. **Add the second `MERI_HERMES_WORKER_RESOLVER` binding** — a static resolver returning a configured worker URL, with the ECS lifecycle service remaining the default. This unblocks V5–V7 with **zero** new permissions, against an out-of-band worker exactly as V1–V4 were run.
3. **Run V5–V7**, then complete **E-7** with an authenticated gated session.
4. **Reconcile the authorization ledger** (blocker 2) — read the code rather than the documents, and for each of the six state fixed-and-tested, fixed-but-untested, or open. Those are three materially different answers.
5. **Accept or reject ticket #6.** Its stated precondition — A1/A2/A6 clearing plus a converged green run — is now met (§3), so what it needs is a decision, not more evidence.

**Do not begin Phase 2.** Nothing here authorizes pilot activation or tenant-allowlist expansion. The gate is closed in every environment and must stay closed at least until blocker 2 is resolved.
