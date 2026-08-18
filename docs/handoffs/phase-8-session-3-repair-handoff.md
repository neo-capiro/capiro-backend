# Phase 8 Session 3 — Repair Handoff

## Repository / branch / PR

- Repository: neo-capiro/capirov2
- Branch: agent/phase8-session3-program-elements-repair
- Base SHA (origin/main at branch creation): 67f220efe3065f21676c14ec31b65ee5312d93e5
- Base SHA (origin/main at push time, for reference): 27b9a6960ed140a9b61f9bca3b0dc384354296d8
- Head SHA (this branch): d07b24efc7cf526b95b34521868283f079c7b0c0
- PR: https://github.com/neo-capiro/capirov2/pull/1044 (draft, OPEN, base=main, head=agent/phase8-session3-program-elements-repair)
- Changed files (this branch vs origin/main, `git diff --cached --stat` at commit time): 28 files changed, 3875 insertions(+), 13 deletions(-)
  - 2 cherry-picked commits salvaged from the prior broken Session 3 attempt (Prisma schema subset extension, tenant-scoped transaction helper)
  - 1 new commit with the full Session 3 implementation

## What Session 3 actually is now

All 49 routes frozen in `packages/defense-contracts/src/public/index.ts` are implemented
in `apps/defense-api` with real business logic against defense-api's own Prisma client —
not stubs, not a mechanical copy of `apps/api`. Route groups covered: PE finder/list,
summary, profile/detail, intelligence, timeline, narrative, bills, bill actions,
contractors, projects, procurement lines, sources/provenance, related PEs, programs,
provisions, SAM opportunities, positions, movements/deltas, watch/unwatch, PE alert email
prefs, data issues, reconciliation queue, governed manual-override workflow, Budget Lines,
and Programs (search/detail/admin/alias/match).

Architecture rules honored and mechanically verified (not just asserted):
- No apps/api executable imports under apps/defense-api.
- Cross-domain reads (Congress bills, SAM opportunities) are bounded read-only Prisma
  projections owned by defense-api's own schema — no service import of apps/api's
  bills/SAM/USAspending modules.
- No implicit peCode -> BLIN/BLI resolver anywhere.
- Exact-money semantics: manual-override values are canonical-decimal-string validated;
  no `Number()` coercion applied to a governed money value.
- Governed manual-override module reimplemented as new pure source (not copied) scoped to
  the reconciliation-queue target: author != approver, capiro_admin-only approval,
  canonical-decimal-only values, immutable (no update-in-place, no delete) at the DB grant
  level. No promotion or snapshot-activation method reachable anywhere in this module.
- Tenant isolation preserved for watches, PE email prefs, and data issues (RLS + explicit
  withTenant/withTenantActor scoping, checked structurally by the verifier).
- Role behavior: standard_user for normal PE routes, capiro_admin for
  reconciliation/data-issue/program-mutation admin surfaces.
- apps/api remains the sole production owner of every route in this list; no production
  traffic is routed to defense-api (unchanged from Session 2's posture).

## New DB grant

Migration `apps/api/prisma/migrations/20261120210000_phase8_defense_serve_user_resolver/migration.sql`:
- `capiro_defense_resolve_member(tenant_id, clerk_user_id)` — one narrow SECURITY DEFINER
  function resolving (userId, role) for an already-verified session, mirroring the three
  Session 2 tenant-resolution functions exactly.
- `GRANT INSERT, UPDATE ON defense_budget_manual_override TO capiro_defense_serve` (no
  DELETE — immutability enforced at the grant level, additionally checked live in the DB
  rehearsal).
- Rehearsed only against a disposable container Postgres. Never applied to a shared or
  production database.

## Exact commands run and results

All commands below were actually executed in this session; none of these results are
inferred or assumed.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` (worktree) | PASS — background run, exit 0 |
| `pnpm --filter @capiro/auth build` | PASS |
| `pnpm --filter @capiro/defense-contracts build` | PASS |
| `pnpm --filter @capiro/defense-domain build` | PASS |
| `pnpm --filter @capiro/defense-client build` | PASS |
| `pnpm --filter @capiro/defense-api prisma:validate` | PASS — "The schema at prisma\schema.prisma is valid" |
| `pnpm --filter @capiro/defense-api typecheck` | PASS — 0 errors |
| `pnpm --filter @capiro/defense-api test` | PASS — 44 tests, 43 pass, 1 skipped (DB-dependent readyz test), 0 fail |
| `pnpm --filter @capiro/defense-api build` | PASS |
| `pnpm verify:phase8-session2` | PASS — `SESSION2_BOUNDARY_PASS` |
| `pnpm verify:phase8-session2:db` (disposable Postgres 16) | PASS — `SESSION2_DB_REHEARSAL_PASS (36 checks)` |
| `pnpm verify:phase8-session3` (new permanent verifier) | PASS — `SESSION3_BOUNDARY_PASS`, 49/49 route matches |
| `pnpm verify:phase8-session3:db` (disposable Postgres 16) | PASS — `SESSION3_DB_REHEARSAL_PASS (30 checks)` |
| `pnpm verify:phase8-session3:parity` (old-vs-new parity, outside apps/defense-api/src) | PASS — 2/2 |
| `docker build -f apps/defense-api/Dockerfile -t capiro-defense-api:phase8-session3 .` | **FAIL — see blocker below** |
| `git diff --check` | PASS — clean, no whitespace errors |

Route count: 49/49 (exact match against `@capiro/defense-contracts`, confirmed by both the
static verifier and a structural Jest/node:test parity spec).
Test count: 44 in `apps/defense-api` (43 pass, 1 skipped) + 2 in the standalone parity
suite = 46 total test cases run, 45 pass, 1 skipped, 0 fail.
DB rehearsal result: both Session 2 (36 checks) and Session 3 (30 checks) disposable-Postgres
rehearsals PASS.
Docker result: FAIL (environment defect, detailed below — not a code defect).

## Real bugs found and fixed during this repair (not just claimed — reproduced then fixed)

1. **PB-comparison rounding parity gap.** `getPbComparison`'s row-shaping did not round
   `deltaAbs`/`deltaPct` the way apps/api's actual `computePbComparison` pure helper does
   (2dp / 4dp respectively). Found by importing apps/api's real helper into a parity spec
   and comparing outputs on an identical fixture. Fixed in
   `program-element-read.service.ts`; parity spec now asserts field-for-field equality
   against the legacy implementation and passes.
2. **Manual-override Prisma model missing NOT NULL columns.** The initial
   `DefenseBudgetManualOverride` Prisma model omitted `money_original_value`,
   `money_original_unit`, `money_value_millions`, `author_actor_id`, `reason`, and
   `evidence_ids` — all NOT NULL in the real table, with an evidence-array CHECK
   constraint. This surfaced as a real INSERT failure in the first Session 3 DB rehearsal
   run (`FAILED: serve proposes a manual override (INSERT) — the database refused a
   statement it must accept`). Fixed the schema and the Prisma repository adapter
   (`markApproved` was also missing `approver_actor_id`/`approver_role`, which would have
   violated the two-step CHECK constraint on approval). Reran the rehearsal from a fresh
   container: PASS.

## Blocker: Docker build (environment defect, not fixed in this branch)

`docker build -f apps/defense-api/Dockerfile .` fails with:
```
Error: Cannot find module '/workspace/packages/auth/node_modules/typescript/bin/tsc'
```
Root-caused to a Docker-Desktop-on-Windows + pnpm store-cache-mount interaction: pnpm's
symlink-based `node_modules` layout creates
`packages/auth/node_modules/typescript -> /workspace/node_modules/.pnpm/typescript@5.9.3/...`
inside the container, but the underlying store entry the symlink resolves to was written
with a Windows host path (`C:/dev/capiro-p8s3-repair/...`) baked into the BuildKit
`--mount=type=cache,id=pnpm,target=/pnpm/store` cache mount metadata, which is unreachable
inside the Linux build container.

Evidence this is pre-existing and not introduced by this branch:
- Reproduced against the byte-identical, completely unmodified `apps/defense-api/Dockerfile`
  and `pnpm-lock.yaml` (verified via `diff` against `origin/main`'s copies — zero
  differences).
- Reproduced after `docker build --no-cache` (bypasses layer cache, not the named mount).
- Reproduced after `docker builder prune -af` and `docker buildx prune -af` (clears layer
  cache).
- Reproduced after a full `docker buildx prune -f` scoped to the specific active builder
  (clears the named `pnpm` mount cache too) — still failed on a subsequent from-scratch
  build (620/620 packages freshly downloaded, 0 reused).
- The identical scoped `pnpm install --frozen-lockfile --filter=@capiro/defense-api...`
  run directly on the host (not in Docker) succeeds cleanly and produces a correct
  `typescript` symlink.
- Attempted fix #1: `--config.node-linker=hoisted` on the install step avoids the bad
  symlink (confirmed via `readlink -f`, no host-path leak) but then hits a second,
  unrelated Dockerfile layer-ordering conflict: `COPY packages/auth packages/auth` collides
  with hoisted's per-package `node_modules/@types/node` ("cannot replace to directory ...
  with file"). Not resolved in this branch — would require reordering the Dockerfile's
  COPY/install sequence, which is out of scope for a Session 3 code-only repair.

This blocker is disclosed rather than papered over. It affects the Docker build gate only;
it does not affect the typecheck/build/test/verifier/DB-rehearsal results above, all of
which ran and passed for real.

## Remaining blockers

1. Docker build gate (above) — unresolved. Two candidate fixes identified, neither applied.
2. PR #1044 is intentionally draft and unmerged pending resolution of (1) and Neo's review.

## Explicit statements (hard scope limits — all honored)

- AWS mutation: **NONE.** No AWS API calls of any kind were made.
- Production DB mutation: **NONE.** All DB rehearsals ran against disposable, self-managed
  containers (`pgvector/pgvector:pg16` on ephemeral local ports), destroyed on exit. No
  connection was ever made to a shared or production database.
- Production data mutation: **NONE.**
- Routing change: **NONE.** No ALB, ingress, or service-routing configuration touched.
- Schedule change: **NONE.** No EventBridge or cron ownership touched.
- IAM/secrets change: **NONE.** No IAM policies, roles, or secret values touched or read.
- Snapshot activation: **NONE.** The DB rehearsal explicitly re-verified serve cannot
  activate a snapshot (Session 2 negative control, repeated and passing).
- Canonical promotion: **NONE.** No promotion or activation method exists anywhere in the
  new code (mechanically verified by the boundary verifier's forbidden-pattern scan).

## Verdict

**SESSION3_BLOCKED_ON_DOCKER_BUILD**

Not SESSION3_COMPLETE: one required gate (`docker build`) has not passed, and I am not
claiming it did. Everything else required for Session 3 acceptance — the 49-route
implementation, the permanent verifier, the disposable DB rehearsal (including new grants),
old-vs-new parity tests (with two real bugs found and fixed), typecheck, build, and test —
genuinely ran and genuinely passed. The repaired branch is pushed and a focused draft PR is
open, honestly describing this exact state including the unresolved blocker.

Per the assignment's explicit instruction not to advance until both sessions are genuinely
complete: **Session 4 (Part B) was not started.** No work was done on
`agent/phase8-session4-runtime-move` or PR #1035 in this session.
