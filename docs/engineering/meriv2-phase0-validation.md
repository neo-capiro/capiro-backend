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

<!-- Filled in from the background run's final summary. -->

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

## 6. Migration — static verification (live rehearsal blocked, see completion report)

Full static review against `apps/api/prisma/schema.prisma` and the two closest
sibling tables (`meri_action_approval`, `meri_pending_action`) plus the most
recent RLS-setting migration in the repo (`20260805010000_alert_generation_record`,
confirmed still current convention):

- Additive only — new table, zero changes to any existing column.
- **Found and fixed during this review**: the migration as originally written on
  this branch was missing `FORCE ROW LEVEL SECURITY` and the `rls_bypass()`
  escape hatch that every other tenant-scoped table in this schema applies, and
  was missing the conditional `GRANT ... TO capiro_app` block present in both
  sibling migrations. Without `FORCE`, RLS provides no protection if the
  table-owning role bypasses RLS by default (exactly the risk the table's own
  comment already named but did not close); without the `GRANT`, the
  application role may have had no privileges on the table at all. Both are
  fixed in place in the (never-applied, never-deployed) migration file.
- `fingerprint` format-constrained to `^[0-9a-f]{64}$`; `status` and
  `policy_decision` are both DB-level CHECK-constrained to their exact allowed
  enums, matching `MeriActionProposalStatus`/`ComplianceOutcome` in code.
- All four `@@index` declarations in `schema.prisma` have a matching
  `CREATE INDEX` in the migration with matching column order.
- FK to `tenants(id)` with `ON DELETE CASCADE` matches convention.
- `user_id`/`actor_user_id`/`approved_by` are `@db.Uuid`, confirmed correct by
  tracing `TenantContext.userId` to `user.id` (a real DB UUID) in
  `tenant-context.middleware.ts` — distinct from the unrelated, older
  `MeriContext.userId` (a Clerk subject string) used by `meri_action_approval`/
  `meri_pending_action`, which was the source of the apparent inconsistency.

**Not performed**: applying the migration to a live disposable database.
Docker Desktop on this machine is configured for the WSL2 backend, but WSL2 is
not installed, and there is no native PostgreSQL install either — see the
completion report for the exact commands to run this rehearsal in an
environment where Docker/WSL already works. This is the one acceptance
criterion left UNMET by live evidence; everything above is the substitute
static evidence, including one genuine defect this review caught and fixed
that a live rehearsal would also have caught.

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
