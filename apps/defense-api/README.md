# `@capiro/defense-api` — Phase 8 Session 2 dark scaffold

This service is intentionally dark. It has no Program Elements routes, no ALB
ownership, no ingestion schedule, no promoter credentials, and no parser/GPU
dependencies.

## Endpoints

- `GET /healthz`: process liveness only.
- `GET /readyz`: config validity, database reachability, full login-safety
  (not just capability-role membership — no SUPERUSER/BYPASSRLS/CREATEDB/
  CREATEROLE/schema-CREATE/promoter-membership/active-snapshot-mutation/
  unexpected direct grants), and the active-snapshot state for the configured
  `(domain, environment)`, joined to its canonical snapshot and checked for
  `status = 'ACTIVE'`.
  - `DEFENSE_CUTOVER_MODE=dark`: an absent active snapshot returns HTTP 200 with
    `domainAvailability: "unavailable"`.
  - `DEFENSE_CUTOVER_MODE=strict`: an absent active snapshot returns HTTP 503.

## Required serve configuration

- `DATABASE_URL` with `connection_limit` no greater than `DEFENSE_DB_POOL_MAX`
- `CLERK_SECRET_KEY`
- `DEFENSE_SERVE_DB_ROLE` (default `capiro_defense_serve`)
- `DEFENSE_CUTOVER_MODE=dark|strict`
- `DEFENSE_DB_POOL_MAX` (default 12)
- `DEFENSE_DB_STATEMENT_TIMEOUT_MS` (default 15000)
- `PE_SNAPSHOT_ENVIRONMENT` (optional; falls back to `NODE_ENV`) — same
  environment-resolution convention as `PeSnapshotGateService` in `apps/api`,
  so `/readyz` and the canonical read path agree on which pointer is active

The serve task rejects promoter, snapshot-activation, NVIDIA, SageMaker
model-administration, and parser-model credential variables.

## Safe entrypoint modes

Allowed: `serve`, `validate-config`, `readiness-probe`.

Refused: `migrate`, `promote`, `activate`, `parse`, `benchmark`, and unknown
modes.

## Session boundary

Session 2 does not add public defense routes or move any data/job/AWS ownership.
Those begin only in later sessions after the truth-freeze and database rehearsal
gates pass.
