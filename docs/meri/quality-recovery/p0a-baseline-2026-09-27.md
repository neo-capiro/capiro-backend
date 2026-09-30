# P0A Baseline: Meri Quality Recovery and Cutover Plan

**Date:** 2026-09-27\
**Plan:** `C:\Users\Administrator\Desktop\Meri-Architecture-Quality-Recovery-and-Cutover-Plan-2026-09-27.md`, Â§11.2, first work-package row.\
**Scope:** P0A Baseline only; no implementation/deployment.\
**Repo SHA:** `42942dedad59382f4b4aac6f904b9aee0e02efa6` on `main`.\
**Repository path:** `C:\Users\Administrator\cap-meri-completion` (relocated from `C:\dev\cap-meri-completion`; git worktree moved).\
**Evidence directory:** `C:\Users\Administrator\cap-meri-completion-meri-eval-evidence`.

## Executive status

**PASS (deterministic offline sub-gate); BLOCKED (full P0A acceptance).** Promptfoo 0.123.1 installed, packages built, 53 Python unit tests passed, and the deterministic offline 26-case evaluation suite executed with 100% success. No live APIs, database queries, or model invocations occurred. Tool-exposure tracing, privacy-safe customer-failure telemetry, and prioritized live fixtures remain BLOCKED / NOT RUN.

No customer records, secrets, production actions, migrations, database writes, deployments, or authenticated browser canaries were used.

## P0A deliverables

| Deliverable | Status | Evidence / limit |
|---|---|---|
| Source/live release manifest | **PASS** | Read-only AWS proof now binds the public ALB HTTPS listener rule `/meri-api/*` to the Meri target group, ECS service/task definition, healthy target, running task and exact image digest. Repo/source SHA remains separately recorded; this proves deployed route identity, not successful customer requests. |
| Tool-exposure trace | **BLOCKED / NOT RUN** | Static registry/route facts below; no served-run trace for selected, exposed, invoked, or executed tools. |
| Top customer failure families | **BLOCKED / NOT RUN** | No privacy-safe support corpus or live failure telemetry was sampled. Source-identified candidate risks below are hypotheses, not a customer frequency ranking. |
| 26 offline acceptance results | **PASS** | Promptfoo 0.123.1 installed as dev dependency; `@capiro/shared` and `@capiro/meriv2-core` built; Python and Node provider/smoke tests passed; offline evaluation invoked with all secrets/db/model env vars scrubbed; 26/26 cases passed; `verify_report.py` confirmed report integrity. |
| Prioritized live fixture runs | **BLOCKED / NOT RUN** | No disposable staging identity/database/endpoint was established; no fixtures or canaries executed. Suggested priority list below is planning only. |

## Source and live inventory (not full runtime proof)

- **Observed checkout:** `C:\Users\Administrator\cap-meri-completion`, `main` at `42942dedad59382f4b4aac6f904b9aee0e02efa6` during inspection. The only repository changes are this untracked report plus `package.json` and `pnpm-lock.yaml` (Promptfoo 0.123.1 dev dependency).
- **Live Meri ECS identity (read-only, point-in-time):** AWS account `967807252336`, assumed role `capiro-devbox-role/i-02486ea3f57f702f1`; cluster `capiro-dev` in `us-east-1`. Orchestrator service desired/running `1/1`, completed primary deployment, task definition `capiro-dev-meriv2-orchestrator:84`; API `:483` desired/running `2/2`; web-vNext `:381` desired/running `1/1`.
- **Orchestrator image:** task definition `:84`, container `meriv2-orchestrator`, image digest `sha256:227550d5862037ef026b04e3a7cb8f77e3c3467f409e3ab5144ad0ce725018de`. `RELEASE_SHA` and `GIT_SHA` env refs both equal `c2bc41a86ef087e4b163c556595507ec08b396cf`. This proves configured service/task identity, not that a request was routed there or completed successfully.
- **Non-secret task-definition settings observed:** MERIV3_ENABLED=true; model vars gpt-6-astra; JEV provider mode enforce for chat, model jev-1.13.0, 2 max attempts, 8000ms timeout; release gate shadow; Context Packet V2 enforce; coverage retrieval enforce; auto-correction shadow. Values are task-definition environment, not proof each gate ran. No secret values were read.
- **External route proof (read-only, 2026-09-27T21:39:26Z):** the updated `capiro-devbox-role` successfully described the active internet-facing ALB `capiro-prod-alb` (`capiro-prod-alb-57164953.us-east-1.elb.amazonaws.com`). HTTP listener port 80 redirects to HTTPS 443. HTTPS listener rule priority `13` matches `/meri-api/*` and forwards to target group `capiro-prod-meriv2-orch-tg` (`.../9c49e0a42493ce64`) on port 4300.
- **Target/service/task binding:** target `10.40.12.5:4300` was `healthy`. ECS service `capiro-dev-meriv2-orchestrator` had desired/running `1/1`, primary deployment `COMPLETED`, and bound that exact target group to container `meriv2-orchestrator:4300`. Running task `14a61963cb114fab988ec1f9f111b07b` was `RUNNING`/`HEALTHY`, used task definition `capiro-dev-meriv2-orchestrator:84`, had private IP `10.40.12.5`, and reported image digest `sha256:227550d5862037ef026b04e3a7cb8f77e3c3467f409e3ab5144ad0ce725018de`.
- **Route evidence boundary:** this completes the source/live release manifest and proves configured public route -> target group -> healthy running task -> image identity. It does not prove a particular authenticated request reached Meri, selected a tool, or completed successfully; those belong to the still-blocked tool-exposure/live-fixture gates.
- **Plan:** Desktop file identified above; Â§11.2 specifies the acceptance deliverables and Â§12.1 the initial diagnostic slice.
- **Registry:** plan Â§2.2 reports 132 static capabilities (101 read, 31 write); this is not a current runtime catalog.
- **Source seams:** plan identifies `apps/api/src/meri/meri.controller.ts`, `packages/shared/src/index.ts`, governed V3 route / `MeriV3SemanticRuntimeStore`, memory adapter, action proposal service, and VNext controller. Current-source call-path verification remains incomplete.
- **Still unknown:** actual request routing, selected/exposed/invoked/executed tools and outcomes, customer failure rates, and whether traffic exercised the listed flags.

## Bounded test result

### Promptfoo installation

```bash
cd C:\Users\Administrator\cap-meri-completion
pnpm add -D -w promptfoo@0.123.1
pnpm exec promptfoo --version
```

**Result:** `0.123.1` exact, installed as root dev dependency. `package.json` and `pnpm-lock.yaml` updated.

### Build and unit tests

```bash
pnpm --filter @capiro/shared run build
pnpm --filter @capiro/meriv2-core run build
python -m unittest discover -s evals/meri -p 'test_*.py' -v
node --test evals/meri/runtime/provider.test.cjs evals/meri/runtime/smoke.test.cjs
```

**Python unit tests:** `Ran 53 tests in 0.784s OK`, exit code 0.\
**Node provider/smoke tests:** `tests 40 / pass 40 / fail 0`, exit code 0.

### Offline Promptfoo evaluation

```bash
REPORT_DIR="C:/Users/Administrator/cap-meri-completion-meri-eval-evidence"
mkdir -p "$REPORT_DIR"

env -u DATABASE_URL -u DIRECT_URL -u ASSURANCE_EVAL_TENANT_ID \
    -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u CLERK_SECRET_KEY \
    -u STRIPE_SECRET_KEY -u NODE_OPTIONS \
    PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_REMOTE_GENERATION=1 \
  promptfoo eval -c "C:/Users/Administrator/cap-meri-completion/evals/meri/promptfooconfig.yaml" \
  --no-cache --no-share --no-write --no-table --no-progress-bar \
  -o "$REPORT_DIR/meri-offline.json" \
     "$REPORT_DIR/meri-offline.html" \
     "$REPORT_DIR/meri-offline.junit.xml"
```

**Result:** `âœ" 26 passed (100%)`, 0 failed, 0 errors. Duration: 15s (concurrency: 4). Exit code 0.

### Report verification

```bash
python evals/meri/verify_report.py \
  "C:/Users/Administrator/cap-meri-completion-meri-eval-evidence/meri-offline.json" \
  "C:/Users/Administrator/cap-meri-completion-meri-eval-evidence/meri-offline.summary.json"
```

**Result:** `REPORT VERIFIED: 26/26 cases passed`. Exit code 0.

### Evidence artifacts

| File | SHA-256 |
|---|---|
| `C:/Users/Administrator/cap-meri-completion-meri-eval-evidence/meri-offline.json` | `f5d0ee9c1b5f08abde181cfc73b84bdae52b69d7d9f00d454ad0a17f3eeab112` |
| `C:/Users/Administrator/cap-meri-completion-meri-eval-evidence/meri-offline.html` | `97f0f30d49a10e9f4278f092b47df8307db7ab7ed210ebf0305796afa7a9efc9` |
| `C:/Users/Administrator/cap-meri-completion-meri-eval-evidence/meri-offline.junit.xml` | `dbf3155b4ef7ecb85483cbe256e1ce9569192e20ee9788d0730dc34c978b1d12` |
| `C:/Users/Administrator/cap-meri-completion-meri-eval-evidence/meri-offline.summary.json` | `60090fee077c74edce3080bc0b4ddbd5dce0845ed1c4fee2e4f08d81d1aa8c83` |
| `evals/meri/suite-contract.json` | `25be466136f4d47fc141e4b024f732a5ee1c1a477cc084700208c7b2826c052d` |
| `evals/meri/scorer.py` | `0813d0356df6837a8946b46134251f6d93f0a59b84a11138760471199c7bbc55` |
| `evals/meri/runtime/provider.cjs` | `b7eaa13d23949664593a62e9ad690d7f9fa7d388e727ad63ac2d249869328b1d` |
| `evals/meri/runtime/runner.mjs` | `53f1d9c847b65359e89d8408743f4abaff288de3aae3b79808db13870cd9b65d` |

The verifier bound the fresh report to the current fixture SHA-256 `f3474d7d9ee178e224d2b130e32643bec09af5ae0804e808149ed7e08442e770` and confirmed the current harness inputs.

### Case coverage summary

| Mode | Count |
|---|---|
| `core/` | 11 |
| `ga/` | 6 |
| `plan/` | 5 |
| `sequence/` | 2 |
| `calibration/` | 2 |
| **Total** | **26** |

### Suite contract facts (offline v1)

- **Base snapshot (not accepted):** `81c7c9c58a4fc3c1e34ab9714614882d74a60c9d`
- **Current checkout SHA:** `42942dedad59382f4b4aac6f904b9aee0e02efa6`
- **Fixture version:** `2026-09-06.1`
- **Suite version:** `meri-offline-v1`
- **Threshold:** `1.0` (100% required)
- **Promptfoo version:** `0.123.1`
- **Python version:** `3.14.7`

## Candidate issues from plan/source review (not frequency-ranked customer failures)

1. Governed V3 route may fail to install request-local selector state before schema selection; verify exact current caller and source diff.
2. Institutional-memory retrieval may cap candidates before relevance ranking; validate against current code and deterministic older-memory fixture.
3. Some read/action handlers may resolve with logical error payloads; inspect handler-owned validators and verify with controlled adapters.
4. Approval UI may not visibly reconcile non-2xx/ambiguous outcomes; verify current served handler and controlled response without executing an action.
5. CI setup failures may prevent affected suites from running; separate â€œtest failedâ€ from â€œtest never ran.â€

No customer telemetry was sampled, so priority/order is a hypothesis from the plan, not observed incidence.

## Prioritized live fixtures â€” proposed, NOT RUN

The planâ€™s diagnostic starting slice (Â§12.1) is **01, 12, 14, 17, 20, 46, 51, 72, 74, CD-02, CD-05**. Subject to safe isolated fixtures, start there; then extend with 10, 25, 42, 56â€“58, 71 and remaining CD cases. This is a proposed sequence, not completed execution.

Additional candidate grouping (planning only):

1. **Source/memory:** cases 12, 20, 40, 45; record source/version/locator and coverage.
2. **Tool/approval truthfulness:** cases 51, 72, 75 and CD-05 in disposable sinks; require logical-failure injection, operation receipt, and duplicate-effect count.
3. **Scope / durable execution:** cases 05â€“10, 63, 71â€“75 in isolated tenant fixtures; stop at access, persistence, or fencing boundaries.
4. **Commitments & Deliverables:** preserve CD-01â€“CD-07 as a separate extension; explicitly test complete-source coverage, Monday state, pagination and no-write-by-launcher.

Before any live fixture: confirm non-production endpoint/tenant, disposable DB and sink, fixture reset safety, test identity permissions, exact build/config hashes, and user-run authenticated browser policy. No live test was run here.

## QA and acceptance corrections

- A separate bounded, read-only Hermes QA session using `anthropic/claude-sonnet-5` returned **PASS for the offline scope only** after cross-checking the report, README, verifier summary, worker result, package dependency, and live Git status/diff stat. It did not rerun the suite. The coordinator independently re-ran `verify_report.py` successfully and recomputed the evidence hashes; fresh Python and Node tests are recorded below. This baseline was updated for the relocated repository path (`C:\Users\Administrator\cap-meri-completion`) and fresh evidence hashes on 2026-09-27. The coordinator independently re-ran the fail-closed verifier against the relocated evidence; all eight integrity checks passed.
- The 53 Python unit-test result is verified from actual jumpbox output; it is separate from the 26 Promptfoo cases.
- Promptfoo 0.123.1 is documented by `evals/meri/README.md`; this session did not establish it absent globally. Do not claim it is missing from PATH.
- Earlier table reference â€œTable 12.301â€ was incorrect and has been removed; Â§12.1 is cited without an invented table number.
- The live-fixture ordering preserves the planâ€™s explicit initial diagnostic slice.
- **Acceptance:** PASS for the deterministic offline sub-gate; BLOCKED for full P0A acceptance because the tool-exposure trace, privacy-safe customer-failure telemetry, and prioritized live fixtures remain BLOCKED / NOT RUN. The source/live release manifest is now PASS after the read-only ALB-to-running-digest proof. Do not describe full P0A as complete or live quality as passed.

## Worker result (2026-09-27)

**Artifact:** `C:\Users\Administrator\p0a-home-closeout-worker-result.md`

**Git status:**\
```
 M package.json
 M pnpm-lock.yaml
 ?? docs/meri/quality-recovery/
```

**Diff stat:** 2 files changed, 6100 insertions(+), 190 deletions(-)

**Head SHA:** `42942dedad59382f4b4aac6f904b9aee0e02efa6` on `main`

**Test execution summary:**
- `pnpm --filter @capiro/shared run build` -> exit 0 (TypeScript)
- `pnpm --filter @capiro/meriv2-core run build` -> exit 0 (TypeScript)
- `python -m unittest discover -s evals/meri -p 'test_*.py' -v` -> exit 0 (53 tests OK)
- `node --test evals/meri/runtime/provider.test.cjs evals/meri/runtime/smoke.test.cjs` -> exit 0 (40/40 pass)
- `promptfoo eval ...` -> exit 0 (26/26 cases passed)
- `python evals/meri/verify_report.py ...` -> exit 0 (REPORT VERIFIED)

**Evidence artifacts (SHA-256):**
- `meri-offline.json` | `f5d0ee9c1b5f08abde181cfc73b84bdae52b69d7d9f00d454ad0a17f3eeab112`
- `meri-offline.html` | `97f0f30d49a10e9f4278f092b47df8307db7ab7ed210ebf0305796afa7a9efc9`
- `meri-offline.junit.xml` | `dbf3155b4ef7ecb85483cbe256e1ce9569192e20ee9788d0730dc34c978b1d12`
- `meri-offline.summary.json` | `60090fee077c74edce3080bc0b4ddbd5dce0845ed1c4fee2e4f08d81d1aa8c83`

**Side effects:**
- Eval output moved to `C:\Users\Administrator\cap-meri-completion-meri-eval-evidence`
- No commits, deployments, migrations, or database writes

**Remaining blockers:**
1. Tool-exposure trace (requires served-run tracing)
2. Live fixtures (no disposable staging endpoint documented)
3. Customer failure telemetry (no privacy-safe support corpus sampled)

**Final verdict:** BLOCKED - deterministic offline gate passes; full P0A blocked pending runtime trace, live fixtures, and telemetry analysis.

## References

- Plan Â§11.2, P0A row; Â§12.1 acceptance inventory and diagnostic initial slice.
- `evals/meri/README.md`, `evals/meri/suite-contract.json`, `evals/meri/test_scorer.py`, `evals/meri/test_verify_report.py`.
- Exact run output: Python unittest invocation above; 53 tests, exit code 0.
