# Prisma failed-migration recovery

## Purpose

Production migration deployment must fail closed when Prisma reports an unfinished or failed migration. No container startup path, deployment script, or scheduled task may update `_prisma_migrations` automatically.

This runbook applies to Aurora/PostgreSQL environments managed by Capiro. Recovery is a controlled database change and requires an incident or change ticket, an operator, and a separate approver.

## Stop conditions

Do not run `prisma migrate resolve` and do not edit `_prisma_migrations` when any of the following is unknown:

- which migration failed;
- whether the migration executed partial DDL or DML;
- whether application containers are still writing against the affected schema;
- whether the intended migration is safe to replay;
- who approved the recovery choice.

Keep the deployment blocked until the evidence below is complete.

## 1. Capture the failure

Record in the ticket:

- environment and AWS account;
- deployment/task ARN and container image digest;
- application and migration Git SHA;
- migration name;
- task start/end time and exit code;
- complete redacted Prisma error and CloudWatch log link;
- operator and proposed approver.

Do not paste credentials, database URLs, or secret values into the ticket.

## 2. Inspect Prisma's migration ledger

Use a read-only database session first:

```sql
SELECT
  id,
  migration_name,
  checksum,
  started_at,
  finished_at,
  rolled_back_at,
  applied_steps_count,
  logs
FROM _prisma_migrations
WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
ORDER BY started_at DESC;
```

Export the result to the ticket with secrets and sensitive data redacted. Do not update the table directly.

## 3. Inspect actual schema and data effects

Read the failed migration SQL from the exact deployed Git SHA. For every statement, prove whether it executed by checking the PostgreSQL catalogs and, when applicable, affected row counts or constraints.

Examples:

```sql
SELECT to_regclass('public.expected_table_or_index');

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'expected_table'
ORDER BY ordinal_position;

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.expected_table'::regclass;
```

For data migrations, capture bounded checksums/counts and representative samples. Never infer that a transaction rolled back merely because Prisma recorded a failure; confirm the database state.

## 4. Choose a recovery strategy

### Fix forward

Use fix-forward when partial effects exist, the failed SQL is not safely replayable, or a corrective migration is clearer and safer.

1. Create a new corrective migration in an isolated branch.
2. Rehearse it against a disposable database and a recent staging snapshot.
3. Document before/after schema and data checks.
4. Obtain approval.
5. Deploy the corrective migration through the normal pipeline.

### Explicit Prisma resolution

Use `prisma migrate resolve` only after the operator and approver have proved one of these states:

- **Rolled back:** all partial DDL/DML is absent or was explicitly and safely reversed.
- **Applied:** every statement and required postcondition is present and verified.

Commands must name the exact migration:

```bash
pnpm --filter @capiro/api exec prisma migrate resolve \
  --schema prisma/schema.prisma \
  --rolled-back <migration_name>
```

or:

```bash
pnpm --filter @capiro/api exec prisma migrate resolve \
  --schema prisma/schema.prisma \
  --applied <migration_name>
```

Never issue both commands for the same recovery. Never update `_prisma_migrations` with ad hoc SQL.

## 5. Record approval and execution

The ticket must contain:

- chosen strategy and rationale;
- migration name and checksum;
- exact command or corrective migration SHA;
- operator name and execution timestamp;
- approver name and approval timestamp;
- pre-execution evidence;
- command output and exit code;
- post-execution verification.

## 6. Verify recovery

Run:

```bash
pnpm --filter @capiro/api exec prisma migrate status --schema prisma/schema.prisma
pnpm --filter @capiro/api exec prisma migrate deploy --schema prisma/schema.prisma
```

Then verify:

- no unfinished migration remains;
- the expected schema/data postconditions hold;
- API health checks pass;
- the affected feature's targeted tests and smoke checks pass;
- no unexpected write or alert was emitted;
- CloudWatch contains the failed attempt and the controlled recovery attempt.

Close the incident/change ticket only after the approver reviews the postconditions.

## Prohibited behavior

- Automatically setting `rolled_back_at` or `finished_at`.
- Editing `_prisma_migrations` directly.
- Resolving a migration because the next deployment is blocked without inspecting partial effects.
- Reusing an approval from another environment.
- Omitting the image digest, Git SHA, operator, approver, or verification evidence.
