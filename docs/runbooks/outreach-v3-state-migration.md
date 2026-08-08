# Outreach V3 Revised Phase 2 State Migration

## Authorization boundary

The migration file may be built and rehearsed as part of Phase 2 implementation.

Applying it to any shared dev/staging/production database requires separate explicit authorization for that environment. Authorization to implement Phase 2, deploy an image, or run browser acceptance does **not** imply authorization to migrate a shared database.

## Migration

```text
apps/api/prisma/migrations/
  20260908010000_outreach_v3_campaign_state/migration.sql
```

Additive tables only:

```text
outreach_sessions
outreach_state_versions
outreach_events
outreach_command_proposals
```

No legacy Outreach table is altered, backfilled, renamed or dropped.

## Pre-apply gates

Before any shared-environment apply:

```bash
pnpm install --frozen-lockfile
pnpm verify:outreach-v3-phase-2
pnpm verify:outreach-v3-phase-2:db
```

The DB rehearsal must prove both:

```text
fresh empty DB -> full migration chain
pre-Phase-2 DB -> exact new migration
```

and must preserve a real `outreach_records` sentinel across the upgrade.

Review the exact migration bytes and confirm:

- no destructive DDL;
- no legacy Outreach table reference;
- composite `(session_id, tenant_id)` child FKs;
- state version/event unique keys;
- command-batch idempotency unique index;
- RLS enabled and forced;
- append-only state/event triggers;
- proposal lifecycle trigger;
- narrowed runtime grants;
- no data backfill.

## Database safety checks

The rehearsal is required to demonstrate:

- own-tenant visibility through a non-superuser probe role;
- foreign-tenant denial;
- child/session tenant mismatch rejection;
- duplicate state version rejection;
- duplicate event sequence rejection;
- duplicate command batch ID rejection;
- state version UPDATE/DELETE rejection;
- event UPDATE/DELETE rejection;
- invalid proposal status rejection;
- proposal content immutability;
- terminal proposal immutability;
- runtime session DELETE denial;
- legacy Outreach sentinel unchanged.

## Apply sequence for an authorized environment

1. identify exact environment/account/database and release SHA;
2. verify current migration state has no failed/pending contradiction;
3. confirm application/database connection budget is healthy;
4. run the repository's approved migration mechanism—do not improvise `prisma migrate dev` against a shared environment;
5. verify migration record is finished;
6. verify all four tables/constraints/triggers/policies/grants;
7. keep `OUTREACH_V3_STATE_ENABLED=false` initially;
8. deploy the exact approved engagement-api image separately if authorized;
9. enable the V3 state flag only under its own authorization;
10. run the authenticated state acceptance flow;
11. verify current main API/UI and Outreach v2 remain unchanged.

## Failure response

If migration application fails:

- leave V3 state flag off;
- preserve Prisma/database error evidence;
- do not mark the failed migration resolved without understanding its exact state;
- reproduce and repair forward on a disposable DB first;
- use the environment's established migration-recovery procedure under separate authorization.

## Rollback posture

The migration is additive and carries audit/history data once used. Routine rollback is therefore:

```text
OUTREACH_V3_STATE_ENABLED=false
+ service rollback if needed
+ leave additive tables intact
```

A destructive table drop/down migration is not part of normal Phase 2 rollback and requires a separate data-destruction design and authorization.

## Production

Production migration/deployment/cutover is not authorized by the Phase 2 implementation branch. No canonical Engagement routing, worker/callback/Recall ownership or external action changes are part of this migration.
