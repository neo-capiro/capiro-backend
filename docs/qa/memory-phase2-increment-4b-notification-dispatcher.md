# Memory Review UX Phase 2 — Increment 4B

## Scope

This increment turns the durable notification obligations from Increment 4A into a safe dispatcher. The current product posture is **in-app notifications only**. Memory Review has no email transport.

## Implemented

- Concurrent outbox claims use `FOR UPDATE SKIP LOCKED` with five-minute leases.
- Claims are bounded to 200 rows and terminate after eight failed attempts.
- Transient failures use bounded exponential retry delays.
- Feature-disabled tenants are deferred without consuming an attempt.
- Every row is rebound to the exact tenant through `runWithMemoryGovernanceTenant`.
- Delivery requires an active tenant membership.
- Assignment notifications require the recipient to remain the current named reviewer.
- Proposer notifications require the workflow to remain in the matching decision state.
- Canonical memory authorization is re-evaluated immediately before delivery.
- Client-scoped notifications are suppressed after client archival.
- In-app notifications are tenant-bound, recipient-only under FORCE RLS, and idempotent.
- In-app metadata contains no proposal value, section body, source excerpt, review feedback, or rejection reason.
- Delivered events write body-free audit evidence.
- Recipient foreign keys use `ON DELETE RESTRICT` so identity cleanup cannot erase governance evidence.
- Added a bounded operator command; no schedule or production flag was added.
- The prior SES adapter and `MEMORY_REVIEW_EMAIL_DELIVERY` runtime path were removed by the administrator self-approval follow-up.

## Compatibility note

The already-merged `20260818040200_memory_phase2_notification_dispatcher` migration contains legacy email bookkeeping columns. They are retained as inert compatibility columns rather than rewriting migration history or adding a risky drop-column migration. Runtime code does not read, write, or send through them.

## Files

- `apps/api/prisma/migrations/20260818040200_memory_phase2_notification_dispatcher/migration.sql`
- `apps/api/src/memory/memory-review-notification.helpers.ts`
- `apps/api/src/memory/memory-review-notification-dispatcher.service.ts`
- `apps/api/src/memory/memory-review-notification.helpers.spec.ts`
- `apps/api/scripts/lib/memory-phase2-notification-dispatcher-contract.spec.ts`
- `apps/api/scripts/dispatch-memory-review-notifications.ts`
- `apps/api/scripts/verify-memory-phase2-notification-closeout.ts`
- `apps/api/src/memory/memory.module.ts`

## Validation

The dispatcher contract covers claim concurrency, retry bounds, tenant feature scope, membership, current workflow state, canonical authorization, archived-client suppression, body-free payloads, recipient RLS, module wiring, and the explicit absence of Memory Review email delivery.

## Required complete-checkout validation

Run the notification closeout against two different empty local PostgreSQL/pgvector databases. The command first executes the established Phase 2 persistence closeout, then applies the full migration chain to the upgrade database and checks:

- clean and upgrade migration paths;
- assignment, reassignment, and changes-requested event obligations;
- body-free outbox payloads;
- concurrent lease claims with no duplicate work;
- recipient-only in-app RLS;
- cross-tenant isolation;
- in-app idempotency; and
- database rejection of forbidden feedback content.

Required final marker:

```text
MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE
```

## Not included

- Production schedule or EventBridge wiring.
- Any email delivery for Memory Review.
- Deployment or production migration application.
