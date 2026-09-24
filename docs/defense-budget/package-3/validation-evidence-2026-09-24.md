# Package 3 validation and runtime evidence

## Confirmed implementation contracts

Repository inspection confirms the following contracts in the Package 3 working tree:

| Area                         | Confirmed behavior                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable family routing       | RDT&E uses its semantic artifact factory; procurement, O&M and MILCON resolve to the proof-bound non-RDT&E factory. Other family names resolve to no family-specific factory.                        |
| Non-RDT&E parser proof       | Selected parser-run identity is recomputed; an exact persisted parser result is located and verified before the semantic artifact is persisted. Missing or mismatched identity/proof fails.          |
| Durable artifact integrity   | Serialized semantic artifact bytes are put through the immutable store, and the store's byte SHA-256 must match the expected byte hash.                                                              |
| Qualification comparison     | `qualification_artifact_projection_v1` defines the stable substantive projection and SHA-256; exact artifact-byte SHA-256 remains independent.                                                       |
| Scoped-fact publication plan | Pure deterministic plan construction emits `reviewed_partial` / `partial` rows and exclusions, bound to cohort and expected active snapshot. It contains no canonical write or activation operation. |

## Executed validation

| Gate                                                                        | Result | Evidence                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package 3 focused regression set                                            | PASS   | 9 suites / 108 tests after final formatting: durable RDT&E and non-RDT&E factories, composed artifact proof binding, lifecycle account propagation/replay, scoped publication planning, handoff launch, re-extraction and qualification hashing. |
| Full non-RDT&E family suite                                                 | PASS   | 32 suites / 392 tests covering procurement, O&M, MILCON, P-1/P-40, O-1/OP-5, C-1/DD1391 and the proof/completeness gates.                                                                                                                        |
| Full parser-router suite                                                    | PASS   | 24 suites / 274 tests. The first run exposed an unsynchronized local Python parser environment; `uv sync --locked` in `apps/defense-budget-parser` repaired that environment, and the three real-runtime seam tests then passed.                 |
| Qualification hash and scoped publication regressions after final hardening | PASS   | 2 suites / 30 tests, including semantic tuple-order preservation and persisted scope-key binding.                                                                                                                                                |
| Targeted TypeScript gates                                                   | PASS   | `tsconfig.budget-parser-router.json`, `tsconfig.non-rdte-phase-5.json` and `tsconfig.defense-budget-ingestion-manifest-v1.json`. The Phase 5 config now carries the Nest decorator compiler settings required by its existing controller scope.  |
| Trusted runtime-source mirror                                               | PASS   | The complete `apps/api/src/defense-budget` tree is byte-identical to `apps/defense-api/runtime-source/defense-budget`. Package 3 repaired pre-existing mirror drift before release.                                                              |
| Patch hygiene                                                               | PASS   | `git diff --check`.                                                                                                                                                                                                                              |

## Congressional production gate

Congressional semantic production remains quarantined/blocked because governed structured-table inputs and the persisted proof inputs needed for production qualification are absent. This release makes no claim of production qualification for congressional tables or publication from congressional semantic artifacts.

## Supplied read-only AWS rollback baseline

Audit scope: account `967807252336`, region `us-east-1`, cluster `capiro-dev`.

| Task definition     | State               | Digest             |
| ------------------- | ------------------- | ------------------ |
| API `:443`          | Desired/running 2/2 | `sha256:445a9515…` |
| Drain `:27`         | Parked; no service  | `sha256:8ac22557…` |
| Qualification `:33` | Same drain digest   | `sha256:8ac22557…` |

These runtime facts are supplied as the current live read-only audit baseline. They do not establish a Package 3 rollout, canonical activation or congressional qualification. Refresh the read-only audit before any later operational change.
