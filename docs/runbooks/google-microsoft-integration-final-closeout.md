# Google / Microsoft Integration — Final Closeout and Rollout

## Release scope

This release closes the remaining provider-state defects and the verification gap in the
Google Workspace / Microsoft 365 engagement integration:

- Gmail reset/reclaim starts from a genuinely fresh mail baseline. An established
  `historyId` cannot preempt an unfinished full-backfill page chain.
- Gmail treats a saved full-backfill page token as authoritative even when an older build
  left a stale `historyId` or contradictory `backfillDone: true` beside it. The next successful
  sync cleans the hybrid state rather than abandoning concrete provider work.
- Google Calendar keeps the two provider pagination contracts separate. Full-window
  pagination persists page token + frozen window with no sync token; incremental pagination
  persists page token + sync token with no window. A reset keeps `syncToken = null` until the
  full page chain is exhausted and a replacement token is returned.
- An explicit Google reset now fails visibly when its mail leg fails, even if Calendar already
  succeeded. Ordinary scheduled syncs retain their existing partial-success behavior, but a
  reset can no longer look complete while preserving the old mail baseline.
- Ambiguous Calendar state written by an older build (page token + sync token + full-window
  marker) fails closed: the unprovable cursor is discarded and the bounded full window restarts
  from page one rather than sending an invalid parameter combination.
- The production smoke command now prints reliably, validates connection/cursor health,
  exits non-zero on an unsafe continuation state, and is included in the API package typecheck
  through a dedicated narrow scripts tsconfig.
- The `integration-sync-correctness` assertion inside the existing
  `engagement-trust-boundary` workflow permanently gates 25 suites / 248 tests covering
  provider cursor, reset, removal, body-extraction, OAuth-scope, mail-read, and AI-evidence
  contracts with zero failures, zero skips, and a non-shrinking count floor.

No OAuth scope, token-encryption, send, tenant-authorization, networking, secret, or UI
behavior changes in this release.

## Database impact

**This PR adds no Prisma migration.** The reset fixes operate on the existing
`integration_connections.sync_state` JSON and automatically repair hybrid cursor state on
the next ordinary sync.

The previously merged migration below remains a rollout prerequisite if it has not yet
been applied in the target database:

`20260727170000_mail_message_removal_state`

It adds `mail_messages.removed_at`, `mail_messages.removed_reason`, and the removal-state
index. It is additive; no message row or message body is deleted.

## Required rollout order

1. Merge only after all PR checks are green, including the
   `engagement-trust-boundary` job's `integration-sync-correctness` assertion.
2. Record the merge SHA. Build the API image from that exact SHA; do not use a floating
   branch tag.
3. Inspect the target's pending apps/api migrations, then run the standard API migration task
   (`/usr/local/bin/entrypoint.sh migrate`). It uses `prisma migrate deploy`, applies **every**
   pending apps/api migration in repository order (not only the removal-state migration), and
   must fail closed on any failed migration history.
4. Verify the removal-state migration is complete with a read-only query:

   ```sql
   SELECT migration_name, finished_at, rolled_back_at
   FROM _prisma_migrations
   WHERE migration_name = '20260727170000_mail_message_removal_state';
   ```

   Pass condition: exactly one row, `finished_at IS NOT NULL`, and
   `rolled_back_at IS NULL`.
5. Deploy **apps/api only** from the merge-SHA image. This release contains no web,
   intel-api, workspace, orchestrator, or infrastructure change.
6. Confirm the running API task definition/image is the exact merge SHA.
7. Run the historical thread-summary repair in dry-run mode:

   ```bash
   pnpm --filter @capiro/api backfill:mail-removal-state -- --all-tenants
   ```

   If `affectedThreads=0`, no write is needed. If it is non-zero, preserve the dry-run
   output as rollout evidence, approve the one-time repair, then run:

   ```bash
   pnpm --filter @capiro/api backfill:mail-removal-state -- --all-tenants --commit
   ```

   Rerun the dry run afterward. Pass condition: no failed repairs; repeated commit mode is
   idempotent.
8. Run the read-only integration health check:

   ```bash
   pnpm --filter @capiro/api smoke:integrations -- --tenant=capiro-internal
   ```

   Pass condition: at least one Google/Microsoft connection is present, exit code 0,
   final `PASS`, and every connection reports `health: healthy` with a complete refresh-token
   envelope and a recorded successful sync.
9. Complete `docs/runbooks/integration-smoke.md`. Do not run a mailbox reset, disconnect a
   live account, or perform a partial-grant test against a production mailbox.

## Hybrid-state recovery during canary

The new code recovers states that an older reset could have left behind:

- Gmail: `mail.historyId` plus `mail.labels.ALL.backfillPageToken`, or a backfill page token
  incorrectly paired with `backfillDone: true`. The saved provider page is authoritative; stale
  incremental/completion markers are cleared when the chain resumes.
- Calendar: `calendar.syncToken` plus `calendar.pageToken` plus a persisted full-window marker.
  That combination is ambiguous because older builds used the same shape for two different
  provider request modes. The release discards the unprovable page/sync cursor pair and restarts
  the bounded full-window sync from page one.

The read-only smoke command intentionally reports both legacy shapes as errors. Run one ordinary
Google **Sync now**. Rerun the smoke command; it must show only a healthy steady state or one of
Calendar's two explicit continuation modes (`full_window` or `incremental`) before widening.

A full mailbox reclaim is not required for this release. `reclaim-google-mail --commit`
remains a separately approved historical-recovery operation only when a specific tenant
needs older skipped mail reprocessed.

## Automated release evidence

Retain the following for the SOC 2 change record:

- PR number, approved diff, branch head SHA, and merge SHA.
- Green `ci-pr`, `engagement-trust-boundary`, and `legiwatch-ci` runs, including the
  Google/Microsoft integration test and assertion steps inside `engagement-trust-boundary`.
- The uploaded `integration-sync-correctness-summary` artifact.
- Migration task identifier and the read-only `_prisma_migrations` result.
- API image digest/task-definition revision proving the merge SHA.
- Removal-state repair dry-run/commit output, when applicable.
- Read-only smoke output and manual canary sign-off.

The smoke script never decrypts or prints OAuth token material. Do not put mailbox bodies,
access tokens, refresh-token ciphertext, or provider secrets in rollout evidence.

## Rollback

The code rollback is API-only:

1. Redeploy the previous API task-definition/image revision.
2. Leave `20260727170000_mail_message_removal_state` and its additive columns/index in
   place. Do not run a destructive down migration.
3. Do not edit provider cursors manually. The previous application version can read the
   same JSON state; the next forward deployment can resume the page chain.
4. Record the rollback SHA/revision and the reason in the change record.

If the migration task fails, stop before deployment. Use the existing failed-migration
recovery runbook; never mark a failed Prisma migration applied merely to unblock a release.
