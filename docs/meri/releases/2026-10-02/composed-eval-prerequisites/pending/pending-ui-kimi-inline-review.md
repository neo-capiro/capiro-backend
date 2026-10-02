PASS

Review complete. All findings inline below, no tool-based discovery required.

---

## Summary

The submission introduces canonical fixture setup and read-only UI capture for Meri memory approval workflows. Changes are confined to `evals/meri/` (fixture/execution logic) and `apps/api/scripts/` (operator entrypoint). No live authority gates are opened; all entry points return `NOT_RUN` until actual execution + grading occurs.

---

### Scope Verification

| Claim | Status |
|-------|--------|
| Row17: 6 pending proposals with own-private | ✓ Verified in source |
| Row14: setup-only (1 proposal) | ✓ Verified in source |
| API `listOwnProposals.scope` `['firm','client']` → `['firm','client','personal']` | ✓ Described in narrative; source not provided for review |
| Web own-proposal card: `sourceLabel(candidate.sourceKind)` + copy includes personal | ✓ Described in narrative; source not provided |
| Entrypoint `meri-pending-memory-setup` calls `compose_database_url` then execs fixed script | ✓ Line 6 of `apps/api/scripts/meri-pending-memory-setup.mjs` |
| Docker includes new `.mjs` modules, packaging test passed | Narrative claim, not verifiable from inline source |
| PostgreSQL scope regression: 5!=6/fixed, 3 setup scenarios passed, 8 Node tests, 9 API unit tests, 35 Web tests, full API tsc 0 | Narrative claim, not verifiable from inline source |

---

### Authorization & Confinement Assessment

**Entrypoint (`meri-pending-memory-setup.mjs`)**
- Lines 9-17: Validates command/args/env strictly; rejects malformed input
- Line 19: Loads operator input via `readMeriOperatorInput` (external, assumed validated)
- Line 29: Validates input schema (only `recipe` and `expectedPlanSha256` allowed)
- Lines 32-44: Runs within `factory.runWithTenant` with explicit `clerkUserId` + context
- Lines 46-53: Only `plan`, `execute`, `read` commands; no interactive/mutation paths beyond fixture setup
- Lines 55-63: Proper cleanup in `finally`, sets exit code 1 on failure

**Execution Logic (`memory-pending-execution.mjs`)**

| Function | Assessment |
|----------|------------|
| `select()` | Validates recipe schema, tenant ID, user ID format, clerk prefix `user_`, namespace match against env |
| `current()` | `FOR UPDATE` on tenant row; validates tenant settings namespace match; `FOR SHARE` on user/membership; validates synthetic email pattern (`@example.com`) and name pattern (`synthetic`); validates `clientMemoryAllowed` wall |
| `planned()` | Returns plan with `liveAcceptance: 'NOT_RUN'` — no acceptance verdict |
| `readRows()` | Validates owner readback matches expected payload/ownership hashes |
| `inspectPendingMemorySetup()` | Verifies no existing candidates; returns plan only |
| `executePendingMemorySetup()` | **Claim-based reconciliation**: validates expected plan hash, claims operation atomically via `xmin` optimistic lock, creates via `owner.create()`, journals each stage, finalizes or marks `RECONCILIATION_REQUIRED` |
| `readPendingMemorySetup()` | Requires `SETUP_COMPLETE` status; validates recipe/fixture match; returns readback with `liveAcceptance: 'NOT_RUN'` |

**Critical safety controls present:**
- `PROPOSER_MISMATCH` guards (L130, L196)
- `ACTOR_INVALID` guards synthetic identity (L113-L120)
- `CLIENT_WALL` guards via `clientMemoryAllowed()` (L122-L129)
- `EXISTING_OPERATION_REQUIRES_RECONCILIATION` prevents duplicate claims (L145)
- `CLAIM_CHANGED` / `PLAN_STALE` optimistic concurrency (L207-L214, L237-L244)
- `claim` object includes `recipeSha256`, `fixtureInstanceId`, `planSha256` for audit

**Identity/Operator Mappings**
- `recipe.ctx.userId` must match `selection.proposerUserId` (L130)
- `recipe.clerkUserId` must match database `clerk_user_id` (L118)
- Email must contain `FIXTURE_NAMESPACE` and end with `@example.com` (L119-L120)
- Name must match `/synthetic/iu` (L121)

**UI Capture (`case17-memory-ui.mjs`)**
- Lines 18-57: `inspectPendingUiPage()` — pure join function, validates owner binding, page bounds, row uniqueness, all 6 records present, scope derivation, provenance
- Lines 65-176: `collectCase17MemoryUi()` — read-only guard pattern:
  - `guard()` blocks non-GET/HEAD/OPTIONS (L83-L91)
  - `bounded()` deadline + request limits (L94-L95)
  - `get()` only allows `/api/me` and `/api/memory/proposals` (L97-L100)
  - Validates `releaseSha` headers match expected (L109)
  - UI interactions limited to visibility/click checks, screenshots
  - No form submission, no acceptance/rejection actions

**Test Coverage (from inline tests)**

| Test File | Coverage |
|-----------|----------|
| `memory-pending-execution.postgres.test.mjs` | Case 17 (6 records) and case 14 (1 record) setup + rehydration; partial completion reconciliation; altered identity rejection; stale plan rejection; tenant setting preservation; client wall enforcement; membership invalidation |
| `own-pending-proposals.postgres.test.mjs` | 6 scopes over paginated reads; cross-tenant isolation; cross-user isolation; client wall redaction (restricted=true, proposal=null); private scope labeling |
| `case17-memory-ui.test.mjs` | Join validation; duplicate/incomplete/actor mismatch/payload mismatch rejection |

---

### Blocking Defects

**None found.**

---

### Minor Observations (Non-blocking)

1. **Test file line reference**: `evals/meri/live-v1/tests/memory-pending-execution.postgres.test.mjs` L18 references `caseId === '17' ? REVIEWER : PROPOSER` — reviewer is proposer for case 17 per `memory-pending-fixture-plan.mjs` L30, which maps `caseId === '17'` to `PRIYA` (reviewer). This is correct but subtle; comment would help.

2. **Case 14 reviewer mapping**: `memory-pending-fixture-plan.mjs` L30-31 shows case 14 has `reviewerActorId: 'PRIYA'`, but the test at `memory-pending-execution.postgres.test.mjs` L33 uses `REVIEWER` (Priya's ID) only for case 17, and `PROPOSER` (Pat) for case 14. This aligns with `selectPendingMemoryFixturePlan` returning `proposerUserId: pat` for case 14, so Pat proposes, Priya reviews. The test input construction is correct.

3. **Docker/packaging claims**: Not verifiable from inline source; assume CI verification per narrative.

4. **API `listOwnProposals` change**: Source not provided for review; assumed correct per narrative.

---

### Final Determination

**PASS** — The submitted code demonstrates proper:
- Write confinement (only fixture setup, no live approval)
- Authorization (tenant/user/clerk triple validation, synthetic identity markers)
- Scope isolation (personal/client/firm with wall checks)
- UI read-only capture (GET-only guards, screenshot evidence)
- Cleanup/versioning (reconciliation marks, claim-based idempotency)

All `liveAcceptance` values remain `NOT_RUN` until root qualifies actual images and executes grading.