# Real PostgreSQL and Nest lifecycle qualification plan

**Plan only; not executed.** This is a separate positive runtime gate for the proposed Alpine image. Source was inspected at `355bb11ae0a1e404f49411193a2b3f0e55190c16`, whose application/schema baseline is `50475125275853299798fc40f8cb119f0b865464`. No database, container, build, installation or cloud operation was performed for this document. Execution and any additional spend require separate authorization. No Core or PostgreSQL runtime digest is qualified by this plan.

The intended result is evidence that the **exact built image**, through its normal entrypoint, completes compiled Nest startup against a real isolated PostgreSQL fixture, serves its actual SQL-backed health route, and exits after SIGTERM with its database connections closed. This narrow gate does not qualify authenticated roster/Meri/business routes, tenant isolation, provider operations, production data compatibility or rollout. Existing deployment and route holds remain.

## What must actually run

| Source evidence at the reviewed commit | Required future observation |
| --- | --- |
| `apps/api/Dockerfile.alpine-amd64-qualification` ends with user `capiro`, workdir `/app/apps/api`, entrypoint `dumb-init -- /usr/local/bin/entrypoint.sh`, command `serve`. `apps/api/scripts/entrypoint-dispatcher.inc:1022` executes `node dist/main.js`. | Run this final runtime image and command unchanged; record its image configuration, PID tree and container state. No diagnostic build target, replacement entrypoint, Nest test module, mock Prisma or synthetic listener. |
| `apps/api/src/main.ts:18` validates runtime controls, creates the full `AppModule`, enables shutdown hooks at line 25, then awaits `app.listen` at line 42. | Successful completion of initialization and an actual listening API within the deadline. Merely loading the compiled module is insufficient. |
| `apps/api/src/prisma/prisma.service.ts:93` awaits `$connect`; line 136 awaits `$disconnect` in `onModuleDestroy`. | A real application pool connects, executes SQL, and leaves no application sessions after the bounded shutdown. Hook existence alone is not evidence that it ran. |
| `apps/api/src/health/health.controller.ts:12` handles GET and **awaits `this.prisma.$queryRaw\`SELECT 1\``** before returning `{status:'ok', time}`. `apps/api/src/bootstrap/configure-api-http-app.ts:91` excludes health from `/api`; `apps/api/src/app.module.ts:168` excludes it from tenant middleware. | Request **`GET /health`**, without an auth bypass or authentication header, and correlate the successful response with the real database query. `/api/health`, `/health/pe` and a probe-owned server are not this assertion. |
| `apps/api/src/bootstrap/configure-api-http-app.ts:111` supplies `X-Capiro-Release-Sha`; lines 203–205 set long keep-alive/header timeouts and no request timeout. | Assert the exact release header. Give every probe and shutdown an external deadline; close probe keep-alives before SIGTERM. The source supplies no 30-second shutdown guarantee. |

The existing `run-alpine-amd64-entrypoint-db-gate.sh` intentionally expects an unreachable database/P1001. The existing runtime probe's tiny signal-forwarding child and loopback listener are separate synthetic tests. Prisma version/help output, those synthetic tests, and the expected negative boot remain useful, but none satisfies any positive observation above.

## Mandatory pins and prerequisites before execution

Record a reviewed run manifest before starting resources. Missing values mean **HOLD**, not permission to substitute mutable tags.

- Full final Core source commit/tree, sealed context SHA-256, selected Dockerfile and closure-contract hashes; the **immutable Linux AMD64 Core child-image digest** and image-config digest/revision. Recheck source anchors if the application changes after the commit above.
- **Immutable Linux AMD64 PostgreSQL-with-pgvector child-image digest**, its image-config digest, exact PostgreSQL patch version and expected extension versions. The source baseline is PostgreSQL **16**: `docker-compose.yml:2` describes Aurora PostgreSQL 16 plus pgvector, and `infra/cdk/lib/data-stack.ts:84` selects 16.8 for preview/staging versus 16.4 otherwise. Those are source declarations, not a fresh live-version readback. Select and review the fixture patch explicitly; a different patch must be recorded as a compatibility limitation. The compose tag `pgvector/pgvector:pg16` is mutable and is not an accepted pin.
- Canonical Git-byte hashes of `apps/api/prisma/schema.prisma`, the image's derived/generated schema, `docker/postgres/init/01-extensions.sql`, `scripts/ci/disposable-capiro-worker-prerequisite.sql`, and an ordered path/SHA-256 manifest of **all 486** checked-in `apps/api/prisma/migrations/*/migration.sql` files at the reviewed commit. Bind the migrations actually present inside the image to that manifest.
- Reviewed fixture TLS configuration, initialization SQL, observer/probe commands and hashes; a unique run ID; explicit CPU/memory/PID limits, deadlines and authorized resource/cost envelope. Pin any additional helper image; prefer the Node and psql already supplied by the two pinned images.

No suitable image digest, complete TLS fixture/harness artifact or full clean migration replay is supplied by this documentation change. These are unresolved prerequisites. Do not describe the plan as immediately executable until they are resolved and the bounded run is approved.

## Isolated fixture and schema setup

1. Use a native Linux AMD64 executor and create a new, run-labelled **internal-only** Docker network and empty PostgreSQL volume. Refuse any existing container/network/volume with the proposed names, and retain returned IDs. The API, PostgreSQL and any reviewed observer are the only members. Publish no host ports; attach no other network. Enforce and verify denial of external/provider and metadata traffic, including access through the host or DNS. Do not mount host credentials, application environment files, cloud configuration or the Docker socket. The unmodified compose file is unsuitable: it exposes a host port and uses reusable names/storage.
2. Generate disposable TLS material for the fixture only. Configure PostgreSQL with `ssl=on`, a correctly owned private key with restrictive permissions, and reviewed `hostssl` SCRAM rules; reject non-TLS TCP connections. Record the certificate fingerprint, never its private key. The **normal serve dispatcher unconditionally composes `sslmode=require&connection_limit=10`** (`apps/api/scripts/entrypoint-dispatcher.inc:44`); the migration URL helper also requires TLS. Do not override the URL helper, alter the entrypoint or disable TLS to make a plain PostgreSQL container pass. Verify TLS with `pg_stat_ssl` for the application session, not just a psql connection.
3. Initialize a fresh database named **`capiro`** and a fixture-only migration administrator. The database name is required by `20260502020000_capiro_app_role/migration.sql:29`. Use unique generated credentials restricted to this run. Apply the reviewed initialization SQL only after verifying the newly created container ID and database identity. The checked-in init file enables `uuid-ossp`, `citext`, `pg_trgm` and `vector`, and creates a placeholder `capiro_app` login. Replace its password with a run-only random value before starting the API; never use the checked-in placeholder as the test credential.
4. Apply the exact reviewed `scripts/ci/disposable-capiro-worker-prerequisite.sql` to this fixture. It creates a non-login, non-superuser, non-inheriting, non-BYPASSRLS `capiro_worker` and rejects unexpected existing memberships/flags. Do not spoof or invoke the GitHub-only wrapper. This is an external role prerequisite of `20281002010000_research_portfolios_phase10_watch_delivery/migration.sql:6`. That migration itself creates and validates `reject_append_only_mutation()` at lines 9–30; do not pre-seed an unnecessary replacement function.
5. Run the **same Core image**, same normal entrypoint, with command `migrate` and the isolated administrator's DB variables. This invokes `prisma migrate deploy` (`apps/api/scripts/entrypoint.sh:90`). Proposed replay deadline: 10 minutes, subject to the approved run envelope. Then run its normal `migration-status` command. Require both exit 0. At the first error, preserve logs and stop qualification. No `db push`, migration skipping, `migrate resolve`, migration-ledger surgery, production snapshot or application/migration edit is an allowed fallback.
6. Independently read `_prisma_migrations`: every expected migration must appear once with the source checksum, completed `finished_at`, no `rolled_back_at`, and no incomplete/failed or extra entry. Require the application extensions `uuid-ossp`, `citext`, `pg_trgm`, `vector`, **`pgcrypto`** (also required by `20260905205000_district_nexus_release4_priority_intelligence/migration.sql:19`). Compare the complete extension inventory and versions to the reviewed pinned fixture baseline, including PostgreSQL's default **`plpgsql`**; do not incorrectly require the unfiltered inventory to contain only the five application extensions. The vector build must support the migration's HNSW requirements (`20260527021119_context_embeddings_v2/migration.sql:44`). Extension availability or `SELECT 1` alone does not prove that this history replays.
7. Use **`capiro_app` for serve**, never the migration administrator. Record its actual role flags and memberships after migrations; require non-superuser/non-BYPASSRLS and do not add owner membership or elevated privileges to rescue startup. Preserve the migrated privilege model. A health query does not verify RLS/tenant authorization. No real tenants, users, meetings, jobs or provider data are needed for the intended health gate. Any additional data demanded by full bootstrap is an explicit synthetic-fixture prerequisite requiring review, not an invitation to copy live data.

Suggested observer SQL, executed only through the recorded fixture container and short-lived administrator connection, includes:

```sql
SELECT current_database(), current_user, version();
SELECT extname, extversion FROM pg_extension ORDER BY extname;
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit
FROM pg_roles WHERE rolname IN ('capiro_app', 'capiro_worker');
SELECT parent.rolname AS granted_role, member.rolname AS member
FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
JOIN pg_roles member ON member.oid=m.member
WHERE parent.rolname IN ('capiro_app','capiro_worker')
   OR member.rolname IN ('capiro_app','capiro_worker');
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM "_prisma_migrations" ORDER BY migration_name;
```

Run psql with `-X -v ON_ERROR_STOP=1`; never ignore SQL errors. The future harness must compare the returned values to the pinned manifest, not just save successful command exits.

## Full application startup with provider egress denied

Start the immutable Core image with **`serve`**, its default non-root user and normal `dumb-init` entrypoint. Retain a read-only root filesystem, a bounded writable temporary mount usable by `entrypoint.sh:10`, dropped capabilities and no-new-privileges; record the approved resource limits. Do not mount a host dependency tree or compiled output into the image. Supply only an explicit fixture environment, including the isolated `DB_HOST`, `DB_PORT`, `DB_NAME=capiro`, `DB_USER=capiro_app`, run-only password, `NODE_ENV=production`, `API_PORT=4000` and the exact `RELEASE_SHA`. Do not use `NODE_ENV=test` to suppress real bootstrap.

Supply syntactically acceptable **synthetic, nonfunctional** Clerk values for the required configuration fields (`apps/api/src/config/config.schema.ts:35`); provide no real provider credentials. Constructor acceptance of these values during full bootstrap is still unproved. If they are rejected, stop and record that fixture blocker; do not change auth or substitute a test AppModule. Health already has its ordinary exemption.

Review and freeze this local fixture control set before execution; it is not a proposed live configuration change:

| Existing control | Fixture value / source |
| --- | --- |
| `CAPIRO_SERVICE_NAME`, `ENGAGEMENT_PROCESS_MODE` | `api`, `active`: run the normal API bootstrap. |
| `ENGAGEMENT_BACKGROUND_OWNER`, `ENGAGEMENT_EXTERNAL_ACTIONS`, `ENGAGEMENT_CALLBACKS_ENABLED`, `ENGAGEMENT_RECALL_WEBHOOK_ENABLED` | `disabled`, `disabled`, `false`, `false`; accepted API posture in `apps/api/src/engagement/runtime/engagement-runtime-env.ts:91` and background policy in `engagement-runtime-policy.service.ts:65`. |
| `CLIENT_PROFILE_FILL_WORKER_ENABLED`, `CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED` | Both `false`; `apps/api/src/clients/client-profile-fill-workflow.service.ts:279` and `client-profile-fill-completion-runtime.ts:30`. |
| `MERI_JOB_SWEEPER_ENABLED`, `RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED` | Both `false`; `apps/api/src/meri/meri-job-lease-sweeper.ts:49` and `apps/api/src/research-portfolios/research-portfolio-watch-worker.service.ts:63`. |
| `NEWSLETTER_INVITATION_EMAIL_ENABLED`, `NEWSLETTER_REVIEW_EMAIL_ENABLED` | Both `false`; corresponding workers under `apps/api/src/workspace-collab/`, line 66. |
| `PREVIEW_NATIVE_GETS_ENABLED`, `CORE_ROSTER_PREVIEW_ENABLED`, `RETAINED_READS_ENABLED` | `false`; leave the default standard profile and do not add a tool allowlist, service secret or native-auth bypass for this lifecycle check. This does not qualify a later serving profile. |
| Cloud/provider credentials and telemetry exporter endpoint | Absent; `AWS_EC2_METADATA_DISABLED=true`; no credential mounts/task-role endpoint. |
| `DIRECTORY_S3_BUCKET` | Synthetic fixture-only name, to avoid the source's real-bucket fallback. |

These controls are not proof that every full-AppModule initializer is inert. In particular, `apps/api/src/directory/directory.service.ts:184` starts best-effort directory prewarming; no off switch was established in this review. Its denied-provider warning may be expected, but successful provider egress is forbidden and an initialization hang/failure blocks the gate. Keep network denial authoritative, capture bounded startup logs, and resolve any additional initializer/configuration prerequisites before claiming a reproducible run. No source change to suppress bootstrap is part of this plan.

## Positive HTTP and actual SQL assertions

Proposed deadline: **120 seconds** from container start to readiness, with **5-second** individual HTTP deadlines. Require the Prisma-connected log, the actual `Capiro API listening` log and the following HTTP/SQL observations. Logs alone do not count as readiness.

1. From the isolated namespace, use the image's Node HTTP client (for example, a pinned probe supplied to `docker exec` through stdin) to request `http://127.0.0.1:4000/health` in the running API container. This executes a client only; it must not create a listener or load a second Nest/Prisma instance. Send no Authorization or Origin header, disable connection pooling and use `Connection: close`.
2. Require **HTTP 200**, JSON `status === 'ok'`, a valid current ISO `time` within the harness's clock tolerance, and exact `X-Capiro-Release-Sha`. Obtain three successful responses at least one second apart, then observe the same process for 60 seconds and repeat the assertion. No restart, OOM, fatal bootstrap error or unexplained unhandled failure is acceptable.
3. Configure only this disposable database to log the application role's SQL with a prefix containing timestamp, PID, user and database. Correlate a health request window with the actual **`SELECT 1`** execution by `capiro_app`. Assert its result through the real health response, whose source awaits that query. This is the database-backed query through the deployed Prisma client; an observer's separate `psql SELECT 1` is only fixture availability evidence.
4. Capture live application sessions and their TLS state using the separate observer role:

```sql
SELECT a.pid, a.usename, a.datname, a.state, s.ssl, s.version, s.cipher
FROM pg_stat_activity a LEFT JOIN pg_stat_ssl s ON s.pid=a.pid
WHERE a.datname='capiro' AND a.usename='capiro_app';
```

Require at least one observed application session and TLS for every observed application session. Keep the observer connection distinct from the API role. Absence of sessions cannot be mistaken for a successful cleanup baseline.

As a separately labelled negative-control run after a successful baseline, stop only the owned fixture PostgreSQL and request the same health endpoint. It must not return successful `status:ok` without a working database; a database error/non-2xx or a bounded client timeout is expected. Restore the same fixture and require recovery before taking further positive observations. A client timeout proves neither server-side cancellation nor graceful shutdown. Do not combine this disrupted run with the clean SIGTERM acceptance result below.

## Real SIGTERM, database connection cleanup and owned-resource teardown

Use an undisrupted healthy API/fixture pair with the positive observations above. Stop sending requests, close the probe's HTTP sockets and record the API's live database sessions. The proposed **30-second API exit deadline** is an acceptance threshold enforced by the future harness, not an existing source guarantee.

1. Send `docker kill --signal=TERM "$API_CONTAINER_ID"` to the **recorded** API container ID. Let its real dumb-init/Nest lifecycle handle the signal. Record monotonic start/finish times and `docker wait` under the harness deadline. Do not replace the process, call Nest `close()` from a test or terminate database backends.
2. Require exit within 30 seconds, exit code **0 or 143** consistent with the captured signal event, no OOM, no restart and no SIGKILL/137. Record logs and container state. An accepted signal exit code alone is insufficient: require the independent connection test below. Do not infer a particular lifecycle hook solely from process exit; the combined observations establish the externally visible shutdown result.
3. Within **5 seconds after exit**, query `pg_stat_activity` using the separate observer. Require **zero `capiro_app` sessions in the fixture database**, with PostgreSQL still alive and responding to a short-lived observer `SELECT 1`. No `pg_terminate_backend`, database restart or container removal may be used to manufacture this result. Timeout or surviving sessions is a failed qualification even if forced cleanup subsequently succeeds.
4. Close observer sessions, send PostgreSQL its reviewed graceful signal (planned SIGTERM), and require exit 0 and its shutdown-complete log within 30 seconds. Collect evidence before removing anything. This PostgreSQL teardown does not substitute for the earlier API-connection assertion while the database was alive.
5. Remove only the IDs created by this run and verify their absence, including the dedicated network, containers and volume. Recheck run ownership before cleanup. Reuse the ownership/refuse-existing approach of `apps/api/scripts/lib/pe-phase-9-owned-postgres.sh`; its force-removal helper alone is not graceful-shutdown evidence. Emergency forced cleanup after a timeout is permitted only as cleanup under the future execution authorization, must be reported separately, and cannot turn a failed lifecycle result into a pass.

This idle healthy shutdown gate does not claim draining of long-running business requests. The application's large HTTP timeouts make that a separate qualification question, not a reason to silently increase the acceptance deadline or modify shared middleware here.

## Evidence, decision and remaining blockers

Retain a structured run report with exact source/image/config/fixture hashes; architecture and resource limits; PostgreSQL and extension versions; migrated schema/ledger comparisons; role flags/memberships; TLS proof; API startup times/logs; each HTTP status/body/header/timing; correlated application SQL; sessions before and after SIGTERM; signal/exit/elapsed/OOM/restart observations; PostgreSQL shutdown and final owned-resource absence. Store command exit codes and bounded scrubbed logs, including failed stages. Never dump environment values, credentials, TLS private keys or connection strings into published evidence.

**PASS requires every positive stage above against the same pinned image and reviewed fixture.** A missing observation is HOLD; an observed mismatch, timeout, failed migration, unexpected egress or forced termination is FAIL. Do not label unexecuted stages PASS or use version/help, P1001, synthetic listeners/signals, compilation, source tests or an empty scan as substitutes. Scan/native-owner gates remain independently mandatory.

The current blockers are explicit:

1. Replacement Core and PostgreSQL fixture digests, fixture TLS/harness artifacts, resource envelope and execution/spend approval are not supplied by this plan.
2. The complete 486-migration clean replay and post-migration role/schema assertions have not run. The known TLS and worker-role prerequisites must be satisfied; further replay dependencies may still emerge.
3. Full AppModule startup with synthetic required credentials and provider egress denied has not run. Directory prewarming is a known attempted external initialization path; other runtime fixture requirements remain unverified.
4. Real health/SQL, stable listening, bounded SIGTERM, zero remaining application connections and successful teardown are all unexecuted.

No application-source fix is established as necessary solely by this inspection. If the actual positive run exposes a source defect, stop, preserve the evidence and propose a separately reviewed change. This document neither modifies the frozen application baseline nor authorizes runtime, migration, auth or routing changes.
