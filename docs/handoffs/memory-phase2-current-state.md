# Memory Review UX Phase 2 — Current State

## Branch and pull request

- Branch: `feat/memory-phase2-review-workflow`
- Draft PR: `#761` — `feat(memory): Phase 2 review workflow foundation`
- Base: `main@af9ef9d2b6bf08f08b548d8a7807337fc24d038d`
- Branch relation at Increment 1 closeout: 0 commits behind `main`

## Current completed increment

Increment 1 establishes the durable backend review-workflow foundation. It includes body-free workflow obligations, dark-rollout-compatible named assignment, request-changes, required reasons, ethical-wall-aware reassignment, and database assignment-race enforcement after Phase 2 activates a named reviewer.

Evidence and implementation:

- `docs/qa/memory-phase2-increment-1-foundation.md`
- `apps/api/src/memory/memory-review-workflow.service.ts`
- `apps/api/prisma/migrations/20260818010000_memory_phase2_review_workflow_foundation/migration.sql`

## Validation status

Passed in the available environment:

- strict isolated production TypeScript;
- strict isolated spec TypeScript;
- focused workflow runtime probes;
- migration structural/static probes;
- post-publication GitHub diff and security review.

Not yet established: full repository install/typecheck/tests, pinned Prettier, Prisma validate/generate, clean and upgrade PostgreSQL migration replay, real-role RLS, web build/Vitest, browser acceptance, and GitHub Actions.

## Phase 2 is not complete

Remaining work includes immutable revision/resubmission, notifications and email obligations, Review Inbox UX, proposer history/status surfaces, compatibility-route closeout, full repository validation, PostgreSQL migration replay, real-role RLS tests, web build/Vitest, and authenticated browser acceptance.

## Next increment

Implement proposer-only immutable revision and resubmission after `changes_requested`, including predecessor/successor lineage, monotonic revision numbers, atomic supersession, fresh authorization and reviewer eligibility, and focused concurrency tests.

## Operating rule

Continue in tested increments on this branch. Keep PR #761 draft. Do not merge, deploy, apply production migrations, or enable production flags until the final Phase 2 acceptance gate and explicit human authorization.
