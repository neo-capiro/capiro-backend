# Memory Review — Administrator Self-Approval Policy

## Product decision

Independent approval is no longer required for shared firm or client memory.

Any **active** tenant administrator may approve, reject, request changes, or
reassign a governed-memory review they are currently authorized to access,
including a proposal they created themselves.

Administrator roles:

- `user_admin`
- `capiro_admin`

Assignment remains useful for routing and notifications, but it is not an
administrator authorization prerequisite.

## Controls retained

This policy change does not bypass:

- exact tenant scope;
- active tenant membership;
- ethical walls;
- client-memory access grants;
- archived/inactive client denial;
- legal hold restrictions;
- body-free broad inbox and notification payloads;
- immutable revision lineage;
- generic `/api/reviews` containment;
- bounded audit reasons and decision stamps.

A standard user with an explicit review/approval grant may continue to act only
when currently assigned, and may not approve or review their own proposal.

## Database boundary

Migration:

```text
20260818050000_memory_admin_self_approval_policy
```

It:

1. removes the `assigned_to <> requested_by` shape restriction;
2. preserves the shape, status, reason-size, and body-free metadata checks;
3. permits a decision only when the decider is an active `user_admin` or
   `capiro_admin`, or the existing assigned non-admin reviewer;
4. preserves standard-user self-decision denial;
5. updates existing pending workflow wording without changing status,
   assignment, candidate content, or active memory;
6. updates future trigger-created workflow wording.

## Application boundary

- Canonical authorization exempts administrators from the self-review denial
  only after wall and client-status checks.
- Candidate and immutable-version activation retain defense-in-depth self-review
  checks for non-admin actors.
- Workflow decisions no longer require current assignment for administrators.
- The administrator Review Inbox surfaces every currently authorized pending
  review, including the administrator's own submission.
- Standard-user inbox and decision behavior remains unchanged.

## Local acceptance

Run against freshly recreated local clean and upgrade databases:

```bash
pnpm --filter @capiro/api exec tsx \
  scripts/verify-memory-phase3-review-inbox-closeout.ts
```

Required markers:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE
MEMORY_PHASE3_DATABASE_ACCEPTANCE_COMPLETE
MEMORY_ADMIN_SELF_APPROVAL_DATABASE_ACCEPTANCE_COMPLETE
MEMORY_PHASE3_REVIEW_INBOX_CLOSEOUT_COMPLETE
MEMORY_ADMIN_SELF_APPROVAL_CLOSEOUT_COMPLETE
```

The closeout also runs focused TypeScript, the existing Phase 2/3 tests, the
administrator policy tests, web Vitest, and a production web build.

## Production rollout

Keep rollout limited to the tenant UUIDs for:

- `capiro-internal`
- `dualsiight`

Keep `MEMORY_REVIEW_EMAIL_DELIVERY` unset until in-app canary acceptance passes.
