I'll review the code for security, correctness, and adherence to the stated requirements. Let me analyze the implementation carefully.

## Line-by-Line Review

### `mail-query-deadline.ts`

**Line 9:** `const MAIL_READ_BUDGET_MS = 3_500;` - ACCEPTED. 3.5s shared deadline as specified.

**Line 20:** The `withTenant` callback receives `tx` but the type is `PrismaService`, which should be the transaction client. Looking at Prisma's interactive transactions, `$executeRaw` and `$queryRaw` are available on transaction clients.

**Line 21-22:** Deadline calculation and remaining computation - ACCEPTED. The `Math.floor` on remaining time is appropriate for PostgreSQL `set_config`.

**Line 24:** The template literal `` `${remaining}ms` `` builds a PostgreSQL interval string. With `remaining = 3490`, this produces `'3490ms'`. This is valid PostgreSQL interval syntax.

**Lines 23-25:** The `set_config` call uses `true` (is_local) which correctly limits the setting to the current transaction/session. **However**, when examining the Prisma documentation and PostgreSQL behavior more carefully:
- `set_config('statement_timeout', ..., true)` sets it for the current session only
- When the connection returns to the pool, this setting should be isolated per connection
- The third parameter `true` means "is_local" which is session-scoped

**Line 26:** Returns `tx.$queryRaw<R>(sql)` - ACCEPTED, runs the actual query after timeout is set.

**Lines 29-31:** Error handling for P2010/57014 timeout - ACCEPTED. This maps the Prisma timeout error to a sanitized 503.

**Lines 29-30:** The error structure check: `failure?.code === 'P2010' && failure.meta?.code === '57014'` 
- The Prisma `RawQueryError` has `code` at the top level for some errors
- The check correctly handles the SQLSTATE 57014 case

---

### Tests Review

**`mail-query-deadline.spec.ts`:**
- Line 35: `expect(f.tx.$executeRaw.mock.calls.map(call => call[1])).toEqual(['3490ms', '2400ms', '100ms']);` - This extracts the second element of each call (`call[1]`), but looking at the implementation on line 24, the template literal passes the parameter as a tagged template literal variable. **However**, the mock is on `$executeRaw` which in Prisma accepts tagged template literals. The test's expectation of `call[1]` being the string implies the mock captures template literal parameters correctly.

Wait - let me re-examine the Prisma raw query API usage:

```typescript
await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${remaining}ms`}, true)`;
```

This is a tagged template literal call. In Prisma, `$executeRaw` as a tagged template receives the interpolated values. The test extracts `call[1]` but the actual arguments structure would need to be verified based on how Jest mocks tagged template literals.

Looking at the test more carefully - the mock returns promises and the test verifies the **extracted parameters** via `.mock.calls`. The test expects `call[1]` to be the timeout value string. This suggests the mock setup in `fixture()` is capturing calls appropriately.

**`mail-query-deadline.postgres.spec.ts`:**

- Lines 8-12: Properly gated with environment variable check `MERI_APPROVED_MEMORY_PG_CONFIG` - ACCEPTED.

- Line 28: `url.searchParams.set('connection_limit', '1');` - Single connection for test isolation - ACCEPTED.

- Line 29: `prisma = new PrismaService({ datasources: { db: { url: url.toString() } }, log: [] });` - Direct instantiation with test config, not using global pool - ACCEPTED.

- Lines 39-46: The test verifies:
  1. First scan completes (2s sleep)
  2. Second scan is cancelled (8s sleep exceeds remaining ~1.5s budget)
  3. Error is 503
  4. Timeout is restored after transaction
  5. Pool is reusable afterward

- Lines 49-50: Verification that the timeout is restored post-transaction - **This is testing the "leaked timeout" concern but the assertion is not precise**. It compares `after` to `before`, but doesn't explicitly verify the timeout was reset. The `set_config` with `is_local=true` is session-scoped, meaning when the transaction ends and connection returns to pool, the next acquirer starts fresh. However, Prisma's connection pooling may maintain sessions across checkouts.

Wait - PostgreSQL sessions are tied to connections. When a connection is returned to the pool, the session state (including `statement_timeout`) persists until changed or the connection is reset. Prisma doesn't automatically reset `statement_timeout` on connection return.

**CRITICAL FINDING:** The implementation uses `set_config(..., true)` for *local* (transaction-level in some PostgreSQL contexts, but `statement_timeout` is session-level). The comment says "LOCAL cannot leak" but this is misleading. When the transaction ends, the `statement_timeout` remains at whatever value was last set for that session/connection. The next pool user inherits this timeout.

Looking at the test line 50: `expect(after).toEqual(before);` - This compares the entire row object including `timeout`. If `before.timeout` was the default (e.g., "0" or "") and `after.timeout` is still the short timeout set during the test, this test would fail. The test expects they match, implying the timeout is restored.

But the implementation DOES NOT explicitly restore the timeout! It only sets `statement_timeout` before each query. The "restoration" would only happen if:
1. The test database's default `statement_timeout` happens to match what was set
2. OR the connection is being discarded/fresh

Re-examining - the test's assertion `expect(after).toEqual(before)` is comparing the timeout values before and after. If the implementation doesn't restore, and if the previous timeout was "0" (disabled), the `after` timeout would be the last short value (e.g., "100ms"), not matching `before`.

**However**, looking more carefully at the test setup - it uses a fresh Prisma instance with `connection_limit: 1`. Each test gets its own isolated connection via `beforeAll`. The `before` check queries current settings, then the deadline helper runs, then `after` checks again. 

The issue is: `set_config('statement_timeout', X, true)` with `is_local=true` in a transaction context - in PostgreSQL, `SET LOCAL` only affects the current transaction and reverts at transaction end. This IS the correct behavior! The "leak protection" comes from PostgreSQL's `SET LOCAL` semantics, not Prisma or the code.

Reference: PostgreSQL docs state `SET LOCAL` affects only the current transaction, and the value reverts at transaction end.

So the implementation IS correct - the `true` third parameter to `set_config` corresponds to `SET LOCAL`, and the database automatically restores the previous value when the transaction commits or rolls back.

---

### SQL Predicate Preservation

Checking `mail-query.ts`:

- Lines 19-80: Input validation preserved - ACCEPTED
- Lines 90-123: SQL condition building - ACCEPTED
- Lines 128-155: The three queries (count, page, coverage) - ACCEPTED

The original `withMailQueryDeadline` replaces the direct `prisma.withTenant` calls while preserving all SQL semantics. The `query` function wrapper transparently executes the same SQL with added timeout protection.

---

### Error Handling

**`mail-query-deadline.ts` lines 29-31:**

```typescript
if (failure?.code === 'P2010' && failure.meta?.code === '57014') throw unavailable();
```

This checks that both the Prisma error code (`P2010` = raw query error) AND the PostgreSQL SQLSTATE (`57014` = query cancelled) match. **ACCEPTED** - this ensures only timeout cancellations get the sanitized 503, not other query errors.

---

## Critical Issues Found

### Issue 1: Potential SQL injection via `remaining` value (HIGH)

**Location:** `mail-query-deadline.ts:24`
```typescript
await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${remaining}ms`}, true)`;
```

The `remaining` value is computed as `Math.floor(deadline - performance.now())`. While `Math.floor` returns a number, the string interpolation `` `${remaining}ms` `` creates a string. This is then passed as a parameter to the template literal.

**Actually, re-reading carefully:** The outer template literal `${...}` syntax means `remaining` is being interpolated into a JavaScript string first, then THAT string is passed to the SQL template literal. Wait, no - let me parse this more carefully:

```typescript
`SELECT set_config('statement_timeout', ${`${remaining}ms`}, true)`
```

The inner backticks `${remaining}ms` creates a JavaScript string like "3490ms". This is then interpolated into the outer template literal. Since `$executeRaw` is a tagged template literal, the actual value passed to PostgreSQL would be this "3490ms" string.

The **PostgreSQL `set_config` function** accepts text values. The value "3490ms" is valid PostgreSQL interval syntax. Since this goes through Prisma's parameter binding (via template literal interpolation), it's properly escaped.

Actually wait - I need to verify this is secure. The flow is:
1. `remaining` is a number from `Math.floor()`
2. `${remaining}ms` creates string like "3490ms"  
3. This string is interpolated into the outer template literal
4. Prisma's `$executeRaw` treats this as a bound parameter

This IS safe because Prisma's tagged template literals use parameterized queries. The `remaining` value, even if maliciously crafted, would be bound as a parameter. However, since `remaining` comes from `Math.floor(deadline - performance.now())`, it's guaranteed to be a number (or NaN in edge cases, giving "NaNms").

**Not a vulnerability** - Prisma's template literal API handles parameterization.

### Issue 2: Template literal nesting may cause incorrect parameter binding

**Location:** `mail-query-deadline.ts:24`

Looking at the code again:
```typescript
await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${remaining}ms`}, true)`;
```

The nested template literal `${`${remaining}ms`}` is evaluated first by JavaScript, producing a plain string. This string is then passed as a single parameter to the SQL query. This works correctly.

**Actually**, there's a subtle issue: the inner template literal creates a string with the format "3490ms", but this string is then passed as a SQL parameter. PostgreSQL's `set_config` expects the value as text, which is correct. But I want to verify the `statement_timeout` G actually accepts interval syntax like "3490ms".

PostgreSQL's `statement_timeout` setting accepts values like '1s', '100ms', '5min', or integer milliseconds. So "3490ms" is valid.

### Issue 3: Error handling doesn't cover `executeRaw` failures (MEDIUM)

**Location:** `mail-query-deadline.ts:24-26`

If the `set_config` call itself fails (rare but possible), the error will propagate without being caught. The try/catch only wraps the outer block. This is probably acceptable since a failure to set timeout should indeed fail fast.

### Issue 4: Test mock expectations may not match actual Prisma call structure (LOW)

**Location:** `mail-query-deadline.spec.ts:36`

The test expects:
```typescript
expect(f.tx.$executeRaw.mock.calls.map(call => call[1])).toEqual(['3490ms', '2400ms', '100ms']);
```

But `$executeRaw` as a tagged template literal receives `(strings, ...values)` where `strings` is an array of string segments. The mock in the fixture:
```typescript
$executeRaw: jest.fn().mockResolvedValue(0)
```

This doesn't replicate the tagged template literal signature. Jest mocks for tagged template literals capture calls as `[strings, ...values]`. So `call[0]` would be the strings array, and `call[1]` would be the first interpolated value.

If the implementation uses:
```typescript
`SELECT set_config('statement_timeout', ${`${remaining}ms`}, true)`
```

Then there's ONE interpolated value (the "3490ms" string), making `call[1]` = "3490ms". This matches the test expectation. The test expects 3 calls with values ['3490ms', '2400ms', '100ms'].

**The test is verifying the decaying timeout values**, which is correct - each scan gets less time remaining.

### Issue 5: PostgreSQL test timeout assertion (LOW)

**Location:** `mail-query-deadline.postgres.spec.ts:44`

```typescript
expect(elapsed).toBeGreaterThan(3000); expect(elapsed).toBeLessThan(4500);
```

The first scan starts at t=0 with 3500ms budget, uses ~2s for `pg_sleep(2)`, so remaining is ~1500ms. Second scan gets `pg_sleep(8)` but times out after ~1500ms. Total should be ~3500ms (within the Jest timeout of 12s and the assertion bounds).

This looks reasonable for testing timeout behavior without being too strict about timing.

---

## Summary Assessment

| Category | Finding |
|----------|---------|
| SQL Injection | **NOT FOUND** - Prisma parameterized queries protect against injection |
| SQL State Mapping | **PASS** - P2010/57014 → 503 correctly implemented |
| Timeout Isolation | **PASS** - `SET LOCAL` (is_local=true) provides transaction-scoped timeout |
| Pool Leakage | **PASS** - PostgreSQL restores setting at transaction end |
| Predicate Preservation | **PASS** - All original mail-query.ts SQL is unchanged |
| Partial Results | **PASS** - Deadline check before each scan prevents partials |
| Error Sanitization | **PASS** - SQL errors not leaked, 503 returned |

---

## Final Verdict

**PASS**

The implementation correctly:
1. Uses `set_config(name, value, is_local=true)` for transaction-scoped timeout that PostgreSQL automatically reverts at transaction end
2. Maps P2010 + SQLSTATE 57014 to sanitized ServiceUnavailableException (503)
3. Prevents partial results by checking remaining budget before starting each scan
4. Preserves all original SQL semantics in `mail-query.ts`
5. Uses proper Prisma parameterized queries (no injection vulnerability)
6. Tests correctly verify: shared deadline decay, early rejection on exhaustion, error sanitization, unrelated error preservation, and actual PostgreSQL cancellation behavior

The PostgreSQL-local-revert behavior of `SET LOCAL` is the correct mechanism for preventing timeout leakage between pooled connections. The tests appropriately verify this with a single-connection pool and before/after state comparison.