# Runtime guardrails acquisition and implementation checkpoint

Original pre-implementation boundary and current adoption record

- Scope: the served MeriV3 assistant turn only. The increment will add one request-local aggregate controller for model attempts, tool dispatches, repeated logical failures, and alternating no-progress observations. It will not create a second runtime or change provider/model/pricing configuration.
- Ownership: existing mode deadlines, round ceilings, synthesis reserve, P0B validation, and write-intent deduplication remain authoritative. The controller may stop new model/tool work, but it cannot approve, execute, or reinterpret a write.
- Identity: a logical tool signature is scoped by actor, tenant, client, run/conversation, tool name, canonical validated arguments, and relevant source/artifact revision. Raw arguments are not exposed by guardrail metadata.
- Atomicity: a provider-emitted batch is reserved before any member is dispatched. If the whole batch does not fit the remaining tool-call budget, none of it starts. This prevents parallel or batched oversubscription.
- Progress: identical failures and repeating A/B failure cycles are bounded across provider rounds. A changed validated input or relevant source/artifact revision creates a new signature and permits a bounded retest. Cursor/page/offset changes are distinct progress; explicitly classified polling is exempt from no-progress cycle detection but still consumes aggregate calls.
- Exhaustion: Stop/cancellation, deadline, model-call budget, tool-call budget, retry budget, or no-progress halt closes acquisition before dispatch. No write starts after closure. Existing supported findings remain available to the existing no-tools synthesis/finalization path, which must disclose partial/uncompleted work rather than claim completion.
- Shared calls: native assistant gather, provider-boundary repair, document-completion repair, coverage follow-up, passage selection, JEV/live repair, and final synthesis are to consume the same turn-local counters where they pass through the available composition seams. Any call path not reached by this increment will be listed as residual rather than claimed complete.
- Compatibility: no API/UI/schema/migration/global-setting change. Existing profile ceilings are reused to derive additive call ceilings. Existing feature flags and rollout behavior remain unchanged.

Foundation mapping

- `C:/dev/cap-meri-foundation/docs/meri/implementation/01-Meri-Foundation-and-Reliability.md`, section 5.3: retain current mode deadlines/round caps; add turn-wide call bounds, scoped/versioned canonical signatures, bounded unchanged failures and batches, cancellation, and synthesis reserve; do not use a tool-name-global breaker; distinguish pagination/polling.
- Same document, CW-07: bound alternating identical read failures, permit a retest after an artifact revision changes input, and report partial findings/uncompleted work truthfully.

Acquired upstream material

Repository: Nous Research Hermes Agent
License: MIT License, copyright 2025 Nous Research
Pinned source snapshots:

- `upstream/hermes-agent/516535b54275e963a82b4c28f866338fb768e7bc/agent/tool_guardrails.py`
- `upstream/hermes-agent/062dc1e7f0f5faa5114b4d98b94c48f5ec5df36f/agent/tool_guardrails.py`
- `upstream/hermes-agent/062dc1e7f0f5faa5114b4d98b94c48f5ec5df36f/tests/agent/test_tool_guardrails.py`
- `upstream/hermes-agent/062dc1e7f0f5faa5114b4d98b94c48f5ec5df36f/tests/agent/test_tool_call_guardrail_runtime.py`
- `upstream/hermes-agent/516535b54275e963a82b4c28f866338fb768e7bc/LICENSE`

The snapshots were supplied locally under `C:/dev/cap-meri-foundation-evidence/`; no network acquisition was performed.

Behavior mapped for adaptation

- Canonical, non-reversible signatures over tool plus normalized arguments.
- Pre-dispatch hard stop after an unchanged failure threshold.
- Detection of repeating multi-call cycles rather than only consecutive identical calls.
- Exemption of legitimate pollers and reset/new-experiment behavior after a meaningful revision.
- Runtime composition tests proving blocked work is not dispatched.

Adaptation boundary

The TypeScript implementation will be a substantial Meri-specific adaptation, not a line-for-line port. Hermes is per-turn and tool-centric; Meri requires actor/tenant/client/run scope, revision-aware signatures, aggregate batch reservation, existing P0B result semantics, and deterministic terminal synthesis. The full MIT notice is retained in the repository's bounded `THIRD_PARTY_NOTICES` file, and this record maps the acquired behavior to tests and implementation.

Implemented mapping

- `meriv3-run-budget.ts` owns request-local admission, canonical SHA-256 signatures, aggregate tool/model/retry counters, atomic batch reservation, source/artifact revision extraction, identical/A-B cycle detection, explicit pending-poll exemptions, Stop/deadline closure, and a dedicated finalization reserve.
- `meriv3-assistant.service.ts` composes that controller into the served assistant loop, automatic document reads, coverage reads, live repair, passage/client-fit/JEV selection, status-provenance reads, and final synthesis. A closed controller returns provider-call outputs without dispatching them, skips later write/page-write paths, and preserves projected ledger evidence for a truthful partial synthesis or deterministic bounded fallback.
- `openai-responses.client.ts` accounts real OpenAI wire attempts, including compatibility retries and recursive research critic/finalizer calls, against the same turn controller.
- Existing P0B provider-response validation still rejects incomplete or mixed-malformed batches before dispatch; existing per-batch write-intent deduplication and action authority remain unchanged.

Tests mapped to acquired behavior

- `meriv3-run-budget.spec.ts`: unchanged A/B failure cycles, changed artifact revision retest, pagination/polling progress, atomic parallel-batch oversubscription, Stop, shared retry accounting, and synthesis reserve.
- `meriv3-assistant.service.spec.ts`: served-runtime alternating failure termination with partial synthesis; provider-batch oversubscription with zero dispatch; existing Stop mid-batch behavior; existing malformed/incomplete P0B batches with zero dispatch.
- `openai-responses.client.spec.ts`: a provider compatibility retry cannot exceed the turn-wide retry ceiling.

Actual exhaustion paths

- `tool_calls`: the emitted batch is larger than the remaining aggregate tool capacity, so no member starts.
- `retry_calls`: repeated canonical tool signatures or provider retries consume the shared retry ceiling; the rejected retry does not start.
- `model_calls`: non-final model work exhausts its profile-derived allocation. Reserved synthesis/finalization attempts remain available.
- `no_progress`: three unchanged laps of a failure cycle of period one through four close acquisition after retaining completed projected evidence.
- `cancelled` / `deadline`: the request signal or existing absolute turn deadline closes all admission, including finalization. Deadlines are not reset.

Residuals / non-claims

This is the first native aggregate-bound increment, not completion of Foundation 5.3. It does not add token or cost reservation, cross-process/durable budget state, child-run budget delegation, queue-level admission, or tenant-wide metering. Legacy `RequestScopedLlmClient` providers are charged as logical model calls at the available decision/revision seams; opaque provider-internal retries outside the native OpenAI and JEV fetch boundaries are not individually visible. Detached work outside the served MeriV3 assistant turn and budgets surviving process restarts require separate increments.

## Concrete integrated source record

Disposition at Capiro source `71efe006a7c120f157a90a6dac6adaf743353937`: `ADAPTED_INTEGRATED_BOUNDED`. Original implementation `854a5fc30b2e88badc986134355ee1969699649e` is integrated through replay `f2151de654926ef8950029cc9226aceff7426a02`; terminal-control repair is integrated through replay `170f73c43e0583f27eb8aad0ddaec085cbc009d2`. This is not Foundation 5.3 PASS.

Exact donor hashes:

- both pinned `agent/tool_guardrails.py` files: SHA-256 `cbbf453b3fa2c8f6080b262117d40de430c4c469b28beb4630169bb43abcb0f4`
- `062dc1.../tests/agent/test_tool_guardrails.py`: `c67c7288fa65feab2f8201a955a419dc90c89100f14585f780f56a8d12cb8af9`
- `062dc1.../tests/agent/test_tool_call_guardrail_runtime.py`: `1f05878c366da3e56bdcd53cc5cd35958bc69540455020ebaecf83bbc77748c3`
- pinned MIT `LICENSE`: `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6`

Current Capiro target SHA-256 values:

- `meriv3-run-budget.ts`: `fe79cce7339e4074742613a1d8397c9fca6e498484aaa9e263c398243c052b75`
- `meriv3-assistant.service.ts`: `2e15bfd7e86f4ed20e9f61af70185316bd365abfd091022d40b3706bffe184cd`
- `openai-responses.client.ts`: `82a84aa72b3525c0f24be62ecd39d75aa6800e7d075da2155a4120abde6f8df2`
- `meriv3-run-budget.spec.ts`: `3a3df6decfb0f035db2279a5209a0cf52737afa029f6bb9d2bd0cda37b71dbcc`

The donor's canonical signature and unchanged period-1..4 cycle behavior map to `bounds an unchanged alternating A/B failure cycle across rounds`; progress/reset behavior maps to `a changed artifact revision is a new bounded experiment` and `changed pagination routes and explicit pending polling do not false-block`; runtime admission maps to `rejects a parallel/provider batch atomically when it would oversubscribe`, `Stop closes acquisition and permits no later tool admission`, and the actual assistant test `bounds alternating unchanged read failures across real provider rounds and synthesizes retained partial evidence`. No donor test code or fixture was copied.

Observed saved receipts: original focused implementation reported 6/6 run-budget tests, one provider retry test and five assistant composition tests; independent repaired status-provenance review at `1f6dcdfa02ef93d2443638eac56a1775e7bff809` passed 10 core + 19 runtime + 81 assistant tests and 22 additional direct probes. See external `runtime-bounds-report.md` and `review-status-provenance-residual-report.md`. These are focused local receipts, not live cases 71–72.

License/distribution: this is a substantial behavior adaptation, not copied Python or a package dependency. Root `THIRD_PARTY_NOTICES` lists H1 and retains the complete pinned MIT text for source/product distributions containing the adaptation.

Rollback owner: File-01 lead / P1C native-runtime owner. Revert the H1 replay commits as an application rollback; no H1 schema/dependency was added. Preserve existing action receipts and do not restart exhausted work as a new effect. Upstream updates require a new explicit pin/test mapping; never silently move either Hermes pin.
