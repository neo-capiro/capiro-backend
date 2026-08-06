# Memory Administrator Self-Approval — Release Handoff

## Branch

```text
fix/memory-admin-self-approval
```

## Policy

The same active administrator may create and approve the same shared-memory proposal.

Example:

```text
Admin A creates firm/client memory proposal
→ proposal enters pending review
→ Admin A opens the proposal
→ Admin A approves it
→ approved memory becomes active
```

No second administrator or independent approver is required.

This applies to active:

- `user_admin`
- `capiro_admin`

The administrator must still be currently authorized for the memory. Tenant scope, active membership, ethical walls, client grants/status, and legal holds remain enforced.

Standard-user reviewers remain assignment-bound and cannot self-review.

Memory Review notifications are in-app only. There is no email delivery path or email rollout step.

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

Run the existing Memory Review notification dispatcher for recipient-scoped
in-app notifications only.

## Safety

No production migration, deployment, dispatcher schedule, flag change, Clerk
mutation, backfill, or customer-data mutation is performed by this branch.
