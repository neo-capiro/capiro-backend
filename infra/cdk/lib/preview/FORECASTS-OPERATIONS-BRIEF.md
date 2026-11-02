# Government forecasts on the preview clone: shipping brief

Executor: Release (the sole shared AWS, migration and deployment operator). Everything
below runs from one shell against AWS profile `default`, account 967807252336,
us-east-1, after `aws sts get-caller-identity` shows that caller. No step touches the
live database, the live ALB or any ECS service. Snapshot the clone before step 1.

Image: the Core48 preview-core image (digest `sha256:bad6082a…`, source head `4ee2a11…`;
its forecast scripts and entrypoint are byte-identical to current main), so no new
build is needed. The importer-role migration rides the release's normal migrate image.
Never print a secret; report counts and booleans.

## What this delivers

| Piece | Where | Note |
| --- | --- | --- |
| Importer role `capiro_forecast_importer` | migration `20281102110000` | NOLOGIN, no password in Git; per-table SELECT/INSERT/UPDATE as the producer issues them, sequence USAGE, role timeouts. Login is enabled by Release (step 2). |
| Stack `Capiro-Preview-Government-Forecasts` | `infra/cdk/lib/preview/forecasts-operations.ts`, bin `preview-forecasts-operations` | Fargate ARM64 task definition from the preview-core digest (read-only root, `TMPDIR=/dev/shm`), EFS archive + access point, reference to the Release-owned secret, daily rule (disabled, retry 0, DLQ), three alarms, SNS topic. |
| Specs | `infra/cdk/test/preview-forecasts-operations.spec.ts` (node:test), `apps/api/src/government-forecasts/forecast-importer-role.spec.ts` (jest) | Rendered-template and migration-text checks; no AWS call. Run the CDK spec with `node --require ts-node/register/transpile-only --test`, not the jest config. |

The task gets `DATABASE_URL` whole from the secret, as the scripts require; nothing is
composed from `DB_*`. The archive root is `/var/lib/capiro/forecast-archive` on EFS,
owned by uid 1001 (the image user); the exclusive marker and every run's receipts
(including the fetched `source.xml`) live there and survive every task. Custody of
the source bytes is that retained file plus the database's `source_xml` column.

## Order of effects

1. **Migrate the clone.** Run the existing migration path for the clone with the
   release's migrate image. Expect `20281102110000_government_forecast_importer_role`
   applied. Verify as the clone master, read-only:

   ```sql
   SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
   FROM pg_roles WHERE rolname = 'capiro_forecast_importer';
   -- one row: f f f f f   (login is enabled in step 2)
   SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type)
   FROM information_schema.role_table_grants
   WHERE grantee = 'capiro_forecast_importer' GROUP BY table_name ORDER BY table_name;
   -- government_forecast INSERT,SELECT,UPDATE | _check INSERT,SELECT,UPDATE | _observation INSERT
   -- _revision INSERT,SELECT | _source INSERT,SELECT | _terminal INSERT,SELECT; no other table
   ```

2. **Enable login and create the secret (one time, Release-owned).** As the clone
   master, in one `psql` session with `\set` so nothing lands in shell history:

   ```sql
   ALTER ROLE capiro_forecast_importer LOGIN PASSWORD :'importer_password';
   ```

   Then create the secret with the whole URL, never a fragment, before the stack
   exists (the stack only references it by name, so no deploy can reset it):
   `postgresql://capiro_forecast_importer:<url-encoded password>@<clone writer endpoint>:5432/capiro?sslmode=require`

   ```bash
   aws secretsmanager create-secret --name /capiro/preview/government-forecasts/importer-database-url --description "DATABASE_URL for capiro_forecast_importer on the preview clone" --secret-string file://<owner-only tmp file>
   ```

   Remove the temp file. Why the role is a migration and only the login is a step
   here: every environment with the forecast tables carries the same reviewed
   privileges and `migrate status` proves presence; a password cannot live in a
   migration, and `bootstrap-roles.ts` is bound to the live dev Compute stack.

3. **Render and deploy the stack.** Write the binding (not in Git):

   ```json
   { "schemaVersion": 1, "sourceHead": "4ee2a11<full 40 hex>", "imageDigest": "sha256:bad6082a<full 64 hex>",
     "scheduleEnabled": false, "schedule": { "hour": 9, "minute": 30 } }
   ```

   ```bash
   npx ts-node --transpile-only bin/preview-forecasts-operations.ts --render <binding.json> <fresh-dir>
   ```

   Deploy `<fresh-dir>/Capiro-Preview-Government-Forecasts.template.json` with the
   ordinary CloudFormation path. The rule is created DISABLED and the stale alarm's
   actions are disabled; nothing runs yet. Outputs to record: TaskDefinitionArn,
   ArchiveFileSystemId, ArchiveAccessPointId, ImporterSecretArn, DailyRuleName,
   AlertsTopicArn, LogGroupName. Subscribe the on-call address to the topic and
   confirm the subscription.

4. **Preflight before any run-task.** As the importer (its URL from the secret, in
   memory only): `SELECT current_user;` returns `capiro_forecast_importer`. As the
   clone master:

   ```sql
   SELECT table_name, privilege, has_table_privilege('capiro_forecast_importer', table_name, privilege) AS granted
   FROM (VALUES ('government_forecast_source','INSERT'),('government_forecast_source','SELECT'),
                ('government_forecast','SELECT'),('government_forecast','INSERT'),('government_forecast','UPDATE'),
                ('government_forecast_revision','INSERT'),('government_forecast_revision','SELECT'),
                ('government_forecast_check','INSERT'),('government_forecast_check','SELECT'),('government_forecast_check','UPDATE'),
                ('government_forecast_observation','INSERT'),
                ('government_forecast_terminal','INSERT'),('government_forecast_terminal','SELECT')) AS t(table_name, privilege);
   -- thirteen rows, every granted = t
   SELECT has_sequence_privilege('capiro_forecast_importer', 'government_forecast_check_id_seq', 'USAGE'); -- t
   SELECT has_table_privilege('capiro_forecast_importer', 'government_forecast', 'DELETE');                -- f
   ```

5. **Dry run: fetch the publisher and record what it is.** One task, no `--apply`,
   no database write (the task still mounts the archive and reads the secret):

   ```bash
   aws ecs run-task --cluster capiro-dev --launch-type FARGATE --task-definition <TaskDefinitionArn> \
     --network-configuration 'awsvpcConfiguration={subnets=[subnet-0920665f91c905f01,subnet-0e38bd390f8961fef,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}' \
     --overrides '{"containerOverrides":[{"name":"government-forecasts","command":["refresh-government-forecasts","--archive-dir","/var/lib/capiro/forecast-archive","--run-id","pin-202510-dryrun"]}]}'
   ```

   Wait for the task to stop with exit 0. The log stream `forecasts/government-forecasts/<task>`
   ends with the run JSON (`status: dry-run`). Under `pin-202510-dryrun/` in the archive,
   `source.json` and `import-result.json` must show:

   | Field | Expected |
   | --- | --- |
   | `source.json.edition` | `202510` |
   | `source.json.sha256` | `4dc85fe0…` (the pin, full hash from the data-population receipt) |
   | `source.xml` size | 17,624,465 bytes |
   | `source.json.observedAt` | a UTC timestamp, called **T** below |
   | `import-result.json.mode` / `candidates` | `dry-run` / `1916` |

   If edition or hash differ, the publisher has moved on: stop, report both values,
   do not apply; the pinned apply is then Neo's decision. A completed dry run releases
   the marker; if the task died, `.forecast-refresh-active` remains and must be
   inspected (see break-glass), never deleted on age.

6. **One-off pinned apply from the retained bytes.** The pinned XML is the dry run's
   `source.xml`; the sync verb imports exactly that file with the pin and the
   original observed-at, so the import is bound to what was fetched. First without
   `--apply` (local parse only), then with it, each as a `run-task` with the command:

   ```json
   ["sync-government-forecasts","--input","/var/lib/capiro/forecast-archive/pin-202510-dryrun/source.xml","--edition","202510","--sha256","<pin>","--observed-at","<T>"]
   ```

   ```json
   ["sync-government-forecasts","--input","/var/lib/capiro/forecast-archive/pin-202510-dryrun/source.xml","--edition","202510","--sha256","<pin>","--observed-at","<T>","--apply"]
   ```

   Expected log lines: dry run `{"mode":"dry-run","candidates":1916,…}`; apply
   `{"mode":"apply","checkId":"1","accepted":1916,"rejected":1380,"replay":false}`.
   An apply that exits non-zero with `Forecast import failed` has either rolled back
   atomically or left an unknown outcome: run the verification queries first, then
   re-run the same apply command unchanged (same hash and observed-at) only if the
   check table has no `success` row; the producer replays an identical import rather
   than duplicating it.

7. **Verify** as the clone master, read-only:

   ```sql
   SELECT count(*) FROM government_forecast_source;                                     -- 1
   SELECT edition, status, accepted_count, rejected_count FROM government_forecast_check; -- 202510 | success | 1916 | 1380
   SELECT count(*) FROM government_forecast;                                            -- 1916
   SELECT count(*) FROM government_forecast_revision;                                   -- 1916
   SELECT count(*) FROM government_forecast_observation;                                -- 1916
   SELECT status, count(*) FROM government_forecast_terminal GROUP BY status ORDER BY status;
   -- source_completed 1241 | withdrawn 208   (1449 in all)
   SELECT count(*) FROM government_forecast WHERE current_revision <> 1;                -- 0
   SELECT count(*) FROM government_forecast WHERE window_from IS NULL;                   -- 148 (unplaced periods)
   SELECT encode(sha256(convert_to(source_xml, 'UTF8')), 'hex') = '<pin>' FROM government_forecast_source; -- t
   SELECT has_table_privilege('capiro_app', 'government_forecast', 'SELECT'),
          has_table_privilege('capiro_app', 'government_forecast_revision', 'SELECT'),
          has_table_privilege('capiro_app', 'government_forecast_check', 'SELECT');     -- t t t
   ```

   Then the deployed behavior: an authenticated staff `GET /government-forecasts?from=<month start>&to=<next month>`
   on the preview host returns rows with non-null windows; `/government-forecasts/:id/history`
   returns one revision for any id.

8. **Enable the schedule.** Only after step 7 verifies: re-render with
   `"scheduleEnabled": true` and deploy. That one render enables the rule and the stale
   alarm's actions together; a later deploy cannot flip either by accident. The first
   scheduled run should log `status: import-returned` with `replay: true` or a small
   accepted count (an unchanged edition yields observations without new revisions).

9. **Rollback.** Disable the rule (re-render `false`), nothing else. Imported rows are
   publisher facts behind authenticated read endpoints; they are not removed. The role
   migration stays (applied migrations are history); `ALTER ROLE capiro_forecast_importer NOLOGIN`
   makes the job inert.

## Break-glass: inspecting the archive

The task has no shell dispatch, so the archive is inspected with an ad hoc task that
reuses this stack's task role, volume and security group: register a one-off task
definition from `public.ecr.aws/docker/library/busybox` (ARM64) with the same
`taskRoleArn`, the same `forecast-archive` EFS volume (access point, IAM, transit
encryption) mounted at `/var/lib/capiro/forecast-archive`, `sg-01def4e5c0fe44d4a` and
the same subnets, and a command such as
`["sh","-c","ls -la /var/lib/capiro/forecast-archive /var/lib/capiro/forecast-archive/pin-202510-dryrun; cat /var/lib/capiro/forecast-archive/pin-202510-dryrun/*.json; wc -c /var/lib/capiro/forecast-archive/pin-202510-dryrun/source.xml"]`.
Read the log stream; deregister the task definition afterwards. Removing a stale
`.forecast-refresh-active` is done the same way, only after the receipts and the check
table show no pending outcome, and the removal is recorded.

## Alarms

`capiro-preview-government-forecasts-failed` fires on either terminal failure line the
scripts print (`Forecast import failed`, `Forecast refresh failed`);
`…-delivery-failed` fires when EventBridge could not start the task (DLQ depth);
`…-stale` fires when no `import-returned` line was logged in five six-hour windows
(about 30 hours), with its actions enabled only while the schedule is enabled. All
notify the alerts topic on alarm and on recovery. On a failure: read the run's receipts
(`failed-run.json`, `unknown-outcome.json`, `source-failure.json`), then the check table.
An `unknown-outcome.json` keeps the marker; reconcile from `import-intent.json` with the
same hash and observed-at before anything else runs. Never retry with a new observation.

## The 120 s Serializable transaction

The producer imports a whole edition in one Serializable transaction with a 120 s
Prisma timeout and about six short statements per candidate (roughly 12k round trips
for 1916 candidates). On a Fargate task in the clone's VPC that is tens of seconds,
not minutes, but the first load from empty is the largest the transaction will ever
be. Mitigations chosen:

- **No concurrency by construction.** One daily occurrence, retry 0, `.forecast-refresh-active`
  on the shared archive, and `pg_advisory_xact_lock(721111, 1)` inside the transaction:
  a Serializable conflict cannot come from a sibling run. Role `lock_timeout` 10 s makes a
  stray duplicate fail fast instead of queueing.
- **Timeouts arranged so the client times out first.** Role `idle_in_transaction_session_timeout`
  180 s exceeds the 120 s client timeout, so the database never kills a live transaction
  that would otherwise have committed; `statement_timeout` 60 s bounds a single stuck statement.
- **Atomic failure.** A timeout rolls back everything; no partial edition can be
  observed. The refresh then records `failed-run.json` and the alarm fires; the next
  day's occurrence is the retry, with the same hash if the edition is unchanged.
- **The one-off runs first and attended**, with the rule disabled, during the acceptance
  window; if `import-result.json` is absent and `unknown-outcome.json` is present, run the
  verification queries before any reconciliation.
- Not chosen: raising the transaction timeout or batching the producer. Both change the
  import contract and need their own review; the measured first run decides whether
  either is ever needed.
