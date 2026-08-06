# Memory Review UX Phase 2 — Increment 4A

## Scope

This increment establishes durable reviewer-notification obligations without sending email or in-app notifications inside memory-review transactions.

## Implemented

- Added `memory_review_notification_outbox`.
- Enqueues atomically from `review_request` transitions.
- Covers initial reviewer assignment, revised-successor assignment, reassignment, changes requested, approval, and rejection.
- Uses tenant-scoped idempotency keys.
- Forces PostgreSQL row-level security.
- Marks every row as requiring fresh authorization before delivery.
- Keeps payloads body-free and reason-free.
- Backfills only currently pending assigned reviews.
- Does not synthesize stale terminal notifications.
- Correctly distinguishes a trigger-created workflow's first assignment from a later reassignment.

## Security boundaries

The outbox stores only workflow identifiers, recipient identity, client identity, candidate kind, bounded title, event type, and the requirement for current authorization. Proposal values, sections, source excerpts, review feedback, and rejection reasons remain outside notification payloads.

Delivery is not authorized by row existence alone. A dispatcher must re-check tenant membership, current assignment where relevant, ethical-wall access, client status, and feature flags immediately before delivery.

## Validation

- Static migration contracts for RLS, idempotency, event coverage, body-free payloads, security-invoker functions, pinned search path, pending-only backfill, and assignment classification.
- Manual SQL review for trigger ordering and same-transaction enqueue behavior.

## Not included

- Notification dispatcher.
- Email rendering or sending.
- In-app notification persistence.
- Retry worker or dead-letter handling.
- Production migration application or feature enablement.

## Next increment

Implement the dispatcher against the existing Capiro notification/email infrastructure with fresh tenant and ethical-wall authorization, claim-based concurrency, bounded retries, and delivery audit evidence.
