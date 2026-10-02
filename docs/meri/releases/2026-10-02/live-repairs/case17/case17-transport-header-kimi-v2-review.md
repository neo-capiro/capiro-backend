READ bootstrap/AGENTS.md
READ hermes/OPERATING.md
READ machine-paths.local.yaml
CONFIRM ops HEAD=39590a3bfc57ce03b0411ff7912a7c8d99deb70c origin/main
NO-TOOLS BOUNDED KERNEL REVIEW — Hermes/Kimi (moonshotai.kimi-k2.5)
================================================================================

Observation: unchanged policy (39590a3...) binds me to read-only, no-write kernel review with PASS/BLOCK verdict only.

Review scope: two mechanical diffs provided in context (no file access required):
- Patch 1 (UA): adds descriptive User-Agent header `Capiro-Meri-Authorized-QA/1.0` to native case17 capture probe
- Patch 2 (SOURCE): plumbs `RELEASE_SHA ?? GIT_SHA` into existing middleware, adds Nest test asserting 404 response carries release header without service header

--------------------------------------------------------------------------------

PATCH 1 — UA header in case17-live-capture.mjs
Mechanism: literal string header insertion; no runtime branch/secret injection.
Risk: None. Identifies probe as authorized QA traffic vs generic HTTPS.
Policy check: Aligns with existing bootstrap middleware support; no change to routing/auth.
Verdict: PASS

--------------------------------------------------------------------------------

PATCH 2 — release SHA header in main.ts + test
Mechanism: reads `process.env.RELEASE_SHA ?? process.env.GIT_SHA`, passes to `configureApiHttpApp` which conditionally sets `X-Capiro-Release-Sha` header via existing identity middleware.
Test: Asserts 404 response carries header when configured, and `X-Capiro-Service` remains absent for main API.

Correctness:
- Options interface already supports `releaseShaHeader?: string` — new usage is within contract
- Fallback `RELEASE_SHA ?? GIT_SHA` matches deployment context where either may be injected
- Test exercises exact header name and explicitly asserts service header undefined (no Engagement identity leak)
- Existing main without release config has no header (backward compatible)

Risk: None detected. No policy/routing change; header additive only.

--------------------------------------------------------------------------------

BOUNDED REVIEW VERDICT: PASS

No correctness defects identified. Patches are mechanical, localized, and preserve existing invariants.