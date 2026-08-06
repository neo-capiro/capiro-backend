# Memory Review UX Phase 2 — Current State

## Branch and pull request

- Branch: `feat/memory-phase2-review-workflow`
- Draft PR: `#761` — `feat(memory): Phase 2 review workflow foundation`
- Base: `main@af9ef9d2b6bf08f08b548d8a7807337fc24d038d`
- Branch relation at Increment 2 closeout: 0 commits behind `main`

## Completed increments

### Increment 1 — durable review workflow foundation

- body-free workflow obligations;
- dark-rollout-compatible named assignment;
- request-changes and required reasons;
- ethical-wall-aware reassignment;
- assigned-reviewer enforcement after Phase 2 activates assignment.

Evidence:

- `docs/qa/memory-phase2-increment-1-foundation.md`
- `apps/api/src/memory/memory-review-workflow.service.ts`
- `apps/api/prisma/migrations/20260818010000_memory_phase2_review_workflow_foundation/migration.sql`

### Increment 2 — immutable revision and resubmission lineage

- proposer-only immutable successor creation after `changes_requested`;
- root/predecessor/revision lineage and one-successor concurrency guards;
- atomic predecessor and workflow supersession;
- fresh authorization before and after successor creation;
- fresh reviewer assignment for the successor;
- server-derived canonical content and regenerated source identity;
- preserved original reviewer attribution;
- no active-memory mutation during revision.

Evidence:

- `docs/qa/memory-phase2-increment-2-revision-lineage.md`
- `apps/api/src/memory/memory-review-revision.service.ts`
- `apps/api/prisma/migrations/20260818020000_memory_phase2_revision_lineage/migration.sql`

## Validation status

Passed in the available environment:

- strict isolated TypeScript for the exact production workflow and revision sources;
- focused workflow and revision runtime probes;
- migration structural/static contract probes;
- post-publication GitHub diff and security review.

Not yet established:

- full repository install/typecheck/tests and pinned Prettier;
- Prisma ownership parity for the lineage columns;
- Prisma validate/generate;
- clean and upgrade PostgreSQL migration replay;
- real concurrent-transaction and RLS behavior;
- web build/Vitest and authenticated browser acceptance;
- GitHub Actions.

## Phase 2 is not complete

Remaining work includes persistence compatibility closeout, notifications and email obligations, Review Inbox UX, proposer history/status surfaces, compatibility-route closeout, full repository validation, PostgreSQL migration replay, real-role RLS tests, web build/Vitest, and authenticated browser acceptance.

## Next increment

Close the revision persistence compatibility gate before beginning notifications:

1. reconcile Prisma ownership of the four lineage columns;
2. add clean and upgrade PostgreSQL replay evidence;
3. execute real concurrent successor tests;
4. test proposer/reviewer/walled/cross-tenant RLS identities;
5. verify compatibility decision routes cannot bypass lineage or named assignment.

## Operating rule

Continue in tested increments on this branch. Keep PR #761 draft. Do not merge, deploy, apply production migrations, or enable production flags until the final Phase 2 acceptance gate and explicit human authorization.
