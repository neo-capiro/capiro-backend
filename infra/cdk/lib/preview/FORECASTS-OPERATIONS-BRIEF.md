# Government forecasts on the preview clone: shipping brief

Executor: Release (the sole shared AWS, migration and deployment operator). Everything
below runs from one shell against AWS profile `default`, account 967807252336,
us-east-1, after `aws sts get-caller-identity` shows that caller. No step touches the
live database, the live ALB or any ECS service. Snapshot the clone before step 2.

Source: this branch's head, built once as the preview-core image; record its digest.
Never print a secret; report counts and booleans.

## What this delivers

| Piece | Where | Note |
| --- | --- | --- |
| Importer role `capiro_forecast_importer` | migration `20281102110000` | SELECT/INSERT/UPDATE on the six `government_forecast*` tables, sequence USAGE, role timeouts. The password is the one environment-only input (step 3). |
| Stack `Capiro-Preview-Government-Forecasts` | `infra/cdk/lib/preview/forecasts-operations.ts`, bin `preview-forecasts-operations` | Fargate ARM64 task definition from the preview-core digest, EFS archive + access point, S3 custody bucket, Secrets Manager secret, daily rule (disabled, retry 0, DLQ), two alarms, SNS topic. |
| Spec | `infra/cdk/test/preview-forecasts-operations.spec.ts`, `apps/api/src/government-forecasts/forecast-importer-role.spec.ts` | Rendered-template and migration-text checks; no AWS call. |

The task gets `DATABASE_URL` whole from the secret, as the scripts require; nothing is
composed from `DB_*`. The archive root is `/var/lib/capiro/forecast-archive` on EFS,
owned by uid 1001 (the image user); the exclusive marker and every run's receipts
live there and survive every task.

## Order of effects

1. **Migrate the clone.** Run the existing migration path for the clone with this
   head's image (`migrate deploy` through `/usr/local/bin/entrypoint.sh migrate` as the
   current preview procedure does). Expect `20281102110000_government_forecast_importer_role`
   applied. Verify as the clone master, read-only:

   ```sql
   SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
   FROM pg_roles WHERE rolname = 'capiro_forecast_importer';
   -- one row: t f f f f
   SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type)
   FROM information_schema.role_table_grants
   WHERE grantee = 'capiro_forecast_importer' GROUP BY table_name ORDER BY table_name;
   -- six rows, each INSERT,SELECT,UPDATE; no other table
   ```

2. **Render and deploy the stack.** Write the binding (not in Git):

   ```json
   { "schemaVersion": 1, "sourceHead": "<40-hex head>", "imageDigest": "sha256:<64 hex>",
     "scheduleEnabled": false, "schedule": { "hour": 9, "minute": 30 } }
   ```

   ```bash
   npx ts-node --transpile-only bin/preview-forecasts-operations.ts --render <binding.json> <fresh-dir>
   ```

   Deploy `<fresh-dir>/Capiro-Preview-Government-Forecasts.template.json` with the
   ordinary CloudFormation path. The rule is created DISABLED; nothing runs yet.
   Outputs to record: TaskDefinitionArn, ArchiveFileSystemId, StagingBucketName,
   ImporterSecretArn, DailyRuleName, AlertsTopicArn. Subscribe the on-call address to the
   topic and confirm the subscription.

3. **Set the importer password (one-time, documented here; not a migration).** As the
   clone master, in one `psql` session with `\set` so nothing lands in shell history:

   ```sql
   ALTER ROLE capiro_forecast_importer PASSWORD :'importer_password';
   ```

   Then put the whole URL in the secret, never a fragment:
   `postgresql://capiro_forecast_importer:<url-encoded password>@<clone writer endpoint>:5432/capiro?sslmode=require`

   ```bash
   aws secretsmanager put-secret-value --secret-id /capiro/preview/government-forecasts/importer-database-url --secret-string file://<owner-only tmp file>
   ```

   Remove the temp file. The role is why the migration carries the grants and only the
   password is environment state: every environment with the tables carries the same
   reviewed privileges, and `migrate status` proves presence; a password cannot live in
   a migration, and `bootstrap-roles.ts` is bound to the live dev Compute stack, so the
   clone's one role is set here.

4. **Pin check (dry run, no database write).** Upload the pinned edition XML to the
   custody bucket under `pinned/202510.xml` and record its sha256 (expected
   `4dc85fe0…`, the full hash from the data-population receipt). The image dispatches
   only its own verbs, so the pinned file is not copied into the task; the refresh verb
   fetches the publisher itself and the receipts prove what it fetched. Run one task
   without `--apply`:

   ```bash
   aws ecs run-task --cluster capiro-dev --launch-type FARGATE --task-definition <TaskDefinitionArn> \
     --network-configuration 'awsvpcConfiguration={subnets=[subnet-0920665f91c905f01,subnet-0e38bd390f8961fef,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}' \
     --overrides '{"containerOverrides":[{"name":"government-forecasts","command":["refresh-government-forecasts","--archive-dir","/var/lib/capiro/forecast-archive","--run-id","pin-202510-dryrun"]}]}'
   ```

   Wait for the task to stop (exit 0). The log stream `forecasts/government-forecasts/<task>`
   ends with the dry-run JSON. Under the archive `pin-202510-dryrun/` the receipts
   `source.json` and `import-result.json` must show:

   | Field | Expected |
   | --- | --- |
   | `source.json.edition` | `202510` |
   | `source.json.sha256` | `4dc85fe0…` (equal to the custody object's hash) |
   | `import-result.json.mode` | `dry-run` |
   | `import-result.json.candidates` | `1916` |

   If edition or hash differ, the publisher has moved on: stop, report both values, and
   do not apply; the pinned apply is then a decision for Neo (apply the live edition or
   reconcile the pin). The marker is released by a completed dry run; if the task died,
   `.forecast-refresh-active` remains and must be inspected, not deleted on age.

5. **One-off pinned apply.** Same `run-task`, new run id, with `--apply`:

   ```json
   ["refresh-government-forecasts","--archive-dir","/var/lib/capiro/forecast-archive","--run-id","pin-202510-apply","--apply"]
   ```

   Expected from an empty clone (`import-result.json`, mode `apply`, `replay: false`):

   | Field | Expected |
   | --- | --- |
   | `accepted` | 1916 minus the held and rejected count (every candidate is new) |
   | `rejected` | the dry run's `rejected` plus held same-key terminals |
   | `checkId` | `1` |

   Verification queries as the clone master, read-only:

   ```sql
   SELECT count(*) FROM government_forecast_source;                  -- 1
   SELECT edition, status, accepted_count, rejected_count FROM government_forecast_check; -- 202510 success …
   SELECT count(*) FROM government_forecast;                         -- = accepted
   SELECT count(*) FROM government_forecast_revision;                -- = accepted (revision 1 each)
   SELECT count(*) FROM government_forecast_observation;             -- = accepted
   SELECT count(*) FROM government_forecast_terminal;                -- withdrawals observed in the edition
   SELECT count(*) FROM government_forecast WHERE current_revision <> 1; -- 0
   ```

   Then the deployed behavior: an authenticated staff `GET /government-forecasts?from=<month start>&to=<next month>`
   on the preview host returns rows with non-null windows; `/government-forecasts/:id/history`
   returns one revision for any id.

6. **Enable the schedule.** Only after step 5 verifies: re-render with
   `"scheduleEnabled": true` and deploy. Enabling is a re-render so the rule's state is
   always the binding's state; a later deploy cannot flip it by accident. The first
   scheduled run should produce `outcome.json` with `replay: true` or a small accepted
   count (an unchanged edition yields observations without new revisions).

7. **Rollback.** Disable the rule (re-render `false`), nothing else. Imported rows are
   publisher facts behind authenticated read endpoints; they are not removed. The role
   migration stays (applied migrations are history); revoke by `ALTER ROLE … NOLOGIN` if
   the job must be made inert.

## Alarms

`capiro-preview-government-forecasts-failed` fires on either terminal failure line the
scripts print (`Forecast import failed`, `Forecast refresh failed`);
`…-delivery-failed` fires when EventBridge could not start the task (DLQ depth). Both
notify the alerts topic on alarm and on recovery. On a failure: read the run's receipts
(`failed-run.json`, `unknown-outcome.json`, `source-failure.json`), then the check table.
An `unknown-outcome.json` keeps the marker; reconcile from `import-intent.json` with the
same hash and observed-at before anything else runs. Never retry with a new observation.

## The 120 s Serializable transaction

The producer imports a whole edition in one Serializable transaction with a 120 s
Prisma timeout and ~6 short statements per candidate (about 12k round trips for 1916
candidates). On a Fargate task in the clone's VPC that is tens of seconds, not minutes,
but the first load from empty is the largest the transaction will ever be. Mitigations
chosen:

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
