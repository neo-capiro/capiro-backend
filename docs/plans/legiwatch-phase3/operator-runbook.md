# Phase 3 release and rollback

Read the existing Prisma and `web-vnext-os-capiro-ai` runbooks. Use the current
AWS service/target definitions, never stale task revisions copied from this note.
The rollout account is 967807252336, region us-east-1, cluster capiro-dev.

## Build and qualify

1. Incorporate newer main changes and push an exact clean commit. Record its
   tree/archive SHA-256. Build native ARM64 API, Intel and dedicated web-vNext
   images with the source commit label; resolve every published tag to its digest.
2. Override the existing CodeBuild project's default buildspec. Its default
   publishes mutable `latest` and forces an unrelated service restart; those
   actions are not this release flow. The qualification build must not deploy.
3. Apply the complete API then Intel migration chains to disposable PostgreSQL
   with pgvector. Run scoped typechecks, existing entrypoint/import checks and
   `scripts/legiwatch-phase3-qualification.mjs`. Supply `DATABASE_URL` and a
   separate `LEGIWATCH_SAVED_TEST_DATABASE_URL`. All gates require no failures or
   skips and enforce minimum counts.

## Deploy dark

1. Snapshot HTTP definitions/digests, all hearing/source/report/record/capture
   targets, current flags, source quotas and active tasks. Recheck before each
   mutation; preserve newer service releases and existing target command/env.
2. Pin `capiro-dev-api-migrate` to the qualified API digest. Run its ordinary
   `migrate` verb and verify actual applied migration names and container exit 0.
   Do not use the admin-migrate family or automatic migration ledger resolution.
3. Run the Intel migration chain from the qualified Intel image through the
   existing migration role/entrypoint. Verify both chains and schema constraints.
4. Roll API and Intel HTTP services to compatible digest-pinned task revisions,
   retaining counts, secrets, network and health checks. Keep both Phase 3 tenant
   flags and outbound worker switches off initially.
5. Pin the shared Phase 9 API and Intel scheduled families, daily hearing sync
   and LegiScan drain to compatible images before writing state canonical rows.
   Preserve schedules, target inputs and capture job behavior. Existing capture
   tasks finish normally; do not terminate user recordings for this rollout.
6. Register a separate API source task using the existing API image/role/network
   machinery and `discover-hearings --source=florida --session=2026`.
   Set `FL_CALENDAR_INGEST_ENABLED=true`, `FL_CALENDAR_SESSION=2026`. The rolling
   default covers the preceding week and following fourteen days. An explicit
   historical run may use `--from=2026-02-23 --to=2026-03-01`.
7. Register a bounded Florida source EventBridge schedule, preserving existing
   LegiScan quotas/schedules. Record actual rule/target/task IDs and a scheduler-
   initiated successful cycle. A JSON plan alone is not a deployed schedule.
8. Register the tenant-scoped Intel `task run-agenda-updates <tenantUUID>` task
   with `LEGIWATCH_AGENDA_ALERTS_ENABLED=false` and `TRACKER_ALERTS_ENABLED=false`.
   Its new agenda rule starts disabled. Do not enable captured recipients.
9. Publish only the dedicated web-vNext service after backend contracts exist.
   Preserve the newest main source, `WEB_SURFACE=vnext`, exact
   `CAPIRO_WEB_RELEASE_SHA`, and immutable image digest. Never broad-deploy Compute
   or change canonical web/DNS/listener routing.

## Qualify and activate reviewed scope

Enable `legiwatch_state_calendar_v1` only for the authorized review workspace(s).
Verify a scheduler-produced official observation reaches the public calendar
and a real preparation draft without a browser being open during ingestion.
Check desktop/mobile, keyboard, source errors, query/export scope, encoded
directory links and immutable draft staleness. Record original source URLs,
coverage expected/found/issues and the export/preparation artifacts.

Enable `legiwatch_agenda_alerts_v1` for configuration review separately from
outbound switches. Promote the eight current staged IDs into inactive review
drafts, preserving names, memberships and staging hashes. Source cadence remains
unknown. Require current staff/channel and Capiro cadence review. Do not infer
cadence or activate the empty-target/deleted-owner definitions automatically.

A designated notification proof requires an explicitly authorized recipient and
scope after the candidate is concrete. Then enable only the needed task/tenant/
rule switches, record its baseline and single intent, and distinguish queued,
provider-accepted, confirmed-delivered, held and uncertain outcomes. Captured
staff/client addresses are not this authorization.

## Rollback

Disable the new agenda and Florida source schedules; disable the two Phase 3
tenant flags and outbound worker switches. Verify unsent agenda work is held and
the existing Phase 1/2 capability and federal capture remain available. Restore
recorded HTTP/worker digest-pinned task revisions only if needed for a code
rollback; preserve active recordings and unchanged job inputs. Retain additive
schema, immutable preparation/transition/delivery history and source observations.
Record the exact before/after state and health/runtime-config verification.
