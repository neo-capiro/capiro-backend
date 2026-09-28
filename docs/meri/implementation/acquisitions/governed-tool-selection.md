# H4 governed tool-selection adoption record

## Disposition

Current integration source `71efe006a7c120f157a90a6dac6adaf743353937`: `CANDIDATE_HELD_NOT_INTEGRATED`.

The served candidate was inspected only as Git blobs at `9a651d5fae1f240a36fc9b04c7007d76d8cba172`. Its selector ancestry includes `b7ad92e260c98bebef95583b91857758464cbfc7` and replay `d2675758b5c19c373671322a6634b42e9f89b5ba`; served-procedure work at `5a1985ce9ccf2f6e33a91b95fc0b36a85adfc645` is also in that candidate line. The files `meriv3-governed-tool-selection.ts` and `meriv3-procedure-guard.ts` are absent from current integration. No candidate file or notice was copied into the current product by this bookkeeping change.

Acquired source plus a held candidate is not adoption PASS. Foundation 7.1 still requires integrated progressive discovery, actual provider-schema evidence, required-capability recall, authorization, source coverage, and privacy/freshness qualification.

## Exact donor source

Project: Nous Research Hermes Agent
License: MIT License, Copyright (c) 2025 Nous Research

Original H4 source pin:

- `NousResearch/hermes-agent@516535b54275e963a82b4c28f866338fb768e7bc/tools/tool_search.py`, SHA-256 `1f3598a0cd221e77132bc20636e57bc10dc7fb6c2fc12b93f4427bc9019eac44`
- `.../tools/tool_search_catalog.py`, SHA-256 `7ecbeef40ce88a2932fc261b881923a808004876d8425e668c3c829162552722`
- `.../tools/tool_search_validation.py`, SHA-256 `495d75b44fcaa1f694ac9dc3cae86d5d22d1d964f76c46df022b345fe818dbc0`
- `.../LICENSE`, SHA-256 `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6`

Separate later test pin required by Foundation 9.5:

- `NousResearch/hermes-agent@062dc1e7f0f5faa5114b4d98b94c48f5ec5df36f/tests/tools/test_tool_search.py`, SHA-256 `abd8d6ebdaf8a0364f695caa3f40fa5792e00c185a2258b003df9fe6441d0564`
- `.../test_tool_search_context_provider.py`, SHA-256 `3d2cffb736714e1984e20f29f18694a921101934654b85174f9a0dcce303ad5c`
- `.../test_tool_search_multiquery.py`, SHA-256 `e67020d8ae3c886fece392180d1d31a7775ecd070af2be58257dd2084c8bae09`

The pins remain separate. The candidate used the `516535...` source; the `062dc1...` tests are translated comparison specimens, not a replacement source pin.

## Candidate adaptation determination

The candidate is a concept-level TypeScript adaptation, not copied Python and not a dependency. It translates live request-scoped catalog construction, required ambient capability retention, exact-name scope intersection, unknown-name rejection, canonical dispatch, bounded selection, and redacted event intent into Capiro's registry/authorization seam. This is deliberate donor-informed adaptation, not a conclusion based on one phrase.

The candidate deliberately does not implement Hermes's provider-driven `tool_search` / `tool_describe` / `tool_call`, deferred searchable catalog, later-round schema loading, or bridge invocation. Its eight-name deterministic plan fallback is static selection. The current integration has neither the candidate nor full progressive discovery.

## Candidate targets and hashes

SHA-256 over exact Git blobs at `9a651d5fae1f240a36fc9b04c7007d76d8cba172`:

- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-governed-tool-selection.ts`: `928f3e8c09d57d45607eda77b30e48846cbdb0060c17064103accfa2abe3b9a5`
- `apps/meriv2-orchestrator/src/meri/meriv3/meri-semantic-tool-gateway.ts`: `c40b80b3f9c93fbf89c0ba1e1d54e820665b7147862d945d2f4ed3d6cd87e017`
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts`: `0e4a052a22e8e432a5c3743ad4145a95ddbf74793d9e3d09497fce6ba96d2ee3`
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-governed-tool-selection.spec.ts`: `5a70fad9ab58938cbac6480b64bedbd70d146a186a23689c4ff082f3817ff96d`
- `apps/meriv2-orchestrator/src/meri/meriv3/meri-semantic-tool-gateway.spec.ts`: `a362f0195780b75eeb9e179fd9edf2b2b876b9b279009f5d0426d2cc1e308570`
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.spec.ts`: `efb7641321c9ac787b9694d9362049c67f62b8d53c874c131a0cf08f16d0abcb`

## Donor-test mapping and observed candidate receipts

- `test_tool_search.py` -> candidate `meri-semantic-tool-gateway.spec.ts`: `enabled mode exposes only the semantic proposal for an allowlisted tenant` and `protects every authorized required capability without recreating unavailable names`.
- `test_tool_search_context_provider.py` -> candidate `meriv3-governed-tool-selection.spec.ts`: `protects evidence, document, coverage, and exact trusted-procedure capabilities` and `does not name-enable a capability from user text`.
- `test_tool_search_multiquery.py` -> candidate gateway test `bounds fallback discovery and intersects it with the live authorized surface`; unlike the donor, this remains static and does not provide multi-query provider discovery.

Saved observations only: selector candidate `b7ad92e...` passed 132 tests across three focused suites; its package suite reported 1,242 passed and two skipped. Served candidate `5a1985ce9...` reported 141 orchestrator tests across four suites plus 48 API and 15 governed-context tests. Independent review then reproduced user-visible/persisted leakage of an undeclared provider-controlled name and a meetings-reader/served-procedure gap; the broader `9a651d5fa...` Git candidate was not rerun for this record. See `governed-selector-completion-report.md`, `review-governed-selector-report.md`, `served-procedure-completion-report.md`, and `review-served-procedure-report.md` under the external evidence root.

## Notice, rollback, update owner, and remaining gap

The held candidate line contains a Hermes notice, but current integration does not distribute the H4 candidate. Therefore this record does not add H4 to current `THIRD_PARTY_NOTICES`. If a reviewed H4 adaptation is integrated, the integration commit must add the exact pin/files to that notice while retaining the existing full MIT text.

Rollback owner: File-01 lead / P1B registry-selector owner. Current rollback is "do not integrate or enable the candidate"; existing selector flags remain unchanged. If later promoted, rollback must turn off new admissions and revert the application slice without replacing the canonical registry or authorization gateway.

Update policy: no silent pin upgrade; compare a new donor pin and tests in a new record.

Remaining mandatory work: integrate a reviewed candidate; repair private unknown-name propagation and required meetings coverage; prove actual current provider schemas, progressive search/describe/load/invoke or an explicitly approved equivalent, required-capability recall, current authorization/freshness, source coverage, telemetry privacy, invocation freshness, and rollback. H4 is not conditionalized and is not PASS.
