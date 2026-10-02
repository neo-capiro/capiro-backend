Review of evals/meri/live-v1/case17-readonly-guard.mjs and related sources.

CLOSEOUT: PASS with ACCEPTED LIMITATION

DETAILED FINDINGS:

1. BYPASS ANALYSIS — PASS
   - deny() returns TRUE (blocked) for all non-GET/HEAD/OPTIONS methods except Clerk
   - The preference PUT exemption is bounded:
     • method === PUT
     • origin === os.capiro.ai
     • pathname === /api/clio/vnext/preferences exactly
     • phase ∈ {initial, afterReload}
     • maximum 3 per phase (enforced by inspectCase17WriteAccounting)
   - No query strings, fragments, or path variations are accepted
   - The CLERK origin is hardcoded and whitelisted entirely for auth flows
   - Route guard in case17-live-capture.mjs (lines) AND page guard in case17-memory-ui.mjs (guard function) both call deny() — shared accounting

2. CLEANUP EVIDENCE — PASS
   - Native-write-guard-diagnostic.json is written in finally{} block of collectCase17LiveCapture (line ~271-284)
   - Readonly-guard-diagnostic.json is written in collectCase17MemoryUi:
     • Before OWNER_OR_WRITE_CHANGED check (case17-memory-ui.mjs lines ~318-332)
     • Also on guard failure path via try/finally (line ~350)
   - diagnostic structure includes ownerBeforeSha256, ownerAfterSha256, ownerUnchanged — persists evidence even when check fails

3. COUNTER DOUBLE COUNTING — PASS
   - blockedWrites incremented once per deny() call
   - Nested guards (page.route + context.route in test) both call deny():
     • In real code: context.route first (lines ~64-76 in case17-live-capture.mjs)
     • Then page.route falls through via route.fallback()
   - Event listener on requestfailed only counts failedWrites for verification, not accounting
   - Test verifies blockedWrites=2 despite nested guards (test file lines ~45-52)

4. SCREENSHOT CORRUPTION — PASS
   - Clipping rejection: screenshotCase17Card() validates visibility before capture
   - Evaluates getBoundingClientRect() and walks scroll ancestors
   - Rejects if any dimension clipped with need(fullyVisible, 'CARD_SCREENSHOT_CLIPPED')
   - Test confirms PNG dimensions match ceiling(Math.ceil) of physical bounds
   - scrollIntoView(block:'center') only changes scroll, not layout/text/style

5. REAL-TEST ADEQUACY — PASS
   - Real Chromium test validates:
     • Actual browser launch, page, navigation
     • PUT /api/clio/vnext/preferences rejected with 'aborted' result
     • Nested route guards count once
     • POST business write rejected
   - Geometry test validates clipping detection with real overflow containers
   - Native Windows storage collector test validates real artifactStorage with owner-change and unknown-write negatives

ACCEPTED LIMITATIONS:

1. Panel navigation same-origin PUT accounting:
   • Bound ≤3 per phase, 2 phases, 6 total — specified in problem
   • This is explicitly authorized bounded exception per task description
   - Implementation correctly limits to exactly this bound

2. PNG fractional physical rounding:
   • Test acknowledges Chromium rounds outward to physical pixels
   - Implementation uses Math.ceil/Match.floor matching browser behavior

BOUNDARY VERIFICATIONS:

- inspectCase17WriteAccounting() validates:
  • blockedWrites ∈ [0,6]
  • blockedPreferenceWrites === blockedWrites (all writes are either preference or other)
  • blockedWriteRequests array length === blockedWrites
  • Each entry: method, fixed path categories only, phase, kind
  • Per-phase count ≤3
  - Fails closed on any deviation

- No caller objects become LIVE authority:
  • createCase17WriteAccounting returns frozen object
  • inspectCase17WriteAccounting is pure function
  • Outcomes WeakMap in case17-live-capture.mjs is native collector only
  - External callers receive receipts, not capabilities

VERDICT: Patch correctly implements read-only guard with shared accounting, scroll-only screenshots, clipping rejection, diagnostic persistence before failures, and bounded preference PUT exemption as authorized. No bypasses identified. Cleanup evidence preserved. No double counting. Tests cover real browser behavior, geometry, and native storage. PASS with the documented ACCEPTED LIMITATION for required panel navigation PUTs.