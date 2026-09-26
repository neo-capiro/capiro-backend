# Phase 2 floor-vote envelope source package

Base: `6977e6f5765413e707952235c3e6ffca20f75520`. This package adds an opt-in observation method for `search_floor_votes`; the model-facing tool, response shape, authorization path, and tool registry remain unchanged. It is source preparation for later QA or versioned projection, not a live-source acceptance.

`executeFloorVotesWithResultEnvelope` runs the existing authenticated handler and wraps its unchanged result. The envelope identifies the local `roll_call_vote` database query and retains vote row IDs and selected source URLs as provenance. It does not claim upstream feed completeness, sync recency, or a source observation timestamp. `generatedAt` is not substituted for freshness.

Coverage is complete only for a validated local query response whose returned count is below the effective limit. A result exactly at the limit is partial because more matching rows may exist; it does not claim that truncation occurred. A zero-result response is `not_found_within_scope` only after the scope and count checks pass. Unresolved bill or member input is `needs_input` with no roll-call query coverage. Conflicting identities, counts, filters, or row shapes remain unknown. Invalid chamber values are omitted from applied scope because the handler ignores them.

The adapter has authored but unrun contract tests for canonical IDs, provenance, bounded coverage, unresolved scope, conflicting data, and observer isolation. Under the current hold, no Jest/Node tests, typecheck, build, database operations, Docker/image work, browser/provider calls, or live QA were performed. `git diff --check` is the only planned static gate. The next gate is source-specific QA against an authorized response before any model-visible exposure.
