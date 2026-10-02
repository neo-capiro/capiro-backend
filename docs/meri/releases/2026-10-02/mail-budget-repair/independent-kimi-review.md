I'll review the three-file delta at commit `991b5b15fa134d64579c96853dc92e9a00fa8520` against the review criteria. Let me examine the changes carefully.

## Review Summary

Based on my analysis of the three-file delta, here are my findings:

---

### ✅ Shared Monotonic Budget (Not Fresh Per Query)

**PASS** - `mail-query-deadline.ts:9-10`  
The `MAIL_READ_BUDGET_MS = 10_000` is established once at the outer scope, and the `deadline` is computed once before entering `read()` (line 22: `const deadline = performance.now() + MAIL_READ_BUDGET_MS`). Each query subtracts elapsed time from this single shared deadline (line 24: `const remaining = Math.floor(deadline - performance.now())`). The comment on line 7 explicitly states "One shared execution budget for count, page, and coverage."

---

### ✅ Timeout > Budget Cancellation Path

**PASS** - `mail-query-deadline.ts:26`  
`prisma.withTenant()` is called with `{ timeoutMs: MAIL_READ_BUDGET_MS + 2_000 }` = 12 seconds. This exceeds the 10-second budget, ensuring Prisma's transaction timeout won't trigger before the statement-level deadline. The test at `mail-query-deadline.spec.ts:23` verifies this: `expect(f.withTenant.mock.calls[0]![2]).toEqual({ timeoutMs: 12_000 })`.

---

### ✅ LOCAL Scope No Leakage

**PASS** - `mail-query-deadline.ts:27-28`  
`set_config(..., true)` uses `is_local=true`, binding `statement_timeout` to the transaction. The postgres spec test at `mail-query-deadline.postgres.spec.ts:50-51` explicitly captures `before`/`after` PID and timeout settings and asserts `expect(after).toEqual(before)`, proving no leakage to pooled connections.

---

### ✅ Sanitized 503 No Partial Results

**PASS** - `mail-query-deadline.ts:29-33`  
When remaining ≤ 0 before query execution, `unavailable()` is thrown immediately before any DB call. The error handler (lines 30-33) catches P2010/57014 (timeout) and rethrows sanitized `ServiceUnavailableException`. The unit test at `mail-query-deadline.spec.ts:35-39` verifies no partial data: `expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1)` (only first query executes before budget exhaustion).

---

### ✅ Preservation of Unrelated Errors

**PASS** - `mail-query-deadline.ts:30-33` and `mail-query-deadline.spec.ts:41-47`  
The error handler specifically checks for `failure?.code === 'P2010' && failure.meta?.code === '57014'` before mapping to 503. All other errors fall through `throw error`. The test matrix includes P2010 with different meta.code, P2024, P2028, and generic Error - all preserved unchanged.

---

### ✅ Ordinary Ownership/Filter Semantics Preserved

**PASS** - `mail-query.ts` unchanged  
The mail module uses `withMailQueryDeadline` identically; no changes to SQL generation, tenant scoping in `queryMailMessages`, deduplication logic, or result shaping. The `withTenant` wrapper still receives the same tenantId from `ctx.tenantId`.

---

### ✅ Meaningful Tests

**PASS** - Coverage across both test files:

| Test File | Purpose | Assertion Coverage |
|-----------|---------|-------------------|
| `postgres.spec.ts:36-52` | 10s timeout cancellation vs 15s pg_sleep | Budget exhausted after 2nd scan (not 3rd), 503 returned, timeout ~10s not Prisma's 5s |
| `postgres.spec.ts:54-63` | Healthy multi-scan beyond old 3.5s limit | 4s cumulative (2+2+0) completes intact |
| `postgres.spec.ts:65-71` | Baseline fast queries | No regression |
| `spec.ts:11-27` | Unit: shared deadline math | Mocked time proves monotonic decay |
| `spec.ts:29-36` | Unit: budget exhaustion blocks new scans | First query OK, second throws, no partial |
| `spec.ts:38-47` | Error preservation & 503 sanitization | No leakage of SQL details in error message |

The postgres tests require `MERI_APPROVED_MEMORY_PG_CONFIG` env var and are skipped otherwise - safe for CI without PG.

---

## Final Verdict: **PASS**

All three files correctly implement the bounded mailbox availability tradeoff:
- `mail-query-deadline.ts` - Core logic: shared 10s budget, 12s transaction timeout, LOCAL scope, proper error mapping
- `mail-query-deadline.spec.ts` - Unit tests for deadline math, budget exhaustion, error preservation
- `mail-query-deadline.postgres.spec.ts` - Integration tests against real PG verifying cancellation and no leakage

The 10-second allowed occupancy is appropriately scoped to mail queries only (mail-query.ts caller), with unchanged 5-second billing deadline per the PR description. The fix addresses the regression where healthy ~3.5s queries failed under the old deadline, while maintaining cancellation safety through statement_timeout + LOCAL scope.