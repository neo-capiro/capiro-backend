# H2 context-compaction adoption record

## Disposition

Status at Capiro source `71efe006a7c120f157a90a6dac6adaf743353937`: `ADAPTED_INTEGRATED_BOUNDED`.

The initial implementation `a9f5819557f6a7fde1c839f86a3504a44a087f34` was rejected as sufficient proof. Original repairs `8ee5c2e0b601d7f53a166735cb66075002cf37a5`, `0bb847e7d91d48fccebf1d323e4de35e3af35a26`, `89b3612073809fd894ffc8b69341f27b8028c15c`, `f910369fcef9802509670140a792ff96e183fcf6`, and `72519696d84ebb5b83a39c357524d68a5d1fe978` were integrated through replays `085db54ed09eb007277efab00c937a5721985ee0`, `2d1b33ff95393818255d33d49eab91a9c49f5d53`, `35e76021b908f430d74ac9885f917b5cefde2d74`, `3f5adcf1c1b44898f89419c3d78c47343d288df2`, `9df51eb883858de00f32f8f77b6b7d92adb6fa2e`, and `a884d6445344fdce1ab94f3d7abe0589677dbf4c`. The integrated behavior is limited to a bounded character envelope for persisted replay history plus protected state, a complete contiguous user/assistant suffix, exact PostgreSQL compare-and-swap publication, and truthful partial/omission records. It is not full Foundation 5.4.

## Exact donor source

Project: Nous Research Hermes Agent
License: MIT License, Copyright (c) 2025 Nous Research

Original H2 source pin (kept separate):

- `NousResearch/hermes-agent@516535b54275e963a82b4c28f866338fb768e7bc/agent/context_compressor.py`, SHA-256 `2414082ba0a3984412d544ec22073a3ee6a89a4dbcc46037a2628f6e7b84f837`
- `NousResearch/hermes-agent@516535b54275e963a82b4c28f866338fb768e7bc/agent/conversation_compression.py`, SHA-256 `9cfc32dfefade45d49a1b37691be4d64dd2d416792bb4da8ca418b8f80051e48`
- `NousResearch/hermes-agent@516535b54275e963a82b4c28f866338fb768e7bc/LICENSE`, SHA-256 `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6`

Later test snapshot (not substituted for the original source pin):

- `NousResearch/hermes-agent@062dc1e7f0f5faa5114b4d98b94c48f5ec5df36f/tests/agent/test_compression_adoption_preserves_live_tail.py`, SHA-256 `28f8b154252ed717ab5269eafaf4b3a47affbbc02b00ae9a101d19235c139694`
- `.../test_compression_stall_deterministic_fallback.py`, SHA-256 `698c1d3f0f5f1e19e06133884b844c1cfb95b38ddfb43845b5e0406668eb6f65`
- `.../test_compressor_tail_cut_tool_pair_floor.py`, SHA-256 `feba841ffe8bcd42cc661b00eb557221f7ef442c9095aa3fd3011ad708917d8e`
- `.../test_context_compressor_cross_session_guard.py`, SHA-256 `4819a1b14b6dd06aa4e0103935f507a2ca3b4840a2a062861c446b1a0a16632c`
- `.../test_steer_compaction_persistence.py`, SHA-256 `b8e3f01dabb2830121c2f6ff0535a97ecbb6fe44197025023ac7dec471d8fbd6`

All bytes are local under `C:/dev/cap-meri-foundation-evidence/upstream/hermes-agent/<pin>/`; none was executed for this record.

## Adoption determination

This is a behavior adaptation, not copied Python and not a dependency. The implementation intentionally translated donor invariants after reading the source and later tests: protect a live tail, cut only at complete protocol units, preserve steering/objective state, bind state to the current session scope, and use a deterministic fail-closed fallback when summary authority is unavailable. Capiro replaced Hermes's process/session and summary-model machinery with native TypeScript, existing conversation rows, opaque source/proposal receipts, current-client validation, and a PostgreSQL CAS fence. The deliberate source-and-test translation is more than a shared phrase or superficial similarity, so H2 is included in the existing Hermes MIT notice.

## Capiro targets and hashes

All hashes below are SHA-256 at Capiro source `71efe006a7c120f157a90a6dac6adaf743353937`.

- `apps/api/src/meri/meri-compaction.helpers.ts`: `86e0766a6ec3adb739b71c708fb9117f6fded4a16bf2571bd99ec235b31b2f3c`
- `apps/api/src/meri/meri.service.ts`: `bde8f24f64b3399fc8b7444b20f9c6a6feef971e68ffbc65044a434ad3a2b6f9`
- `apps/api/src/meri/meriv3-proxy.service.ts`: `65e1c4fa255dec133967cb0be399b22f1fd895a429081b30c3c6a4085afd133d`
- `apps/api/src/meri/meri-compaction.helpers.spec.ts`: `add5018254c80385d13c8d4c82332bdbc91d2c358ab5bce8c689e316902a1afe`
- `apps/api/src/meri/meri-protocol-compaction.service.spec.ts`: `7be0afac33991e0f0339fb2d3cf4de7d4f07e2a0d15034815ab3f1cef98091ac`
- `apps/api/src/meri/meriv3-proxy.service.spec.ts`: `95d4692f31a01c97353ce5d0760863d87a2f27ecd71df321eca9e08ea9601dd3`

## Donor-test mapping

- `test_compression_adoption_preserves_live_tail.py` -> `MeriService protocol compaction commit / allows only the concurrent boundary-CAS winner to report a committed compaction`; Capiro never rewrites the live tail.
- `test_compressor_tail_cut_tool_pair_floor.py` -> `protocol-safe compaction receipts / moves the watermark backward instead of splitting a user/assistant protocol unit` and `retains a contiguous newest suffix instead of backfilling around an oversized middle unit`.
- `test_context_compressor_cross_session_guard.py` -> `fails closed when historical metadata cannot prove the boundary or current client` and the actor/client/revision/boundary publication test.
- `test_steer_compaction_persistence.py` -> `preserves objective, corrections, source versions, partial status and pending proposal handles`.
- `test_compression_stall_deterministic_fallback.py` -> `keeps bounded state across many short turns without another model call`; no donor summarizer is invoked and unproved history is partial.

Observed receipts, not a new run: integrated source `a884d6445344fdce1ab94f3d7abe0589677dbf4c` passed 145 API tests across four suites and full API typecheck; independent review passed the exact notice boundaries and a 4,864-case allocation grid. Earlier native PostgreSQL 16 evidence passed 19 exact revision/fence checks. See `C:/dev/cap-meri-foundation-evidence/foundation-pr-body-1219.md`, `review-boundary-followups-report.md`, and `compaction-pg-revision-repair-report.md`.

## License, distribution, rollback, and update owner

`THIRD_PARTY_NOTICES` identifies H2 and retains the complete pinned MIT text. It is the distribution notice for repository/source and product distributions that contain this substantial behavior adaptation; the donor Python files are inspection evidence and are not distributed as runtime files.

Rollback owner: File-01 lead / P1C API conversation owner. Roll back the integrated H2 chain as an application change while retaining conversation rows; no H2 schema or dependency was added. Before rollback, confirm no caller relies on `metadata.meriProtocolCompaction`; never reinterpret protected receipts as source authority.

Update policy: a future donor review records a new pin and mapping. It must not silently replace either `516535...` source or the separate `062dc1...` test snapshot.

## Remaining mandatory gaps

Not implemented by H2: durable provider call/output pairing; token/current-provider envelope accounting; source-current-authority hydration; semantic revocation of source text quoted by users; whole-request system/schema/evidence/output reserve; live-provider qualification. Cases 25, 42, 71 and CW-06 remain unexecuted as original authenticated acceptance. Bounded H2 integration is not a PASS for Foundation 5.4.
