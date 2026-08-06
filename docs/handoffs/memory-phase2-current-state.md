# Memory Review UX Phase 2 — Current State

## Branch and pull request

- Branch: `feat/memory-phase2-review-workflow`
- Draft PR: `#761`
- Base: `main`
- Keep the PR draft; do not merge or deploy.

## Completed increments

### Increment 1 — durable review workflow foundation

- body-free workflow obligations;
- dark-rollout-compatible named assignment;
- request-changes and required reasons;
- ethical-wall-aware reassignment;
- assigned-reviewer enforcement after Phase 2 activates assignment.

Evidence: `docs/qa/memory-phase2-increment-1-foundation.md`.

### Increment 2 — immutable revision and resubmission lineage

- proposer-only immutable successor creation after `changes_requested`;
- root/predecessor/revision lineage and one-successor concurrency guards;
- atomic predecessor and workflow supersession;
- fresh authorization before and after successor creation;
- fresh reviewer assignment and no active-memory mutation.

Evidence: `docs/qa/memory-phase2-increment-2-revision-lineage.md`.

### Increment 3 — persistence integrity and closeout

- revision SQL bound to tenant and actor context;
- system-bypass revision calls denied;
- Prisma-modeled, SQL-enforced tenant-bound lineage;
- deterministic concurrent-successor conflicts;
- body-free workflow metadata;
- portable Windows/Corepack closeout runner;
- clean and exact upgrade migration replay;
- compatibility-route and active-memory mutation checks.

The complete-checkout marker has passed on the persisted branch state:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
```

Evidence:

- `docs/qa/memory-phase2-increment-3-persistence-gate.md`
- `docs/qa/memory-phase2-increment-3b-metadata-conflicts.md`
- `docs/qa/memory-phase2-increment-3c-closeout-runner-portability.md`

### Increment 4A — notification obligations

- durable, tenant-isolated notification outbox;
- atomic obligations for assignment, revision assignment, reassignment, changes requested, approval, and rejection;
- body-free and reason-free payloads;
- pending-only backfill;
- correct first-assignment classification.

Evidence: `docs/qa/memory-phase2-increment-4a-notification-obligations.md`.

### Increment 4B — notification dispatcher

- concurrent leased claims with `FOR UPDATE SKIP LOCKED`;
- bounded retries and terminal handling;
- active membership, current workflow, exact tenant feature scope, canonical memory authorization, ethical-wall, and archived-client checks;
- tenant-bound, recipient-only in-app notifications under FORCE RLS;
- default-off, at-most-once SES email;
- body-free delivery audit evidence;
- audit-retaining recipient foreign keys;
- operator and complete-checkout validation commands without production scheduling.

Evidence: `docs/qa/memory-phase2-increment-4b-notification-dispatcher.md`.

## Validation completed

- Prisma validate and generate passed after the persisted lineage reconciliation.
- Clean and upgrade Phase 2 persistence replay passed.
- `MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE` passed.
- Notification helper passed strict isolated TypeScript and runtime probes.
- Static contracts cover notification leases, retries, tenant scope, membership, workflow state, authorization, archived-client suppression, RLS, idempotency, body-free channels, default-off email, at-most-once email state, and module wiring.

## Notification gate still open

Increment 4B is persisted but still requires complete-checkout execution against two freshly recreated disposable databases.

Required marker:

```text
MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE
```

The notification closeout first reruns the established persistence closeout, then validates the complete clean and upgrade migration chains, event obligations, concurrent claims, recipient-only RLS, cross-tenant isolation, in-app idempotency, and database rejection of feedback/body fields.

## Phase 2 is not complete

Still required:

- execute and repair the notification closeout;
- Review Inbox backend read model;
- Review Inbox and proposer-history frontend;
- notification list/read-state endpoints;
- remaining compatibility-route closeout;
- full API/monorepo tests, typecheck, pinned formatting, web build/Vitest, authenticated browser acceptance, and final security review.

## Branch synchronization note

At Increment 4B closeout the feature branch is two commits behind `main`. Both upstream commits are Defense Budget / parser changes and do not overlap the Memory Review files in this increment. Synchronize before final acceptance and rerun affected checks.
