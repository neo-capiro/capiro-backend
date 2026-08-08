# Outreach V3 State Recovery

## Scope

Recovery for Revised Outreach Phase 2 campaign planning state only.

This runbook does not authorize deployment, migration, generation, send, Recall, callbacks, worker transfer, or canonical Engagement cutover.

## First response

If the V3 state surface is producing incorrect behavior:

1. set `OUTREACH_V3_STATE_ENABLED=false` in the affected **existing engagement-api** runtime using the separately authorized deployment/config mechanism;
2. verify V3 state routes return the disabled/absent 404 behavior;
3. verify current Outreach v2, Meetings, Reports and Integrations remain unchanged;
4. preserve database rows and evidence;
5. diagnose before changing historical state.

Do not delete or edit state versions/events to make the current state look correct.

## User-level state recovery

When a user intentionally wants an earlier campaign state:

1. read the session and immutable version list;
2. inspect the exact source version;
3. submit `RESTORE_STATE_VERSION` with the **current** `expectedStateVersion`;
4. server reauthorizes known client references;
5. the command engine copies the source snapshot into a **new** state version;
6. verify the current pointer advances to the new version;
7. verify the source and intervening versions remain unchanged;
8. verify restore events identify the source version.

Never update `outreach_sessions.current_state_version` directly to an old number as a rollback mechanism.

## Stale/concurrent write

`OUTREACH_STATE_CONFLICT` means another committed mutation advanced the campaign.

Response:

- fetch the latest session/state;
- present the conflict to the caller;
- require a new explicit command/proposal against the new version.

Do not auto-retry a stale command because user/model intent may no longer apply to the changed campaign.

## Proposal recovery

### Superseded / stale

A proposal targeting an old version is terminal `superseded`. Apply returns `OUTREACH_PROPOSAL_STALE`.

Do not auto-rebase it. A user or later reasoning layer must create a new proposal against the current version.

### Applied but response lost

The proposal row is terminal `applied`, and its state version/event history is authoritative. Do not submit the same commands as a new direct batch merely because the HTTP response was lost.

### Pending proposal with corrupt hash

`OUTREACH_STATE_CORRUPT` is fail-closed. Disable V3 state mutation for the affected environment if needed and preserve the row for investigation. Do not rewrite commands/hash in place; proposal content is DB-immutable.

## Batch replay

For direct command batches:

```text
same batchId + same normalized payload hash
  -> durable prior command_batch_result is replayed

same batchId + different hash
  -> OUTREACH_COMMAND_ID_REUSE
```

Do not delete the prior event to “free” an idempotency key.

## Database corruption/invariant failure

If append-only triggers, RLS, composite session/tenant FKs, unique state/event keys or proposal lifecycle constraints are missing/drifted:

1. disable V3 state API;
2. do not repair rows manually through the product role;
3. capture schema/migration state and affected identifiers;
4. reproduce on a disposable database;
5. create a forward repair migration;
6. run fresh + ordered-upgrade rehearsal;
7. independently validate before applying to a shared environment.

## Service rollback

If an engagement-api release must be rolled back:

- disable the V3 state flag first;
- roll the existing engagement-api image/config back using its normal release mechanism;
- do not create a second Outreach service;
- do not change main API routing or current web behavior.

Phase 2 tables are additive and may safely remain unused while the state API is disabled.

## Migration rollback

There is intentionally no routine destructive down migration.

After an applied additive migration, prefer:

```text
feature off
+ old service image if needed
+ retain unused Phase 2 tables/history
```

Dropping the tables destroys audit/history and requires a separate, explicit data-destruction decision.

## Evidence to preserve

- exact release SHA;
- session ID;
- current state version/hash;
- relevant immutable version IDs/hashes;
- event sequences/types/batch IDs;
- proposal IDs/status/hash;
- domain error code;
- database migration state;
- no full Campaign Spec or sensitive proposal body in ordinary incident logs unless access-controlled evidence handling explicitly requires it.
