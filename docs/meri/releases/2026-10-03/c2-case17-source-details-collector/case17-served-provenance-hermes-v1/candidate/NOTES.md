Case17 served-provenance candidate changes

Proposed files (original repository-relative paths):
- evals/meri/live-v1/case17-memory-ui.mjs
- evals/meri/live-v1/case17-saved-checks.mjs
- evals/meri/live-v1/tests/case17-memory-ui.test.mjs
- evals/meri/live-v1/tests/case17-saved-checks.test.mjs

The collector now joins every candidate physical ID to the current six-record fixture owner and requires the API's recordedSource to be exactly { sourceType: "meri_synthetic_fixture", sourceId: that record's ownership.markerSha256 }. It bounds the type and lowercase 64-hex digest, and rejects unexpected fields inside recordedSource. For each UI card it opens its existing exact “Source details” summary, checks visible “Source type: Synthetic fixture” and the exact “Recorded source reference: <marker hash>” text, and captures the card screenshot with those details open. Per-card structured proof is bounded to the expected source type, marker digest, displayed label, and expanded/visible booleans; saved checks rejoin it to the canonical fixture binding in both initial and afterReload rounds.

The saved checker rejects missing, unknown, swapped, duplicated, malformed, hidden, or mismatched source proof, in addition to its existing owner/page/card/screenshot/reload/write checks. Synthetic positive fixtures and the focused browser fixture use the current recordedSource API shape and actual expandable markup. Existing artifact history is not changed or regraded; prior runs lacking this proof do not pass this new checker.

Scope notes / unknowns: production markup in the supplied evidence renders only the recorded source type label and sourceId reference; sourceExcerpt is not part of the visible Source details block. Accordingly this change proves those exact visible fields and does not claim to inspect arbitrary internal payload excerpts, nor does it add a broad URL-leakage rule unsupported by the visible source contract. It does not alter live-capture authority, application code, fixture ownership, thresholds, cost accounting, auth/native-browser guards, write accounting, time/duration/read limits, or zero-write/zero-synthesis behavior. Human rubric/full original prompt remain NOT_RUN. These are proposed files only; parent applies, reviews, and tests them. No tests or live operations were run in this lane.