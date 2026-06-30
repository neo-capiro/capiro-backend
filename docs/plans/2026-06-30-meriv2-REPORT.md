# MeriV2 — Build Run Report

Date: 2026-06-30
Branch: `meriv2/phase0` (in clone `C:\Users\neoma\capiro-meri`, base `main @ b7dd73e`)
Run mode: **build-and-prove-only** (no `cdk deploy`, no AWS resources, migrations local/scratch
only, branch unmerged/unpushed). Companion: `…-DECISIONS.md`, `…-PREFLIGHT.md`.

---

## 1. TL;DR

**Phase 0 (the critical-path orchestrator spine) is implemented end-to-end** — all 11 work items
P0-T1…P0-T11 are built, committed, and verified to the maximum the local environment allows. Every
piece of code typechecks, builds, is unit/integration-tested, and is prettier-clean.

**Overall: GREEN for everything not gated on infrastructure** (local Docker daemon was down all
session; AWS deploy is guardrail-gated). The gated items — a live `cdk deploy` + image-digest triple
(SC0.1), DB-backed migration apply (SC0.5), live both-paths parity (SC0.3) and live cross-tenant
row-parity (SC0.7) — have their code/tests written and their deterministic portions proven; the live
runs are flagged **NEEDS-APPROVAL** / **pending-environment** with exact commands below.

Did NOT reach Phases 1–5 (they depend on the spine; this run delivered the spine correctly rather
than touching later phases shallowly). Existing `api`/`web`/`workspace` behavior is **unchanged** and
all `meriv2.*` flags ship **OFF**.

---

## 2. Live components touched

| Component | State | How to reach / test |
|---|---|---|
| `packages/meriv2-core` (NEW) | built, 36 unit tests pass | `pnpm --filter @capiro/meriv2-core test` |
| `apps/meriv2-orchestrator` (NEW) | builds; boots locally; **NOT deployed** | `node apps/meriv2-orchestrator/dist/main.js` then `curl :4300/meri-api/health` |
| `apps/api` | **behavior unchanged** (flags OFF) | additive: flag helpers, MeriModule export, dormant proxy branch in workspace-assistant |
| `apps/workspace` | **behavior unchanged** (flags OFF) | additive: dormant proxy branch in generateAllSections |
| `apps/api/prisma/schema.prisma` | +3 additive tables (claim/evidence/compliance_check) | migration written; **not applied** to any live DB |
| `infra/cdk` | orchestrator wiring added; **not synthed/deployed** | `pnpm --filter @capiro/infra-cdk typecheck` (passes) |
| `.github/workflows` | `ci-pr.yml` + `meriv2-evals.yml` added | run on next PR; eval gate proven locally |

**Explicit confirmation:** `api`, `web`, and `workspace` were NOT behaviorally changed — every edit
to them is additive and gated behind `meriv2.*` flags + the `MERIV2_ENABLED` env kill-switch, **all
default OFF**. No `cdk deploy` ran; no AWS resource was created or modified; no migration was applied
to `capiro-dev` or prod. `git diff main..meriv2/phase0` = 84 files, +5861/-15 (the 15 deletions are
single-line signatures expanded to multi-line + the MeriModule exports line — no behavioral edits).

## 3. Morning smoke test (when you choose to pilot)

This run did **not** deploy. To pilot MeriV2 after a human deploy:

1. Deploy the orchestrator (see §7 "Deploy" follow-up) and confirm `curl https://<dev-host>/meri-api/health` → 200.
2. Set `MERIV2_ENABLED=true` on the `capiro-dev-api` task (and the orchestrator-aware surfaces).
3. For ONE internal tenant, set `settings_jsonb.clioFeatureFlags."meriv2.inEditorAssistant" = true`.
4. Run the parity harness live before trusting it: `MERIV2_PARITY_LIVE=1 pnpm --filter @capiro/meriv2-core parity`.

**Rollback (< 5s, no redeploy):** unset `MERIV2_ENABLED` (or flip the tenant flag false) and invalidate
the flag cache — both force the surfaces back to the in-process path immediately. Full teardown:
`2026-06-30-meriv2-revert-plan.md` (this run is the §5 fast-path case: delete the branch, drop the
local DB; nothing else persists).

## 4. Success-criteria status (Phase 0)

| SC | Status | Evidence |
|---|---|---|
| SC0.1 deploy + digest triple + health 200 | **PARTIAL / NEEDS-APPROVAL** | Local: `node dist/main.js` → `/meri-api/health` 200 (and e2e). Live deploy + imageDigest==ECR `:latest`==merge SHA requires AWS+Docker (gated). |
| SC0.2 existing surfaces unchanged, flags OFF | **PASS** | `git diff` = additive wrapping only; workspace-assistant.service.spec 6/6 green; api+workspace `nest build` clean. |
| SC0.3 parity harness | **PARTIAL** | Harness + diff engine (5 unit tests) + N=20/surface corpus + `parity` script; self-check 20/20. LIVE both-paths run pending-environment. |
| SC0.4 flag flip rollback < 5s | **PASS (mechanism)** | Unit test: flip ON→OFF + `invalidate` → immediate OFF, no redeploy; env kill-switch forces OFF. Live tenant demo pending stack. |
| SC0.5 additive migrations | **PASS (by inspection) / pending live apply** | Migration is CREATE-only + ALTER on the 3 NEW tables; zero ALTER/DROP on existing tables; `prisma validate` 🚀. Apply-on-prod-shaped-DB pending a DB. |
| SC0.6 CI fails on leakage/grounding regression | **PASS** | Seeded run: LEAK [b-secret-1] + UNGROUNDED [hr-2], exit 1 (RED); unset → 2/2, exit 0 (GREEN). |
| SC0.7 scoping parity + 401/403 | **PARTIAL** | 401 matrix runs green (e2e); cross-tenant 403 + (user,tenant) row-parity written + GATED (row-parity holds by construction — get_client_context delegates to api's own scoped endpoint). Auth was NOT reimplemented/relaxed (verbatim Clerk clone, DECISIONS D8). |

## 5. Verification evidence (captured this run)

```
# meriv2-core
> jest  →  Test Suites: 6 passed, Tests: 36 passed

# meriv2-orchestrator
> jest  →  Test Suites: 5 passed, Tests: 2 skipped, 14 passed
> node dist/main.js + curl:
  GET /meri-api/health  → {"ok":true,"service":"meriv2-orchestrator"}  HTTP 200
  GET /meri-api/tools   → HTTP 401 (no JWT)

# api (touched specs)
> sync-run.helper.spec        → 13 passed
> tenant-flags.spec           → (incl. MeriV2) 6 passed
> meri-feature-flags.spec     → 4 passed (incl. SC0.4 flip)
> workspace-assistant.spec    → 6 passed (unchanged behavior)

# builds
> @capiro/api      nest build  → exit 0
> @capiro/workspace nest build → exit 0
> @capiro/infra-cdk tsc --noEmit → exit 0
> prisma validate  → "schema is valid 🚀"

# CI eval gate (SC0.6) red→green
> eval:meriv2                       → 2/2 pass, exit 0   (GREEN)
> MERIV2_EVAL_SEED_FAILURE=1 …       → 0/2, exit 1        (RED)
> (unset)                            → 2/2 pass, exit 0   (GREEN)

# parity self-check (SC0.3)
> parity → Self-check: 20/20 parity-identical; corpus in-editor=20, workspace-gen=20

# prettier (ci-pr gate)
> prettier --check (MeriV2 code) → "All matched files use Prettier code style!"
```

## 6. Decisions

Full log: `docs/plans/2026-06-30-meriv2-DECISIONS.md`. The consequential ones to review:

- **NEEDS-APPROVAL — D8 (auth):** `ClerkService`/`TenantContextMiddleware` live in `apps/api` (not
  importable cross-service); `@capiro/shared` exports only the auth *types*. The orchestrator clones
  `apps/workspace`'s proven Clerk auth verbatim (same verification, no relaxation). The guardrail's
  letter (one shared canonical impl) needs extracting auth into `@capiro/shared` + migrating
  api/workspace/orchestrator onto it — that rewires LIVE auth, so it was NOT done unattended.
- **NEEDS-APPROVAL — D2/D13 (deploy + DB):** live `cdk deploy` (SC0.1) and any migration apply to
  `capiro-dev` (SC0.5) await a human + AWS creds; the revert plan forbids a blind `cdk deploy`.
- **DEVIATION — D3 (lint):** `pnpm lint` is non-functional repo-wide (eslint not installed); the gate
  substitutes `prettier --check`. Follow-up: install eslint repo-wide.
- **DEVIATION — D10 (dormant proxy):** the orchestrator's full surface endpoints are later-phase;
  Phase 0 ships the dormant flag-gated branch + client, gated by the parity harness.
- Also: D9 (get_client_context delegates to the api endpoint), D11 (Evidence tenant_id for RLS),
  D12 (workspace flag read via `$queryRaw`).

## 7. Blockers & follow-ups

**Environmental (this session):**
- **Docker daemon never came up** → no local Postgres, no image build, no `prisma migrate dev`. This
  gated all DB-backed live verification (SC0.5 apply, SC0.3 live parity, SC0.7 row-parity).

**Awaiting CTO / human action (NEEDS-APPROVAL):**
- **Deploy** the orchestrator out-of-band (revert plan §4: never blind `cdk deploy Capiro-dev-Compute`):
  create ECR repo `capiro/dev/meriv2-orchestrator`, build+push the arm64 image
  (`meriv2-orchestrator-image.yml` or `docker buildx --platform linux/arm64`), then add the Fargate
  task/service + target group + the `/meri-api/*` rule (priority 15) on the live `capiro-prod-alb`
  out-of-band. Then prove SC0.1 (digest triple + health 200) and record the values.
- **Apply the migration** on a prod-shaped DB copy (or local once Docker is up) and confirm
  `prisma migrate status` clean (SC0.5).
- **Auth consolidation** (D8) — reviewed change to extract Clerk verification into `@capiro/shared`.
- Extend the api ecr-push GHA role + the orchestrator OIDC role for the new ECR repo.

**Engineering follow-ups (later phases / out of Phase-0 scope):**
- Build the orchestrator's full in-editor-assistant + workspace-generation SURFACE endpoints (so the
  dormant proxy becomes live), then run the live parity harness before flipping any tenant.
- Migrate the remaining Meri tools into the registry (get_client_context is the template).
- Phases 1–5 (alert/KG consolidation, gap capabilities + sources, command center, reliability,
  Live Hearing) — not started; the spine they depend on is now in place.

## 8. Branch & commits

Branch `meriv2/phase0` (unmerged, unpushed). 11 commits on top of `main @ b7dd73e`:

```
8008b38 style(meriv2): prettier --write across MeriV2 code (ci-pr gate green)
01a6f9d test(meriv2): P0-T9 scoping-parity e2e + P0-T11 flag-flip rollback proof
79f270d feat(meriv2-core): P0-T6 parity harness (diff engine + corpus + runner)
49c7980 feat(ci): P0-T10 PR gate + MeriV2 leakage/grounding eval gate (SC0.6)
7c1752c feat(meriv2): P0-T4 dormant flag-gated proxy in both surfaces (additive)
760e08a feat(api): P0-T3 MeriV2 feature flags (default OFF) — reuse existing flag system
ebbb5aa feat(infra): P0-T2 CDK + CI wiring for apps/meriv2-orchestrator (deploy-gated)
d9abb7a feat(meriv2): P0-T2 orchestrator service + P0-T5 get_client_context tool
c1bd9e2 feat(api): P0-T8 standardize skip-if-running guard in runWithSyncRun
7879734 feat(api): P0-T7 first-class Claim/Evidence + ComplianceCheck stores (additive)
d55fe88 feat(meriv2-core): P0-T1 scaffold @capiro/meriv2-core orchestrator spine
```

Review the diff: `git -C C:\Users\neoma\capiro-meri diff main..meriv2/phase0`.
Revert (fast path): `git branch -D meriv2/phase0` (nothing else persists in build-and-prove-only mode).
