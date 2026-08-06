# Memory Review UX Phase 2 — Increment 4B

## Scope

This increment turns the durable notification obligations from Increment 4A into a safe dispatcher. It creates recipient-only in-app notifications and optionally sends body-free email without performing either delivery inside the memory-review transaction.

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
- In-app metadata and email contain no proposal value, section body, source excerpt, review feedback, or rejection reason.
- Email delivery is default-off and requires the exact token `MEMORY_REVIEW_EMAIL_DELIVERY=enforce`.
- Email uses an at-most-once reservation: a crash after an uncertain send never causes an automatic duplicate.
- Existing `sent`, `failed`, and `suppressed` email outcomes are preserved across retries.
- Delivered events write body-free audit evidence.
- Recipient foreign keys use `ON DELETE RESTRICT` so identity cleanup cannot erase governance evidence.
- Added a bounded operator command; no schedule or production flag was added.

## Files

- `apps/api/prisma/migrations/20260818040200_memory_phase2_notification_dispatcher/migration.sql`
- `apps/api/src/memory/memory-review-notification.helpers.ts`
- `apps/api/src/memory/memory-review-notification-email.service.ts`
- `apps/api/src/memory/memory-review-notification-dispatcher.service.ts`
- `apps/api/src/memory/memory-review-notification.helpers.spec.ts`
- `apps/api/scripts/lib/memory-phase2-notification-dispatcher-contract.spec.ts`
- `apps/api/scripts/dispatch-memory-review-notifications.ts`
- `apps/api/scripts/verify-memory-phase2-notification-closeout.ts`
- `apps/api/src/memory/memory.module.ts`

## Validation completed in the implementation environment

- Manual migration review for tenant-bound foreign keys, recipient-only RLS, idempotency, leases, and audit retention.
- Static dispatcher contract covering claim concurrency, retry bounds, tenant feature scope, membership, current workflow state, canonical authorization, archived-client suppression, body-free payloads, at-most-once email, module wiring, and delivery counters.
- Strict isolated TypeScript compilation of the pure notification helper.
- Runtime probes for exact email flag parsing, assignment-state matching, HTML escaping, and safe deep-link encoding.

Marker from the isolated helper probe:

```text
MEMORY_PHASE2_NOTIFICATION_HELPERS_LOCAL_PASS
```

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
- Production email enablement.
- In-app notification listing/read endpoints.
- Review Inbox or proposer-history frontend.
- Deployment or production migration application.

## Next increment

Implement the Review Inbox backend read model, including assigned-to-me, submitted-by-me, terminal history, revision lineage, and notification read-state endpoints under current tenant and ethical-wall authorization.
