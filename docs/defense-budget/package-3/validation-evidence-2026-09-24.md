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
| Congressional resolver exact-match regression                            | PASS   | Focused resolver suite: 7/7 tests passed, including a manifest-bound packet with exact source identity, routing/profile bindings, packet-byte SHA-256, and a persisted parser-artifact proof resolved to `matched`. The success path is offline-only and performs no production registration, database write, backfill, publication or notification. |
| Targeted TypeScript gates                                                   | PASS   | `tsconfig.budget-parser-router.json`, `tsconfig.non-rdte-phase-5.json` and `tsconfig.defense-budget-ingestion-manifest-v1.json`. The Phase 5 config now carries the Nest decorator compiler settings required by its existing controller scope.  |
| Trusted runtime-source mirror                                               | PASS   | The complete `apps/api/src/defense-budget` tree is byte-identical to `apps/defense-api/runtime-source/defense-budget`. Package 3 repaired pre-existing mirror drift before release.                                                              |
| Patch hygiene                                                               | PASS   | `git diff --check`.                                                                                                                                                                                                                              |

## Congressional production gate

Congressional semantic production remains quarantined/blocked because a governed production structured-table provider, persisted production SourceDocument identity, mixed-family completeness, independent review and operational approvals remain absent. The new exact-match resolver test proves the handoff seam against offline fixtures; it does not establish production qualification or publication from congressional semantic artifacts.

## Source control and build release

- Pull request [#1774](https://github.com/neo-capiro/capirov2/pull/1774) merged to GitHub `main` at `f3c0bb74ba97541aba2676552a77539e97bd02d6`; local `main` was fast-forwarded to the same commit.
- GitHub-hosted checks did not start because the repository account reported a billing/spending-limit problem. This is recorded as CI infrastructure failure, not a passing CI signal. The locally executed gates above and the isolated AWS qualification below are the release evidence.
- AWS CodeBuild `capiro-build-intel-api:d4a8af42-9d81-49d9-95c1-2e331c02deb7` resolved the exact merge commit and succeeded.
- The native ARM64 API image is `sha256:99db81bbd38cfdd21c046f038c05d96a85b6fffe95da975e1aac63282e8bf6c6`; the drain/qualification image is `sha256:5b6739e35336845668e3731bbb77e1babc0a4e0f53e3fc58f743ff381dba521e`. The API's 32 layers are an exact prefix of the drain image's 51 layers.

## Isolated release qualification

Both one-off tasks used qualification task definition `capiro-dev-defense-budget-qualification:34`, local Postgres and local MinIO sidecars, and the exact official FY2024 source. Neither task used production Aurora or canonical publication paths. Both qualification containers exited zero.

| Run                      | Formal verifier                    | Decision                     | Assertions | Omissions              | Exact artifact SHA-256                                             | Substantive SHA-256                                                |
| ------------------------ | ---------------------------------- | ---------------------------- | ---------- | ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `package3-f3c0bb74-run1` | `RELEASE_IMAGE_QUALIFICATION_PASS` | `REVIEW` / `TERMINAL_REVIEW` | 522        | 417 `ambiguous_layout` | `07e834a4a91b84cd1b60d629b578aaee0df4d91af2784906964e53ad5f2573f1` | `7cac359b01ae245d713f633345a2e0a9a3138b07ca62d3fa3762942205e71a0b` |
| `package3-f3c0bb74-run2` | `RELEASE_IMAGE_QUALIFICATION_PASS` | `REVIEW` / `TERMINAL_REVIEW` | 522        | 417 `ambiguous_layout` | `7aa6b14ac538ca6da59c3c26dd2f241fc69e26483bc7378a7d4259590c526e41` | `7cac359b01ae245d713f633345a2e0a9a3138b07ca62d3fa3762942205e71a0b` |

The exact byte hashes differ because run-scoped identities remain part of the exact artifact. The versioned substantive hashes match, which is the cross-run determinism gate. Both reports had `dbverifyOk: true`, DB decision `REVIEW`, target PE `0601102A`, and FY2024 total `296.67` million.

## AWS deployment evidence

Audit scope: account `967807252336`, region `us-east-1`, cluster `capiro-dev`.

| Runtime        | Result                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API service    | Task definition `:445`; rollout `COMPLETED`; desired/running/pending `2/2/0`; deployment count 1; zero failed tasks.                                                                                      |
| API identity   | Both running tasks report `HEALTHY`, exact API digest `sha256:99db81bbd38cfdd21c046f038c05d96a85b6fffe95da975e1aac63282e8bf6c6`, and task-definition `GIT_SHA` / `RELEASE_SHA` equal to the merge commit. |
| Load balancer  | Both replacement targets reached `healthy`; ECS reached steady state.                                                                                                                                     |
| Drain          | Task definition `:28` points at the qualified drain digest, keeps `echo no-op-default-command`, and has zero running or pending tasks.                                                                    |
| Qualification  | Task definition `:34`; both one-off tasks stopped normally with qualification-container exit code 0; zero running or pending tasks remain.                                                                |
| Canonical data | No production manifest, replay, drain, canonical write or snapshot activation was started.                                                                                                                |

Machine-readable identifiers and hashes are in `release-evidence-2026-09-24.json`.
