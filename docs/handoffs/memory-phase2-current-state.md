# Capiro Memory Review UX — Current State

## Current release branch

- Follow-up branch: `fix/memory-admin-self-approval`
- Draft PR: `#764`
- Base: `main`
- Do not merge or deploy until the complete-checkout closeout passes on the final synchronized head.

The original Phase 2/3 implementation shipped through PR #761. This follow-up changes shared-memory approval policy and removes Memory Review email delivery.

## Shared-memory approval policy

- Firm and client memory still enter a durable review workflow before becoming active.
- Any active `user_admin` or `capiro_admin` who is currently authorized for the memory may decide the review.
- The administrator who created the proposal may approve that same proposal.
- No independent or second approver is required.
- Assignment remains useful for routing and in-app notifications, but it does not limit an administrator's authority.
- Standard-user reviewers remain assignment-bound and cannot review or approve their own shared-memory proposal.
- Tenant scope, active membership, ethical walls, client grants, archived-client denial, and legal-hold rules remain enforced.

## Durable review workflow

- shared candidate obligations;
- request changes, approve, reject, reassign, and withdraw boundaries;
- required bounded reasons;
- ethical-wall and grant-aware authorization;
- administrator self-approval with exact candidate/actor authorization capability;
- standard-user assignment enforcement and self-review denial.

## Immutable revisions

- proposer-only successor after changes are requested;
- tenant-bound root, predecessor, successor, and revision-number lineage;
- one-successor concurrency guarantee;
- atomic predecessor/workflow supersession;
- fresh authorization at decision time;
- no active-memory mutation before approval.

## Persistence acceptance

- Prisma-modeled, SQL-enforced lineage;
- tenant/actor context guards and system-bypass denial;
- clean and ordered-upgrade migration replay;
- real concurrent revision acceptance;
- compatibility decision guard;
- active-memory mutation checks.

Previously proven marker:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
```

## Notification obligations and dispatcher

Memory Review notifications are **in-app only**.

- tenant-isolated notification outbox;
- assignment, revision assignment, reassignment, changes-requested, approval, and rejection events;
- body-free and reason-free payloads;
- concurrent leased claims with bounded retries;
- fresh membership, current workflow, ethical-wall, grant, archived-client, and canonical memory authorization checks;
- recipient-only in-app notification persistence;
- local RLS acceptance under a dedicated `NOSUPERUSER NOBYPASSRLS NOINHERIT` role;
- no SES service, no Memory Review email flag, and no email delivery path.

The legacy email bookkeeping columns already created by the merged Phase 2 migration remain inert for migration-history compatibility. Runtime code does not use them.

Required marker:

```text
MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE
```

## Phase 3 Review Inbox

Evidence: `docs/qa/memory-phase3-review-inbox.md`.

### Backend

- body-free cursor-paginated views for Needs my review, Submitted by me, All pending, Blocked, and History;
- explicit tenant and actor predicates on every raw SQL query;
- active membership reload and current role;
- canonical wall/grant/client-status authorization;
- standard-user assignment and reviewer eligibility checks;
- administrators can see every currently authorized pending review, including their own proposal;
- protected detail by candidate ID or review-request ID;
- proposal content, feedback, eligible reviewers, capabilities, and immutable revision timeline only after authorization.

### Notification read state

- recipient-only in-app notification list;
- unread count;
- idempotent mark-one-read;
- bounded mark-all-visible-read;
- explicit `tenant_id` and `recipient_user_id` predicates;
- current memory authorization before listing or mutation.

### Compatibility closeout

- generic `/api/reviews` list filters memory rows;
- generic detail, assignment, approval, and rejection reject memory IDs before `ReviewsService` runs;
- non-memory held-deliverable behavior remains delegated unchanged.

### Frontend

- canonical Settings → Memory inbox for standard users and administrators;
- plain-English workflow tabs, counts, statuses, blocked explanations, and next action;
- protected proposal drawer and immutable revision history;
- approve, request changes, reject, revise/resubmit, assign reviewer, and withdraw actions;
- administrator creators receive approval controls for their own proposals;
- in-app notification list and read state;
- review-request deep-link support at `/settings/memory?review=<review-request-id>`;
- old broad `MemoryProposalQueue` and `MemoryReviewQueue` no longer mounted.

### Validation harness

- focused API typecheck: `tsconfig.memory-review-phase3.json`;
- focused Jest and Vitest suites;
- real clean/upgrade database acceptance for cursor stability, body boundaries, former-reviewer denial, cross-tenant denial, blocked work, notification recipient isolation, generic-route rejection, and administrator self-approval;
- one-command closeout: `scripts/verify-memory-phase3-review-inbox-closeout.ts`.

Required final output chain:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE
MEMORY_PHASE3_DATABASE_ACCEPTANCE_COMPLETE
MEMORY_ADMIN_SELF_APPROVAL_DATABASE_ACCEPTANCE_COMPLETE
MEMORY_PHASE3_REVIEW_INBOX_CLOSEOUT_COMPLETE
MEMORY_ADMIN_SELF_APPROVAL_CLOSEOUT_COMPLETE
```

## Authenticated browser acceptance

Validate at least:

- administrator creates and approves the same firm-memory proposal;
- administrator creates and approves the same authorized client-memory proposal;
- another administrator can also decide the proposal regardless of assignment;
- standard-user proposer cannot self-approve;
- former assigned reviewer loses assignment-only authority after reassignment;
- walled administrator cannot bypass the wall;
- archived client cannot be approved;
- cross-tenant user cannot read or decide the review;
- in-app notification list, unread count, and mark-read state remain recipient-only.

## Safety boundary

No merge, production migration, AWS deployment, dispatcher schedule, production flag, backfill, Clerk mutation, or customer-data mutation has been authorized by this follow-up branch.
