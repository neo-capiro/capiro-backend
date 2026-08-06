# Capiro Memory Review UX — Current State

## Branch and pull request

- Branch: `feat/memory-phase2-review-workflow`
- Draft PR: `#761`
- Base: `main`
- Keep the PR draft; do not merge or deploy.

## Phase 2 completed implementation

### Durable review workflow

- shared candidate obligations;
- named independent reviewer;
- request changes, approve, reject, reassign, and withdraw boundaries;
- required bounded reasons;
- ethical-wall and grant-aware eligibility;
- assignment enforcement and self-review denial.

### Immutable revisions

- proposer-only successor after changes are requested;
- tenant-bound root, predecessor, successor, and revision-number lineage;
- one-successor concurrency guarantee;
- atomic predecessor/workflow supersession;
- fresh authorization and reviewer assignment;
- no active-memory mutation before approval.

### Persistence acceptance

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

### Notification obligations and dispatcher

- tenant-isolated notification outbox;
- assignment, revision assignment, reassignment, changes-requested, approval, and rejection events;
- body-free and reason-free payloads;
- concurrent leased claims with bounded retries;
- fresh membership, current workflow, assignment, ethical-wall, grant, archived-client, and canonical memory authorization checks;
- recipient-only in-app notification persistence;
- default-off, at-most-once SES email;
- local RLS acceptance under a dedicated `NOSUPERUSER NOBYPASSRLS NOINHERIT` role.

Required marker still being executed in a complete checkout:

```text
MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE
```

## Phase 3 implemented

Evidence: `docs/qa/memory-phase3-review-inbox.md`.

### Review Inbox backend

- body-free cursor-paginated views for Needs my review, Submitted by me, All pending, Blocked, and History;
- explicit tenant and actor predicates on every raw SQL query;
- active membership reload and current role;
- canonical wall/grant/client-status authorization;
- current assignment and reviewer eligibility;
- bounded counts using the same projection rules;
- protected detail by candidate ID or review-request ID;
- proposal content, feedback, eligible reviewers, capabilities, and immutable revision timeline only after authorization.

### Notification read state

- recipient-only notification list;
- unread count;
- idempotent mark-one-read;
- bounded mark-all-visible-read;
- explicit `tenant_id` and `recipient_user_id` predicates;
- current memory read authorization before listing or mutation.

### Compatibility closeout

- generic `/api/reviews` list filters memory rows;
- generic detail, assignment, approval, and rejection reject memory IDs before `ReviewsService` runs;
- non-memory held-deliverable behavior remains delegated unchanged.

### Review Inbox frontend

- canonical Settings → Memory inbox for standard users and administrators;
- plain-English workflow tabs, counts, statuses, blocked explanations, and next action;
- protected proposal drawer and immutable revision history;
- approve, request changes, reject, revise/resubmit, assign reviewer, and withdraw actions;
- in-app notification list and read state;
- old broad `MemoryProposalQueue` and `MemoryReviewQueue` no longer mounted;
- email deep link corrected to `/settings/memory?review=<review-request-id>`.

### Phase 3 validation harness

- focused API typecheck: `tsconfig.memory-review-phase3.json`;
- focused Jest and Vitest suites;
- real clean/upgrade database acceptance for cursor stability, body boundaries, former-reviewer denial, cross-tenant denial, blocked work, notification recipient isolation, and generic-route rejection;
- one-command closeout: `scripts/verify-memory-phase3-review-inbox-closeout.ts`.

Required final marker:

```text
MEMORY_PHASE3_REVIEW_INBOX_CLOSEOUT_COMPLETE
```

## Complete-checkout closeout still required

The branch implementation is persisted. Final local acceptance must still execute the Phase 2 notification and Phase 3 closeout commands and repair every failure before the PR can leave draft.

Required output chain:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE
MEMORY_PHASE3_DATABASE_ACCEPTANCE_COMPLETE
MEMORY_PHASE3_REVIEW_INBOX_CLOSEOUT_COMPLETE
```

Then run authenticated browser acceptance for:

- proposer;
- assigned reviewer;
- former reviewer after reassignment;
- walled administrator;
- cross-tenant user;
- notification email deep link.

## Branch synchronization note

The feature branch is currently two non-overlapping Defense Budget/parser commits behind `main`. Synchronize before final acceptance and rerun the complete closeout after synchronization.

## Safety boundary

No merge, production migration, AWS deployment, dispatcher schedule, production flag, backfill, Clerk mutation, customer-data mutation, or production email enablement has been authorized.
