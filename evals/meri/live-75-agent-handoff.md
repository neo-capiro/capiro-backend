# Agent handoff: implement and run Meri's live evaluation

**Prepared:** September 26, 2026; reconciled to native V3 September 27, 2026 (America/New_York)  
**Repository:** `neo-capiro/capirov2`; this handoff was updated after the Phase 4 revert, with main observed at `d86b0662d1c6c6eb559ce2a74ea3e7244233672b`. Recheck `main` and the deployed API/web image digests before editing; record the actual revisions in every report.  
**Mission:** Build a repeatable, affordable **75-case live Meri evaluation** using Playwright and Promptfoo, run what the available isolated environment supports, and deliver a failing-case report plus a small reviewable PR. The complete [case specification](live-75-case-spec.md) is supplied as a separate file. Implement and test the evaluation harness; do not claim a passing Meri product or enable a new runtime merely because its tests compile. Evaluate only the served native Meri V3 path; the earlier Hermes Phase 4 broker merge was reverted.

## Current repo facts and boundaries

| Existing artifact | What it proves | What to do |
| --- | --- | --- |
| [`evals/meri/`](https://github.com/neo-capiro/capirov2/blob/d86b0662d1c6c6eb559ce2a74ea3e7244233672b/evals/meri/README.md) | **26 offline, deterministic Promptfoo cases** with a fail-closed SHA/fixture [report verifier](https://github.com/neo-capiro/capirov2/blob/d86b0662d1c6c6eb559ce2a74ea3e7244233672b/evals/meri/verify_report.py). No live model, retrieval, memory, DB or UI. | Preserve its contracts, input hashes and strict 26/26 gate; run it independently. Never relabel its results as live answer quality. |
| [Phase 19 browser workflow](https://github.com/neo-capiro/capirov2/blob/d86b0662d1c6c6eb559ce2a74ea3e7244233672b/.github/workflows/meriv2-phase19-browser-acceptance.yml), [fixture seed](https://github.com/neo-capiro/capirov2/blob/d86b0662d1c6c6eb559ce2a74ea3e7244233672b/apps/api/scripts/seed-meriv2-phase19-browser-fixtures.ts), [CDP runner](https://github.com/neo-capiro/capirov2/blob/d86b0662d1c6c6eb559ce2a74ea3e7244233672b/apps/web/scripts/meriv2-phase19-browser-acceptance.mjs) | Reusable disposable Postgres, migrations, API/web and four Clerk role patterns; the earlier Phase 19 browser acceptance itself was blocked, and its memory review visits **`/settings/memory`**. | Reuse setup and actor patterns only. Add Playwright tests that approve **inside `/meri`**; do not report Phase 19 as passing product acceptance. The fixed-tenant seed is destructive and belongs only on a disposable local database. |
| [Phase 4 revert](https://github.com/neo-capiro/capirov2/commit/ae5c2b85c1266e6de4e160f2fda4155a726a7364) | The broker runtime was removed from main. Older Phase 4 test instructions refer to a historical tree. | Do not enable, count, or depend on the reverted broker as part of this benchmark. Treat the 75 as a live diagnostic baseline, not certification of the separate 300-case/50-per-family routing promotion standard. |

The web package currently has no Playwright dependency. Add one **exact pinned** `@playwright/test` version with a lockfile change and a dedicated config; keep the existing custom CDP runner. The root workspace has `pnpm@9.12.0` and a locked Promptfoo installation; check `pnpm exec promptfoo --version` against the offline suite's documented **0.123.1** before relying on current upstream examples.

## Required implementation

### 1. Make a single manifest for the 75 cases

Create `evals/meri/live-v1/` (or a similarly explicit separate directory) with a typed `cases` manifest. The [75-case contract](live-75-case-spec.md) is its source of truth. Every row needs `id: '01'..'75'`, user prompt, category, `api | workspace | research` surface, authenticated actor, selected client, fixture version/source IDs, setup/previous turns, injected fault if any, expected exact facts, required/forbidden sources, expected operation and terminal status, deterministic hard gates, and human rubric instructions. Validate exactly 75 unique sequential IDs and a frozen fixture hash before a run; keep the 26 offline IDs in a separate namespace.

Use a case-specific seed namespace and run ID so retries cannot reuse a previous candidate, conversation, watch or approval. Record the git SHA, API/web image SHAs, flag snapshot, model/mode, fixture hash, clock, actor and client with each result. Fail closed if any of these are missing or if the local checkout and deployed system differ without an explicit recorded reason. Do not transcribe expected facts from model answers into the manifest.

### 2. Build an isolated, authenticated target

Begin with a disposable local Postgres/pgvector stack and the [existing browser setup](https://github.com/neo-capiro/capirov2/blob/d86b0662d1c6c6eb559ce2a74ea3e7244233672b/scripts/run-meriv2-phase19-local.mjs). Add the second tenant, two similarly named clients, authorized reviewer, ordinary proposer, denied/ethical-wall actor, versioned memories and documents, synthetic budget/bill/opportunity records, research portfolios, BD prospect and District Nexus evidence specified in the [case contract](live-75-case-spec.md). Freeze the test clock at its stated instant. Seed synthetic official-page snapshots and external-provider adapters; never use live government changes, real clients, live email delivery or real PDL enrichment to make a deterministic case pass.

Use dedicated Clerk test identities and actual tenant authorization. Reuse Phase 19's session/organization pattern without copying session cookies into code. Keep auth state under an ignored temporary directory, never commit it or print it in traces. Use separate actor contexts, and start state-changing cases serially. Playwright's [authentication guidance](https://playwright.dev/docs/auth) recommends isolated accounts for tests that change server state. For remote nonproduction staging, seed only a dedicated eval tenant with an owned namespace and cleanup; **never point the fixed-ID Phase 19 destructive seed at a shared DB**.

Check readiness before spending model tokens: authentic login, V3 endpoint/stream and `/meri` route, Context Plane scope, memory-review rollout flags, fixture/source hashes, configured model, mock external sinks and bounded run cost. Do not invent an endpoint path or pretend a test bypass token exercises Clerk. If required staging identities or model configuration are unavailable, implement the harness and run offline/local checks, then report live cases `BLOCKED: missing prerequisite`; no green placeholders.

### 3. Capture the answer and behavior **once**

Use Playwright Test as the case orchestrator. For most factual cases, Playwright's authenticated `APIRequestContext` or an authenticated streaming client can drive the **real governed** Meri endpoint without loading the UI; inspect the actual V3 route and SSE protocol. For workspace cases, drive the real browser and confirm the persisted API/database result. Await the actual terminal response and collect answer text, citations/passage locators, selected client, tool attempts and outcomes, trace/run IDs, first useful visible content, terminal latency, token use, cost when available, and resulting receipts. Keep raw synthetic evidence server-side and save only bounded passages or secure references in the model-grader input.

Do **not** let Promptfoo call Meri again merely to grade an already executed write. After the captured run, feed the recorded answer and source/receipt metadata into a **separate live-v1 Promptfoo configuration** using `providerOutput` if supported by the installed version, or a minimal **read-only local JavaScript provider** if not. Never use a model stub or a mere answer fixture as a live pass. Promptfoo's [custom-provider contract](https://www.promptfoo.dev/docs/providers/custom-api/), [recorded output field](https://www.promptfoo.dev/docs/configuration/reference/) and [JavaScript assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/) are suitable patterns; verify them against the installed pinned version. Reports and evidence must go outside the git worktree.

### 4. Make Playwright prove the Meri workspace

Test memory cases **13–19**, client switch **10**, upload/history **41–46**, action approval **51**, research save/watch/resume **61–63**, prospect save **67**, and Stop/resume **73–74** through browser flows where relevant. Start at the vNext [`/meri` route](https://github.com/neo-capiro/capirov2/blob/d86b0662d1c6c6eb559ce2a74ea3e7244233672b/apps/web/src/vnext/app/VNextApp.tsx) with `VITE_WEB_SURFACE=vnext`. Prefer accessible role locators; existing hooks include `Message Meri`, `Send`, `Stop research`, `[data-meri-answer-body]`, `[data-meri-turn]`, and `[data-meri-context-rail]`. Open **Context and Memory → Memory** in the workspace for candidate review; business proposals also use the **Approvals** inspector. Assert the URL stays under `/meri`, no `/settings/memory` navigation, a decision survives reload, and the next turn observes only the authorized result. Six pending proposals must be reachable; conflict review must be possible there. Current UI may fail these cases: report that as a product failure rather than navigating to Settings as a workaround.

For an approval HTTP error, browser request interception can prove visible failure/retry in case 19 or 51, but also check the real persisted candidate/action state. For artifact case 46, await a Playwright download and compare bytes/checksum, filename and authorization; its [download event pattern](https://playwright.dev/docs/downloads) starts waiting before clicking. Capture screenshots, network failure and a [retained trace on failure](https://playwright.dev/docs/trace-viewer); keep screenshots and traces access-controlled because they may contain synthetic credentials or content. Avoid fixed sleeps and brittle text-only selectors; use web-first assertions and stable test IDs where existing markup is insufficient.

### 5. Inject faults at the right layer

Cases **71, 72 and 75** need controlled **server/provider/tool adapter** faults keyed to the case run: `429` plus `Retry-After`, resolved HTTP 200 `{error}`, and incomplete/malformed model function output. A Playwright route override of the final chat response would bypass the reasoning loop and prove nothing about it. Case **74** may restart only an isolated disposable research worker; compare pre/post source receipts and downstream mock side-effect counts. JEV cases **56–58** require explicit canary/enabled and shadow configurations; for a targeted-repair test seed the wrong *draft at JEV's boundary*, then observe Meri's own correction before release. Do not rewrite the final answer in the browser and claim JEV repaired it. Log fault type, injection point and correlation ID.

The reverted Phase 4 broker is outside this live evaluation. Do not revive its schema, worker or flags to make a case pass. A future runtime pilot would require its own current design, authorization and isolated qualification.

### 6. Score what matters, with a fail-closed report

Run deterministic assertions **before** any LLM grader: tenant/client/ethical-wall isolation, memory lifecycle, requested versus enacted figures, exact IDs, source passage/version, unavailable/partial state, no unapproved or duplicate write, no false completion, correct artifact bytes and visible failed approvals. A critical violation fails the case regardless of narrative score. Then grade five dimensions **0–2 each**: factual support, evidence coverage and citation validity, client relevance, directness/clarity, and actionable judgment. Substantive answer target: **≥8/10 with no zero dimension**, plus every exact case assertion. Use the existing [government-affairs rubric](https://github.com/neo-capiro/capirov2/blob/d86b0662d1c6c6eb559ce2a74ea3e7244233672b/docs/meri-government-affairs-evaluation.md) as language guidance, but do not merge its different scale or output-only results into this score.

Use Promptfoo's version-pinned JavaScript assertions for IDs, amounts/status, and forbidden claims. An optional inexpensive, explicitly selected grader may score the narrative **only on synthetic evidence**, with an exact rubric, model/version, prompt and cost logged. Blind-review the source-dependent answers with a human and adjudicate disagreement; do not use a judge to override a failed permission, source or write assertion. A missing trace/source, incomplete run, skipped case, unavailable grader, or unsupported mode must be labeled honestly, never converted to a pass. Redact auth tokens and client data from any prompt or external grader request. Set Promptfoo telemetry/remote generation off and sharing disabled.

Report per case: `caseId, fixtureHash, checkoutSha, deployedSha, flags, actor, client, mode, effectiveModel, expected/consulted/cited source IDs and versions, passage checks, tool status/attempts, approval or action receipt, hard gates, five rubric dimensions, human adjudication, answer status, firstUsefulMs, terminalMs, tokens, estimatedCost, traceId, artifact links`. Aggregate completion, source recall, citation validity, first useful time, p50/p95 terminal time, token/cost **per correct completed case**, holds, needless clarifications, retry counts and hard-gate violations by category and mode. Attach sanitized failing traces and reproduction steps. Do not substitute one opaque average for hard gates.

### 7. Run in three cost-controlled stages

1. **Preflight:** run the current 26 offline cases per [`evals/meri/README.md`](https://github.com/neo-capiro/capirov2/blob/d86b0662d1c6c6eb559ce2a74ea3e7244233672b/evals/meri/README.md), including package builds, Python and Node unit tests, pinned local Promptfoo, and `verify_report.py`. Keep its required secrets **unset**. Keep its report outside the repository; require 26 unique IDs, 26/26 and verifier success.
2. **Vertical slice:** build fixture+auth+capture+grading+report verification for **01, 12, 14, 17, 20, 46, 51, 72 and 74**. Several are likely to expose current product defects. Do not soften expectations to make the harness green; demonstrate the verifier distinguishes `PASS`, `FAIL`, `BLOCKED` and `NOT_RUN`.
3. **Full live baseline:** execute all 75 once in the isolated default runtime. Repeat the appendix's eight representative cases in Standard/Deep where those modes exist, and the three JEV cases in shadow/enabled configurations. Rerun only failing or variable slices after a fix. Run a cheap offline suite on PRs; schedule/manual-run the live suite where authenticated staging and a spend cap exist. Record an explicit cost limit, concurrency (start at 1), timeout and cleanup before enabling a scheduled run.

The existing offline preflight is runnable from the repo root as follows. First run `pnpm install --frozen-lockfile`; check that the local CLI prints 0.123.1. This example follows its README's isolation rules; keep the report directory outside the worktree and leave model/DB/Clerk credentials unset for the Promptfoo invocation.

```bash
pnpm --filter @capiro/shared run build
pnpm --filter @capiro/meriv2-core run build
python -m unittest discover -s evals/meri -p 'test_*.py' -v
node --test evals/meri/runtime/provider.test.cjs evals/meri/runtime/smoke.test.cjs
pnpm exec promptfoo --version
REPORT_DIR="${PWD}-meri-eval-evidence"
mkdir -p "$REPORT_DIR"
env -u DATABASE_URL -u DIRECT_URL -u ASSURANCE_EVAL_TENANT_ID \
    -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u CLERK_SECRET_KEY \
    -u STRIPE_SECRET_KEY -u NODE_OPTIONS \
    PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_REMOTE_GENERATION=1 \
    pnpm exec promptfoo eval -c evals/meri/promptfooconfig.yaml \
    --no-cache --no-share --no-write --no-table --no-progress-bar \
    -o "$REPORT_DIR/meri-offline.json" \
       "$REPORT_DIR/meri-offline.html" \
       "$REPORT_DIR/meri-offline.junit.xml"
python evals/meri/verify_report.py \
    "$REPORT_DIR/meri-offline.json" "$REPORT_DIR/meri-offline.summary.json"
```

Use separate commands/configs such as `pnpm exec playwright test --config evals/meri/live-v1/playwright.config.ts` and `pnpm exec promptfoo eval -c evals/meri/live-v1/promptfooconfig.yaml --no-cache --no-share ...`. Add documented npm/pnpm scripts once paths are real. Do not modify the 26-case offline suite's result verifier to accept new cases.

## Completion and delivery

Deliver a reviewable PR with a README, pinned dependency/lockfile, manifest/fixtures, isolated auth/setup, API and browser capture, Promptfoo grading, deterministic verifier, clean report schema, CI/manual job, and a small set of meaningful harness tests that prove fixture isolation and verifier failure on a missing ID, source leak, duplicate write or false success. Run those checks and provide the actual commands/exit codes. If credentials or a dedicated environment are unavailable, complete the implementation and local evidence, identify the exact blocked live cases and missing prerequisites, and leave the live score unset. Never manufacture a 75/75 result.

Supply a report headed **26 offline / 75 live baseline** with separate statuses. Include an ordered list of confirmed Meri product failures and the smallest proposed fix for each, with traces and case IDs. Confirm explicitly that memory and business approvals were evaluated within the **Meri workspace**. Do not merge the PR or toggle production rollout flags solely because this harness passes.

## Complete case contract

The frozen 75 prompts, fixtures, roles, and pass conditions are in [live-75-case-spec.md](live-75-case-spec.md). Preserve its IDs and expected outcomes.
