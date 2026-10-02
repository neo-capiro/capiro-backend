PASS

Source-grounded review of `apps/api/src/intelligence/bill-keyword-deadline.ts` against the stated requirements:

**1. Engine cancellation vs SQL-error handling** — Correct. `withBillKeywordSqlDeadline` does not catch Prisma query errors. When PostgreSQL cancels a statement (error code 57014), Prisma surfaces it as `{code:'P2010',meta:{code:'57014'}}`. The diff shows no `try/catch` around `tx.$queryRaw` in the `query` closure; cancellations propagate unmodified. The wrapper only throws `BillKeywordDeadlineExceeded` for client-side pre-checks (`remaining()`), not for SQL execution failures. This matches the requirement to distinguish engine cancellation from SQL-error handling.

**2. Shared deadline (COUNT+rows)** — Correct. The `deadline` variable is captured once at entry and shared across both queries via `remaining()`. The `performance.now()` math and passing `milliseconds` to `set_config('statement_timeout', ...)` are per-query adaptive, but both draw from the same absolute `deadline`. The test `spends one deadline across count and rows` verifies the second statement timeout is lower than the first after a 35ms delay.

**3. Late fallback connection blocked by expired scope** — Correct. `withBillKeywordProfileDeadline` stores the deadline in `AsyncLocalStorage`. `withBillKeywordSqlDeadline` reads `scope.getStore() ?? Infinity` and computes `Math.min(scope.getStore() ?? Infinity, performance.now() + budgetMs)`. If the stored deadline has passed, `remaining()` throws `BillKeywordDeadlineExceeded` before `prisma.$transaction` is called. The caller note confirms: "late fallback cannot outlive profile scope" and the test `expired profile scope refuses late fallback before acquiring any connection` passes.

**4. Concurrent ALS isolation** — Correct. `AsyncLocalStorage` provides request-scoped storage. The test `isolates concurrent request deadlines` demonstrates two concurrent calls with different budgets (10ms vs 150ms) result in one rejection and one fulfillment, with the expired transaction never acquired. There's no shared mutable state between concurrent requests.

**5. Transaction reset / pool reuse** — Correct. `prisma.$transaction` with `{maxWait, timeout}` acquires one connection for the duration. On cancellation (statement_timeout exceeded), PostgreSQL aborts the transaction; Prisma rolls back. The connection is returned to the pool. The subsequent `$queryRaw` reuses the same connection (pid unchanged per native test `before`/`after` assertion). The `statement_timeout` is reset via `set_config(..., true)`, but the test explicitly validates session state resets via pid comparison and timeout readback.

**6. Access semantics unchanged** — Correct. The diff does not modify `withTenant`, RLS bypass, or any auth/tenant checks. `matchingIds` CTE and final SQL bodies are identical to `base3d`; only wrapping deadline logic changed. No term truncation occurs—full `allTerms` pass through unchanged. No route/auth/tenant/result format mutations.

**7. Partial source failure vs fabricated zero** — Correct. On rejection (cancellation or any error), the promise rejects. The caller note states: "Neither wrapper adds withSystem/RLS bypass" and "they do not catch budget or SQL errors." The result is propagated rejection, not a fallback zero/empty result. This matches the requirement: no false emptySuccess.

**8. `maxWait: 1000` and cleanup transaction guard** — Correct. The `$transaction` options are `{maxWait: Math.min(1000, initial), timeout: initial + 1000}`. `maxWait` caps at 1 second for pool acquisition; `timeout` adds 1 second cleanup margin to the actual work deadline. This matches "1s pool wait and 1s cleanup transaction guard."

**9. 15s monotonic ALS guard** — Correct. `BILL_KEYWORD_PROFILE_BUDGET_MS = 15000`. The ancestor `withBillKeywordProfileDeadline` sets the ALS store to `Math.min(existing ?? Infinity, now + 15s)`. This is inherited by nested deadline calls but never extended. The existing 20s `Promise.race` in the caller (per caller notes) remains for other sources; only these two keyword methods get the 5s SQL + 15s ALS guard.

**10. Global catalog semantics** — Correct. The SQL queries against `congress_bill` remain global reads. The CTE `matchingIds` is unchanged. No tenant filter added to these queries.

**Minor observation:** `Math.min(scope.getStore() ?? Infinity, performance.now() + duration(...))`—if no outer scope exists, `Infinity` preserves the passed or default budget; if outer scope exists and is tighter, it's respected. This is the "monotonic" (non-extending) semantics required.

**Conclusion:** Implementation correctly bounds actual two `congress_bill` keyword queries (COUNT+rows) to a shared 5s server-side deadline with 1s pool wait and 1s cleanup, a 15s profile ALS guard, late fallback protection, concurrent isolation, proper transaction reset/pool reuse, and no false zero fabrications. All constraints from the task description are satisfied.