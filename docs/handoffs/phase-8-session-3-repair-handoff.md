# Phase 8 Session 3 — Repair Handoff

## Repository / branch / PR

- Repository: neo-capiro/capirov2
- Branch: agent/phase8-session3-program-elements-repair
- Base SHA (origin/main at original branch creation): 67f220efe3065f21676c14ec31b65ee5312d93e5
- Base SHA after restack (origin/main): d14e1d161e3d243532e0e75de8dac82e46823b99
- Head SHA: see latest commit on the branch (includes Dockerfile Docker-gate fix)
- PR: https://github.com/neo-capiro/capirov2/pull/1044 (draft, OPEN, base=main, head=agent/phase8-session3-program-elements-repair)
- Restack: rebased cleanly onto latest main (9 main commits replayed under Session 3 tip; no conflicts)
- Docker gate: CLOSED on this tip (see below)

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
| `docker build -f apps/defense-api/Dockerfile -t capiro-defense-api:phase8-session3-restack .` | **PASS** (exit 0; image `capiro-defense-api:phase8-session3-restack`) |
| Image smoke (`docker run … serve` without secrets) | Expected fail-closed boot: `DATABASE_URL`/`CLERK_SECRET_KEY` required — proves `dist/main.js` loads (not MODULE_NOT_FOUND) |
| `git diff --check` | PASS — clean, no whitespace errors |
| Restack re-verify: `node scripts/verify-phase8-session3.mjs` | PASS — `SESSION3_BOUNDARY_PASS`, 49/49 |
| Restack re-verify: `pnpm --filter @capiro/defense-api test` | PASS — 41 pass, 1 skipped, 0 fail |

Route count: 49/49 (exact match against `@capiro/defense-contracts`, confirmed by both the
static verifier and a structural Jest/node:test parity spec).
Test count: 44 in `apps/defense-api` (43 pass, 1 skipped) + 2 in the standalone parity
suite = 46 total test cases run, 45 pass, 1 skipped, 0 fail (prior tip); restack re-ran
unit suite 41 pass / 1 skipped / 0 fail.
DB rehearsal result: both Session 2 (36 checks) and Session 3 (30 checks) disposable-Postgres
rehearsals PASS on the pre-restack tip; static boundary + unit + Docker re-verified after restack.
Docker result: **PASS** after Dockerfile fix (see below).

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

## Docker build gate — CLOSED

### Prior failure (pre-fix)

`docker build -f apps/defense-api/Dockerfile .` failed with:
```
Error: Cannot find module '/workspace/packages/auth/node_modules/typescript/bin/tsc'
```

Root cause was **not** primarily a poisoned cache mount. The Dockerfile did
`COPY packages/auth packages/auth` (and the same for other packages) **after**
`pnpm install`. That wholesale directory copy overwrote/collided with the
per-package `node_modules` graph pnpm had just created. A later
`--config.node-linker=hoisted` attempt then failed with
`cannot replace to directory ... with file` for the same reason. Fresh cache
mount IDs still failed because the COPY ordering bug is deterministic.

### Fix applied

`apps/defense-api/Dockerfile` now matches the main API Dockerfile pattern:

1. Copy only `package.json` files for lockfile validation + install.
2. `pnpm install --filter=@capiro/defense-api...` with an isolated cache mount
   id `pnpm-defense-api` and `PNPM_PACKAGE_IMPORT_METHOD=copy`.
3. Copy **source + tsconfig only** for auth / defense-* / defense-api (never a
   full package directory that would stomp `node_modules`).
4. Build packages + defense-api, then prod prune.

### Proof (this restack tip)

```text
docker build -f apps/defense-api/Dockerfile -t capiro-defense-api:phase8-session3-restack .
→ DOCKER_EXIT=0
image: sha256:a38ae30b9ff94c520e4a52c6fdc1d875e0cf97aa06a653e32f33c5894cf289ff

docker run --rm capiro-defense-api:phase8-session3-restack serve
→ boot reaches Nest config validation:
  "Invalid defense-api serve environment: DATABASE_URL is required; CLERK_SECRET_KEY is required"
  (fail-closed on missing secrets — binary + module graph load successfully)
```

## Remaining blockers

1. PR #1044 is still draft and unmerged pending Neo's review / Session 3 acceptance.
2. Optional: re-run disposable Session 2/3 DB rehearsals on the post-restack tip if desired
   (pre-restack tip already PASS; restack conflicts were none and static/unit/Docker green).

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

**SESSION3_DOCKER_GATE_CLOSED** (restack + Dockerfile fix)

Docker build is no longer the open gate. Session 3 implementation gates that were already
green (49-route surface, permanent verifier, disposable DB rehearsal on the prior tip,
parity tests, typecheck/build/test) remain green; after restack onto
`d14e1d161e3d243532e0e75de8dac82e46823b99` the boundary verifier, unit tests, and Docker
image build were re-proven.

Not claiming production deploy or merge. PR #1044 stays draft until Neo accepts.

Per prior assignment scope: **Session 4 was not started** in this restack session.
