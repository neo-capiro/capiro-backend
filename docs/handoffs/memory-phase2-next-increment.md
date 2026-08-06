# Capiro Memory Review UX — Final Local Closeout

Phase 2 notifications and Phase 3 Review Inbox are implemented. The next work is validation and repair, not another feature increment.

## 1. Synchronize the checkout

Use a fresh local checkout of the current remote feature branch. The branch is presently two non-overlapping parser commits behind `main`; synchronize it safely before final acceptance, resolve current-main first, and do not rewrite published history.

After synchronization, confirm:

```powershell
git rev-parse HEAD
git status --short
git diff --check
```

Do not commit generated Prisma clients, build output, logs, local environment files, or line-ending-only normalization.

## 2. Recreate the disposable databases

```powershell
docker exec capiro-memory-phase2-pg psql -U capiro -d postgres -c "DROP DATABASE IF EXISTS capiro_memory_phase2_clean;"
docker exec capiro-memory-phase2-pg psql -U capiro -d postgres -c "DROP DATABASE IF EXISTS capiro_memory_phase2_upgrade;"
docker exec capiro-memory-phase2-pg psql -U capiro -d postgres -c "CREATE DATABASE capiro_memory_phase2_clean;"
docker exec capiro-memory-phase2-pg psql -U capiro -d postgres -c "CREATE DATABASE capiro_memory_phase2_upgrade;"
```

## 3. Install and run the one-command closeout

From the repository root:

```powershell
pnpm install --frozen-lockfile

$env:MEMORY_PHASE2_CLEAN_DATABASE_URL = 'postgresql://capiro:capiro@127.0.0.1:55452/capiro_memory_phase2_clean'
$env:MEMORY_PHASE2_UPGRADE_DATABASE_URL = 'postgresql://capiro:capiro@127.0.0.1:55452/capiro_memory_phase2_upgrade'
Remove-Item Env:MEMORY_REVIEW_EMAIL_DELIVERY -ErrorAction SilentlyContinue

pnpm --filter @capiro/api exec tsx scripts/verify-memory-phase3-review-inbox-closeout.ts
```

The command performs:

1. Phase 2 persistence and notification clean/upgrade closeout;
2. `@capiro/shared` and `@capiro/meriv2-core` builds;
3. real Phase 3 database acceptance on both disposable databases;
4. focused Phase 3 API typecheck;
5. focused Phase 2 notification and Phase 3 Jest suites;
6. Phase 3 web Vitest;
7. complete web typecheck and Vite production build.

It refuses non-local database names and refuses to run while `MEMORY_REVIEW_EMAIL_DELIVERY=enforce`.

## Required markers

The command must exit `0` and print all four:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE
MEMORY_PHASE3_DATABASE_ACCEPTANCE_COMPLETE
MEMORY_PHASE3_REVIEW_INBOX_CLOSEOUT_COMPLETE
```

Do not treat earlier markers as success if the final marker is absent.

## 4. Broad repository checks

After the focused closeout passes:

```powershell
pnpm --filter @capiro/api typecheck
pnpm --filter @capiro/api test -- --runInBand
pnpm --filter @capiro/web test
pnpm --filter @capiro/web build
git diff --check
```

Classify every failure as:

- introduced by this branch;
- reproduced on current `main`;
- environment/dependency setup;
- external CI/startup failure.

Repair every branch-introduced failure. Do not weaken tests or branch protections.

## 5. Authenticated browser acceptance

Keep production flags and email delivery off. Use a local or internal environment with seeded test users.

Accept all of these scenarios:

### Proposer

- submits a shared firm/client edit;
- sees it under Submitted by me;
- cannot approve or reject it;
- sees reviewer feedback;
- revises and creates an immutable successor;
- prior revision remains in history;
- may withdraw an open proposal.

### Assigned reviewer

- sees only currently assigned work under Needs my review;
- opens protected proposal detail;
- can approve, reject, or request changes according to capabilities;
- cannot decide their own proposal.

### Former reviewer

- work disappears after reassignment;
- direct detail URL returns unavailable/not-found unless independently authorized;
- cannot decide through legacy or generic review routes.

### Administrator

- sees All pending and Blocked;
- cannot bypass an ethical wall;
- may assign only an eligible reviewer;
- archived-client work is visibly paused.

### Notifications

- unread count matches visible notifications;
- another member cannot read or mark the notification;
- mark-one and mark-all are idempotent;
- email preview/deep link opens `/settings/memory?review=<id>` and loads the correct protected detail;
- no proposal body or reviewer feedback appears in notification metadata or email.

### Cross-tenant user

- guessed candidate, review-request, and notification UUIDs disclose nothing;
- counts and lists contain no other-tenant rows.

## 6. Final handoff evidence

Report:

```powershell
git rev-parse HEAD
git status --short
git log -1 --oneline
git rev-list --left-right --count main...HEAD
```

Include:

- all closeout markers;
- focused and broad test summaries;
- web build result;
- browser acceptance results by role;
- unresolved failures with exact logs;
- migration list and deploy order;
- required production environment variables and their default-off state.

Only after this evidence is green should the PR leave draft. Merge, migration application, AWS deployment, dispatcher scheduling, and production flag enablement remain separately authorized operations.
