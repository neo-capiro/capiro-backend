# Memory Administrator Self-Approval — Release Handoff

## Branch

```text
fix/memory-admin-self-approval
```

## Policy

Any active `user_admin` or `capiro_admin` may decide a currently authorized
shared-memory review, including their own proposal and regardless of assignment.

Standard-user reviewers remain assignment-bound and cannot self-review.

## Pre-merge acceptance

Synchronize with `main`, recreate both disposable databases, and run:

```bash
pnpm --filter @capiro/api exec tsx \
  scripts/verify-memory-phase3-review-inbox-closeout.ts
```

Require all markers documented in:

```text
docs/qa/memory-admin-self-approval-policy.md
```

Do not merge if the branch head changes after closeout.

## Release scope

Enable only the tenant UUIDs corresponding to:

- `capiro-internal`
- `dualsiight`

Keep email delivery unset during initial canary acceptance.

## Safety

No production migration, deployment, dispatcher schedule, flag change, email
enablement, Clerk mutation, backfill, or customer-data mutation is performed by
this branch.
