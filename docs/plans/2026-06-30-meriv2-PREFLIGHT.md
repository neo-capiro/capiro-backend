# MeriV2 — Pre-flight Capture (build run)

Date: 2026-06-30
Run mode: **build-and-prove-only** (see DECISIONS D2). No `cdk deploy`, no AWS resource
creation, migrations on a local/scratch DB only, branch unmerged. This makes the revert a
30-second operation (revert-plan §5): `git branch -D meriv2/phase0` + drop the local DB.

These captures are the "known-good" baselines the revert plan (§1) expects. Because the run is
build-and-prove-only, the AWS-side captures (DB snapshot, ALB rules, EventBridge rules, service
desired counts) describe **what would need capturing IF a live deploy is later approved** — they
are deliberately deferred here since this run creates **zero** AWS resources.

## 1. Code baseline
- Workspace clone (build location): `C:\Users\neoma\capiro-meri` (separate clone, outside OneDrive).
- `main` SHA (known-good to return to): `b7dd73ec579a9849c386c55488b6a23dc208bc74`
- Build branch: `meriv2/phase0` (created at the SHA above; never merged; never pushed to main).
- Remote: `https://github.com/neo-capiro/capirov2.git` (shared with the OneDrive clone).

## 2. DB snapshot (master rollback)
- **DEFERRED / N-A for this run.** No migrations are applied to `capiro-dev`. New additive
  Prisma models (Claim/Evidence/ComplianceCheck) are written to `schema.prisma` and a migration
  is generated, but applied only to a local/scratch DB. If a live deploy is later approved, take
  `aws rds create-db-cluster-snapshot ... --db-cluster-snapshot-identifier meriv2-preflight-2026-06-30`
  BEFORE applying to `capiro-dev`.

## 3. ALB rule inventory
- **DEFERRED / N-A.** No ALB listener rule is created (build-and-prove-only). The intended new
  rule is `/meri-api/*` at **priority 15** (free slot; existing: 3=api, 5=marketing, 10=workspace,
  20=web). If a live deploy is approved, capture
  `aws elbv2 describe-rules --listener-arn <DEV_HTTPS_LISTENER_ARN> > preflight-alb-rules.json`
  first and confirm the out-of-band priority-15 `/webhooks/*` rule is present and untouched.

## 4. EventBridge inventory
- **N-A for Phase 0** (no new sync jobs in Phase 0). Phase 2 adds `sync-*` jobs; capture
  `aws events list-rules --name-prefix capiro-dev > preflight-rules.json` before any Phase-2
  schedule lands.

## 5. Service desired counts
- **Not modified.** This run does not touch `capiro-dev-api/web/workspace`. Their desired counts
  are unchanged by definition.

## Environmental notes captured at session start
- Docker daemon was **not running** at session start (blocks `db:up`, local image build, and
  `prisma migrate dev`). Docker Desktop was launched; DB/image-dependent verification proceeds if
  it comes up, otherwise those steps are recorded as pending-environment in the REPORT.
- `pnpm lint` is non-functional repo-wide (eslint not installed). Quality gate is
  `prettier --check` + `tsc --noEmit` (typecheck) + `jest` (test) + `build`. (See DECISIONS D3.)
- `@capiro/shared` is pre-built (`packages/shared/dist`). Prisma client was not generated at
  session start (`node_modules/.prisma/client` absent) — generated as part of setup.
