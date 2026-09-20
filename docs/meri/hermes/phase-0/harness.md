# Phase 0 compatibility harness — reproduction guide

Everything here runs locally (Docker Desktop + the fixture Postgres). Nothing touches a deployed environment. Secrets are passed as environment variables at run time and are never written to the repository or the evidence folder (the runner redacts them from logs).

## Components

| Piece | Path | Role |
|---|---|---|
| Pinned worker image | `docker/hermes-worker/` (`build-base.sh`, `Dockerfile`, `entrypoint.sh`, `config.template.yaml`, `SOUL.template.md`, `plugins/`) | Upstream Hermes built from the verified tarball + Meri layer |
| Fixture seed | `apps/api/scripts/meri-hermes-phase0-seed.ts` + `scripts/meri-hermes/phase0-fixtures.json` | Two fixture tenants, three users, clients (one walled), conversations, memory items with marker facts, one DOCX attachment |
| Harness API | `apps/api/scripts/meri-hermes-phase0-harness-api.ts` (launcher `scripts/meri-hermes/phase0-harness-api.mjs`) | Runs the **real** adapter, broker, controllers and memory services with a fixture-identity middleware instead of Clerk |
| Runner | `scripts/meri-hermes/phase0-harness.mjs` | Orchestrates seed → harness API → worker container → demonstrations → evidence |
| Unit specs | `apps/api/src/common/meri-hermes-flags.spec.ts`, `apps/api/src/meri/hermes/*.spec.ts`, `apps/api/src/meri/meriv3-runtime.proxy.spec.ts` | Gate, token, translator, run store, proxy routing |
| Data inventory | `scripts/meri-hermes/generate-data-inventory.mjs` | Schema inventory + coverage check |

## Prerequisites

- Docker Desktop (linux/amd64), Node 24, pnpm 9; workspace installed (`pnpm install --frozen-lockfile --offline`) and the five workspace packages built in this order: `packages/shared`, `packages/defense-domain`, `packages/defense-contracts`, `packages/auth`, `packages/meriv2-core`, then `apps/api: prisma generate` (fresh-worktree gate; see memory note `capirov2-fresh-worktree-gate-prebuild`).
- Fixture Postgres: `docker compose up -d postgres` then, in `apps/api`, `DATABASE_URL=postgresql://capiro:capiro@localhost:5432/capiro?schema=public ./node_modules/.bin/prisma migrate deploy` (407 migrations).
- A model credential: either `OPENAI_API_KEY` in the environment or AWS CLI access to the platform secret `capiro/dev/openai-api-key` (the runner fetches it into memory when the env var is absent; override the id with `MERI_HERMES_OPENAI_SECRET_ID`).

## Build the pinned image (once, ~35–45 min cold)

```bash
./docker/hermes-worker/build-base.sh
```

This downloads `v2026.9.14.tar.gz`, verifies SHA-256 `47df72eb…d7834`, builds `meri-hermes-worker:v2026.9.14` with the upstream Dockerfile, then the Meri layer `meri-hermes-worker:v2026.9.14-meri`. To rebuild only the Meri layer after editing plugins/config:

```bash
docker build -t meri-hermes-worker:v2026.9.14-meri docker/hermes-worker
```

## Run the full harness

```bash
node scripts/meri-hermes/phase0-harness.mjs
```

Options: `--only D1,D2,ISO` (subset), `--keep` (leave the workers and harness API running for inspection), `--skip-seed`, `--skip-docker` (reuse running workers), `--reuse-api` (reuse a harness API already listening on `HARNESS_PORT`), `--model gpt-5.6-luna`, `--evidence-dir <dir>`. Ports: `HARNESS_PORT` (4450); workers `meri-hermes-p0-alice` on 18642 and `meri-hermes-p0-bob` on 18652 (one worker per execution scope — the harness API receives the scope → worker map as `MERI_HERMES_SCOPE_RUNTIMES`). Worker sizing for the benchmark class: `HERMES_CPUS` (1), `HERMES_MEMORY` (2g). Approval mode switch: `HERMES_EXEC_ASK` (default `1`; without it the `api_server` platform auto-denies guarded commands, see `hermes-source-evidence-a.md` §8).

Phased runs (the way the evidence folders were produced): run the first phase with `--keep`, then later phases with `--skip-docker --reuse-api --skip-seed --keep`. For that to work the same `HARNESS_SECRET`, `MERI_HERMES_API_KEY` and `MERI_HERMES_BROKER_SIGNING_KEY` must be supplied in the environment for every phase (otherwise the runner generates fresh random values and the kept processes reject them). After changing adapter code, recompile (`node scripts/meri-hermes/phase0-harness-api.mjs --compile`, or the tsc command it prints) and stop the kept API on port 4450 so the next run starts a fresh one.

Evidence lands in `docs/meri/hermes/phase-0/evidence/<timestamp>/`:

| File | Content |
|---|---|
| `summary.md`, `checks.json` | one row per check: `passed` / `failed` / `blocked` / `observed` |
| `D*.json`, `ISO*.json`, `CAPS.json` | per-check observations (frames, run ids, statuses, timings, previews) |
| `hermes-capabilities.json`, `hermes-toolsets.json`, `hermes-skills-initial.json`, `hermes-health-detailed.json` | pinned-build inspection |
| `meri-capabilities.json` | `GET /api/clio/hermes/capabilities` as the pilot identity |
| `worker-token-claims.json` | scope token claims (token redacted) |
| `measurements.json` | cold/warm start, per-run wall time, tokens, tool latencies, `docker stats` samples, cost inputs |
| `harness-api.log` | harness API log (secrets redacted) |

## Manual iteration

Start the harness API by itself (identity headers `x-harness-tenant-id`, `x-harness-user-id`, secret `x-harness-secret`):

```bash
NODE_ENV=test DATABASE_URL=postgresql://capiro:capiro@localhost:5432/capiro?schema=public HARNESS_SECRET=<random> HARNESS_PORT=4450 MERI_HERMES_ENABLED=true MERI_HERMES_PILOT_TENANT_IDS=a0000000-0000-4000-8000-000000000001 MERI_HERMES_RUNTIME_URL=http://127.0.0.1:18642 MERI_HERMES_SCOPE_RUNTIMES='{"tenant:a0000000-0000-4000-8000-000000000001:user:a0000000-0000-4000-8000-0000000000a1":{"url":"http://127.0.0.1:18642","apiKey":"<worker key>"}}' MERI_HERMES_API_KEY=<worker key> MERI_HERMES_BROKER_SIGNING_KEY=<32+ chars> MERI_HERMES_MODEL=gpt-5.6-luna node scripts/meri-hermes/phase0-harness-api.mjs
```

Useful routes: `GET /api/harness/health`, `GET /api/harness/gate`, `POST /api/harness/worker-token`, `POST /api/harness/conversations/:id/stream` (SSE), `GET /api/harness/runs/:id/full`, plus the real `GET /api/clio/hermes/*` control surface and the worker-facing `/api/internal/hermes/broker/*`.

Start a worker by hand (values from the harness `worker-token` response):

```bash
docker run -d --name meri-hermes-p0-alice -p 18642:8642 -v meri-hermes-p0-alice-home:/opt/data --add-host host.docker.internal:host-gateway -e API_SERVER_KEY=<worker key> -e MERI_BROKER_URL=http://host.docker.internal:4450/api/internal/hermes/broker -e MERI_WORKER_TOKEN=<token> -e MERI_EXECUTION_SCOPE_ID=<scope> -e OPENAI_API_KEY=<key> -e MERI_HERMES_MODEL=gpt-5.6-luna -e MERI_HERMES_PROVIDER=custom -e MERI_HERMES_BASE_URL=https://api.openai.com/v1 -e HERMES_EXEC_ASK=1 meri-hermes-worker:v2026.9.14-meri
```

Then `curl -H "authorization: Bearer <worker key>" http://127.0.0.1:18642/v1/capabilities`.

## Unit tests

```bash
cd apps/api && ./node_modules/.bin/jest --runInBand --forceExit src/common/meri-hermes-flags.spec.ts src/meri/hermes src/meri/meriv3-runtime.proxy.spec.ts src/meri/meri-feature-flags.service.spec.ts
```

Result in the final state of this branch: 5 suites, 33 tests passed (`meri-hermes-flags`, `meri-hermes-worker-token`, `meri-hermes-event-translator`, `meri-hermes-run-store`, `meriv3-runtime.proxy`). API typecheck (`tsc --noEmit --rootDir .` in `apps/api`) passes apart from one pre-existing, unrelated error in `src/program-element/models/conference-probability.service.ts` (ESM import of `simple-statistics` under CommonJS), which is present on the base commit.

## What is mocked or substituted (always labelled)

- Identity: fixture identities asserted by the runner; membership still resolved from the database; production uses Clerk + the tenant middleware.
- Context Plane compile: not loaded in the harness (governed prompt empty); recall uses `DirectMemoryItemsRecallPort` (`path: direct_memory_items_prototype` in results) with the same predicates as the store.
- Run store: in-process memory (Phase 1 replaces with Prisma tables).
- Artifact bytes: inline in `ClioArtifact.metadata` (≤2 MiB) instead of S3.
- Model: real provider calls (no mocked model); tokens and timings are real for this host, not production guarantees.
