I'll conduct an independent security/correctness review of the provided code. Let me analyze each file systematically.

## Review Summary

**Overall Assessment: PASS**

The code demonstrates strong security architecture with proper tenant isolation, role-based access control, and defense-in-depth patterns. No concrete blockers identified.

---

## Detailed Findings by File

### 1. `pending-memory-fixture-evidence.ts` — PASS

**Security observations:**
- Hard-coded tenant/slug validation (`f2d6cf8f-057c-479a-8110-62fe5086d43f`, `meri-foundation-20260928-t1`)
- Role hard-coded to `user_admin`
- Environment variable `MERI_SYNTHETIC_FIXTURE_NAMESPACE` must match exactly
- Dynamic module import uses `pathToFileURL` with `__dirname` (prevents path traversal)
- Returns `null` on any validation failure (fail-closed)
- No user input reaches the module import path

**Correctness:**
- Proper async pattern with module caching via `modulePromise ??=`
- Strong type safety with TypeScript interfaces

---

### 2. `memory-pending-execution.mjs` — PASS

**Security observations:**
- Extensive input validation in `select()`:
  - Fixed schema version check (`!== 1` → fail)
  - Fixed target (`!== 'capiro-dev'` → fail)
  - Fixed fixture namespace match against environment variable
  - Strict context key ordering validation
  - Role-based conditional (`user_admin` for case17, `standard_user` for case14)
  - UUID format validation with anchored regex
  - Clerk user ID prefix validation (`user_`)
- Database queries use parameterized queries via `$queryRawUnsafe` with explicit type casting (`::uuid`)
- Row-level tenant validation (slug match, settings verification)
- Actor validation: email domain check, synthetic name pattern, role consistency, clerk ID binding
- Client wall check: `memory_wall` status verified before access
- Plan hash verification before execution (prevents replay/stale plans)
- All mutations require `EXPECTED_PLAN_SHA256` match
- Optimistic concurrency via `xmin::text` row versioning on UPDATE

**Key security patterns:**
- `fail()` function centralizes error handling
- `structuredClone()` prevents mutation of validated inputs
- No user input constructs SQL directly—all values parameterized

**Correctness:**
- Plan hash computed deterministically via `sha256Stable`
- Receipt includes SHA256 chain linking recipe → manifest → records
- `readRows()` verifies physical record matches canonical source

---

### 3. `case17-memory-ui.mjs` — PASS

**Security observations:**
- `need()` assertion pattern (throws on any validation failure)
- Origin hard-coded: `https://os.capiro.ai`
- Browser route guards abort non-GET/HEAD/OPTIONS requests (except Clerk)
- Navigation requests restricted to allowed origins
- Page-level bound: max 10 pages, 24 requests, 120s deadline
- Response size bound: 256KB (`<= 262144`)
- Bearer token cannot appear in response body (leak prevention)

**Critical binding validations in `inspectPendingUiPage()`:**
- Owner kind, caseId, fixtureInstanceId, manifest hash all validated
- 6 records required, unique physical IDs
- Each row bound: logical→physical ID, tenant, proposer, payload hash, ownership marker, status, scope
- UI elements verified: scope label, PENDING status, source provenance, withdraw action enabled
- Screenshot captured and stored with SHA256 verification

**Correctness:**
- Cursor pagination validated
- Page chain integrity (null only on last page)
- No duplicate logical IDs allowed

---

### 4. `case17-build-authority.mjs` — PASS

**Security observations:**
- Platform check: `process.platform === 'win32'` (limits to expected environment)
- AWS CLI path hard-coded: `C:/Program Files/Amazon/AWSCLIV2/aws.exe`
- Command whitelist (`READS` Set) prevents arbitrary AWS operations
- Output limited to 8MB maxBuffer
- Build validation:
  - Source must be from `neo-capiro/capirov2` GitHub repo
  - Image digest must match `sha256:` prefix + 64 hex chars
  - Task definition environment must not use `environmentFiles`
  - All build phases must succeed
  - Deployment must be COMPLETED (not IN_PROGRESS)
  - Container image must match exact ECR path with digest

**Correctness:**
- `inspectCase17Build()` validates full chain: Git → CodeBuild → ECR → ECS task definition → service deployment
- Environment variable binding verified (GIT_SHA, RELEASE_SHA)

---

### 5. `case17-live-capture.mjs` — PASS

**Security observations:**
- HTTPS only with `rejectUnauthorized: true`
- Bearer token restricted scope (no model calls, no writes)
- Input validation: strict schema, caseId, target, UUID formats, SHA patterns
- Session management:
  - Ticket callback `createSignInTicket` only receives clerkUserId
  - Session ID returned via `onSessionCreated` (allows revocation tracking)
  - Sign-out enforced in finally block
  - Timer kills browser after 240s
- Build proof must be <30 minutes old
- Full cleanup in finally: revoke session, close browser

**Critical isolation:**
- Browser route blocks all non-GET/HEAD/OPTIONS (except Clerk)
- Main frame navigation restricted to origin
- Child frames restricted to origin + Clerk
- No caller-provided transport, method, or page object can bypass guards

**Authority pattern:**
- WeakMap stores internal state (private to module)
- Outcome frozen with `Object.freeze()`
- `currentCase17CaptureAuthority()` re-verifies entire chain:
  - Outcome hash matches stored hash
  - Artifact storage validated
  - Bytes re-read and hashed
  - Evidence re-parsed and validated
  - Screenshots re-verified (PNG magic bytes + SHA256)

---

### 6. `case17-saved-checks.mjs` — PASS

**Security observations:**
- Pure function—no I/O
- Zero-write validation: `synthesisSubmissionCount === 0 && applicationWrites === 0 && blockedWrites === 0`
- Owner consistency verified (`before` vs `after` hash match)
- Page evidence chain: every page must reference same `fixtureEvidence` hash
- 12 screenshots required (6 per round × 2 rounds)
- Screenshot references unique, paths validated
- All bindings rechecked via `inspectPendingUiPage()`

---

### 7. `grade-case17-capture.mjs` — PASS

**Security observations:**
- Grading ONLY uses `currentCase17CaptureAuthority()` (re-verifies storage)
- `inspectCase17VisualReview()` validates:
  - Exact evidence SHA256 match
  - Capture run ID match
  - All 12 screenshot hashes present and sorted
  - ReviewedAt within bounds (after completion, before now)
  - Required boolean fields present
- Manual review deliberately separate from deterministic checks
- No second capture/replay—pure validation of saved evidence

---

### 8. Test Files — PASS

Test coverage validates all security boundaries:
- Invalid scopes rejected
- Fake storage rejected
- Copied receipts rejected
- Forged actor rejected
- Build tampering detected
- Visual review binding enforced

---

## Production Diffs Review

All diffs are additive/surgical:

1. **`meri-case01-setup-dependencies.mjs`**: Adds `runWithMemoryGovernanceTenant` to deps (no new authority)
2. **`meri-pending-memory-setup.mjs`**: Switches to `runWithPendingMemorySetupActor()` (adds additional validation layer)
3. **`governed-memory-candidate.service.ts`**: Adds `readOwnPendingFixtureEvidence()` method exposing existing safe function
4. **`memory-proposal.controller.ts`**: Adds fixture evidence to response only when present (null propagation safe)
5. **`memory-proposal.controller.spec.ts`**: Tests rejection propagation and evidence flow

---

## Conclusion

**PASS** — The implementation correctly implements:
- Tenant/role isolation with hard-coded authorized values
- Immutable evidence with SHA256 chains
- No caller-supplied authority minting
- Read-only browser capture with write blocking
- Build provenance verification via AWS read-back
- Deterministic grading separate from capture
- Root ownership of live operations (AWS reads via scoped CLI)