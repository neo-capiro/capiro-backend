Reviewing the two-file collector hydration repair.

## Analysis

**Problem:** The original collector code attempted to interact with UI elements (`Expand panel`, `Open Context and Memory`, `Memory` buttons) before React had mounted the rail component. The live diagnostic showed selectors running against the DOM before `[data-meri-context-rail]` was present.

**Fix in `openCase17MemoryPanel` (line 115-116):**
```javascript
await page.locator('[data-meri-context-rail]').waitFor({ state: 'visible', timeout: 15000 });
```
This waits for the atomic rail mount before checking for `Expand panel`, `Open Context and Memory`, or `Memory` buttons. Correct approach - matches the diagnosis exactly.

**Test verification (`case17-memory-ui-delayed-mount.test.mjs`):**
- Creates a realistic delayed-mount fixture using `setTimeout(() => render(mode), 150)`
- First verifies the old broken behavior would fail: buttons absent initially, clicking Memory without waiting times out
- Then verifies `openCase17MemoryPanel` succeeds across all three entry modes (`collapsed`, `inspector`, `context`)
- Asserts correct button transition sequences for each mode

**Key constraints preserved:**
- No auth/network/provider in the unit test - pure DOM timing fixture
- Timeout bounds preserved (15000ms rail wait, 500ms negative test timeout)
- Source-owned tenant/fixture guards remain in `collectCase17MemoryUi` (unchanged)
- Exported helper `openCase17MemoryPanel` remains available to collector

**Cross-check against policies:**
- `AGENTS.md`: Review-only work, no external writes, no tool calls required - compliant
- `hermes/OPERATING.md`: Independent verification of delegated work via source inspection - compliant

## Verdict

**PASS**

The fix correctly addresses the root cause (DOMContentLoaded vs React mount timing), the test actually reproduces the pre-mount skip condition and verifies the corrected wait behavior, all bounds are preserved, and the exported helper remains usable by the collector. No behavioral, auth, or routing changes.
