# Capiro Memory Review UX — Phase 3 Review Inbox

## Product result

Phase 3 replaces the two broad legacy memory queues with one plain-English Review Inbox under Settings → Memory.

Users can answer:

- what needs my review;
- what I submitted;
- what is blocked or unassigned;
- who owns the next action;
- what happened to prior revisions;
- which in-app review notifications are unread;
- whether I may safely act now.

The administrator self-approval follow-up changes one important rule: an active authorized `user_admin` or `capiro_admin` may decide their own shared-memory proposal. No independent approver is required. Standard-user reviewers remain assignment-bound and cannot self-review.

## Backend read model

Authenticated routes under `/api/memory/review`:

- `GET /inbox`
- `GET /inbox/summary`
- `GET /inbox/candidates/:candidateId`
- `GET /inbox/requests/:reviewRequestId`
- `GET /notifications`
- `GET /notifications/unread-count`
- `POST /notifications/:notificationId/read`
- `POST /notifications/read-all`

The inbox supports:

- `needs_my_review`;
- `submitted_by_me`;
- administrator `all_pending`;
- administrator `blocked`;
- terminal `history`.

Broad list rows are body-free. Proposal values, section bodies, and reviewer feedback are loaded only by protected detail routes.

## Authorization and tenant isolation

Every production query carries an explicit tenant predicate. Notification reads and mutations also carry the authenticated recipient predicate. The implementation does not rely on PostgreSQL RLS as the sole boundary because the production database role may bypass RLS.

Before returning work or content, the service revalidates:

- active tenant membership and current role;
- canonical governed-memory read/review/approve/propose policy;
- administrator self-approval eligibility where applicable;
- standard-user assignment and self-review restrictions;
- ethical-wall visibility;
- current grants and grant expiry;
- client status;
- current reviewer eligibility.

An administrator is not an ethical-wall bypass. A former reviewer loses assignment-only authority after reassignment unless they independently remain authorized under the canonical policy.

## Pagination and counts

Lists use a bounded opaque cursor over the deterministic total order:

```text
created_at DESC, id DESC
```

Cursor decoding validates the timestamp and UUID. Page size is server-bounded from 1 to 50. Counts and rows use the same canonical authorization projection. Summary counts disclose when the bounded 1,000-row scan is truncated.

## Detail and revision timeline

Protected detail returns:

- current proposed memory;
- human-readable workflow state;
- feedback for authorized participants;
- current capabilities and next action;
- eligible reviewer identities for authorized reassignment;
- immutable root/predecessor/successor timeline;
- controlling-memory reference where present;
- explicit confirmation that active memory remains unchanged before approval.

Raw candidate provenance, raw audit blobs, provider secrets, and unrelated memory bodies are not returned.

## Notification read state

Memory Review notifications are **in-app only**. There is no Memory Review email transport or email feature flag.

The in-app endpoints provide:

- recipient-only list;
- unread count;
- idempotent mark-one-read;
- bounded mark-all-visible-read.

Every operation includes explicit `tenant_id` and `recipient_user_id` predicates and rechecks current memory authorization. Another member receives not-found semantics rather than notification-existence disclosure.

The review-request deep-link remains supported for internal navigation:

```text
/settings/memory?review=<review-request-id>
```

## Compatibility closeout

The generic `/api/reviews` held-deliverable surface filters memory rows from broad lists and rejects memory IDs before detail, assignment, approval, or rejection. Governed memory can be decided only through the canonical memory-review services.

Existing non-memory review behavior remains delegated to `ReviewsService` unchanged.

## Frontend

`MemoryReviewInbox` provides:

- Needs my review, Submitted by me, All pending, Blocked, and History tabs;
- stable counts and load-more pagination;
- plain-English statuses, blocked explanations, and next-action wording;
- protected proposal drawer;
- approve, request changes, reject, revise/resubmit, assign reviewer, and withdraw actions;
- administrator approval controls even when the administrator submitted the proposal;
- immutable revision timeline;
- in-app notifications, unread count, and mark-read controls;
- review-request deep-link handling.

`MemoryGovernanceCenterHost` no longer mounts `MemoryProposalQueue` or `MemoryReviewQueue`. Standard users receive the canonical inbox; administrators receive the inbox plus the separately gated Governance Center.

## Validation artifacts

Focused tests and contracts include:

- `memory-review-inbox.helpers.spec.ts`
- `memory-review-inbox.service.spec.ts`
- `memory-review-admin-inbox.service.spec.ts`
- `memory-review-inbox.controller.spec.ts`
- `memory-review-compatibility-guard.service.spec.ts`
- `memory-phase3-review-inbox-contract.spec.ts`
- `memory-admin-self-approval-contract.spec.ts`
- `MemoryReviewInbox.phase3.test.tsx`

Focused typecheck:

- `apps/api/tsconfig.memory-review-phase3.json`

Real database acceptance:

- `scripts/verify-memory-phase3-review-inbox-database.ts`
- `scripts/verify-memory-admin-self-approval-database.ts`

One-command closeout:

- `scripts/verify-memory-phase3-review-inbox-closeout.ts`

The database acceptance covers:

- body-free list serialization;
- protected detail content;
- equal-timestamp cursor stability without duplicates or omissions;
- standard-user/former-reviewer assignment denial;
- authorized administrator self-approval;
- cross-tenant guessed-ID denial;
- blocked/unassigned visibility;
- recipient-only in-app notification read state;
- mark-all recipient isolation;
- generic-review compatibility rejection.

## Required closeout markers

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE
MEMORY_PHASE3_DATABASE_ACCEPTANCE_COMPLETE
MEMORY_ADMIN_SELF_APPROVAL_DATABASE_ACCEPTANCE_COMPLETE
MEMORY_PHASE3_REVIEW_INBOX_CLOSEOUT_COMPLETE
MEMORY_ADMIN_SELF_APPROVAL_CLOSEOUT_COMPLETE
```

## Still external to code-only closeout

- authenticated browser acceptance with admin proposer/self-approver, another administrator, standard-user proposer, former reviewer, walled administrator, and cross-tenant user;
- review of broad monorepo failures unrelated to this surface;
- merge approval;
- production migration application;
- AWS deployment;
- production in-app dispatcher scheduling;
- production flag enablement.

There is no Memory Review email rollout step.
