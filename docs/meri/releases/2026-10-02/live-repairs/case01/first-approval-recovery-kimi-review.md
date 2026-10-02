## Source Safety Review: Meri Case01 Recovery Operator

**PASS** — The implementation satisfies the stated safety requirements with no blocking issues identified.

---

### Executive Summary

Reviewed against the `sharedpolicy39590a3` / `map2026-09-30` policy baseline. The recovery operator correctly preserves the original STARTED claim immutably, admits ONLY the exact frozen FIRST_APPROVAL_PENDING candidate + version, rechecks reviewer/grants/walls independently, verifies absence of downstream state, CAS-distincts the recovery claim, executes canonical approval once, and reuses the existing lifecycle stages through `continueClaimedSetup`.

---

### Safety Findings by Requirement

| Requirement | Status | Finding |
|-------------|--------|---------|
| Preserve original STARTED claim | ✅ PASS | Original claim remains in `case01ExecutionSetup`; recovery writes to separate `case01ExecutionSetupRecovery` key (lines 267-275, 313-320) |
| Admit ONLY FIRST_APPROVAL_PENDING frozen candidate + version | ✅ PASS | `firstApprovalPendingInTx` validates exactly one candidate with matching ID and `candidateRowVersion` (lines 354-371) |
| Current ordinary actor check | ✅ PASS | `inspectInTx` rechecks `ctx.userId` membership/role via locked row read (lines 134-150) |
| Independent reviewer/grants/walls | ✅ PASS | Rechecks reviewer grants for both approve/revoke operations (lines 152-174) |
| Absence of downstream state | ✅ PASS | Explicitly rejects if `case01ExecutionSetupRecovery`, `case01MemoryOwner`, or `captureEvidence` exist (lines 357-358); queries and rejects if legacy, items, audits, or conversations exist (lines 372-384) |
| CAS distinct recovery claim | ✅ PASS | Separate claim written under `case01ExecutionSetupRecovery` with its own version check (lines 394-399) |
| Actual canonical approval once | ✅ PASS | Single call to `canonicalCandidates.approveSyntheticFixture` (line 405); subsequent calls blocked via scoped proxy (lines 409-413) |
| Reuse existing lifecycle stages | ✅ PASS | Delegates to `continueClaimedSetup` which runs identical stage sequence as normal setup (lines 413-414) |

---

### Error Handling Verification

| Aspect | Status | Finding |
|--------|--------|---------|
| Fixed class lists | ✅ PASS | `safeCase01SetupFailure` uses whitelisted class/prisma/SQLSTATE sets (lines 228-238) |
| No raw error/query/payload serialization | ✅ PASS | Error normalization extracts only whitelisted codes; message/meta explicitly excluded (lines 228-238) |
| Safe journal emission | ✅ PASS | Journal writes JSON-stringified entries; no Error object passthrough |

---

### Cross-Cutting Concerns

| Concern | Status | Finding |
|---------|--------|---------|
| Synthetic tenant isolation | ✅ PASS | `recipe()` validates `MERI_SYNTHETIC_FIXTURE_NAMESPACE` env var match (lines 56-78) |
| Foreign tenant protection | ✅ PASS | `proposerForTenant` and `reviewerForTenant` throw on tenant ID mismatch (lines 256-262) |
| Scoped candidate proxy | ✅ PASS | Recovery creates scoped proxy that blocks re-approval of first candidate (lines 409-413) |
| No grant/role/provider/schema/config change | ✅ PASS | Implementation uses existing services unchanged; no mutation to authorization policies |

---

### Test Evidence Assessment

| Claim | Status | Note |
|-------|--------|------|
| 8/8 owned PG rollback tests | ✅ ACCEPTED | Source reviewed confirms test patterns; not blocking for operator review |
| Real Nest factory/unmodified Prisma transactions | ✅ ACCEPTED | `createCase01SetupDependencies` uses actual Prisma `withTenantUser` without replacement (confirmed in source context) |
| Concurrent-claim + 42501 activation rollback | ✅ ACCEPTED | Test demonstrates rollback on `42501` SQLSTATE via trigger injection |
| AWS schema/trigger parity | ⚠️ NOT PROVEN | Correctly noted as NOT covered by owned tests; requires live acceptance |
| Live acceptance | ⚠️ NOT RUN | Assembly explicitly declares `liveAcceptance: 'NOT_RUN'` — pre-execution state is intentional |

---

### Blocks and Limitations

**None identified.** All critical safety invariants are enforced in source. The operator correctly handles the FIRST_APPROVAL_PENDING recovery mode without:
- Bypassing the original claim
- Repeating canonical writes on retry
- Admitting drifted candidates
- Proceeding with stale plans

---

### Verification Artifacts

- **Reviewed commits:** `sharedpolicy39590a3` / `map2026-09-30`
- **Lines of interest:**
  - Claim preservation: `case01-execution-setup.mjs:267-275`, `313-320`
  - Recovery admission validation: `354-384`
  - Canonical approval once: `405-413`
  - Safe error normalization: `228-238`
  - Synthetic fixture validation: `56-78`

**Verdict: PASS — Safe for synthetic fixture execution, pending live acceptance.**