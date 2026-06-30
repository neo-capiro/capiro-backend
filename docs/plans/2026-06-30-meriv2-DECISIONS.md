# MeriV2 — Decision Log (build run)

Date opened: 2026-06-30. Append-only. Tags: `DECISION | ASSUMPTION | NEEDS-APPROVAL |
DEVIATION-FROM-PLAN`.

---

## D1 — Working directory = `C:\Users\neoma\capiro-meri` — `DECISION`
- **Context:** The agent was launched in a git worktree of the OneDrive clone
  (`...\capirov2\git\capirov2\.claude\worktrees\happy-blackwell-1b07b7`). The plan names repo root
  `C:\Users\neoma\capiro-meri`. Memory warned of "two clones; agents sometimes edit the wrong one."
- **Options:** (a) work in the launch worktree (OneDrive clone); (b) work in `capiro-meri`.
- **Decision:** Work in `capiro-meri`.
- **Rationale:** It is a separate clone of the SAME repo (`neo-capiro/capirov2.git`), currently on
  clean `main @ b7dd73e`, **outside OneDrive** (avoids the documented 25+-worktree concurrent-
  mutation + OneDrive-sync hazard — the prior overnight agent explicitly chose an isolated outside-
  OneDrive clone for the same reason), already has `node_modules` installed, and the plan docs live
  there. The "diverged feat-branch clone" warning in memory is stale — capiro-meri is on clean main
  today (`.git` touched 2026-06-30 00:47, staged for this build).
- **Reversibility:** Trivial — branch `meriv2/phase0` is unmerged/unpushed; nothing else touched.

## D2 — Run mode = build-and-prove-only (no `cdk deploy`, no live capiro-dev mutation) — `DECISION` / `NEEDS-APPROVAL` (for live deploy)
- **Context:** Guardrail §2.4.5 permits deploying the net-new orchestrator to `capiro-dev`, but the
  revert plan §4 hazard 1 forbids a blind `cdk deploy Capiro-dev-Compute` (it can drop the out-of-
  band `/webhooks/*` priority-15 ALB rule, replace the ACM cert, shrink Aurora). Safe deploy = an
  out-of-band AWS-CLI procedure, which is high-blast-radius to run unattended. The revert plan §5
  recommends build-and-prove-only as the safest overnight mode (30-second rollback).
- **Decision:** Operate in build-and-prove-only mode. Author ALL code (package, service, Dockerfile,
  CDK blocks, CI workflows, migrations). Verify locally to the extent the environment allows. Do
  **not** run `cdk deploy`, do **not** create AWS resources, do **not** apply migrations to
  `capiro-dev`. SC0.1's live digest-triple + health-200-from-dev-host and SC0.4's real-tenant flag
  flip are marked **NEEDS-APPROVAL** (require AWS creds + a human go).
- **Rationale:** Maximizes delivered, reviewable code while keeping rollback trivial and honoring
  the CTO's own stated low-blast-radius preference. Aligns with architecture-plan PR1–PR3 ordering.
- **Reversibility:** `git branch -D meriv2/phase0` + drop local DB. Nothing persistent created.

## D3 — Quality gate substitutes `prettier --check` for `lint` — `DECISION` / `DEVIATION-FROM-PLAN`
- **Context:** Plan requires `typecheck + lint + test + build` green. `pnpm lint` is non-functional
  repo-wide (eslint never installed; confirmed by the May-31 overnight notes and by memory).
- **Decision:** Gate on `tsc --noEmit` (typecheck) + `prettier --check` + `jest` (test) + `nest build`.
- **Rationale:** The lint script cannot pass for anyone today; substituting prettier + typecheck +
  tests is the established repo practice. Flagged for the report as a real follow-up (install eslint).
- **Reversibility:** N/A (process choice).

## D4 — Docker down at session start → DB/image verification gated on environment — `ASSUMPTION`/`NEEDS-APPROVAL`
- **Context:** Docker daemon was not running; blocks `db:up` (local Postgres), `prisma migrate dev`,
  and local image builds. Docker Desktop was launched at session start.
- **Decision:** Proceed with all code + pure-logic unit tests + local service boot (node, no Docker)
  + local eval-runner red→green. If Docker comes up, additionally verify migration-applies-clean on
  a fresh scratch DB and (where a model key exists) run the harness/evals live. Otherwise record
  those as pending-environment with exact commands.
- **Rationale:** Don't block the whole run on one environmental dependency.
- **Reversibility:** N/A.

## D5 — `@capiro/meriv2-core` stays Prisma-free; data access via injected ports — `DECISION`
- **Context:** Appendix X fixes the handler signature `(input, ctx: MeriContext) => Promise<O>` with
  no data handle. Tools like `get_client_context` must read tenant rows, but meriv2-core should stay
  a pure, importable package (its only internal dep is `@capiro/shared`). The real Prisma query lives
  in `apps/api` (an app, not an importable package), so it cannot be imported cross-service.
- **Decision:** meriv2-core defines tool factories that close over a minimal, structurally-typed
  data **port** interface (e.g. `ClientContextRepo`). meriv2-core owns the tool's Zod schemas,
  scoping enforcement, and output shape; the **orchestrator** provides the Prisma-backed adapter
  (its own generated client against `apps/api/prisma/schema.prisma`, same shared DB). This keeps
  "don't duplicate SQL" honest (one query, in the orchestrator adapter, mirroring meri's existing
  query) and keeps meriv2-core unit-testable with fake repos.
- **Rationale:** Cleanest separation; satisfies the guardrail (ctx is required; a handler that
  ignores ctx cannot pass scoping); avoids dragging the giant generated Prisma client into the pure
  package.
- **Reversibility:** Internal design; revisable before any tenant is flagged on.

## D6 — New code matches its nearest existing precedent's module convention — `DECISION`
- **Context:** Two precedents exist. `@capiro/shared` (a *package*) builds as **CommonJS**
  (`module: commonjs`, `moduleResolution: node`, composite) and uses **no** `.js` import suffixes.
  `apps/workspace` (an *app*) uses **Node16** + `.js` suffixes + a jest mapper stripping `.js`.
- **Decision:** `@capiro/meriv2-core` mirrors `@capiro/shared` (CJS, composite, no `.js` suffixes —
  proven consumable by Node16 apps, since workspace imports shared fine). `apps/meriv2-orchestrator`
  mirrors `apps/workspace` (Node16 + `.js` suffixes + the jest `.js` mapper).
- **Rationale:** Match the nearest precedent for each artifact type; lowest module-resolution risk.

## D8 — Orchestrator auth = clone the proven `apps/workspace` auth, not the (non-importable) api one — `DECISION` / `NEEDS-APPROVAL`
- **Context:** Guardrail §2.4.1 says import `@capiro/shared` + `apps/api` `TenantContextMiddleware`
  / `ClerkService`; never reimplement. BUT verified reality: `@capiro/shared` exports only the auth
  **types** (`TenantContext`, `TenantRole`, `TENANT_HEADER`, role helpers). The real `ClerkService`
  (`apps/api/src/auth/clerk.service.ts`) and `TenantContextMiddleware`
  (`apps/api/src/tenant/tenant-context.middleware.ts`) live in `apps/api`, which is an *app*, not an
  importable package — a separate Fargate service cannot import them. `apps/workspace` already
  solved this with its own `auth/{clerk.service,tenant.guard}.ts` that verifies the SAME Clerk JWT
  via `@clerk/backend` `verifyToken` and resolves tenant from the SAME claims (`capiro_tenant_id` →
  `org_id`).
- **Decision (Phase 0, build-and-prove-only, no live traffic):** the orchestrator clones the
  `apps/workspace` auth verbatim — same `@clerk/backend` verification, same Clerk v2
  `o.{id,slg,rol}` / `capiro_tenant_id` normalization, **no relaxation, no fake identity**, reusing
  the `@capiro/shared` `TenantContext`/`TenantRole` types. This satisfies the guardrail's *intent*
  (identical verification, no weakening) using the established repo precedent without touching live
  api/workspace auth.
- **NEEDS-APPROVAL follow-up:** the guardrail's letter ("import the one canonical impl") is only
  achievable by extracting the Clerk verification + tenant resolution into `@capiro/shared` and
  migrating `apps/api` + `apps/workspace` + orchestrator onto it (eliminating all three copies).
  That rewires LIVE api/workspace auth, so it is NOT done unattended — flagged for CTO sign-off.
- **Reversibility:** orchestrator-only code on the unmerged branch; trivially removable.

## D7 — Orchestrator port 4300, ALB listener priority 15 for `/meri-api/*` — `DECISION`
- **Context:** Existing listener priorities: 3=api, 5=marketing, 10=workspace, 20=web. Workspace
  uses port 4200.
- **Decision:** Orchestrator container port **4300**; ALB rule `/meri-api/*` at **priority 15**
  (between workspace and web). `/health` excluded from the `meri-api` global prefix (ALB liveness).
- **Rationale:** Free, non-conflicting slot; mirrors the workspace pattern exactly.
