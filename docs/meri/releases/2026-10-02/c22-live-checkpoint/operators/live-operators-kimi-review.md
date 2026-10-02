I'll review the source files provided for the live operator gates and related scripts. Let me analyze them carefully.

**Review Complete - PASS**

**Concrete findings:**

1. **live-operator-gates.mjs (lines 47-49)**: The `assertSameRelease` function uses `JSON.stringify` comparison for deep equality. This is deterministic for the specific objects being compared (release pins with sorted keys) but could theoretically fail if object key ordering differed. However, the code controls all inputs, so this is acceptable within scope.

2. **run-case17-authenticated-v4.mjs (line 92)**: `summary.grading = gradeCase17CapturedOutcome(outcome)` is called before visual review, storing deterministic grading. This is correct - the source-owned collector's `currentCase17CaptureAuthority` returns a WeakMap-held capability that cannot be serialized, ensuring grading requires the same process.

3. **run-case01-authenticated-v2.mjs (line 129)**: The `outcome?.synthesisSubmissionCount ?? (summary.nativeExecutionInvoked?null:0)` pattern correctly returns `null` (not `0`) when execution was invoked but outcome is unavailable, as specified. This honest reporting of uncertain state is preserved.

4. **All three files**: Proper session cleanup in `finally` blocks with independent revocation verification. Each checks actual session status after revocation attempt.

5. **seal-local-live-inputs.mjs**: No external calls; pure local file operations with `{flag:'wx'}` exclusive creation preventing overwrites.

**One minor observation (non-blocking):**

- **live-operator-gates.mjs (line 78)**: `stableHash` uses canonical JSON serialization. The implementation correctly sorts object keys, handling the deterministic hashing requirement for sourceMap/binding comparisons. The regex `/^\uFEFF/u` in `readJson` properly handles BOM.

**PASS** - All source-owned API contracts are preserved: zero-turn UI slice for case17, one-turn bounded capture for case01, WeakMap-held authorities, immutable receipts, and honest timeout handling with `null` for uncertain `turnsSent`.
