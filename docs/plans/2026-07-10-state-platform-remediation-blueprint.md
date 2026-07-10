# State Legislation Platform — Remediation Blueprint (Phase 0 + Phase 1)

**Date:** 2026-07-10
**Status:** Blueprint (no code written yet). Supersedes nothing; sequences the fixes for the 69 verified audit findings + 2 failing gates + deferral-doc gaps.
**Scope:** Phase 0 (S1–S7, commit `b226059`, **merged + live in prod**) and Phase 1 (M1–M5, commit `5dc77c2`, **PR #377, unmerged/undeployed**).
**Author framing:** principal engineer / pragmatic CTO. Every step is grounded in code read on 2026-07-10; nothing here is assumed. Anything that genuinely requires a product/ops call is in the **Decision Register (§4)** — those steps are _blocked until decided_, not guessed.

---

## 1. Executive summary & verdict

The core scaffolding is production-grade: RLS policies, the deterministic status/deadline/district/vote derivations, the LegiScan per-child upsert, H-1 metering, and federal-engine reuse are correct in their main paths. The defects cluster in **(a) the new M5 agentic rail** and **(b) edge-case derivations, ingestion idempotency, and observability**.

Two things are true simultaneously and must be handled on **different ship vehicles**:

1. **Deployed Phase 0 has live correctness bugs** corrupting prod output right now (canonical status inversion, alert double-emit, most state transitions never reaching the inbox, permanent vote loss on a failed child fetch). These ship as **prod hot-fixes off `main`** — independent of PR #377.
2. **Phase 1 (PR #377) is not mergeable as-is:** one blocker (the Tier-2 worker throws on every run) plus an R7 violation (a client-facing cross-realm AI writer that would go live enabled on first deploy with no kill-switch or shadow mode). These ship as **commits on `dev/state-legislation-phase1`** before merge.

**Merge gate for #377:** Waves 1–3 complete (blocker fixed, agentic rail dark-by-default with a shadow posture, the two capability highs fixed, the anti-fabrication gates closed). **Prod hot-fixes (Wave 0)** proceed in parallel and are not gated by #377.

Totals: **1 blocker, 7 high, 27 medium, 24 low, 9 nit** + **2 failing gates** (prettier, migration index-name drift) + **1 gate warning** (GroundedJson curly-quote hole) + **documentation-honesty gaps** (plan exit tables overstate completion of data-blocked deferrals).

---

## 2. Engineering guardrails (govern every step)

- **G1 — Minimal deterministic fix first.** Prefer the smallest change that restores correctness (e.g. reorder a branch, fix a comparison) over a redesign. Redesign only where the audit proved the minimal fix insufficient.
- **G2 — Every fix ships with a regression pin.** Each step adds/edits a test that **fails on current HEAD and passes after the fix**. No fix lands on assertion alone.
- **G3 — One source of truth.** Duplicated logic that diverged (chair-title sets, DEFAULT_TRIGGERS, district-code normalization, status-rank knowledge) is consolidated into `@capiro/shared` — never re-copied (R5).
- **G4 — New capability ships dark.** The agentic writer defaults OFF/shadow by a **code-level default**, so posture holds regardless of which deploy rail creates the schedule (R7).
- **G5 — Determinism stays deterministic; AI stays grounded.** No fix may move a canonical value (status/deadline/district/vote/dedup) under an LLM (R3); no AI output may reach a client surface without evidence + validation, with unsupported claims _dropped, not logged_ (R4).
- **G6 — Prod hot-fixes are separated from the feature PR** and re-verified against live data (re-derive/backfill where a fix changes historical rows).
- **G7 — Formatting is the last mechanical step** on each branch (single explicit-file-list `prettier --write` pass), to avoid the known full-file-reformat hazard churning unrelated lines.
- **G8 — Cross-realm writes stay safe-by-construction:** deep jsonb merge (never clobber sibling keys), explicit `tenant_id` bind under `withSystem`, `::text` casts, `ON CONFLICT` predicate matching a real partial index, and deploy ordering enforced by the default-OFF gate (R9/R10).

---

## 3. Delivery waves

Effort key: **S** < 0.5d · **M** 0.5–2d · **L** > 2d. Each step lists **findings resolved → design → logic → files → tests → success criteria → risks → deps → rollback → effort**.

### WAVE 0 — Phase-0 PROD hot-fixes

**Goal:** stop live prod output corruption.
**Branch & deploy:** new branch off `main` (e.g. `fix/state-phase0-hotfix`). Ship as **1–2 PRs** split by risk (0a critical/data-mutating, 0b lower-risk). Deploy via `scripts/deploy-dev.sh` (migrate → roll api → roll web) + separate intel-api migrate+roll. Verify ECR `:latest` carries the merge SHA before rolling (memory `infra_image_tag_race`).
**Entry criteria:** none (independent of #377).
**Exit criteria:** all Wave-0 regression pins green; post-deploy SQL reconciliation queries (below) pass; zero new `ExceptionsHandler`/Prisma errors in `/capiro/dev/api` for 30 min.

#### W0.1 — Canonical state status: fix `failed`/`passed` inversion (+ verb hardening & spec) · HIGH · M

- **Findings:** "failedChamber precedence inverted"; "derive-state-bill-status.spec.ts missing"; "derive verb loads whole corpus unbatched"; "carryover self-heal has no reversal test"; (decision-gated) "S3.2 override-motion set not implemented".
- **Design (defense-in-depth, R3):**
  - **Layer 1 (source of truth)** in `apps/api/scripts/derive-state-bill-status.ts`: replace the two independent chronology-blind sets with a per-bill **most-recent passage roll-call outcome**. Build one map `billKey → latest passage vote (by date)`; a bill is `passedChamber` iff its latest passage-type vote passed, `failedChamber` iff its latest passed=false. A reconsidered-then-passed bill then has `passedChamber=true, failedChamber=false`.
  - **Layer 2 (shared engine)** in `packages/shared/src/index.ts` `deriveStateBillStatus`: move the `input.failedChamber` term OUT of the step-4 hard-terminal branch to a branch **after** the step-8 `passedChamber`/`legiscanStatus===2` check, matching the federal `deriveBillStatus` precedent and the plan's step-7-before-8 ordering. Keep `legiscanStatus===6` and `progress event 11` as terminal (those are authoritative coded facts); only the roll-call-derived boolean is reordered.
  - **Verb hardening:** page the `state_bill` scan with a Prisma cursor (~5k/batch); keep the vote-outcome map and sine-die map materialized once before the loop.
- **Logic:** `passedChamber(bill) = latestPassageVote(bill)?.passed === true`; `failedChamber(bill) = latestPassageVote(bill)?.passed === false`; derivation order = enacted → overridden → vetoed → (coded failed: status 6 / progress 11) → to_governor → dead_by_deadline → resolving → **passed_chamber (incl. reconsidered)** → **roll-call-failed** → reported → text ladder.
- **Files:** `apps/api/scripts/derive-state-bill-status.ts` (set-building, batching, export pure helpers `buildPassageOutcomeSets`, `sineDieKey`); `packages/shared/src/index.ts` (branch reorder); new `apps/api/scripts/derive-state-bill-status.spec.ts`; `packages/shared/.../state-bill-status.spec.ts` (add reversal + reorder cases).
- **Tests:** both-sets/reconsidered case → `passed_chamber`; `legiscanStatus=6` still → `failed`; `progress 11` still → `failed`; carryover reversal (dead_by_deadline input with null/future sine-die re-derives live); batching idempotency (2nd run 0 updates). All must fail on HEAD, pass after.
- **Success criteria:** (1) reconsidered bill derives `passed_chamber` (rank 4) and `computeStateDeadlineRisk` returns non-null for it; (2) coded-failed inputs unchanged; (3) `derive-state-bill-status.spec.ts` exists, discovered by jest, green; (4) peak memory bounded by one batch; verb completes < 5 min (S3-C) on the TX corpus; (5) **post-deploy backfill:** run `derive-state-bill-status --commit`; SQL check `SELECT count(*) FROM state_bill WHERE status='failed'` drops by the number of reconsidered bills, and no bill with a later passing vote remains `failed`.
- **Risks:** re-derive rewrites historical rows → run in a low-traffic window; confirm `emit-state-changes` won't fan a spike of alerts from the correction (tie to W0.3 catch-up decision **D-1**).
- **Deps:** rebuild `@capiro/shared` before apps/api typecheck (worktree gotcha). **D-3** (override set) may add a small parallel set here.
- **Rollback:** revert the branch; re-derive is idempotent so a re-run restores prior values from source.

#### W0.2 — State alert double-emit + veto mislabel · HIGH · M

- **Finding:** "State bills double-emit alerts (coded + action-text) and mislabel a veto as 'Failed / rejected'".
- **Design:** restore the federal mutual-exclusivity invariant on the **state** rail only (do not touch the federal loop at `bill-change-detector.service.ts:220`, R5). When `classifyStateStatusChange(status)` produces a coded event for a transition, suppress the parallel `classifyChange(actionText)` event for the same trigger bucket (drop the colliding `triggerKey`, mirroring how federal `classifyStatusChange` returns null for enacted/failed/passed).
- **Logic:** per state transition, compute coded event first; if present, exclude the action-text classifier's output for that `triggerKey` before `dedupeByChangeType`.
- **Files:** `apps/intel-api/src/tracker/bill-change-detector.service.ts` (`runStateDetectionCycle` only); possibly `change-detector.util.ts`.
- **Tests:** veto/enactment/passage/reported → exactly one `intel_alert` row for the trigger bucket, `changeType` = coded `state_bill_*`, label not "Failed / rejected" for a veto.
- **Success criteria:** (1) for any single state transition, `sum(byType for that triggerKey) === 1`; (2) surviving row is the coded value with a correct label; (3) federal rail byte-identical (regression pin).
- **Risks:** already-persisted duplicate rows in prod remain until cleaned → **D-2** (one-time `dedupe-state-action-alerts` cleanup verb, run _after_ the code fix deploys).
- **Deps:** coordinate with W2.1 (same `writeShadowAlert`/emit loop). **Prod:** intel-api migrate+roll.
- **Rollback:** revert; no schema change.

#### W0.3 — `emit-state-changes` windows on ingestion time, not legislative date · HIGH · M

- **Finding:** "windows on `status_at` (legislative @db.Date) not ingestion time — most transitions never reach the changes inbox".
- **Design:** add a dedicated ingestion-time anchor `status_derived_at` (timestamptz) on `state_bill`, set by the deriver at the moment it writes a status change; window `emit-state-changes` on `status_derived_at > since` instead of `status_at`. Keep the existing status-date `dedupeKey` for idempotency. (Rationale for not reusing `synced_at`: `synced_at` bumps on every sync even when status is unchanged, which would re-emit; `status_derived_at` bumps only on real status change.)
- **Logic:** deriver, on a status change, sets `status_derived_at = now()`; emit selects `WHERE status_derived_at > since` where `since` = last successful emit `startedAt`; dedupeKey unchanged so a re-emit within the window is a no-op.
- **Files:** new migration (add `status_derived_at` + index) on `apps/api`; `derive-state-bill-status.ts` (write the column — merge with W0.1); `emit-state-changes.ts` (window column).
- **Tests:** a transition whose `status_at` predates the last emit run but whose `status_derived_at` is in the current window emits exactly one `intelligence_change`; re-run emits 0.
- **Success criteria:** (1) backdated/late-synced transition surfaces once; (2) post-deploy SQL: `COUNT(state_bill WHERE status_derived_at IS NULL AND status != 'introduced')` = 0 after the backfill; (3) second emit tick over unchanged data writes 0 rows.
- **Risks:** **D-1** — one-time catch-up: after deploy, a backfill of `status_derived_at` for existing rows could flood the Needs-Attention inbox on the first emit. Decision on catch-up semantics (backfill to `status_at` and suppress emit for pre-deploy rows, vs. emit them) required.
- **Deps:** migration before code roll (deploy-dev.sh order enforces this); deriver writes column before emit reads it.
- **Rollback:** revert code; column is additive and harmless if unused.

#### W0.4 — LegiScan: failed `getRollCall` must not advance `change_hash` · MEDIUM · S

- **Finding:** "a failed getRollCall silently loses the vote permanently — the drain advances change_hash even when a child fetch failed".
- **Design:** make the per-bill hash advance conditional on a fully successful child drain (matching the getBill-null precedent already in the file). Introduce a per-bill `childFailed` flag; on any `getRollCall` throw set it true and do **not** write the bill's `billHashes[id] = change_hash`, leaving the bill in `pendingBills` for retry.
- **Files:** `apps/api/scripts/sync-legiscan-bills.ts` (drain loop).
- **Tests:** a run where a `getRollCall` throws leaves `billHashes[bill] != masterlist change_hash` and the bill re-appears in `pendingBills`; `error_count` in the emitted metric > 0.
- **Success criteria:** partial-failure run is fully re-tried next run; no vote permanently lost; idempotent on success.
- **Deps:** same file as W0.5 quota fix — land together. **Prod** (Phase-0 spine).
- **Rollback:** revert.

#### W0.5 — LegiScan quota accounting & governance · MEDIUM (accounting) + LOW×2 · M

- **Findings:** "backfill self-accounting over-attributes queries + no month reset"; "quota governance incomplete (single pre-loop check)"; "no guard that a session was dataset-backfilled before masterlist diffs it".
- **Design:** (a) attribute per-session query cost accurately (per-session cost = 1 `getDataset`; state-level `getSessionList`/`getDatasetList` counted once, not per session) and gate the update-path increment on a `sameMonth` check mirroring the sibling scripts; (b) one shared quota governor helper exposing budget/hard-cap constants + async `monthToDateQueries(prisma)`, consulted by `sync-legiscan-bills`, `sync-legiscan-masterlist`, and `backfill-legiscan-datasets` — including an in-loop re-check so a single run can't overshoot; (c) detect an un-primed session cursor (absent, or empty `billHashes` while masterlist returns many bills) and skip the diff with a loud structured warning instead of draining bill-by-bill.
- **Files:** `apps/api/scripts/backfill-legiscan-datasets.ts`, `sync-legiscan-masterlist.ts`, `sync-legiscan-bills.ts`, new `apps/api/src/ingestion/legiscan-governor.util.ts`.
- **Tests:** month-to-date near budget → single run cannot exceed 30k hard cap (governor break fires); un-primed large session queues 0 bills + emits warning; primed session queues exactly its changed bills; backfill `queriesUsed` sum equals actual call count; prior-month cursor resets.
- **Success criteria:** quota never exceeds the 30k hard cap in a simulated near-budget month; accounting sum == actual calls; un-primed sessions never bill-by-bill drain.
- **Deps:** W0.4 (same drain loop); accurate accounting is a precondition for the governor. **Prod.**
- **Rollback:** revert.

#### W0.6 — Quota governor + LegiScan client/dataset unit tests (S1-D) · MEDIUM · L

- **Findings:** "quota governor has no unit test (S1-D)"; "client + dataset parser untested".
- **Design:** extract the governor decision into a pure `governorDecision(...)` and cover the `INGESTION_SKIP` boundary at `usedThisMonth >= LEGISCAN_MONTHLY_BUDGET`; add `legiscan.client.spec.ts` (envelope-status handling, `getMasterListRaw` session-key shaping) and `legiscan-dataset.util.spec.ts` (dataset parse).
- **Files:** new `legiscan-governor.util.ts` (+ from W0.5), `legiscan.client.spec.ts`, `legiscan-dataset.util.spec.ts`.
- **Success criteria:** S1-D "unit test on the governor" satisfied; client + dataset parser have coverage; all src-located so they run under the worktree jest workaround.
- **Deps:** W0.5 (governor extraction). **Prod.**

#### W0.7 — Phase-0 client-facing correctness (deployed) · MEDIUM×2 + NIT · S each

- **Findings:** state-bill drawer "Abstract" dead (`description` vs `abstract`); `search_state_floor_votes` returns unrelated votes on unresolved billId; Data Explorer "via OpenStates" label.
- **Design:** (a) in `explorer.service.ts stateBillDetail` map `abstract: b.description ?? null` (reconcile toward the web/DTO/schema contract that already expects `abstract`); (b) in `meri-tools.service.ts searchStateFloorVotes`, when `rawBillId` supplied but `resolveStateBillKey().key===null`, short-circuit with `votesFound:0` + the resolver note (mirror `getStateBillStatus`); (c) relabel the State Bills source card "via LegiScan".
- **Files:** `apps/api/src/explorer/explorer.service.ts`, `apps/api/src/meri/meri-tools.service.ts`, `apps/web/src/pages/explorer/DataExplorerPage.tsx`.
- **Success criteria:** Abstract renders in Explorer + Radar drawers for a bill with a description; unresolvable billId → `votesFound:0` + note, zero unrelated votes; label reads LegiScan.
- **Deps:** none. **Prod** (api + web roll).

---

### WAVE 1 — Phase-1 merge blockers (dark-safe)

**Goal:** make PR #377 correct and safe to merge with the agentic rail **dark by default**.
**Branch & deploy:** commits on `dev/state-legislation-phase1`.
**Entry:** Wave 0 in flight (not blocking).
**Exit:** blocker fixed + static SQL-table gate green; worker default-OFF proven by SQL count (zero cross-realm writes on a scheduled run); cross-realm write safety proven.

#### W1.1 — BLOCKER: `client_facility` → `client_facilities` + raw-SQL safety net · BLOCKER · M

- **Findings:** the two deduped blocker entries.
- **Design:** (A) rename the relation in the `findQualifyingAlerts` SQL (`run-intel-workflows.ts:109`) and fix the two comment refs (:93,:106). (B) durable net: guard the auto-run with `if (require.main === module)`; export the three raw-SQL statements as named consts + export `findQualifyingAlerts`/`surfaceBrief`; add a **DB-free static spec** that extracts every `FROM/JOIN/INTO/UPDATE` identifier from those consts and asserts each ∈ the union of `@@map` table-name sets from **both** `apps/api` and `apps/intel-api` schema.prisma (the union is mandatory — this file legitimately touches intel-owned `intel_alert`/`intel_action_item`).
- **Logic:** `referencedTables ⊆ (apiMappedTables ∪ intelMappedTables)`; fails listing `client_facility` on HEAD.
- **Files:** `apps/api/scripts/run-intel-workflows.ts`; new `apps/api/scripts/run-intel-workflows.spec.ts`; (decision-gated) `.github/workflows/ci-pr.yml`.
- **Tests:** static check red on `client_facility`, green after; whitelists `intel_alert`/`intel_action_item`; importing the module boots no Nest/DB.
- **Success criteria:** dry-run and `--commit` both complete without 42P01; static spec passes HEAD-fixed / fails HEAD-broken; a manual seeded dry-run prints `INTEL_WORKFLOWS_DRYRUN {...}` with a non-error count.
- **Risks:** static regex misses an exotic SQL shape → keep statements simple, one table per keyword. **D-4** (add a Postgres-service integration test in CI) is the stronger variant.
- **Deps:** none; must precede W1.2/W3 (worker must run to soak).
- **Rollback:** revert (worker is dark until W1.2 anyway).

#### W1.2 — Agentic writer: kill-switch env + shadow posture + rule dark-by-default + SyncRun wrap · HIGH · M

- **Findings:** "ships enabled+--commit, no kill-switch, no shadow"; "stale LIVE-DRIFT WARNING"; "not wrapped in runWithSyncRun"; "priority/wide masterlist share one SyncRun source".
- **Design:** three-posture model with a **code-level default of dark**: (1) add `--shadow` posture that runs `generate(...)` and writes `ai_run` but **skips `surfaceBrief`**; (2) gate surfacing behind `INTEL_WORKFLOWS_TARGETING_ENABLED` (default OFF) checked in code before any cross-realm write, so posture holds regardless of the deploy rail; (3) create the EventBridge rule `enabled:false`; (4) wrap the body in `runWithSyncRun(prisma,'run-intel-workflows',fn,{skipIfRunning:true})`; (5) give the priority vs wide masterlist schedules **distinct** SyncRun sources.
- **Logic:** posture = `commit && INTEL_WORKFLOWS_TARGETING_ENABLED ? attach : (commit || shadow ? shadow : dry)`; attach is the only posture that writes intel-owned tables.
- **Files:** `apps/api/scripts/run-intel-workflows.ts`; `infra/cdk/lib/ingestion-schedule.ts` (rule `enabled:false`, comment rewrite); `infra/cdk/lib/constructs/scheduled-ingestion-jobs.ts`; `sync-legiscan-masterlist.ts` (source-label arg).
- **Tests:** no env + shipped matrix → shadow (ai_run written, 0 `intel_alert`/`intel_action_item` writes, SQL count verified); `INTEL_WORKFLOWS_TARGETING_ENABLED=1` + `--commit` → attach; concurrent invocation within TTL logs `INGESTION_SKIP`; two distinct SyncRun sources present.
- **Success criteria:** (1) default deployed state performs zero cross-realm writes; (2) one `sync_run` row per worker run; (3) enabling the flag surfaces briefs; (4) matrix comment no longer claims the schedule is un-consumed.
- **Risks:** **D-5** — how the env flag reaches the task without a drift-prone `cdk deploy Compute` (out-of-band task-def edit, per `infra_cdk_taskdef_drift`); **D-6** — whether `enabled:false` requires a Compute deploy or an out-of-band rule edit.
- **Deps:** W1.1 (worker must query successfully to produce a SuccessRun). Coordinate with W2.3 (ai_run dedup) so shadow soak doesn't re-bill.
- **Rollback:** flag OFF is the safe state; revert removes the schedule.

#### W1.3 — Cross-realm write safety: deep jsonb merge + ON CONFLICT deploy sequencing · MEDIUM×2 · S

- **Findings:** "shallow jsonb merge clobbers sibling `evidence.enrichment` keys"; "ON CONFLICT index created by intel-api, consumed by apps/api worker, no deploy sequencing".
- **Design:** (a) replace the top-level `evidence || $1` with a sub-key deep merge using the repo's `jsonb_set` over `COALESCE`'d parent pattern (as in `client-pr...` precedent), writing only `enrichment.targetingBrief` and preserving `enrichment.impact` (Tier-1 W-D) and siblings; (b) make the intel-api migration re-runnable (`DROP INDEX IF EXISTS`) and document the ordering invariant: the intel-api widened partial-unique index MUST be deployed before the apps/api worker is enabled — structurally enforced by W1.2's default-OFF.
- **Files:** `apps/api/scripts/run-intel-workflows.ts` (`surfaceBrief`); `apps/intel-api/prisma/migrations/20260710050000_intel_action_item_targeting_brief/migration.sql`.
- **Tests:** Tier-1 impact write followed by a worker write against the same alert → both `enrichment.impact` and `enrichment.targetingBrief` present (spec fails on old `||`); with the widened index absent, a `--commit` run makes 0 Anthropic calls, writes 0 rows, and pages via `error_count`.
- **Success criteria:** zero enrichment sub-key loss; INSERT succeeds with the index; re-run upserts (no duplicate).
- **Deps:** W1.2 (default-OFF is the ordering enforcement). Same `surfaceBrief` — land both edits together.
- **Rollback:** revert; migration is on the unmerged branch (never applied to prod).

---

### WAVE 2 — Phase-1 capability highs

**Goal:** the M2/M1/M5 headline capabilities actually work.
**Branch & deploy:** `dev/state-legislation-phase1`.
**Exit:** each capability's headline success criterion (below) test-verified.

#### W2.1 — Deadline dedup per-cutoff + DEFAULT_TRIGGERS reconcile + companion backfill · HIGH + LOW + MEDIUM · M

- **Findings:** "deadline dedup keyed on constant changeType suppresses <3d warning / collapses cutoffs"; "`deadline` missing from apps/api DEFAULT_TRIGGERS (lists diverged)"; "backfillDefaultTriggers re-adds 'companion', overriding opt-outs".
- **Design:** (a) add the cutoff identity to the dedup dimension while keeping `changeType` stable — give `writeShadowAlert` an optional `dedupEvidenceKey` (e.g. `cutoffType`), folded into the 14-day `findFirst` WHERE, so a distinct cutoff fires once per `(bill, cutoffType, 14d)` while a repeat on the same cutoff dedups (preserves the intended fire-once-per-window-per-cutoff of M2-C — the refuted "escalation" reading is respected: we do **not** add an escalating series, we separate distinct cutoffs); (b) add `fiscalNote`,`sponsorMomentum`,`deadline` to apps/api `DEFAULT_TRIGGERS` so the two lists are an identical set + add a test that fails on divergence; (c) drop `companion` from `NEWLY_DEFAULT_ON` (its "no prior emitter → no opt-out" premise is false post-Phase-0).
- **Files:** `apps/intel-api/src/tracker/bill-change-detector.service.ts`, `change-detector.util.ts`, `apps/api/src/tracker/tracker.types.ts`, `apps/intel-api/src/intel-alert/intel-alert.service.ts`.
- **Tests:** committeeCutoff→crossover fires once per cutoffType within 14d; same-cutoff repeat writes 0; DEFAULT_TRIGGERS sets equal (test-enforced); backfill no longer re-adds `companion` to an opt-out row; `deadline` still backfilled.
- **Success criteria:** the critical <3d cutoff warning is delivered even after an earlier info-tier cutoff alert; opt-outs survive backfill; the "kept in sync" invariant is test-true.
- **Risks:** **D-7** — whether pre-#374 subscribers need a _gated one-time_ `companion` seed (needs the Phase-0 `companion` emitter ship date).
- **Deps:** coordinate with W0.2 (same emit loop).

#### W2.2 — Representation resolver honors manual districts + shared district normalization + error states · HIGH + MEDIUM + LOW · M

- **Findings:** "resolver ignores manual districts (keys on geocodeStatus='matched')"; "district discrepancy compares raw strings (single-digit false flag)"; "DistrictNexusSection lacks error states".
- **Design:** (a) redefine _resolvable_ = has `state` AND (`geocodeStatus==='matched'` OR any of `congressionalDistrict`/`stateHouseDistrict`/`stateSenateDistrict` non-null); update the forward guard (:84) and all inverse joins (:144,:194) to not hard-filter on `geocodeStatus`; (b) extract a pure `normalizeDistrictCode` (zero-pad, at-large `00`↔NULL) into a shared dependency-free util used by BOTH the resolver and `facility-geocode.util` discrepancy check; (c) add `isError` branches to the nexus + representation queries so a fetch error shows an explicit failure, not the "unlinked"/empty state.
- **Files:** `apps/api/src/clients/representation-resolver.service.ts` (+ .spec that currently pins the wrong behavior), `apps/api/src/clients/facility-geocode.util.ts`, new `apps/api/src/clients/district-code.util.ts`, `apps/web/.../DistrictNexusSection.tsx`.
- **Tests:** manual-district facility (`districtSource='user'`, not matched) resolves state upper/lower legislators + appears in `facilitiesForMember`/`clientsRepresentedByMember` + chokepoint footprint; hand-typed CD equal to geocoded CD after normalization emits no discrepancy; a real wrong hand-entry still flags; one `normalizeDistrictCode` implementation (grep-clean); error state renders.
- **Success criteria:** M1.4/SC-5/M1-B manual fallback works end-to-end (member "represents" pill + chokepoint overlap include manual facilities); no false discrepancy warnings.
- **Deps:** create `district-code.util.ts` first; both consumers import it.

#### W2.3 — QA-held / zero-target brief idempotency · HIGH · M

- **Finding:** "QA-held and zero-target briefs regenerate every run (BYOK spend + ai_run churn + cap starvation)".
- **Design:** add a second idempotency guard to `findQualifyingAlerts`, parallel to the existing action-item `NOT EXISTS`: exclude any alert whose bill already has a **recent** `ai_run` of `workflow='intel_targeting'` (regardless of qaStatus), so held/zero-target briefs are not regenerated until inputs change or a human clears QA. Define "recent" relative to the 48h lookback (recommend: within lookback window).
- **Files:** `apps/api/scripts/run-intel-workflows.ts` (`findQualifyingAlerts`); persist per-gate drop counts on `ai_run` (shared with W3.1) so the guard + provenance align.
- **Tests:** over N runs in the window, `ai_run` rows for a held key increase by exactly 1 (was N); `ai_usage_events` for `intel_targeting` increase by exactly 1; new alerts are not starved by held ones under `LIMIT 25`.
- **Success criteria:** at-most-once generation per `(bill, client, tenant)` within the dedup window; no repeated BYOK spend.
- **Deps:** W1.1 (same function); batch the SQL edits with W1.1/W1.2. Note: keying on a non-existent `ai_run.alert_id` column is wrong — key on `subjectKey`=billKey + tenant.

---

### WAVE 3 — M5 anti-fabrication integrity (MUST precede any schedule enable)

**Goal:** guarantee no fabricated/off-roster/ungrounded AI content can reach the client-facing feed (R3/R4). This wave is the precondition for ever flipping `INTEL_WORKFLOWS_TARGETING_ENABLED` on.
**Branch & deploy:** `dev/state-legislation-phase1` (except the federal alert-memo portion of W3.3 — see **D-9**).
**Exit:** every adversarial (seeded-fabrication) pin green; `ai_run` inspection shows all drop layers.

#### W3.1 — Roster-membership gate + recommendedSequence filter + confidence/drop provenance · MEDIUM×3 · M

- **Findings:** "off-roster real member passes both gates (M5-B false)"; "recommendedSequence bypasses both gates, surfaced unfiltered"; "ai_run confidence ignores validator drops; drop counts not persisted".
- **Design:** (a) add a deterministic **roster-membership gate** as a third code-only drop layer running before the validator: drop any target whose `memberId` is not a key of the resolved chokepoint roster (`memberById.has`); (b) filter `recommendedSequence` to only reference surviving/validated member ids/names (design choice **D-8**: strong schema-bound refs vs post-filter of free text); (c) compute confidence as `kept / (kept + groundingDrops + validatorDrops + offRosterDrops)` and persist per-gate drop counts to `ai_run` (column or `output.drops`).
- **Files:** `apps/api/src/agentic/targeting-brief.service.ts`; `apps/api/prisma/schema.prisma` + migration if drop counts become columns.
- **Tests:** off-roster target dropped 100% before `surfaceBrief` (PINNED, fails HEAD); no dropped member id/name appears in `recommendedSequence` written to `ai_run.output` or `evidence.enrichment` (PINNED); a gutted brief records confidence < 1.0 and per-gate drop counts inspectable from the row.
- **Success criteria:** M5-B is true — every surfaced target's membership + role + district is validator-confirmed AND on the roster; "dropped and logged" verifiable from `ai_run` alone.
- **Deps:** land drop-count plumbing with W2.3. **Must precede schedule enable (R7).**

#### W3.2 — GroundedJson curly-quote gate + removeClaims contract · MEDIUM + LOW · S

- **Findings:** "citation-gate quote extractor misses curly/smart quotes (dead 3rd regex alt)"; "removeClaims optional in type but required in contract".
- **Design:** (a) normalize typographic quotes (U+201C/D, U+2018/19) to ASCII in BOTH claim text and evidence before the `.includes` check (and drop the dead third regex alternative); (b) close the removeClaims gap — recommend type-modeling `extractClaims`+`removeClaims` as one optional sub-object so it's compile-time impossible to supply one without the other (**D-10**: type redesign vs runtime fail-safe).
- **Files:** `packages/meriv2-core/src/grounding/grounded-json.ts` (+ .spec).
- **Tests:** a fabricated U+201C…U+201D quotation is dropped by `checkGroundedCitations` (fails HEAD); straight-quote fixtures unchanged (20-suite green); the removeClaims omission is impossible/fail-safe.
- **Success criteria:** no fabricated smart-quoted claim survives; dead regex removed; no behavior change for the sole caller.
- **Deps:** batch both meriv2-core edits into one package build/publish.

#### W3.3 — Zero-citation paragraphs must not be filed (district-brief + alert-memo) · MEDIUM · S

- **Finding:** "grounding gate vacuously passes zero-citation paragraphs — ungrounded prose emitted into client-facing memos" (duplicated byte-identically in two services).
- **Design:** require a non-empty, fully-valid citation set to keep a paragraph — change the predicate in both `verifyGrounded` copies to `p.claimIds.length > 0 && p.claimIds.every(id => valid.has(id))`; a fully-uncited generation downgrades to the deterministic scaffold with `lowConfidence=true` (not filed as high-confidence).
- **Files:** `apps/api/src/intelligence/alert-memo/district-brief.service.ts`, `apps/api/src/intelligence/alert-memo/alert-memo.service.ts` (+ specs).
- **Tests:** a zero-citation paragraph is never emitted in either service; a fully-uncited generation downgrades to scaffold; federal alert-memo regression pin.
- **Success criteria:** no ungrounded prose in a filed brief/memo.
- **Risks:** **D-9** — `alert-memo.service` is **pre-existing prod (federal)** behavior; fixing it changes federal memo output. Decide whether that rides Wave 0 (prod hot-fix) or Wave 3 (with #377). `district-brief.service` is Phase-1 (branch).

---

### WAVE 4 — Mediums (derivation, ingestion, observability, web, meri)

**Branch & deploy:** mostly `dev/state-legislation-phase1`; W4.3 (`sync-run.helper`) and any deployed-code touch ride a Phase-0 hot-fix.

#### W4.1 — Shared committee/roster role matcher + leadership chamber fix · LOW(umbrella)+MEDIUM×2+NIT×2 · M

- **Findings:** chair/vice-chair titles too strict + duplicated 4 sites; state chair regex misses OpenStates variants; chamberLeadership from wrong chamber; FEDERAL*ROSTER*\* duplicated; chokepoint re-implements rank knowledge.
- **Design:** one shared pure `matchesRole`/`normalizeRoleTitle` in `@capiro/shared` (Chair/Chairman/Chairwoman/Co-Chair/Vice\*/Ranking) consumed by chokepoint + `get_committee_roster` (both rails); add a **chamber predicate** to the state `leadershipCommittees` query (Rules/Calendar committee used only if same chamber as the bill; `length===1` guard within the chamber-filtered set; null when chamber can't be normalized — never guess); export a shared federal rank accessor and have `federalCommitteeAdvancement` compare against the `reported` rank rather than a hardcoded string set.
- **Files:** `packages/shared/src/index.ts` (matcher + rank accessor), `apps/api/src/intelligence/chokepoint/chokepoint.service.ts`, `apps/api/src/meri/meri-tools.service.ts`.
- **Tests:** Chairwoman/Co-Chair resolves as chair (both tools return the SAME chair for the same committee); no cross-chamber leadership attribution (asymmetric-naming fixture); adding a pre-`reported` status auto-updates advancement with no edit; grep-clean of hardcoded title sets.
- **Success criteria:** single source of truth for role titles + rank; state roster no longer reports `chair:null` when a chair exists.

#### W4.2 — Ingestion watermark correctness: FL register `<=` + geocode change_hash · MEDIUM×2 · M

- **Findings:** "FL register watermark `<=` drops same-day notices"; "geocode watermark ineffective (matched rows re-geocode; address-less starve)".
- **Design:** (a) change the FL skip from `<=` to `<` so the boundary date is re-fetched and de-duplicated by the id-keyed upsert (federal inclusive-refetch pattern); (b) replace the `updated_at/geocoded_at` race with a deterministic `geocode_input_hash` column on `client_facilities` — geocode only when the hash of the normalized address differs, prioritize never-tried rows; **D-11**: confirm `client_facilities` is empty in prod (if so, no backfill needed).
- **Files:** `apps/api/scripts/sync-state-register.ts`, `apps/api/scripts/geocode-facilities.ts`, migration (add `geocode_input_hash`).
- **Tests:** same-day boundary notice ingested once (no dup); two runs over unchanged data → 0 geocode calls on the 2nd; an address edit beyond the old BATCH_CAP position is re-geocoded.
- **Success criteria:** no dropped same-day notices; geocode is idempotent + change-driven.
- **Deps:** interacts with W2.2 (resolver reads geocode output).

#### W4.3 — Observability: pageable failures on the bootstrap & wrapper paths (M5-G) · MEDIUM + LOW · S

- **Findings:** "bootstrap-time failures emit no error_count (won't page)"; "runWithSyncRun setup-phase failures emit no metric".
- **Design:** guarantee exactly one `INGESTION_METRIC {error_count>=1}` line on the bootstrap path of `run-intel-workflows` (declare `app` before the try, emit the metric in an outer finally even if `loadNest`/`NestFactory` throw); harden `runWithSyncRun` so a failure in the pre-try setup (skipIfRunning query / watermark read / SyncRun create) also emits one error metric and rethrows.
- **Files:** `apps/api/scripts/run-intel-workflows.ts`, `apps/api/src/ingestion/sync-run.helper.ts` (shared — **prod**).
- **Tests:** simulated `loadNest`/NestFactory throw → exactly one CloudWatch-parseable `error_count>=1` line, process exits nonzero; a rejected setup query → same; no change to success/skip/in-fn-error paths (byte-identical output).
- **Success criteria:** any silent agent/wrapper failure pages via the existing `IngestionErrorMetricFilter`.
- **Deps:** `sync-run.helper` change benefits the whole fleet — ride a Phase-0 hot-fix.

#### W4.4 — Web correctness: ChokepointSection error state + composer error + regulation memo chip · MEDIUM + NIT + LOW · S

- **Findings:** ChokepointSection no error state; DistrictBriefComposerDrawer generic axios error; regulation "Draft client memo" maps to bill-shaped memo.
- **Design:** add `isError` branch to `ChokepointSection` (visible "unavailable" notice); extract `errorMessage()` into a shared web util used by the composer + FacilitiesEditor (surface server 404/503 message); **D-12** on the regulation memo chip (exclude regulation from `canMemo` vs build a real rule-shaped memo).
- **Files:** `apps/web/.../ChokepointSection.tsx`, `DistrictBriefComposerDrawer.tsx`, `apps/intel-api/.../recommended-actions.util.ts`.
- **Success criteria:** error ≠ empty on both sections; real server message shown; regulation chip behavior consistent + no bill-shaped memo with null fields.

#### W4.5 — Meri state_rule surface correctness · MEDIUM + LOW×2 + NIT · M

- **Findings:** on-demand comment-deadline readers not extended to state_rule (M3.4/M3-D); relevance matches title only; isOpen only at 'nprm'; exact-id lookup ignores state.
- **Design:** extend `getCommentPeriodAlerts` (and the criticalDeadlines reader) to also scan `state_rule` **without `withTenant`** (global public table, R1) mirroring `check-comment-periods.ts`; include `abstract` in the keyword haystack (match the header); derive `commentPeriod.isOpen` from the comment window gated to comment-accepting stages (not just `stage==='nprm'`); scope the exact-id `state_rule` lookup to `state` when provided.
- **Files:** `apps/api/src/intelligence/intelligence.service.ts`, `apps/api/scripts/check-comment-periods.ts`, `apps/api/src/meri/meri-tools.service.ts`.
- **Success criteria:** state rule with an open window + matching client appears as a `comment_deadline` chip; `criticalDeadlines` includes state rows (M3-D); notice-stage open windows reported open; cross-state id not returned when `state` set.
- **Deps:** land the reader extension + abstract fix together (single shared helper).

#### W4.6 — Catalog parity enforcement + tool-count/comment truth · MEDIUM + NIT + LOW · S

- **Findings:** byte-identical catalog contract unenforced (2 federal tools already drift); "60-tool surface" comment vs actual 63; stale district_brief comment.
- **Design:** reconcile the two drifted descriptions to apps/api `TOOL_DEFINITIONS` verbatim; add an automated **catalog-parity test** (a checked-in manifest or snapshot the orchestrator test asserts against, since apps/api isn't importable there — **D-13**); update count comments to 63; fix the stale comments.
- **Files:** `apps/meriv2-orchestrator/.../full-chat-read-tools.catalog.ts` (+ .spec), `delegated-tools.catalog.ts` (+ .spec), `apps/web/.../alert-actions-api.ts`.
- **Success criteria:** a CI test fails on any catalog description/name/count drift; comments accurate.

#### W4.7 — ORPHAN-1: untyped interval SQL cast · LOW · S

- **Finding:** `($1 * interval '1 hour')` untyped param in `rule-source-data.repository.ts` (novel form, untested vs real DB).
- **Design:** make the multiplication type-explicit at both sites (`$1::int * interval '1 hour'`).
- **Files:** `apps/intel-api/src/sourcedata/rule-source-data.repository.ts`.
- **Success criteria:** `detect-rule-changes` runs against prod Postgres with 0 `42883`; a CI test executes the actual interval SQL.

---

### WAVE 5 — Lows/nits, gates, documentation honesty

**Branch & deploy:** `dev/state-legislation-phase1` (+ a small Phase-0 hot-fix for the 4 deployed unformatted files). **W5.7 (prettier) is the last mechanical step on each branch.**

#### W5.1 — ai_run RLS: split FOR ALL into per-command policies · LOW · S

- **Finding:** "ai_run RLS USING lets any tenant DELETE/reassign global (null-tenant) rows".
- **Design:** replace the single `FOR ALL` policy with per-command policies: SELECT allows `tenant_id = current_tenant_id() OR tenant_id IS NULL` (global readable by all); INSERT/UPDATE/DELETE allow `rls_bypass() OR tenant_id = current_tenant_id()` (global writable only by system). New migration; coordinate with W5.2 (same file).
- **Success criteria:** under a tenant session, SELECT of a null-tenant row returns it; DELETE/UPDATE of a null-tenant row affects 0 rows; own-tenant rows unchanged.

#### W5.2 — Migration index-name drift (4 indexes) · LOW · S

- **Finding:** 3 `ai_run` + 1 `state_bill` index names diverge from Prisma-derived names.
- **Design:** make each recorded migration index name equal the Prisma-derived name (add `map:` on ai_run indexes to match `AiUsageEvent` convention; align `state_bill_currentCommitteeId_idx`). All 4 migrations are unmerged/unapplied → edit in place; no new migration file.
- **Success criteria:** `prisma migrate diff` (datamodel vs migrations) is empty; one stated naming convention.
- **Deps:** coordinate with W5.1 (both edit the ai_run migration).

#### W5.3 — Schema/doc vocabulary drift · NIT · S

- **Design:** comment-only — extend `ai_run.qaStatus` comment to include `pending`; add `targeting_brief` to `IntelActionItem` singleton-kind comments. No code change.
- **Success criteria:** comments list every value the code writes; `prisma validate` clean.

#### W5.4 — Deferral honesty: SC-6 re-scope + §9 exclude M5-D + deferral rationale · MEDIUM + LOW · S

- **Design:** amend both plan docs: re-scope the SC-6 row (the shipped `backtest-deadline-physics.ts` is a data-quality/directional signal, NOT a ≥90% predictive backtest — the latter is deferred pending point-in-time status snapshots); amend §9 to exclude M5-D (rules-comparison, data-blocked) from the Phase-1 exit gate; state each deferral's blocking data source at the SC level (not only in code comments).
- **Success criteria:** no exit gate marks SC-6 green on the backtest's strength; §9 no longer literally requires M5-D; deferrals visible at SC level.
- **Deps:** edit plan docs **before** W5.7 formats them.

#### W5.5 — sync-state-register default posture · NIT · S · **DECISION D-14**

- **Design:** resolve the FL-default-vs-off inconsistency between the script (`:37/:77` defaults to FL when `STATE_REGISTER_STATES` unset) and the CDK schedule's gating note — in ONE direction. Recommend aligning doc→code (FL is spike-verified, writes only the global feed) OR gating to require the env; must not be assumed (ops-facing).
- **Success criteria:** script default, header comment, and CDK description agree; no unintended change to what the daily rule ingests.

#### W5.6 — Evals: mechanism vs anti-fabrication · LOW · S/M · **DECISION D-15**

- **Design:** either reword M4-D/M4-E criteria to mechanism/determinism scope AND make the apps/api tool anti-fabrication spec a required check, OR add a real anti-fabrication eval case (get_state_rule_status isOpen/no-match) to the meriv2-evals gate.
- **Success criteria:** no success criterion claims anti-fabrication coverage that the eval doesn't exercise.

#### W5.7 — Prettier + CI enforcement · MEDIUM + LOW · S · **(LAST step per branch)**

- **Findings:** prettier FAIL (34 files, incl. 4 deployed Phase-0 files); CI doesn't enforce prettier on state-platform paths.
- **Design:** run `prettier --write` on the genuinely-unformatted files as an **explicit file list** (never a glob; `--end-of-line auto`) so no unrelated repo file is touched (G7); wire `prettier --check` into `ci-pr.yml` for apps/api, apps/intel-api, apps/web (+ docs); the 4 Phase-0 files are formatted on the Wave-0 hot-fix branch.
- **Success criteria:** `prettier --check` over all changed files exits 0; CI fails on any future unformatted state-platform file (proven by a deliberate-fail check); no unrelated pre-existing-debt file touched.
- **Deps:** runs **after** all other clusters' edits land (formatting churn otherwise conflicts).

---

## 4. Decision Register (must NOT be assumed — these steps are blocked until you decide)

| ID       | Decision                                                                                | Why it matters                                                                                         | Options                                                                                                                                               | Recommendation                                                                                       | Blocks           |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| **D-1**  | `emit-state-changes` one-time catch-up after adding `status_derived_at`                 | Backfilling the column then emitting could flood the Needs-Attention inbox with historical transitions | (a) backfill `status_derived_at = status_at` and suppress emit for pre-deploy rows; (b) emit all                                                      | **(a)** — suppress historical flood; only new transitions surface                                    | W0.3             |
| **D-2**  | One-time cleanup of already-persisted duplicate state alerts                            | Live prod has duplicate/mislabeled rows from the double-emit bug                                       | (a) `dedupe-state-action-alerts` cleanup verb run after the fix; (b) leave historical rows                                                            | **(a)** — run cleanup post-fix                                                                       | W0.2             |
| **D-3**  | Implement vote-derived override set (S3.2) vs amend plan                                | Plan claims a vote-derived override set that isn't built                                               | (a) build it — requires override roll-calls to exist in `state_roll_call_vote` (verify first); (b) amend plan to accept progress-7 + text as intended | Decide after verifying whether override motions exist in the data                                    | W0.1             |
| **D-4**  | Add a Postgres service to CI for raw-SQL integration tests                              | The blocker was raw SQL that no gate caught; a live-DB test is the strongest net                       | (a) DB-free static table-name check only; (b) add Postgres service + `migrate deploy` both schemas + execute the queries                              | **(a) now, (b) as a fast-follow** — static check ships immediately, DB service is a larger CI change | W1.1, W0.6, W4.7 |
| **D-5**  | How `INTEL_WORKFLOWS_TARGETING_ENABLED` reaches the task                                | `cdk deploy Compute` would drop out-of-band secrets/env (`infra_cdk_taskdef_drift`)                    | (a) out-of-band task-def env edit (jq recipe); (b) reconcile CDK first                                                                                | **(a)** — out-of-band, consistent with current practice                                              | W1.2             |
| **D-6**  | Does creating the rule `enabled:false` require a Compute deploy?                        | Same drift landmine                                                                                    | (a) out-of-band EventBridge rule edit; (b) Compute deploy                                                                                             | **(a)** if it touches Compute; confirm the schedule construct's deploy rail first                    | W1.2             |
| **D-7**  | Gated one-time `companion` backfill for pre-#374 subscribers?                           | Dropping `companion` from `NEWLY_DEFAULT_ON` may under-seed genuinely-new subscribers                  | (a) just drop it; (b) gate a one-time seed by the emitter ship date                                                                                   | **(a)** unless product wants companion on by default for pre-#374 subs                               | W2.1             |
| **D-8**  | `recommendedSequence` design                                                            | Free-text can leak dropped member names cross-realm                                                    | (a) STRONG: schema binds each step to a validated memberId; (b) post-filter the free text                                                             | **(a)** — structurally impossible to leak; slightly larger schema change                             | W3.1             |
| **D-9**  | Does the zero-citation fix to `alert-memo.service` ride Wave 0 (prod) or Wave 3 (#377)? | It's pre-existing federal prod behavior; the fix changes federal memo output                           | (a) Wave 0 hot-fix; (b) Wave 3 with #377                                                                                                              | **(a)** — it's a live grounding hole in a client-facing federal memo                                 | W3.3             |
| **D-10** | removeClaims contract enforcement                                                       | Optional-in-type but required-in-contract                                                              | (a) type redesign (compile-time); (b) runtime fail-safe                                                                                               | **(a)** — compile-time guarantee                                                                     | W3.2             |
| **D-11** | Is `client_facilities` empty in prod?                                                   | Determines whether `geocode_input_hash` needs a backfill                                               | Verify via a `diag-*` read-only task before the migration                                                                                             | Verify, don't assume                                                                                 | W4.2             |
| **D-12** | Regulation "Draft client memo" chip                                                     | Currently maps to a bill-shaped memo with null bill fields                                             | (a) exclude regulation from `canMemo`; (b) build a real rule-shaped memo                                                                              | **(a)** minimal now; (b) is a feature                                                                | W4.4             |
| **D-13** | Catalog-parity test mechanism                                                           | apps/api isn't importable from the orchestrator                                                        | (a) checked-in manifest asserted both sides; (b) snapshot test                                                                                        | **(a)** — single source both sides assert                                                            | W4.6             |
| **D-14** | `sync-state-register` default when `STATE_REGISTER_STATES` unset                        | Script defaults to FL; schedule note implies gated                                                     | (a) align doc→code (default FL); (b) require the env                                                                                                  | **(a)** — FL is spike-verified, global-feed only                                                     | W5.5             |
| **D-15** | Evals: reword criteria vs add anti-fabrication case                                     | M4-D/M4-E claim coverage the evals don't exercise                                                      | (a) reword + require the apps/api spec; (b) add a real eval case                                                                                      | **(b)** — genuine gate coverage                                                                      | W5.6             |

---

## 5. Risk Register

| Risk                                                                                     | Likelihood | Impact | Mitigation                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Prod re-derive (W0.1) rewrites many rows and fans a burst of correction alerts           | Med        | Med    | Run in a low-traffic window; resolve D-1 (suppress historical emit) first; re-derive is idempotent                                        |
| Agentic writer accidentally enabled before Wave 3 lands                                  | Low        | High   | Code-level default OFF (G4); schedule `enabled:false`; Wave-3 pins are the merge gate; SQL count proves zero cross-realm writes in shadow |
| `cdk deploy Compute` run to ship a schedule/flag drops out-of-band secrets               | Med        | High   | D-5/D-6 mandate out-of-band edits; never `cdk deploy Compute` (`infra_cdk_taskdef_drift`)                                                 |
| Prettier `--write` re-mangles already-clean files (session hazard)                       | Med        | Low    | Explicit file list only, `--end-of-line auto`, `git diff --stat` check after (G7)                                                         |
| Cross-realm jsonb deep-merge fights the Tier-1 W-D enrichment shape                      | Low        | Med    | W1.3 confirms the existing `enrichment` shape before merging; spec asserts both sub-keys survive                                          |
| Shared role-matcher / rank accessor change perturbs federal behavior                     | Low        | Med    | Regression pins on federal chair + advancement (G2/R5)                                                                                    |
| Adding `status_derived_at`/`geocode_input_hash` columns to deployed/near-deployed tables | Low        | Low    | Additive nullable columns; migrate-before-roll ordering; D-11 verifies empty table                                                        |

---

## 6. Rollout & verification — agentic writer ladder

The Tier-2 targeting-brief writer follows the agentic doc §8 ladder, enforced by the W1.2 kill-switch + W3 gates:

1. **Dark** (default on merge): schedule `enabled:false`, `INTEL_WORKFLOWS_TARGETING_ENABLED` unset. Zero runs. _Verify:_ no `sync_run` rows for the worker.
2. **Shadow** (after Wave 3 lands): enable the schedule but keep the flag OFF → worker runs in `--shadow`, writes `ai_run` provenance, performs **zero** cross-realm writes. _Verify (SQL, before/after a run):_ `ai_run` rows increase; `intel_action_item(kind='targeting_brief')` and `evidence.enrichment.targetingBrief` counts unchanged. Soak ≥ 1 week; inspect `ai_run` for drop counts + confidence (M5-B).
3. **Canary** (manual): flip `INTEL_WORKFLOWS_TARGETING_ENABLED=1` for ONE tenant (out-of-band env, D-5). _Verify:_ briefs surface for that tenant only; QA-held (`qaStatus='pending'`) briefs do **not** surface; idempotency (W2.3) holds (no re-billing across runs).
4. **Attach** (broad): enable per-tenant as QA agreement accrues, subject to the D-A4 unlock criteria in the agentic doc (≥0.85 human agreement, ≥100-alert corpus) if impact JSON is ever allowed to suppress alerts.

**Prod hot-fix verification (Wave 0):** after each hot-fix deploy — (a) the wave's regression pins are green in CI; (b) the SQL reconciliation queries in W0.1/W0.3 return the expected counts; (c) `aws logs filter-log-events` on `/capiro/dev/api` shows zero new `ExceptionsHandler`/Prisma errors for 30 min; (d) a manual spot-check of one affected bill/alert in the UI.

---

## 7. CI/CD changes

- Wire `prettier --check` into `ci-pr.yml` for `apps/api`, `apps/intel-api`, `apps/web` (+ docs) (W5.7).
- Add the run-intel-workflows static SQL-table-name spec to the apps/api test surface, and ensure apps/api tests actually gate PRs (today `verify` runs only meriv2-core/orchestrator/auth) (W1.1, D-4).
- Add the catalog-parity test to the orchestrator suite (W4.6).
- (D-4 fast-follow) optional Postgres service for raw-SQL integration tests (W1.1/W0.6/W4.7).
- Confirm `meriv2-evals.yml` path filters already include `meri-tools.service.ts` + `packages/shared/**` (they do, per Phase-1 work) so W5.6's eval change gates.

---

## 8. Deferrals & scope (legitimate — data-blocked, made honest)

These stay deferred; the only action is documentation honesty (W5.4):

- **Amendment-diff mode (Event Analyst):** no `state_bill_amendment` / version-diff data source.
- **Rules-comparison assist (M5.3 / M5-D):** no rule-revision history and no curated bill↔rule link (only fuzzy subject matching).
- **SC-6 ≥90% predictive backtest:** no point-in-time status snapshots; the shipped backtest is a data-quality/directional signal only.
- **Governor-EO ingestion, supplier/facility addresses, QA-clearing source-quality dashboard:** in-plan deferrals with real data-source justifications.

Local-government tracking remains out of scope (R8). OpenStates stays demoted to people/geo (R2).

---

## 9. Overall success definition ("all open items resolved")

1. **Zero surviving audit findings** at blocker/high/medium severity: every W-step's success criteria met, each with a regression pin that fails on the pre-fix state.
2. **Gates green:** `prettier --check` clean on all changed files + enforced in CI; `prisma migrate diff` empty (no index-name drift); apps/api / intel-api / orchestrator / meriv2-core typecheck + tests green.
3. **Phase-0 prod healthy:** post-hot-fix SQL reconciliations pass; no bill with a later passing vote labeled `failed`; state transitions reach the inbox; no permanent vote loss.
4. **Phase-1 (#377) merge-ready:** blocker fixed; agentic rail dark-by-default with a shadow posture proven by SQL; anti-fabrication gates (roster + grounding + validator + confidence provenance) adversarially test-verified (M5-B true).
5. **Agentic rollout:** worker soaked ≥1 week in shadow with clean `ai_run` provenance before any tenant is flipped to attach.
6. **Docs honest:** SC-6 re-scoped, §9 excludes M5-D, deferrals visible at SC level.
7. **Coverage:** every one of the 69 findings maps to a shipped step (see §10) — no orphans.

---

## 10. Coverage map (finding → wave)

- **Wave 0 (prod):** status inversion + spec + batching + carryover + (D-3 override); double-emit + (D-2 cleanup); emit-windowing + (D-1); getRollCall vote-loss; backfill accounting + quota governance + un-primed guard; quota/client/dataset specs; abstract field; search_state_floor_votes; OpenStates label; (D-9) federal alert-memo grounding.
- **Wave 1:** `client_facility` blocker + SQL safety net; agentic kill-switch/shadow/SyncRun/schedule sources; jsonb deep-merge + ON CONFLICT sequencing.
- **Wave 2:** deadline per-cutoff dedup + DEFAULT_TRIGGERS + companion backfill; representation manual districts + district-code util + nexus error states; QA-held idempotency.
- **Wave 3:** roster gate + recommendedSequence filter + confidence/drop provenance; curly-quote + removeClaims; zero-citation memos.
- **Wave 4:** shared role matcher + leadership chamber + rank reuse; FL watermark + geocode hash; bootstrap/wrapper metrics; ChokepointSection/composer/regulation-memo web; state_rule comment surface; catalog parity + counts; untyped interval cast.
- **Wave 5:** ai_run RLS split; index-name drift; vocab drift; SC-6/§9 doc honesty; sync-state-register default; evals scope; prettier + CI.

_No orphans:_ the coverage-backstop agent enumerated all 69 findings against C1–C18; the only additions beyond the ranked set were ORPHAN-1 (untyped interval SQL → W4.7) and the prettier/DEFAULT_TRIGGERS items, all placed above.
