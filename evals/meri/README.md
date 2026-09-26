# Meri Promptfoo Offline Evaluation Suite

## Overview

This directory contains an offline, deterministic regression evaluation harness for the Meri system. This suite **does not** validate live-model answers, actual model-selected tools, actual retrieval, or real conversation memory. It validates mechanism invariants and grader calibration using synthetic fixtures.

**Important:** This is a no-network, no-database, no-model test harness. Do not run full Meri evaluation without approved non-production auth credentials and a separately configured evaluation endpoint.

## Version Information

- **Suite version:** `meri-offline-v1`
- **Initial source snapshot, not an accepted baseline:** `81c7c9c58a4fc3c1e34ab9714614882d74a60c9d` (the runner records the actual checkout HEAD per run).
- **Government affairs fixture version:** `2026-09-06.1`
- **Promptfoo CLI version:** `0.123.1`
- **Python version:** `3.14.7`

## File Structure

| File | Description |
|------|-------------|
| `promptfooconfig.yaml` | Promptfoo evaluation config (11 core + 6 GA + 5 plan + 2 sequence + 2 calibration = 26 cases) |
| `scorer.py` | Custom Python assertion function for GradingResult validation |
| `test_scorer.py` | Unit tests for scorer (RED-GREEN cycle) |
| `test_verify_report.py` | Negative tests for the fail-closed report gate |
| `verify_report.py` | Report JSON verifier (exact IDs, Python grades, per-result input hashes and fixture integrity) |
| `runtime/provider.cjs`, `runtime/runner.mjs` | Local custom provider and real-code fixture runner |
| `runtime/provider.test.cjs`, `runtime/smoke.test.cjs` | Provider, planner, boundary, and import smoke tests |
| `suite-contract.json` | Machine-readable suite contract (required IDs, threshold) |
| `CONTRACT.md` | Wire interface and behavior contract |
| `README.md` | This file |

## Running Tests

### Prerequisites and local tests

Use the existing workspace dependencies (`pnpm install --offline --frozen-lockfile`), build `@capiro/shared` followed by `@capiro/meriv2-core`, and use Promptfoo **0.123.1** (`promptfoo --version`). The runner invokes the locally installed `tsx` from `packages/meriv2-core`, never `npx`. Python 3.14.7 is the tested interpreter; only its standard library is needed for assertions. Run from the worktree root:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
pnpm --filter @capiro/shared run build
pnpm --filter @capiro/meriv2-core run build
python -m unittest discover -s evals/meri -p 'test_*.py' -v
node --test evals/meri/runtime/provider.test.cjs evals/meri/runtime/smoke.test.cjs
```

Both commands must exit 0; counts are reported by the test runners.

### Run Promptfoo Evaluation (OFFLINE only - no live APIs, no DB, no model calls)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

REPORT_DIR="${REPO_ROOT}-meri-eval-evidence"
mkdir -p "$REPORT_DIR"
env -u DATABASE_URL -u DIRECT_URL -u ASSURANCE_EVAL_TENANT_ID \
    -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u CLERK_SECRET_KEY \
    -u STRIPE_SECRET_KEY -u NODE_OPTIONS \
    PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_REMOTE_GENERATION=1 \
  promptfoo eval -c "$REPO_ROOT/evals/meri/promptfooconfig.yaml" \
  --no-cache --no-share --no-write --no-table --no-progress-bar \
  -o "$REPORT_DIR/meri-offline.json" \
     "$REPORT_DIR/meri-offline.html" \
     "$REPORT_DIR/meri-offline.junit.xml"
```

**Exit code must be 0.** Non-zero indicates regression failure.

### Run Report Verification

```bash
cd "$REPO_ROOT"
python evals/meri/verify_report.py \
  "$REPORT_DIR/meri-offline.json" "$REPORT_DIR/meri-offline.summary.json"
```

The verifier must also exit 0. It checks exactly 26 unique IDs, the Python 1.0 assertion for each row, zero provider errors and model tokens, fixture hash, source SHA, per-result hashes of config/scorer/provider/runner/fixture against the current worktree, and the no-cache/private flags. A prior report becomes invalid if any evaluated input changes, even before this worktree is committed. The machine-readable summary records hashes of the report and input files. No accepted baseline is overwritten. Change `REPORT_DIR` to any directory outside the repository if necessary; use native `C:/...` paths with Git Bash/Windows Node.

## Case Coverage

| Mode | Count | Description |
|------|-------|-------------|
| `core/` | 11 | Mechanism invariants (tenancy, grounding, compliance, entity, legislation) |
| `ga/` | 6 | Government affairs reference-answer checks |
| `plan/` | 5 | Planner scenario tests (portfolio, lookup, mail, market research) |
| `sequence/` | 2 | Two sequential pure-planner calls (target carry, target clear; not persisted conversation) |
| `calibration/` | 2 | Grader calibration (bad citation, tenant leak) |
| **Total** | **26** | |

## Pass Threshold

- **Deterministic threshold:** `1.0` (100% pass rate required)
- All 26 cases must pass for suite success.

## Report Outputs

| File | Description |
|------|-------------|
| `$REPORT_DIR/meri-offline.json` | Full JSON report (machine-readable) |
| `$REPORT_DIR/meri-offline.html` | Human-readable HTML report |
| `$REPORT_DIR/meri-offline.junit.xml` | JUnit XML for CI integration |
| `$REPORT_DIR/meri-offline.summary.json` | Machine-readable verification summary |

**Note:** No baseline is currently accepted; do not overwrite any baseline file.

## Safety Considerations

### A separate LIVE model suite would require:
- Approved non-production endpoint configuration
- Valid non-production auth credentials
- Separately approved evaluation tenant

### This Suite Does NOT:
- Call live Meri model endpoints
- Query live databases
- Use real client data
- Generate live model answers
- Validate semantic faithfulness or model quality

**This suite validates:** Mechanism invariants, grader calibration, and deterministic behavior only.

## Custom Scorer (`scorer.py`)

The Python scorer implements `get_assert(output, context)` returning:

```python
{
  "pass": bool,
  "score": float,  # 0.0 or 1.0 for deterministic cases
  "reason": str
}
```

Modes validated:
- `core/`: Mechanism `result.pass` must be True
- `ga/`: Grader passes, sources present, citations valid, required strings present
- `plan/`: Planner outputs match expected recipe/tool/domains
- `sequence/`: First-turn target carries into an explicit overlap; unrelated client follow-up clears it
- `calibration/`: Underlying grader must reject bad input (fail closed)

## DeepEval Status

**Not installed.** This initial offline suite uses custom Python deterministic assertions instead of DeepEval. Semantic answer quality, model-selected tools, retrieved faithfulness, and persisted conversation state remain **NOT RUN** until a separately approved non-production runtime and pinned rubric evaluator are available; this 26-case offline run is not the full Meri release gate.

## See Also

- `CONTRACT.md` - Detailed wire interface and behavior contract
- `runtime/` - Offline custom provider, real-code runner, and tests
- `packages/meriv2-core/test/evals/run-evals.ts` - Source case definitions
- `apps/api/src/meri/evals/government-affairs-fixtures.ts` - GA fixtures
