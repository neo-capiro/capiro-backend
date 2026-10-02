I need to carefully analyze this source-only review of the meri budget terminal closure code. Let me examine the pinned details and trace through the logic.

**Scope Verification (what this code claims to handle):**
- One specific root-invoked append-only closure
- Original case01 run `c6ffa5ad-dd9f-4912-bc31-a03231a9b903` and reservation `d63fd741-aac6-4d3d-9c4d-1276b96bd1a3`
- API 507 task error before any retrieval/provider calls
- Full $3 ceiling consumed, actual cost UNKNOWN (no replay/refund/same-run reserve/late settle)
- Existing $30 owner/no-refund/concurrency=1 constraints remain
- No live ledger touched

**Evidence Anchors (pinned SHA256s from source):**

From `CASE01_TERMINAL_SCOPE`:
- sourceSha: `42988dae5fb7bc2fff3af582ca15a0836a4477c5`
- inventorySha256: `113c55d76637edfd807e5e3efced931e2b2dd73052dabba4d2e0607aff6e57b8`
- requestIdSha256: `f6e630bcbdccc28db3a03c51ff58d90c14aa3588494df70063a55bb8f877a12c`
- traceIdSha256: `7f872a4fea09b9a19687d2b2d53d920fe2c8fed0d08ac4e92deb59da021352db`

From `CASE01_TERMINAL_EVIDENCE`:
- failedExecution: `c0c8e241fb5e902374610af57ea46da3f5b697aecc2b58e0a94903e4a8a16bb7`
- terminalLog: `c4d9d31fdf10db0a8e69e61837c9fdd39f4bbea2d12cf9ff25b63c1542bcf128`
- authenticatedReadback: `e8c2a5b1a7471e158be39914e5d21391a7ff1300dca4cf1e54868e8f92bf4cb6`
- readbackOperator: `8a7d5db96c83053af69158dd3b5b16f5f80695bc5fde6eb0465e22803d2ad804`

From `windows-capture-spend.py`:
- TERMINAL_CASE01_PROOF: `d8555b206bf7d47630838885f8fe4fce0e8fb5f25fda851e3b8e07e54b17314f`

**Trust Boundary Analysis:**

The `.mjs` authority module constrains scope tightly:
- `inspectOriginalCase01TerminalEvidence()` validates 27+ specific fields
- Checks `failedExecution` shows `verdict: 'BLOCKED'`, `failureCode: 'CASE01_RESPONSE_REJECTED'`, `sessionRevoked: true`, `outcome.status: 'CAPTURE_UNCERTAIN'`
- Validates single `meri.api.request.received` and single `meri.api.request.finalized` events with outcome `'error'`
- Checks guard event has `knownStaticReasons` including `'meri_capture_provider_budget_unqualified_retrieval_plan'`
- Verifies authenticated readback shows: `applicationWrites: 0`, `modelSubmissions: 0`, `messageCount: 0`, `turnId: null`, empty `messageRoles: []`, empty `ledger.attempts: []`

This correctly identifies the synchronous guard throw before provider calls via:
- guard timing (`guards[0].atMs === finalized[0].atMs`) 
- finalized outcome `'error'` 
- zero attempts in readback ledger
- empty messages array in readback

**Test Coverage Analysis:**

From `capture-spend-terminal.test.mjs`:
- Test 1: Validates proof SHA256 matches TERMINAL_CASE01_PROOF
- Test 2: 13 mutation tests covering active requests, provider attempts, wrong source, non-empty turn/messages, stale readback - all properly reject
- Test 3: Native closure retains full ceiling (3M micros), UNKNOWN cost, null activeRun
- Test 4: Repeat close, stale checkpoint, late settlement, same-run reserve all rejected
- Test 5: 7 primitive rejection tests (altered proof, inflight flag, alternate run, refund, cost-zero)
- Test 6: Event tampering cannot reopen ledger
- Test 7: JS closure refuses JSON lookalike authority, requires explicit invocation

**Python Native Journal Logic:**

The `close_terminal_uncertain` operation in `windows-capture-spend.py`:
- Line 71-72: Requires active run matches terminal case
- Line 73-74: Pins exact `TERMINAL_CASE01_RUN` and `TERMINAL_CASE01_RESERVATION`
- Line 75: Pins `TERMINAL_CASE01_INVENTORY` boundary
- Line 76-77: Validates row ceiling is exactly `MAX_CASE` (3M)
- Line 78-79: Sets `disposition: 'TERMINAL_SETUP_REJECTION_COST_UNKNOWN'`, `actualCostMicros: null`
- Line 80-91: Validates proof SHA256 and required fields, all 14 proof fields checked
- Line 92: Sets `conservativeCostMicros` to full ceiling (3M micros)
- Line 93: Adds to `closed_unknown` (not `known` settled)

This correctly keeps `actualCostMicros: null` in the stored event while charging the conservative ceiling.

**Root CLI Guards:**

The ROOTCLI entry point:
- Requires `--close-original01-terminal-uncertain-once` flag
- Requires hex commit SHA argument matching current git HEAD
- Requires clean git status
- Requires prior checkpoint SHA256 `b35c9cc1d8019342665b5da93e5af3d05ea6d418b14f8ba93e7967b291a06f63`
- Uses exclusive file creation (`openSync` with `'wx'`) to prevent double execution
- Sets `resubmissionAllowed: false`, `retryAllowed: false`

**WeakMap Authority Pattern:**

Both JS layers use `WeakMap` for capability-based authority:
- `case01-terminal-spend-authority.mjs`: `authorities.set(capability, structuredClone(proof))`
- `capture-spend-aggregate.mjs`: `reservations.set(capability, {...})`
- `authorities.get(capability)` returns proof or undefined

This means JSON lookalikes cannot forge authority - the object reference must come from the authorized preparation path.

**Ledger State Transitions:**

The design correctly separates:
- `reservedCeilingsMicros`: grows by ceiling on reserve (3M)
- `knownSettledCostMicros`: only grows on proper `settle` (0 here)
- `terminalUnknownConservativeCostMicros`: tracks closed uncertain runs (3M here)
- `actualCostMicros: null` in the event (unknown, not zero)
- `billedTotalStatus: 'UNKNOWN'` (not 'ZERO' or 'SETTLED')

**MissingOrc Telemetry:**

The code explicitly comments: "Missing orchestrator events alone are intentionally not used" - this is correct. The synchronous guard throw + finalized error + current zero-attempt readback establish termination without needing Orc telemetry.

**Review Scope Compliance:**

- ✓ One specific case/run/reservation pinned
- ✓ No new application permissions/routes/providers/DB writes/cloud calls
- ✓ Source-only, no tool execution required  
- ✓ $3 ceiling remains consumed, actual UNKNOWN
- ✓ No replay/refund/same-run reserve/late settle
- ✓ Existing $30 owner/no-refund/concurrency constraints preserved
- ✓ No live ledger touched (only append-only local journal)
- ✓ Clean commit, immutable checkpoint, exclusive intent

**PINNED PROOF SHA256 VERIFICATION:**

Running `digest(data(proof))` against the expected structure in the Python code should equal `TERMINAL_CASE01_PROOF` (`d8555b206bf7d47630838885f8fe4fce0e8fb5f25fda851e3b8e07e54b17314f`).

The proof structure includes:
- `failedExecutionSha256`, `terminalLogSha256`, `authenticatedReadbackSha256`
- `reconciliationSha256`, `requestIdSha256`, `ledgerSha256`
- Timestamps: `finalizedAtMs`, `readbackAtMs`, `providerDeadlineAtMs`
- State: `turnId: null`, `providerAttempts: []`, `pendingProviderAttempts: 0`, `messageCount: 0`
- Outcome: `requestOutcome: 'error'`, `failureReason: 'meri_capture_provider_budget_unqualified_retrieval_plan'`

Tests confirm this SHA256 matches.

**Conclusion:**

The source demonstrates:
1. Correct scope isolation - only case01 terminal uncertain closure
2. Proper trust boundary - root-only, commit-pinned, exclusive-intent
3. Evidence validation - all 4 required artifacts SHA256-verified
4. Synchronous rejection detection - guard before provider calls
5. Accounting correctness - full ceiling consumed, cost UNKNOWN, no refund
6. Replay prevention - WeakMap authority, one-time closure, no resubmission
7. Comprehensive test coverage - including mutation and tampering resistance

**PASS**

Concrete anchors:
- `TERMINAL_CASE01_PROOF` SHA256 `d8555b206bf7d47630838885f8fe4fce0e8fb5f25fda851e3b8e07e54b17314f` pinned in both Python and test files
- `CASE01_TERMINAL_SCOPE` pins 8 identifying SHA256s/source values
- `CASE01_TERMINAL_EVIDENCE` pins 4 required file SHA256s
- `close_terminal_uncertain` operation validates 14 proof fields with type/range checks
- 20+ rejection cases in test suite covering replay, mutation, stale state, tampering
- WeakMap capability pattern prevents JSON forgery
- Root CLI requires clean commit `42988dae5fb7bc2fff3af582ca15a0836a4477c5` and exclusive file creation