# Meri live-v1 capture-binding repair report

Date: 2026-09-28
Branch: `codex/meri-capture-binding`
Required base and starting HEAD: `147fd7648dc50c5929a3eb3031cc927d9bec1194`
Scope: `evals/meri/live-v1/**`, plus this evidence report

## Disposition

The residual offline verifier crashes and correlation gaps identified in `C:/dev/cap-meri-foundation-evidence/review-capture-integrity-report.md` are repaired and covered by direct saved-byte UNIT tests. This is not a live adapter and establishes no live PASS. A purported `LIVE_CAPTURE` still returns BLOCKED until capture, authentication, and source authority verification exists. `UNIT_FIXTURE_NOT_LIVE` remains NOT_RUN when its saved structure and row predicate are otherwise acceptable.

The canonical contract remains valid with exactly 75 cases. The locked prompt/source hash is `acd2a1cf766ad6e988025c4c43235213164926e7036cc8361986916d59963b66`; the fixture hash remains `2a8159d45d512f325539eb700907700ecc16cbc2d6536277adf85d8f49368e61`.

## Before/after direct counterexamples

The before results below are the independent review's direct probes retained at:

- `C:/ProgramData/Hermes/profiles/meri-foundation-review/cache/scratch/review-capture-probe.mjs`
- `C:/ProgramData/Hermes/profiles/meri-foundation-review/cache/scratch/review-binding-probe.mjs`
- `C:/ProgramData/Hermes/profiles/meri-foundation-review/cache/scratch/review-old-capture-probe.mjs`

The after probe is retained at `C:/ProgramData/Hermes/profiles/meri-foundation-p0c/cache/scratch/capture-binding-repair-probe.mjs` and exited 0.

| Counterexample | Before at base | After repair |
| --- | --- | --- |
| Saved trace `transitions:null` with a recomputed artifact hash | Verifier threw `TypeError: Cannot read properties of null (reading 'indexOf')` | BLOCKED: `saved artifact schema violation: trace artifact.transitions: expected array` |
| Source record redirected to a trace-only `phantom-not-in-runtime-tools` call | Accepted as UNIT NOT_RUN with a misleading correlations-validated detail | BLOCKED: `source MA510 lacks source→declared-tool→trace correlation` |
| Sink and declaration switched to a new receipt ID while the effect trace retained the old ID | Accepted as UNIT NOT_RUN with a misleading correlations-validated detail | BLOCKED: exact proposal/effect/receipt correlation is absent |
| Citation changed to `invented-version` / `made-up-page-999` while saved source metadata was unchanged | Accepted as UNIT NOT_RUN with a misleading correlations-validated detail | BLOCKED: citation no longer joins the saved source metadata record |
| A single Standard case-20 capture used traversal ref `../invalid` while Deep/default was missing | Returned NOT_RUN for incomplete matrix and suppressed traversal evidence | BLOCKED for integrity with both `missing Deep/default` and traversal diagnostics retained |
| `artifactRoot` reached through a symlinked ancestor | Accepted and read within the canonical boundary | Bundle integrity failure; all 75 results BLOCKED because `artifactRoot contains a symlink component` |

The repaired direct probe returned PASS 0 for every counterexample. Malformed null/primitive trace records and primitive sink receipt records are also covered in `tests/verifier.test.mjs`; verification returns a report rather than throwing.

## Repair details

- Added strict schemas for parsed trace records, source records nested in the trace, and authoritative sink effect/receipt rows. These schemas run before correlation checks, execution predicates, or case predicates.
- Source evidence now joins citation passage hash, locator, and version to the saved source record; its `toolCallId` must exist in both the trace and declared runtime invocation list. Saved source/tool authorization scopes must exactly bind the saved authenticated session, actor, selected tenant, and selected client.
- Every authoritative sink receipt now joins one exact sink logical effect and one exact trace effect with the same operation, proposal, receipt, and logical-effect IDs. Duplicate receipt IDs and unmatched trace effects are integrity defects.
- Structural artifact and correlation defects are BLOCKED even for UNIT fixtures. Semantic row failures remain NOT_RUN under `UNIT_FIXTURE_NOT_LIVE`. Successful structural checks now say authority remains unverified; they do not claim that correlations or source authority were validated.
- Incomplete mode matrices retain underlying evaluations. If an available variant has a BLOCKED integrity defect, the aggregate remains BLOCKED and includes both the missing-mode and integrity details.
- Artifact reads now reject symlinks in every supplied `artifactRoot` component, open the validated file with the platform's no-follow flag where exposed by Node, validate regular-file status and size on the open handle, read at most 16 MiB plus one detection byte, and compare handle stats after reading. The oversized-file and ancestor-symlink paths are directly tested.

No concurrent filesystem replacement race was attempted. The tests establish ancestor-symlink refusal and handle-based byte bounds; they do not prove complete filesystem race immunity.

## Verification

Focused command, run from `C:/dev/cap-meri-approval-recovery/evals/meri/live-v1`, exited 0:

`node --test tests/*.test.mjs && node validate-contract.mjs && node report.mjs evidence/no-live-run.json C:/ProgramData/Hermes/profiles/meri-foundation-p0c/cache/scratch/capture-binding-no-live-report.json C:/ProgramData/Hermes/profiles/meri-foundation-p0c/cache/scratch/capture-binding-no-live-report.md && node --check artifact-reader.mjs && node --check artifact-schemas.mjs && node --check deterministic-predicates.mjs && node --check verify-capture.mjs && node --check tests/helpers.mjs && node --check tests/verifier.test.mjs && git diff --check`

Results:

- Tests: 35 passed, 0 failed, 0 skipped.
- Contract: valid, 75 cases, frozen contract/fixture hashes above.
- Existing no-live input: valid report with PASS 0, FAIL 0, BLOCKED 0, NOT_RUN 75, score null.
- Syntax checks: all changed `.mjs` implementation/test files passed.
- `git diff --check`: passed.
- Direct repair probe: exit 0; all five residual counterexamples returned BLOCKED with the expected diagnostic and PASS 0.

No install, network, provider, cloud, browser, database, live adapter, seed, fault implementation, monorepo gate, push, merge, deploy, or delegation was performed.
