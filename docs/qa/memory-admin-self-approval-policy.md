# Memory Review — Administrator Self-Approval Policy

## Product decision

Independent approval is no longer required for shared firm or client memory.

Any **active** tenant administrator may approve, reject, request changes, or
reassign a governed-memory review they are currently authorized to access,
including a proposal they created themselves.

Administrator roles:

- `user_admin`
- `capiro_admin`

Assignment remains useful for routing and in-app notifications, but it is not an
administrator authorization prerequisite.

## Controls retained

This policy change does not bypass:

- exact tenant scope;
- active tenant membership;
- ethical walls;
- client-memory access grants;
- archived/inactive client denial;
- legal hold restrictions;
- body-free broad inbox and in-app notification payloads;
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
3. permits the administrator exception only when the decider is an active
   `user_admin` or `capiro_admin` **and** the canonical application transaction
   set both the exact candidate and actor capabilities after authorization;
4. rejects a capability issued for a different candidate or actor;
5. preserves assignment enforcement for direct/generic and non-admin writes;
6. preserves standard-user self-decision denial even when the capability
   settings are forged;
7. updates existing pending workflow wording without changing status,
   assignment, candidate content, or active memory;
8. updates future trigger-created workflow wording.

The transaction-local settings are:

```text
app.memory_admin_review_candidate_id=<candidate UUID>
app.memory_admin_review_actor_id=<administrator UUID>
```

## Application boundary

- Canonical authorization exempts administrators from the self-review denial
  only after wall and client-status checks.
- The authorization service grants candidate- and actor-bound database
  capabilities only for an allowed, non-simulated admin `approve` or `review`
  decision on a pending candidate.
- Read-model and eligibility simulations never receive the capabilities.
- Candidate and immutable-version activation retain defense-in-depth self-review
  checks for non-admin actors.
- Workflow decisions no longer require current assignment for administrators.
- The administrator Review Inbox surfaces every currently authorized pending
  review, including the administrator's own submission.
- Admin inbox capability checks are batched per page inside one tenant-bound
  transaction; standard-user inbox behavior remains unchanged.
- Memory Review notifications are in-app only. There is no email transport,
  email feature flag, or SES delivery path.

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

The database acceptance proves:

- a raw admin self-decision without capability is denied;
- capability for candidate A cannot authorize candidate B;
- an exact capability-bearing active admin self-decision succeeds;
- workflow decision evidence synchronizes;
- a standard user cannot self-approve even when attempting to set the same
  candidate/actor capability settings.

The closeout also runs focused TypeScript, the existing Phase 2/3 tests, the
administrator policy tests, web Vitest, and a production web build.

## Production rollout

Keep rollout limited to the tenant UUIDs for:

- `capiro-internal`
- `dualsiight`

Run the notification dispatcher for in-app delivery only. No email configuration
or email rollout step exists for Memory Review.
