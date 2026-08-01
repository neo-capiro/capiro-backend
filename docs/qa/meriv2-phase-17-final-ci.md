# MeriV2 Phase 17 — synchronization and final CI evidence

## Status

**BLOCKED — not accepted.**

Phase 17 requires one final SHA synchronized with current `main`, all branch-introduced checks green, and an accurately documented, mergeable draft PR. Those acceptance conditions are not yet true.

## Repository state observed

- Repository: `neo-capiro/capirov2`
- Release branch: `agent/meriv2-world-class-closeout`
- Primary PR: `#679`
- Main advanced from `3dcb12f823774b6fae8578dc56fc122bf9a0879e` to `b792f2d24920d56d7addcda88a602c6282563f47` during Phase 17 execution.
- The release branch became 101 commits behind and GitHub reports merge conflicts.
- Synchronization PR `#725` (`main` into the release branch) was closed unmerged after GitHub refused it with `Pull Request has merge conflicts`.

## Phase 17 implementation completed

### Inherited chat rollout test contract

The production chat resolver already requires all three server-owned assurance rollout controls:

1. global `off | shadow | enforce` mode;
2. tenant canary;
3. exact surface selection.

The inherited full-chat integration spec still toggled only the global switch. A test-only, file-scoped Jest compatibility setup now binds that legacy spec to internal tenant `t1` and surface `chat`. Production resolution and explicit missing-control fail-closed tests were not weakened.

Files:

- `apps/meriv2-orchestrator/jest.chat-assurance-rollout.setup.ts`
- `apps/meriv2-orchestrator/jest.config.cjs`

### Exact Phase 17 CI matrix

Added `.github/workflows/meriv2-phase17-ci.yml` with the plan’s exact dependency install, five Prisma client generations, required package builds, formatting scope, bypass searches, package and repository typechecks, six test commands, and `eval:meriv2`.

The bypass audit preserves raw matches and fails on live non-test ethical-wall bypasses. Known remaining text matches are restricted to historical migration/comments, regression assertions, the durable-outbox fast path, or the documented off/shadow static policy fallback and must still be reviewed in the final successful run log.

### Current-main synchronization attempt

A temporary branch-only synchronization workflow was created to:

- perform a real three-way merge with current-main conflict precedence;
- verify MeriV2 governed-memory schema, worker, policy, and recall-suppression invariants;
- verify the newly landed Program Elements schema, worker, and model-grounding invariants;
- push only after both release streams survived;
- otherwise abort and publish bounded conflict-path diagnostics.

GitHub Actions did not register or execute that workflow. It produced neither a merge commit nor a diagnostic. The temporary write-capable workflow and its request marker were therefore removed from the branch, rather than left dormant.

The permanent Phase 17 CI matrix remains read-only and is intended to run after synchronization is resolved.

## GitHub Actions control-plane blocker

The repository continues to expose the orphan synthetic workflow identity `324351375` with `path=BuildFailed`. On the Phase 17 commits:

- no pull-request workflow run registered;
- no commit status context registered;
- the branch-only synchronization attempt did not execute.

This is not test evidence. No build, typecheck, test, evaluation, migration rehearsal, or canary result is claimed from these commits.

## Required next acceptance actions

1. Restore legitimate GitHub Actions workflow registration or run the exact matrix in an authenticated checkout.
2. Merge current `main` into the release branch with a real three-way merge.
3. Resolve the shared Prisma schema, API entrypoint dispatcher, and `MeriToolsService` conflicts without taking either MeriV2 or Program Elements wholesale.
4. Run the exact Phase 17 matrix on the resulting SHA.
5. Re-run the bypass audit and record every match disposition.
6. Confirm zero commits behind, mergeable draft PR, and no unresolved release blocker.
7. Update PR #679 with the final base/head SHAs and green evidence.

## Safety boundary

No merge to `main`, deployment, shared-environment migration, production backfill, feature-flag activation, AWS operation, external send, secret retrieval, or customer-data mutation occurred during this Phase 17 attempt.
