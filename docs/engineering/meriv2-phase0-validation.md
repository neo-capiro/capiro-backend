# MeriV2 Phase 0 — Final Validation Report

Base: `origin/main` @ `1cdd372f0409986ac238beef2c4e9f310925fb37`
Branch: `fix/meriv2-p0-control-boundaries`
Validated against the final commit on this branch (see PR #642 for the exact head SHA).

This document supersedes and replaces four earlier, partial/stale validation
documents that previously lived in this directory (`meriv2-phase0-core-validation.md`,
`meriv2-phase0-api-validation.md`, `meriv2-phase0-api-lifecycle-validation.md`,
`meriv2-phase0-memory-validation.md`). Those were produced by a temporary,
now-removed self-modifying GitHub Actions pipeline (`.github/workflows/phase0-*.yml`
+ `.github/scripts/phase0-*.mjs`) partway through development and recorded a mix of
environment-only false failures (packages not built before typecheck/test),
issues later fixed by subsequent commits on this same branch, and three real
compile failures that are fixed as part of this validation pass. None of the
four should be treated as authoritative; this document is.

## 1. Environment note

Every command below was run after building the workspace packages each app
depends on (`@capiro/shared`, `@capiro/auth`, `@capiro/meriv2-core`,
`@capiro/strategy-verifier`) and generating each app's own Prisma client
(`apps/api`, `apps/workspace`). Skipping this step produces a wall of
`TS2307: Cannot find module` errors that look catastrophic but are purely a
fresh-worktree artifact, not a code defect — see the exact command sequence in
the "Reproduction" section at the bottom.

## 2. Typecheck

| Command | Result |
|---|---|
| `pnpm --filter @capiro/meriv2-core typecheck` | PASS |
| `pnpm --filter @capiro/meriv2-orchestrator typecheck` | PASS |
| `pnpm --filter @capiro/api typecheck` | PASS |
| `pnpm --filter @capiro/web typecheck` (via `npx tsc --noEmit`) | PASS |
| `pnpm typecheck` (root, all 18 turbo packages) | PASS — 18 successful, 18 total |

Fixed as part of this pass (all three were genuine, not environment noise):

1. `apps/api/src/meri/meri-memory-legal-hold.spec.ts` — `new MeriService(...)` was
   called with 12 positional arguments; the constructor takes 13
   (`contextCompiler` is the 13th). **This file is byte-identical to
   `origin/main`** — proven via `git diff origin/main...HEAD -- <path>` returning
   empty — so this was already broken on `main` before Phase 0 touched anything.
   Fixed by adding the missing mocked argument in the correct position; the
   production constructor was not changed.
2. `apps/api/src/meri/meri.service.ts:881` — `bearerToken` (`string | undefined`)
   was passed where `streamMessageViaMeriV2` requires `string`. The routing
   predicate (`shouldRouteMeriV2FullChat`) already guarantees `bearerToken` is
   truthy whenever it returns `true`, but as a plain boolean-returning function
   call TypeScript can't see that through it. Fixed with an explicit,
   provably-redundant `&& bearerToken` conjunct in the same `if`, which gives
   real control-flow narrowing without an unsafe non-null assertion and without
   changing behavior (the routing function already requires the same
   truthiness to return `true`).
3. `apps/api/src/meri/meriv2-routing.helpers.spec.ts` — an `it.each` table mixed
   2-element tuples (`[input, label]`) with a single-parameter callback,
   which TypeScript's tuple-array `it.each` overload rejects. Restructured to
   named-object rows (`{ input, label }`) with `$label` interpolation, keeping
   all four original cases.

## 3. Test suites

| Package | Command | Result |
|---|---|---|
| `@capiro/meriv2-core` | `pnpm --filter @capiro/meriv2-core test -- --runInBand` | **30/30 suites, 338 passed / 2 todo / 340 total** |
| `@capiro/meriv2-orchestrator` | `NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @capiro/meriv2-orchestrator test -- --runInBand` | **25/25 suites, 285 passed / 2 skipped / 1 failed → fixed → 288/288 passed on re-run (18 tests are new for Phase 0)** |
| `@capiro/api` (targeted Phase 0 batches) | see §3.1 | all batches green, including 3 new adversarial tests added this pass |
| `@capiro/api` (full suite) | `NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/jest --silent --maxWorkers=2 --workerIdleMemoryLimit=1500MB` | see §3.2 |
| `@capiro/web` | `VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npx vitest run` | **146/147 files, 1255/1256 tests** — the one failure (`ProgramElementWatchPage.test.tsx` / `FundingNarrativePanel.tsx:31`) is a documented pre-existing baseline failure unrelated to any file this branch touches |

### 3.1 API — targeted Phase 0 batches (brief §12.2)

- **Batch 1** (`meri-write-tool-input.spec.ts`, `tool-service-secret.guard.spec.ts`,
  `meri-approval.service.spec.ts`): 3 suites, 21 tests, all PASS.
- **Batch 2** (`meri-action-proposal.service.spec.ts`): 1 suite, **18 tests**
  (15 original + 3 added this pass — tool-swap fingerprint mismatch,
  terminal-failure classification, cross-tenant list scoping), all PASS.
- **Batch 3** (`meri-action-proposal.http.spec.ts`): 1 suite, 8 tests, all PASS.
- **Batch 4** (memory containment — `memory-mutation-auth.spec.ts`,
  `memory-autolearn-governance.spec.ts`, `memory-candidate-rules.spec.ts`,
  `memory-store.mutation.spec.ts`): 4 suites, 45 tests, all PASS
  (heap 1687–1839 MB per suite with `--logHeapUsage`).
- **Batch 5** (`meriv2-routing.helpers.spec.ts`): 1 suite, 5 tests, all PASS.

### 3.2 API — full suite result

Running the genuinely full suite (not just the targeted Phase 0 batches) is
what surfaced three additional real bugs that no batch-level run had ever
reached — none of them have a compile error, so nothing before this had a
reason to catch that they fail at runtime:

1. `apps/api/src/meri/meri-memory-legal-hold.spec.ts` — beyond the constructor
   arg-count compile fix (§2), the fixture itself used `role:'standard_user'`
   against a `scope:'firm'` (shared) memory row. `forgetMemory`/`updateMemory`
   now route shared-scope mutation through `evaluateMemoryMutation`, which
   correctly requires an admin role for shared memory — confirmed this is an
   intentional tightening already present on this branch (not something this
   validation pass introduced) by diffing against `origin/main`'s
   `forgetMemory`, which has no `evaluateMemoryMutation` call at all and lets
   any user touch firm-scope rows. Fixed by changing the fixture's role to
   `capiro_admin` so the legal-hold assertions the file exists to test are
   actually reached, and updating one `deleteMany` assertion to match the
   current, more specific (defense-in-depth) where-clause.
2. `apps/api/src/memory/memory-private-fail-closed.spec.ts` — a
   "regression lock" test that greps `meri.service.ts` for the exact old
   inline check `row.scope === 'user_private' && row.ownerUserId !==
   ctx.userId`, which `evaluateMemoryMutation` legitimately replaced (it
   subsumes the same guarantee — proven separately in
   `memory-mutation-auth.spec.ts` — plus adds role/legal-hold gating the old
   inline check never had). Updated the detection regex to match the new
   `evaluateMemoryMutation(ctx, { scope: row.scope, ownerUserId:
   row.ownerUserId, ...` call shape instead of weakening what it proves.
3. `apps/api/src/memory/memory-verbs.spec.ts` — `MemoryStoreService`'s
   confirm/forget/correct SELECTs grew more columns (`visibility`,
   `owner_user_id`, `client_id`, `status`) so authorization no longer
   piggybacks on the read's own WHERE clause. The mocked `$queryRaw` matched
   on the OLD, narrower column list as a substring key, so post-refactor it
   silently returned no rows. Matched on `'FROM memory_items'` instead
   (stable across column-list changes) and added `visibility`/`owner_user_id`
   to every row fixture so the mocked row is authorized as the owner's own
   private memory — these tests are about confirm/forget/correct SQL control
   flow, not authorization, which has its own dedicated spec.

Command: `NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/jest
--silent --maxWorkers=2 --workerIdleMemoryLimit=1500MB` (from `apps/api`).

**Final tally, the run that found the three bugs above (started before their
fixes landed on disk):** `Test Suites: 15 failed, 439 passed, 454 total.
Tests: 48 failed, 1 todo, 5186 passed, 5235 total. Time: 2557.8s.` The 15
failing suites are exactly the pre-existing 12-suite baseline
(`bill-pe-extractor`, `sam-personnel-extractor`, `dow-org-import.helpers`,
`program-element-read`(+`provisions`), `acquisition-personnel-read`,
`engagement-batch-*` (4 suites), `defense-budget-e2e`,
`meri-tools.firmdata` — all class-2 "drifted hand-mock" failures unrelated to
Meri/memory/proposal code, unaffected by this branch) plus the three files
above, whose Jest workers had already started executing the pre-fix source
by the time the fixes landed — a full 2557s run overlapping a same-repo edit
is expected to show this, not a sign the fixes didn't take.

**Confirmation, fresh targeted run against the current committed HEAD
(`98300e41`) after the fixes:**
`jest src/memory/memory-private-fail-closed.spec.ts
src/meri/meri-memory-legal-hold.spec.ts src/memory/memory-verbs.spec.ts` →
`Test Suites: 3 passed, 3 total. Tests: 20 passed, 20 total.` This confirms
the true current state of the branch is **exactly the 12-suite pre-existing
baseline failing, and nothing else** — zero suites newly broken by Phase 0
work.

## 4. Root validation

`pnpm typecheck` at the repo root: **18/18 packages successful** (includes
`@capiro/api-strategy`, `@capiro/intel-api`, `@capiro/onboard-api`,
`@capiro/onboard-web`, `@capiro/workspace`, `@capiro/auth`, `@capiro/shared`,
`@capiro/strategy-verifier` — none of which this branch touches, confirming no
cross-package breakage).

CI's actual required checks were inspected directly (not guessed) — see the
completion report's "Feature flags and secrets" / CI section for the exact
workflow files and what they run.

## 5. Adversarial cases proven (brief §10, all 20 items)

| # | Case | Evidence |
|---|---|---|
| 1 | Normal user cannot create a proposal without internal service identity | `meri-action-proposal.http.spec.ts` — "browser cannot create a trusted proposal without service identity" |
| 2 | Valid JWT + missing internal secret → 403 for raw write tools | `tool-service-secret.guard.spec.ts` — "staging/production fails closed when the configured secret is missing"; `meri-action-proposal.http.spec.ts` — "raw write tool rejects... without... service identity" |
| 3 | Valid JWT + wrong internal secret → 403 | same two specs, "...or with wrong service identity" |
| 4 | Missing configured secret in production does not permit execution | `tool-service-secret.guard.spec.ts` (guard throws before the controller/executor is ever reached) |
| 5 | Correct JWT + correct secret reaches the mocked internal service | `meri-action-proposal.http.spec.ts` — "correct service identity plus effective user context reaches the delegated service" |
| 6 | Arbitrary 64-character hash cannot authorize an action | `meri-action-proposal.http.spec.ts` — legacy route with a 64-hex fingerprint → 410 Gone, executor never called; new approve route rejects a `fingerprint` body field outright (400) |
| 7 | Approve route rejects forbidden body fields | `meri-action-proposal.http.spec.ts` — "approval body rejects tool, payload, fingerprint, tenant, and status fields" |
| 8 | User cannot approve another user's proposal | `meri-action-proposal.http.spec.ts` + `meri-action-proposal.service.spec.ts` ("does not reveal or execute another user or tenant proposal") |
| 9 | User cannot approve another tenant's proposal | same two specs |
| 10 | Unknown/extra proposal-creation DTO fields rejected | `meri-action-proposal.http.spec.ts` — "orchestrator identity can submit only tool/input/conversation/surface fields" (extra fields → 400) |
| 11 | Changed stored payload → fingerprint mismatch, no execution | `meri-action-proposal.service.spec.ts` — "blocks changed stored payloads because the fingerprint no longer matches" |
| 12 | Changed tool → fingerprint mismatch, no execution | `meri-action-proposal.service.spec.ts` — "blocks a stored tool that no longer matches its fingerprint" (added this pass) |
| 13 | Policy WARN→BLOCK prevents execution | `meri-action-proposal.service.spec.ts` — "rechecks current policy and blocks a WARN proposal that is now BLOCK" |
| 14 | Expired proposal cannot execute | `meri-action-proposal.service.spec.ts` — "expires without execution" |
| 15 | Double-click/concurrent approval executes at most once | `meri-action-proposal.service.spec.ts` — "loses a double-click claim without executing twice" |
| 16 | Provider ambiguity becomes `outcome_unknown` | `meri-action-proposal.service.spec.ts` — "classifies an ambiguous external-send error as outcome_unknown and not retryable" |
| 17 | Failed execution is not shown/stored as succeeded | `meri-action-proposal.service.spec.ts` — "classifies a genuine validation failure as failed_terminal, never succeeded" (added this pass) + "classifies safe internal transient errors as failed_retryable" |
| 18 | Dismissed proposal cannot execute | `meri-action-proposal.service.spec.ts` — terminal-status `it.each` includes `dismissed` |
| 19 | Legacy pending-action route cannot be used by a browser | `meri-action-proposal.http.spec.ts` — "normal user cannot POST arbitrary legacy pending action data" (410) |
| 20 | Cross-tenant list access returns no foreign proposals | `meri-action-proposal.service.spec.ts` — "never returns another tenant or user's proposals" (added this pass) |

Orchestrator-side (brief §D5):

- Approval event emitted only after durable proposal creation — `chat-assistant.service.spec.ts`, "streams pending_approval ... only after the API call resolves."
- Proposal API failure emits no usable card — `chat-assistant.service.spec.ts`, "proposal API failure emits no usable approval card and tells the model nothing was proposed" (new).
- Impersonation metadata forwarded consistently — `impersonation-passthrough.spec.ts` (tool executor, action-proposal creation, compliance audit — the last extended this pass).
- Impersonated write-enabled MeriV2 routing stays disabled — `meriv2-routing.helpers.spec.ts` (pre-existing, still passing) plus the structural read-only guarantee of the legacy fallback path (`meri.service.ts:1046-1055`: the legacy in-process loop filters side-effecting tools out of the model's tool manifest entirely, independent of impersonation — impersonated turns route there and inherit that guarantee).

## 6. Migration — live rehearsal against a genuine disposable Postgres

**Update (this pass): a real live rehearsal was obtained.** Docker Desktop on
this machine needs WSL2, which is not installed, and there is no native
PostgreSQL install either — the two paths originally considered infeasible.
A third, previously untried path worked: the `embedded-postgres` npm package
(zonky-distributed, precompiled PostgreSQL 16.14 Windows binaries) boots a
genuine, fully disposable PostgreSQL server from a scratch temp directory —
no Docker, no WSL2, no system install, no Windows service registration, no
reboot, no production credentials anywhere near it. Installed and run from
`%TEMP%\meriv2-pg-rehearsal` (outside any repo checkout); the entire directory
and every spawned `postgres.exe` process were deleted/killed after the run —
nothing persists.

**Methodology.** A full replay of the repository's 184-migration history was
not possible: the very first migration (`20260501000000_init_identity_tenancy`)
runs `CREATE EXTENSION IF NOT EXISTS "vector"`, and this Postgres distribution
does not bundle the third-party `pgvector` extension (unrelated to this
migration or this branch). Rather than replay the unrelated history, the
rehearsal built the exact minimal prerequisite state this migration actually
depends on, extracted **verbatim** from the real migration files (not
hand-approximated): the `current_tenant_id()`/`rls_bypass()` functions and the
`tenants` table from `20260501000000_init_identity_tenancy`, and the complete
`meri_action_approval` / `meri_pending_action` tables from their own
(never-altered-since) defining migrations, `20260706020000_meri_action_approval`
and `20260715180000_meri_pending_action`. The real, completely unmodified
`20260728010000_meriv2_action_proposals/migration.sql` file was then read from
disk and executed byte-for-byte. This proves everything a full-history replay
would have proven for this migration specifically; it does not re-validate
184 unrelated migrations' compatibility with a non-Docker Postgres binary,
which was never the goal.

**G1 — disposable database:**
- Disposable: confirmed — ephemeral data directory, `persistent: false`,
  deleted after the run.
- Pre-migration schema state recorded: `meri_action_approval,
  meri_pending_action, tenants` (queried from `information_schema.tables`
  immediately before applying the new migration).
- No production credentials loaded: confirmed — fresh local superuser
  (`postgres`/scratch password), no AWS/Capiro secret ever referenced.

**G2 — applying the migration (all 12 items verified live, not just by static
reading):**

1. Applied cleanly from the pre-migration schema — no error.
2. Prisma client generation — proven separately (typecheck, §2); not
   re-tested against this scratch instance since Prisma client generation
   doesn't depend on a live database connection.
3. Table exists with correct columns/types/defaults — queried
   `information_schema.columns`: 28 columns, spot-checked `tenant_id`/
   `user_id` as `uuid not null`, `attempt_count` defaults to `0`.
4. Check constraints work — three live INSERT attempts, each correctly
   rejected by Postgres itself: an invalid `status` value
   (`meri_action_proposals_status_check`), a non-hex `fingerprint`
   (`meri_action_proposals_fingerprint_check`), and an invalid
   `policy_decision` (`meri_action_proposals_policy_decision_check`).
5. Indexes exist — all 4 named indexes plus the primary key index confirmed
   present via `pg_indexes`.
6. RLS policy exists **and is effective** — `pg_class.relrowsecurity` and
   `relforcerowsecurity` both `true` (the Phase I/static-review FORCE fix,
   confirmed live); `pg_policies` shows policy `meri_action_proposals_isolation`
   with the expected `USING`/`WITH CHECK` expression; the migration's own
   conditional `GRANT` block fired correctly once a `capiro_app` role existed
   (`DELETE, INSERT, SELECT, UPDATE` confirmed via
   `information_schema.role_table_grants`).
7. Historical `meri_action_approval`/`meri_pending_action` rows unchanged —
   seeded one real row in each before applying the migration; both rows are
   byte-identical (full-row comparison) after.
8. New proposal creation succeeds — proven as part of the RLS behavioral test
   below (a real `capiro_app` INSERT, not the superuser).
9. **Cross-tenant access is blocked by RLS, demonstrated behaviorally, not
   just read from the SQL text**: connected as `capiro_app` — a genuine
   non-superuser, non-table-owner role (the actual precondition for
   `FORCE ROW LEVEL SECURITY` to matter) — with the session GUC set to tenant
   A: inserting a row tagged tenant B was rejected by the `WITH CHECK` clause
   (`new row violates row-level security policy`); a second `capiro_app`
   session scoped to tenant B saw **zero** of tenant A's rows on a plain
   `SELECT count(*)`. **Caveat, consistent with Phase I finding #4 (§5
   above)**: this proves the *policy's own logic* is correct for any role
   genuinely subject to RLS. It does not by itself prove production's actual
   `capiro_app` connection is subject to RLS in practice — this codebase's own
   existing comment (`prisma.service.ts`) states the real production role
   bypasses RLS, which is why real tenant isolation for live traffic rests on
   the explicit `tenantId`/`userId` predicates in every query (proven
   extensively elsewhere in this document and in Phase I), with RLS serving as
   schema-level defense-in-depth matching repository convention.
10. Approval lifecycle transitions persist — `proposed` → `executing` →
    `succeeded`, each confirmed via a fresh `SELECT` after the `UPDATE`.
11. Dismiss and expiration persist — both confirmed via fresh `SELECT`s.
12. Coexists with the feature flag disabled — code-level fact
    (`MeriActionProposalService.assertEnabled()` throws before any query runs
    when `MERIV2_ACTION_PROPOSALS_ENABLED` is false), verified by reading the
    code rather than re-tested against the scratch instance, since the flag
    gates the NestJS service layer, not the schema.

**G3 — rollback rehearsal:**
- `MERIV2_ACTION_PROPOSALS_ENABLED=false` disables the new path cleanly — code
  fact (item 12 above); the routes/service short-circuit before touching the
  database.
- The additive table can remain present safely — not in question; nothing
  reads it unless the flag is on.
- Old insecure approval routes remain disabled — confirmed elsewhere in this
  document (410 Gone, executor never invoked).
- Read-only Meri behavior remains available — unaffected by this table
  entirely.
- **SQL reversibility, documented not shipped**: a live `DROP TABLE
  "meri_action_proposals" CASCADE` was executed against the rehearsal
  instance and succeeded with no errors; the `meri_action_approval`/
  `meri_pending_action` historical rows were completely untouched afterward,
  confirming the table is fully isolated (also confirmed statically: no
  migration anywhere in the 184-file history has a foreign key referencing
  `meri_action_proposals`). **This is documentation of technical
  reversibility only — no down-migration was created or shipped.** Per the
  brief's own instruction, a destructive rollback that deletes proposal audit
  history is never the recommended path; the feature flag is.

Fingerprint format, index/constraint-to-schema correspondence, and the
`user_id`/`actor_user_id`/`approved_by` UUID-vs-Clerk-subject distinction
(previously verified by static reading) are unchanged and remain accurate;
see the prior static-review notes preserved in git history for that detail if
needed. **This live rehearsal supersedes the "not performed" note from the
prior revision of this document — the migration-rehearsal acceptance
criterion is now MET by live evidence, not a substitute.**

## Reproduction

```bash
pnpm --filter @capiro/shared build
pnpm --filter @capiro/auth build
pnpm --filter @capiro/strategy-verifier build
pnpm --filter @capiro/meriv2-core build
pnpm --filter @capiro/api prisma:generate
pnpm --filter @capiro/workspace prisma:generate
pnpm typecheck
pnpm --filter @capiro/meriv2-core test -- --runInBand
NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @capiro/meriv2-orchestrator test -- --runInBand
NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter @capiro/api test -- --runInBand   # or the split batches in §3.1
npx vitest run   # from apps/web, with VITE_CLERK_PUBLISHABLE_KEY set
```

### Migration rehearsal (no Docker/WSL2 required)

```bash
mkdir /tmp/pg-rehearsal && cd /tmp/pg-rehearsal
npm init -y && npm install embedded-postgres@16.14.0-beta.17 pg@8
# write a script that: new EmbeddedPostgres({databaseDir, user, password, port, persistent:false})
# -> initialise() -> start() -> createDatabase() -> getPgClient(dbName) -> apply prerequisite
# DDL (current_tenant_id()/rls_bypass() + tenants + meri_action_approval + meri_pending_action,
# extracted verbatim from their own migrations) -> fs.readFileSync the real
# 20260728010000_meriv2_action_proposals/migration.sql -> client.query(it) -> run the G2/G3
# assertions in §6 -> stop() -> rm -rf the scratch directory.
# Note: a full `prisma migrate deploy` replay of the whole history is NOT viable
# on this binary — migration 20260501000000_init_identity_tenancy requires the
# pgvector extension, which this distribution does not bundle. That's fine: this
# migration is additive and self-contained, so only its real prerequisites matter.
```
