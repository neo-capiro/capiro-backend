# Memory Review UX Phase 2 — Next Increment

Close Increment 4B notification delivery before beginning the Review Inbox backend.

## Required execution

Use a fresh detached checkout of the current remote feature branch. Do not reuse a stale local branch or commit line-ending normalization.

### Windows PowerShell

```powershell
cd C:\Users\neoma\Downloads\capiro-memory-phase2-review

git fetch origin
git switch --detach origin/feat/memory-phase2-review-workflow

cd apps/api

pnpm exec prisma validate --schema prisma/schema.prisma
pnpm exec prisma generate --schema prisma/schema.prisma

$env:MEMORY_PHASE2_CLEAN_DATABASE_URL = 'postgresql://capiro:capiro@127.0.0.1:55452/capiro_memory_phase2_clean'
$env:MEMORY_PHASE2_UPGRADE_DATABASE_URL = 'postgresql://capiro:capiro@127.0.0.1:55452/capiro_memory_phase2_upgrade'

pnpm exec tsx scripts/verify-memory-phase2-notification-closeout.ts
```

Before the command, drop and recreate both databases empty. The script refuses non-local database names that do not contain `memory_phase2` and the underlying persistence closeout refuses databases containing public tables.

Do not set `MEMORY_REVIEW_EMAIL_DELIVERY=enforce`. Notification email remains default-off during local closeout; the database, authorization, in-app projection, and email-state contracts are validated without sending mail.

## Required markers

The command invokes the established persistence closeout first, so the output must contain both:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
MEMORY_PHASE2_NOTIFICATION_CLOSEOUT_COMPLETE
```

The command must exit `0` with no Prisma or PostgreSQL errors.

## Focused repository checks

```powershell
pnpm exec jest --runInBand `
  src/memory/memory-review-notification.helpers.spec.ts `
  scripts/lib/memory-phase2-notification-outbox-contract.spec.ts `
  scripts/lib/memory-phase2-notification-assignment-contract.spec.ts `
  scripts/lib/memory-phase2-notification-dispatcher-contract.spec.ts

pnpm exec tsc --noEmit --pretty false
```

If the repository uses a package-specific typecheck command instead of direct `tsc`, run that command and report it exactly.

## Acceptance evidence to report

```powershell
git rev-parse HEAD
git status --short
git log -1 --oneline
```

Also report:

- both closeout markers;
- exit code;
- focused Jest result;
- TypeScript result;
- whether either database required an unexpected manual repair; and
- any line-ending-only working-tree changes. Do not commit line-ending normalization or generated Prisma output.

## Next implementation increment after green closeout

Implement the Review Inbox backend read model:

1. assigned-to-me pending reviews;
2. submitted-by-me pending and terminal history;
3. revision lineage and supersession timeline;
4. body-free notification list and mark-read endpoints;
5. current tenant, membership, ethical-wall, grant, archived-client, and feature-flag authorization;
6. stable pagination and counts for frontend tabs;
7. focused cross-tenant, walled-client, removed-member, stale-assignment, and proposer/reviewer tests.

Do not begin the frontend until the read model is locally green.
