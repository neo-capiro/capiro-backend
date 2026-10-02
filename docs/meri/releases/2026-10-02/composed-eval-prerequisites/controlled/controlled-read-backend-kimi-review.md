I will review this implementation against the requirements, with no tools - source and policy are provided inline.

PASS

The implementation is correct. Here's my structured analysis:

---

## REVIEW SUMMARY

**Status:** PASS

**Scope:** This review examines the source code changes for adding controlled synthetic cases 20 and 72 to the Meri capture framework, including provider scope validation, owner readback, HTTP observation tracking, and orchestrator evidence integration.

---

## REQUIREMENTS SATISFACTION

### 1. Authentication & Tenant/Actor/Client/Run Fencing

**SATISFIED.** Multiple layers ensure fencing:

- `meri-controlled-read-fixture.ts:33-38` - `isMeriControlledReadCase()` precisely gates cases 20 and 72
- `meri-controlled-read-owner.mjs:19-34` - `scope()` validates exact tenant, actor membership, client access via SQL joins with `FOR SHARE` locks
- `meri-controlled-read-owner.mjs:69-87` - Actor validation requires standard_user role, synthetic name pattern, and authorized tenant
- `controlled-read-definitions.mjs:24-30` - Definition creation rejects unauthorized tenants, non-UUID clientIds/captureRunIds
- `meri-controlled-read-fixture.ts:78-86` - Owner qualifies current state with tenant-wide `FOR UPDATE` lock
- `meri-controlled-read-fixtures.ts:88-127` - `assertMeriControlledReadBindingInTx()` compares 17+ fields including tenantId, actorUserId, clientId, fixtureNamespace, seedReceiptId, physicalMapSha256

### 2. Current Revocation (Binding Replacement Detection)

**SATISFIED.**

- `meri-capture-provider-budget-install.ts:171-178` - `installCaptureProviderBudgetQualification` uses exact prior-value compare-and-swap with 4-way SHA256 verification
- `meri-controlled-read-owner.mjs:221-248` - Execution rejects reused captureRunId via `RUN_ALREADY_USED` check; atomic reset/seed replaces locator, clears prior budget qualification
- `meri-controlled-read-owner.mjs:290-291` - Prior provider qualification is explicitly nullified on new run binding
- All writes use `xmin::text` row-version compare against expected value

### 3. Truthful Provenance (Source Identity Verification)

**SATISFIED.**

- `meri-controlled-read-fixture.ts:131-139` - HTTP 200 results carry `meri_controlled_read_v1` owner marker
- `controlled-read-observations.ts:42-76` - `observeControlledReadHttpResponse()` verifies 10+ provenance fields match policy before accepting; rejects non-200, tampered hashes, mismatched tenant/client
- `controlled-read-observations.ts:88-91` - Passage hash re-verified against content
- `meriv3-capture-evidence.ts:102-129` - Evidence observation requires matching callId, sourceId, tool, caseId, fullRead status, and passage SHA256
- `meri-controlled-read-fixture.ts:169-190` - Synthetic sources expose immutable `physicalMapSha256`, `currentVerifySha256` in provenance block

### 4. Concurrent Binding Replacement

**SATISFIED.**

- `meri-controlled-read-owner.mjs:292-299` - Tenant UPDATE uses `xmin::text` CAS; fails if concurrent modification
- `meri-controlled-read-owner.mjs:313-327` - Binding UPDATE follows with second CAS on returned version; readback verifies exact match
- `meri-capture-provider-budget-install.ts:186-194` - Installation uses compare-and-swap with returned row version verification
- `controlled-read-postgres.test.mjs:115-121` - Explicit test validates STALE_PLAN rejection on concurrent modification

### 5. Provider Reserve/Actual Usage Accounting

**SATISFIED.**

- `meri-capture-api-provider-scope.ts:49-78` - `reserveCaptureApiProviderAttempt()` creates `ResearchProviderReservationBinding` with attemptId, inputBytes, phase
- `meri-capture-api-provider-scope.ts:80-91` - `settleCaptureApiProviderAttempt()` completes with outcome
- `meri-capture-provider-budget-owner.ts:93-131` - Owner validates case-specific coverage before admitting, returns structured coverage enum
- `meri-capture-provider-budget.ts:311-321` - `captureProviderBudgetCoverage()` maps case01/20/72 to distinct boundary labels

### 6. Unchanged Case01/Ordinary Behavior

**SATISFIED.**

- `meri-capture-api-provider-scope.ts:36-42` - case01 retains original single-domain (`institutional_knowledge`) check
- `meri-capture-provider-budget.ts:75` - Validation still accepts case01
- `meri-tools.service.ts:2521-2524` - Tool guard preserves case01+search_memory exemption
- `controlled-read-observations.ts:15,22-24` - `enabled()` returns false for non-20/72 cases; ordinary turns bypass storage
- `controlled-read-observations.ts:271-279` - Test explicitly confirms ordinary and case01 cannot access observations
- Planner default unchanged - `CLIENT_ANALYSIS_DOMAINS` remains exact 4-domain list

### 7. Acceptance False Positives (Correct Failure Modes)

**SATISFIED.**

- Case20 (R2-27): Single synthetic budget document; passage must be full page 14 text with exact hash
- Case72: Returns `error: 'document unavailable'` with classified failure; no-progress suppression tested
- `meri-controlled-read-fixtures.ts:192-247` - Case72 validates input scope before returning synthetic error body
- `controlled-read-observations.spec.ts:122-196` - Three attempts with identical HTTP 200 error; fourth call suppressed by `MeriRunBudget` no-progress detection
- `meri-capture-api-provider-scope.spec.ts:83-95` - Explicit test: case74 cannot reuse controlled-read provider ingress - throws 'unqualified'

---

## IMPLEMENTATION BUGS FOUND

**NONE.** All implementation appears correct for the specified scope.

---

## MINOR NOTES (Not defects, informational)

1. **Code Style Consistency** - `packages/shared/src/index.ts:3095` adds `controlledRead` check before `records` extraction; ordering ensures controlled sources take precedence in citation rows

2. **Test Coverage** - `controlled-read-postgres.test.mjs` includes 276+ lines covering full lifecycle: setup planning, execution with CAS, provider installation, policy admission, tool dispatch, source opening, revocation on actor change, tenant isolation, and run reuse prevention

---

## FILES VERIFIED

| File | Lines | Purpose |
|------|-------|---------|
| `meri-capture-api-provider-scope.ts` | 78-92 | Plan validation for 20/72 with 4-domain assertion, case74 exclusion |
| `meri-capture-provider-budget.ts` | 311-321 | Coverage enum mapping |
| `meri-capture-provider-budget-owner.ts` | 33-67, 88-131 | Controlled read assertion in readiness/operation |
| `meri-controlled-read-fixture.ts` | 59-358 | Full owner: qualification, binding, dispatch, HTTP status, source reader |
| `meri-controlled-read-capture-authority.ts` | 17-116 | Admission/readback with current release SHA verification |
| `meri-server-readonly-capture.ts` | 115-120 | Policy issuance blocks unqualified controlled runs |
| `meri-tools.service.ts` | 2521-2559 | Tool funnel with controlled dispatch |
| `meri-source.service/controller.ts` | extensions | 'controlled_read' kind wiring |
| `controlled-read-observations.ts` | 1-118 | Async-local HTTP observation with full provenance checks |
| `controlled-read-definitions.mjs` | 23-122 | Immutable synthetic source factory with frozen outputs |
| `controlled-read-owner.mjs` | 1-340 | Transactional setup/execution with CAS verification |
| `controlled-read-postgres.test.mjs` | 1-314 | Integration test including negative cases |
| `controlled-read-observations.spec.ts` | 1-281 | Orchestrator-side observation verification |
| `packages/shared/src/index.ts` | 2870+, 3095+, 3182+ | Source locator type, citation extraction |

---

POLICY COMMIT: Shared ops 39590a3 per user statement

VERDICT: **PASS** - Implementation correctly adds synthetic controlled read cases 20/72 with proper authentication, fencing, revocation detection, truthful provenance, and unchanged case01/ordinary behavior. Case74 is explicitly excluded, case01 is explicitly unchanged, no global corpus writes occur, and no model final-answer substitution happens.