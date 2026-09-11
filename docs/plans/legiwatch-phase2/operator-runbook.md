# Reports and updates: operation and release

## Staff workflow

Open Reports from a folder, Daily reports from Digest, or Published-record alerts from Settings. Capability `legiwatch_reports_updates_v1` must be explicitly enabled for the workspace. Current membership and live folder permissions apply to every request and background run.

An admin promotes staged reports and distribution aliases from Import review. The six captured reports remain separate, including both Tech Reports. Promotion keeps source evidence inactive and links a new draft object; repeat promotion preserves staff edits. Reports do not acquire recipients by name. Review aliases, verification, suppression and private list membership in Contacts & lists.

Generate a report using the selected cutoff and audience. External output excludes private comments. Download report saves self-contained HTML; Print / save PDF opens the browser print workflow. No automated PDF attachment or public report URL is created. The report explains that current title/status reflect the source at generation while dated actions honor the cutoff.

Review delivery freezes the subject, introduction and resolved destination list alongside the exact external report. Select Copy me explicitly if wanted. Approve and queue uses the displayed composition hash. To and Bcc use isolated envelopes; provider acceptance is shown separately from confirmed inbox delivery. `legiwatch_report_delivery_v1` must also be enabled.

Daily schedules save disabled by default. Choose an IANA timezone and local cutoff; new schedules default to draft and skip no-change mail. Activation establishes a baseline. Automatic send requires a separate explicit confirmation, reviewed recipients and complete current canonical source coverage. Resume uses either from-now or one catch-up draft. Run now creates a draft and does not consume the automatic window. A held occurrence blocks later window advancement until reviewed/retried.

Published-record rules require exact mapped folders, current owner/staff and reviewed email/in-app channels. The other captured alert families remain staged. Empty or unresolved definitions stay visible and inactive. Activate from now baselines known records; newly added folder memberships have their own baseline. Client-associated staff email also honors current address, email opt-in, jurisdiction and matching realtime/daily preference. Quiet hours defer dispatch. SMS is not enabled.

## Source and timing policy

Five days means cutoff plus four previous legislative calendar dates. Last-three actions preserve source order within the selected final three. Incremental windows use first observation and keep original legislative dates; normal execution ends at the intended cutoff even if a worker wakes later. DST gaps move to the next valid local minute, folds run once. Missed local dates produce one catch-up draft unless the subscription explicitly chooses sending.

Canonical checks must have succeeded within 24 hours and include required fields. Missing optional committee/relation data is explicit and requires opt-in acknowledgement; it is not manufactured. Send activation first verifies a full current baseline to prevent historical ingestion becoming a new-event broadcast.

The existing `sync-legiscan-bills` API drain supports `LEGISCAN_REPORT_REFRESH_TENANT=<one UUID>`. It queues stale/failed bills from that tenant's active, mapped canonical folders, using their existing state/session cursors. It preserves existing pending IDs and the shared quota governor. Set this only on the qualified existing source-drain task, after checking no concurrent drain. It is not a second provider poller. The queue threshold is 18 hours; reports hold after 24 hours. HTTP health alone does not prove source coverage.

## Runtime ownership and deployment order

1. Record current main, API/Intel/vNext service task revisions and digests, applied migrations, Phase 1 flags/import health, source quota, and actual EventBridge targets. Snapshot these outside Git. Confirm no overlapping release.
2. Build API and Intel ARM64 images from the pushed reviewed SHA. Publish immutable SHA/digest references. Avoid the default CodeBuild buildspec or workflows that publish `latest` and force-deploy services before qualification.
3. Apply API migrations using the normal API migrate runtime, then Intel migrations using the fail-closed Intel migrate entrypoint. Both services share one database. Never use API admin-migrate, pre-resolve a failed migration, or deploy the whole Compute/CDK stack.
4. Roll API and Intel HTTP services to the immutable candidate, preserving unrelated task fields and checking health. Keep both Phase 2 flags off during deployment.
5. Register a scoped Intel worker with `task run-report-updates <tenant UUID>` and the correct DB/SES/internal-inbox configuration. `scripts/legiwatch-phase2-runtime-plan.mjs` prepares reviewable definitions from current snapshots; it makes no cloud writes. The new rate-five-minute EventBridge rule starts DISABLED. Keep `TRACKER_ALERTS_ENABLED=false` for draft qualification.
6. Upgrade the existing Intel emission and daily/weekly digest workers to the fenced runtime, preserving schedules, source eligibility and unrelated queues. The legacy detector currently targets API, not Intel; do not silently repoint it. The old Intel enableflag task's default command changes a hearing flag: never invoke it without the intended task override.
7. Update the existing hourly API source drain to its immutable image and reviewed tenant scope. Preserve its task command, queue, quota and schedule. Deploy vNext only after backend compatibility exists. Main merges may trigger vNext deployment automatically.
8. Enable only the approved workspace report capability, promote/review configurations as a current tenant admin and verify actual coverage. Enable subscriptions/rules individually after their review. Record the deployed due task invocation and resulting immutable run without an open UI.

The record worker additionally requires explicit `LEGIWATCH_RECORD_ALERT_SOURCE_TYPES=state_bill`, `TRACKER_ALERTS_ENABLED=true` and `tracker_owner_intel` before staff dispatch. Report delivery uses its separate feature flag. An empty record allowlist does not claim record deliveries. Preserve the existing `LEGIWATCH_EMIT_SOURCE_TYPES` legacy scope.

Use `REPORT_APP_ORIGIN=https://os.capiro.ai` for authenticated report/record links. Inbox writes go through the existing API internal endpoint and service secret. SES reuses `AWS_REGION_DEFAULT` and `TRACKER_ALERT_EMAIL_FROM`; verify sender identity and provider acknowledgement only with an authorized designated test recipient.

## Recovery, monitoring and rollback

Inspect per-subscription occurrence state, intended time, window, attempts, source issues, run hash, delivery state and per-destination outcome. Generation retries reuse an occurrence. A held retry creates an auditable draft revision without altering the old snapshot. Known provider rejection retries within five attempts. A sending lease that expires becomes uncertain and needs explicit provider reconciliation. Record a receipt for accepted submission, or a reason confirming no send before reusing the existing intent. Do not create a new intent merely to bypass uncertainty.

End-of-day record deliveries bundle compatible due records into batches of at most 50; original contributors remain in history. Inbox batches are bounded by content size, with an explicit excerpt/full-source link for an oversized individual record. Email retains full content. Separate cadences and distinct client report intents remain separate.

To pause Phase 2, disable its EventBridge rule, then disable the tenant's report-delivery and report-capability flags. Pause individual subscriptions/rules if only one workflow is affected. Current authorization and dispatch checks stop unsent work; ambiguous provider outcomes remain for reconciliation. Restore recorded HTTP/source/worker target revisions if rolling back code. Keep additive migrations and immutable history. Never clear old queues, reset legacy watermarks, delete imported folders or rewrite Prisma history.

Verify disable behavior with a synthetic queued occurrence, then verify Phase 1 folders and legacy workflows. Re-enable with an explicit baseline/resume choice. A real five-day pilot and achieved source-to-alert latency must be recorded separately from five simulated windows and nominal schedule intervals.
