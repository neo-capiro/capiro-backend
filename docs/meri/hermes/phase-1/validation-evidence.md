# Validation evidence — Phase 0/1 closeout

Every entry states the **command**, its **true exit code**, the **environment**, and the **revision** it ran against. Evidence classes are labelled distinctly and never conflated:

- **[UNIT]** — pure unit tests, no database.
- **[DB-INT]** — integration against the local fixture Postgres, real Prisma, real services, no HTTP boundary.
- **[APP-INT]** — the real application module graph including the authenticated route and Context Plane gateway.
- **[REAL-HERMES]** — a real turn executed by the pinned Hermes worker container.
- **[PLATFORM]** — real AWS/Fargate. **No entry in this class exists; see the closeout report's BLOCKED gates.**
- **[MOCK]** — AWS SDK or network mocked at the wire level.

Evidence files are stored under `evidence/` as `.txt`/`.json`. **`*.log` is gitignored in this repository**, so any log written with that extension would be silently untracked — all closeout logs use `.txt`.

## 1. Baseline at commit `493d3079c` (before closeout implementation)

Environment: Windows host, Node v24.19.0, local fixture Postgres `capiro` in docker container `capiro-postgres` (`pgvector/pgvector:pg16`), 408 migrations applied, `DATABASE_URL=postgresql://capiro:capiro@localhost:5432/capiro?schema=public`.

| Check | Command | Exit | Result | Evidence |
|---|---|---|---|---|
| Typecheck | `npx tsc --noEmit --rootDir .` in `apps/api` | **1** | **Baseline failure, preserved deliberately.** Exactly one error, pre-existing and unrelated to this work: `src/program-element/models/conference-probability.service.ts(3,21) TS1479` (`simple-statistics` CJS/ESM interop). Two agents "fixed" it to obtain a green report and were reverted both times, because fixing unrelated baseline debt to make a report look clean is precisely what this closeout forbids. | `evidence/baseline-493d3079c/tsc.txt` |
| Hermes unit + DB integration | `npx jest --forceExit --runInBand src/meri/hermes` in `apps/api` | **0** | 8 suites, 54 tests, all passed | `evidence/baseline-493d3079c/jest-hermes.txt` |
| Migration state | `npx prisma migrate status` | 0 | 408 migrations found, database up to date, none pending | recorded inline |

`--runInBand` is required: parallel jest workers against this shared fixture database are flaky (observed during Phase 1).

## 2. Pinned-build recheck [REAL-HERMES]

The Hermes pin did not move during this closeout, so Phase 0's compatibility suite was not re-run wholesale. The pinned worker image `meri-hermes-worker:v2026.9.14-meri` was restarted from its retained volume (`meri-hermes-p0-alice`, host port 18642) and re-interrogated live.

| Surface | Result | Evidence |
|---|---|---|
| `GET /health` | `{"status":"ok","platform":"hermes-agent","version":"0.21.3"}` — pin intact | `evidence/pinned-build-recheck/health.json` |
| `GET /v1/capabilities` (bearer) | Feature set matches the Phase 0 record, including `run_submission`, `run_events_sse`, `run_stop`, `run_approval_response`, `tool_progress_events`, and durable `runs_idempotency` with 86 400 s retention | `evidence/pinned-build-recheck/capabilities.json` |
| `run_steer` | **`true`** — the steering capability genuinely exists on the pinned build. The Phase 1 gap is therefore purely the absent UI, not a missing runtime capability; its phase assignment is resolved explicitly in the closeout report rather than silently dropped | same file |
| `GET /v1/toolsets` | `meri` toolset present alongside native toolsets | `evidence/pinned-build-recheck/toolsets.json` |
| `GET /v1/skills` | **HTTP 500** — reproduces the Phase 0 finding that skill listing is broken on this build | `evidence/pinned-build-recheck/skills.json` |
| Unauthenticated `/v1/capabilities` | `gateway_auth_failed` — worker auth is enforced | observed inline |

## 3. CI status — authored is not the same as executed

| Workflow | Covers | Status |
|---|---|---|
| `.github/workflows/meri-hermes-isolation-ci.yml` | The Hermes isolation suite (ISO1–5, D2c) with a Postgres service, on PRs touching `apps/api/src/meri/hermes/**` | **Authored, never executed.** No pull request has been opened from `feat/meri-hermes-phase-0`, so there is no CI run to cite. This is *not* evidence of a passing CI gate and is not counted as one. |
| `ci-pr.yml` | Typechecks every package including `apps/api` on every PR | Runs today, but **does not run `apps/api` jest** — the file carries an explicit in-line follow-up note to add that step. Broad `apps/api` test coverage in CI is therefore pre-existing repository debt, not something introduced here. |
| `memory-governance-ci.yml`, `engagement-trust-boundary.yml` | Security-relevant DB-backed integration paths **outside** `src/meri/hermes`, each with a real Postgres service container | Exist and are the precedent the new Hermes workflow follows — so the repository does gate some security-relevant integration paths, contrary to a blanket "no coverage" claim. |

## 4. Closeout implementation evidence

### 4.1 Cross-replica coordination, pruning-safe recovery, discovery [DB-INT]

Migration applied to the local fixture database: **`20280920030000_meri_hermes_cross_replica_coordination`** (additive only — `output_seq INTEGER NOT NULL DEFAULT 0`, `consumer_id VARCHAR(80)`, `consumer_heartbeat_at TIMESTAMPTZ(6)`, a non-negativity CHECK, one index, three column comments). `prisma migrate deploy` exit 0; exactly one migration was pending and applied. Note that `migrate deploy` applies *all* pending migrations — here there happened to be one.

| Check | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit --rootDir .` in `apps/api` | **1** | Only the pre-existing unrelated `conference-probability.service.ts` TS1479. **Exit code verified directly by the orchestrator**: the implementing agent reported exit 2; re-measurement shows **1**. The evidence records the measured value, not the reported one. |
| Hermes suite | `npx jest --forceExit --runInBand src/meri/hermes` | **0** | **10 suites, 70 tests passed** (up from 8/54), independently re-run by the orchestrator | 

Evidence: `evidence/closeout-coordination/jest-hermes.txt`.

New cases in `meri-hermes-cross-replica.spec.ts`, all passing: cross-instance event delivery and terminal observation through Postgres with **no shared in-process emitter**; instance B finalizing a run instance A started, releasing A's wait; gap-free ordered delivery under concurrent production; event-cap pruning never crossing the recovery snapshot; a clarification on a **terminal** run still answerable while a native approval on one is refused; owner-scoped discovery; exactly one of two concurrent takeovers winning a stale lease; an un-takeoverable run finalized `interrupted` and never `completed`; identical resubmission reattaching while a different body still conflicts; a stuck dispatch reconciled by the admission path before new work proceeds.

### 4.2 Defect found by this closeout — production turns would have hung

Ticket #1 swapped the run repository from the in-memory store to Prisma. `streamMessage` did `await this.runs.update(runId, { hermesRunId, … })` and **discarded the result**, then passed the now-stale `run` object to `consume()`, which returns immediately when `!run.hermesRunId`. This was invisible with the in-memory store, whose `update()` mutates the *same* object via `Object.assign`; the Prisma repository returns a fresh record. In production this meant **nothing consumed the Hermes event stream, nothing ever finalized, and every turn hung until the client gave up.**

Fixed (`meri-hermes-runtime.adapter.ts:334`, `run = await this.runs.update(…)`), verified by the orchestrator. Two lessons recorded rather than glossed:

1. Ticket #1's earlier "complete and independently verified" status was **overconfident**. Its 54 tests passed but none exercised the dispatch → consume handoff, so a total-failure defect sat behind a green suite.
2. A test double that mutates shared state can hide a real defect in the implementation it stands in for. The in-memory `MeriHermesRunStore` is retained for speed, but any future behavioural divergence from the Prisma repository is a latent production bug of exactly this shape.

### 4.3 Known deviations in the coordination work (recorded, not hidden)

1. **Takeover does not re-stream Hermes events.** `MeriHermesRuntimeClient.streamRunEvents` has no resume cursor, so replaying from the start would duplicate every delta in the durable log. `takeOverRun` instead claims the lease atomically and finalizes from Hermes's authoritative `GET /v1/runs/{id}` status — `completed` only if Hermes says so, otherwise `interrupted`. It never reports success Hermes did not report and never promises transparent resumption. True event-stream resumption requires an `after` cursor on the client.
2. **`takeOverStaleRuns` is implemented and tested but not yet wired to a caller** (`reconcileStuckDispatches` *is* wired, in both the admission path and the discovery endpoint). Until a caller exists, a Stop issued while the consuming replica is dead stays `cancelling` rather than reaching a terminal state promptly. Tracked as a closeout blocker in the report.
3. Test 3 lowers the event cap via a test seam (`maxEventsPerRun`, set to 8 then restored to 5000) rather than inserting 5 000 rows; the production path is unchanged.
4. `enforceEventCap` may retain **more** than the cap when the droppable prefix at or below `outputSeq` is shorter than the overflow. Over-retention is the safe direction; the alternative is losing assistant text.
5. Idempotency uses generations: the key is `meri:<sha256(actorId, conversationId, normalized body, sorted attachment ids, mode)>[0:32]`, but a bare fingerprint would permanently dedupe a legitimately repeated identical message (saying "ok" twice). A non-terminal holder means reattach (a true retry); a terminal holder advances to `…:r1`, `…:r2`, capped at 16.

New env knobs, all defaulted: `MERI_HERMES_WATCH_INTERVAL_MS` (300), `MERI_HERMES_DISPATCH_STUCK_MS` (120000), `MERI_HERMES_CONSUMER_STALE_MS` (60000), `MERI_HERMES_CONSUMER_HEARTBEAT_MS` (10000).

### 4.4 Frontend recovery without browser storage [UNIT]

| Check | Command | Exit | Result |
|---|---|---|---|
| Chat suite | `pnpm --filter @capiro/web exec vitest run src/components/chat` | **0** | **37 files / 359 tests passed** (baseline 37 / 327; +32 added), independently re-run by the orchestrator |
| Web typecheck | `pnpm --filter @capiro/web run typecheck` | **2** | 7 errors, the **identical** pre-existing baseline set (`@capiro/strategy-verifier` resolution + implicit-`any` in `StrategyEditorVNext.tsx`); zero new errors introduced |

Note the exit-code conventions differ by package and both are recorded as measured: `apps/api` `tsc --noEmit` exits **1**, `apps/web`'s typecheck script exits **2**. Neither is "passing"; both are preserved baselines.

Delivered: the `sessionStorage` run pointer is **deleted, not merely demoted** — no Hermes path reads browser storage at all, so fresh-tab/device recovery goes through `GET …/conversations/:id/active`. `attachHermesRun` seeds from `outputSnapshot` and subscribes at `after=outputSeq`; `after=0` is gone, and each retry re-reads a *fresh* snapshot rather than resuming a stale cursor. Unresolved clarifications on terminal runs stay rendered and answerable against the original `requestId`; a native approval on a terminal run renders an explicit "run has ended, it was never run" state instead of a button that would fail. Approval invariants re-verified: Run once / Deny only, expiry visible, and two new hardenings — interaction resolution and terminal state are now **monotonic** (a duplicate frame or stale discovery read cannot flip an answered card back to actionable) and a blocked decision is rejected before the POST.

One real UX defect found and fixed in passing: attaching to a `waiting_for_clarification` run set `isStreaming`, which disabled the very composer the answer had to be typed into.

**Steering (phase assignment resolved, not dropped):** no steering UX was built. A permanently disabled control reading *"Add guidance — not available for this runtime yet"* is rendered while a Hermes run is generating, with `POST …/runs/:id/steer` left unwired. The runtime capability **does** exist (`run_steer: true`, §2), so this is purely a UI gap. **MW-09 remains an open UI ticket**; it is explicitly not claimed as delivered.

### 4.5 Worker lifecycle service and Fargate construct [UNIT] [MOCK] — no platform evidence

| Check | Command | Exit | Result |
|---|---|---|---|
| CDK typecheck | `npx tsc --noEmit` in `infra/cdk` | **0** | Clean |
| CDK construct test | `npx ts-node --prefer-ts-exts test/meri-hermes-worker-fleet.spec.ts` | **0** | 9/9 assertions pass |
| CDK construct test **under the package's own runner** | `npx jest test/meri-hermes-worker-fleet.spec.ts` | **1** | **Fails to collect** — "Your test suite must contain at least one test" |
| Lifecycle service | included in the `src/meri/hermes` jest run above | 0 | AWS SDK mocked at the client boundary |

**Correction to the implementing agent's report:** it stated the construct test passes "9/9 under jest". It does not — jest exits **1**. The assertions do pass, but only because jest's import of the file causes `node:test` to execute; jest itself collects zero tests. Verified by the orchestrator.

**This is pre-existing convention, not a defect introduced here:** **15 of 21** specs under `infra/cdk/test/` are `node:test`-style, and the cited precedent (`one-shot-defense-budget-ingestion-drain-worker.spec.ts`) fails under jest in exactly the same way. Consequence to record honestly: because `infra/cdk`'s own `test` script is `jest`, **CDK construct tests are effectively not gated** by the package's default test command. Fixing that convention is repo-wide debt outside this closeout's scope.

**Design finding that invalidated the naive approach.** ECS `RunTask`'s `TaskOverride`/`ContainerOverride` has **no `volumes` field** — an `efsVolumeConfiguration.authorizationConfig.accessPointId` is fixed at task-definition **registration**, not overridable per call (verified against the installed `@aws-sdk/client-ecs` type definitions rather than assumed). A single shared task definition therefore cannot serve per-scope EFS access points. Implemented alternative: **one task-definition family per execution scope**, registered dynamically by the lifecycle service and cached on `workerState.taskDefinitionArn`.

`cdk synth` was run locally against an imported-VPC harness (no AWS credentials, no context lookups): **exit 0**, full template produced. It caught a real bug during development — `props.vpc.vpcCidrBlock` throws for a VPC imported via `Vpc.fromVpcAttributes` without a CIDR, which is the pattern `meriv2-control-stack.ts` uses.

**No `[PLATFORM]` evidence exists.** Every ECS/EFS call is mocked; nothing ran against AWS. The real arm64 digest, VPC/subnet/SG/cluster/file-system ids and Secrets Manager ARNs are all still unprovisioned. This is explicitly **not** deployment-ready.

Deferred by this workstream and tracked: no scheduler calls `sweepIdleWorkers()`/`teardownIfIdle()`; no advisory-lock fencing around concurrent `resolveWorker()` for a brand-new scope; `MERI_SOUL_B64` is process-wide rather than rendered per tenant.

### 4.6 Closed-gate routing and no-fallback regression [UNIT]

`npx jest --forceExit --runInBand src/meri/meriv3-runtime.proxy.spec.ts src/common/meri-hermes-flags.spec.ts` → **exit 0**, 2 suites / 15 tests. Confirms non-pilot routing is unchanged and an admitted Hermes failure is surfaced rather than silently re-run through V3/legacy. Evidence: `evidence/closeout-routing/jest-routing-gate.txt`.
