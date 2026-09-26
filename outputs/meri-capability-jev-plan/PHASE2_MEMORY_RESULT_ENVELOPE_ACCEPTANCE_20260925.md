# Phase 2 `search_memory` result-envelope pilot — local acceptance

Date: 2026-09-25. Scope: additive, opt-in API adapter only. It is not a deployed runtime response change and it does not complete Phase 2 for other read families.

## Change and acceptance

- `executeSearchMemoryWithResultEnvelope` calls the existing authenticated `search_memory` path, wraps the exact legacy object, and leaves the existing tool response and thrown errors unchanged.
- The adapter reports the requested institutional-memory scope, source availability, source-provided coverage/counts/cursor, and source `lastSyncAt` when present. It does not substitute `generatedAt` for source freshness or infer successful coverage from a nonempty payload alone.
- An absent or unrecognized source status is unknown, not a source outage. Only allowlisted internal stop-reason codes appear in the model-facing truncation field. A scoped no-result requires healthy, complete, nontruncated coverage with explicit zero returned and zero matched counts, and a matching empty displayed result array. Inconsistent counts downgrade completeness.
- No JEV selection, capability registry exposure, authorization widening, or production behavior was enabled.

Verification on the integrated worktree: shared package build passed; API `meri-search-memory-envelope.spec.ts` plus shared-envelope API spec passed **17/17**; API `tsc --noEmit --rootDir .` passed; `verify-pe-phase-a-safety.ts` returned `PE_PHASE_A_B_SAFETY_OK`; `git diff --check` passed. An initial focused run exposed an incorrectly permissive empty-result count condition; it was corrected and the full focused set rerun green.

Two actual Hermes Luna text-only, one-provider-call QA sessions reviewed the contract; each reserved 169,064/1,050,000 reference tokens (16.1013%, below the 50% ceiling), reported 2,109 and 2,124 tokens, and ended its owned process tree and transient workspace. Hermes proposed a missing-results regression, now covered here; its claim that fail-closed `partial` for absent results was itself a bug was not accepted. Its unknown-status observation remains explicitly unknown in the source observation, while the top-level outcome is conservatively non-successful `partial`. This was code review without browser or live-source access.

Remaining Phase 2 exit work: validate this contract against a real authorized source response, add source-specific adapters to the other advertised read families, version model-facing exposure and alias parity, preserve complete/partial/unknown distinctions for mixed sources, and perform deployed Hermes QA after an exact release is approved. These tests are local contract evidence, not factual-answer or live-source acceptance.
