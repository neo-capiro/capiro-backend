# Phase 8 operator runbook

## Controls

Tenant flags: `legiwatch_news_v1`, `legiwatch_florida_budget_v1`, `legiwatch_editorial_v1`. Existing folder/report owner gates still apply. Process controls: API `LEGIWATCH_NEWS_INGEST_ENABLED` and integer `LEGIWATCH_NEWS_DAILY_REQUEST_CAP`; RSS owner `LEGIWATCH_FISCAL_REFRESH_ENABLED`; report worker `LEGIWATCH_NEWS_MONITOR_ENABLED`, `LEGIWATCH_EDITORIAL_PREPARE_ENABLED`, `LEGIWATCH_EDITORIAL_SEND_ENABLED`. All new process controls default off, and an unset/zero news budget performs no monitoring request.

Workspace and Intel keep reciprocal internal base URLs and existing shared-secret authentication. No new sender, queue, IAM role, provider account or scheduler platform is required. The release package records the exact task/environment and schedule revisions. Inspect that current record before operating.

## Reviewed setup

1. Review `phase8-import-review.json` outside Git. It preserves the captured account, exact 38 expressions and five raw alert controls. Use News → Monitors & import to preview and stage; this has no send effects.
2. Review the 74-entry coverage checklist and the current account entitlement. Configure selected monitors with exact folder/client, query interpretation, fields and publisher domains. Activate from now. A successful old search is not authorization for historical delivery.
3. Import the hash-verified public source package with `pnpm --filter @capiro/api exec tsx scripts/sync-legiwatch-phase8.ts --manifest=/absolute/path/phase8-source-manifest.json` (dry run), then repeat with `--apply`. It retains exact original bytes and is replay-safe. It must run through the existing API source owner and its normal database credentials.
4. In Budget, track only reviewed client-relevant projects. A supplied public project table is not a saved client-project inventory. Changed original bytes trigger an extraction-review receipt; qualify the corrected source manifest before using it for outward briefing.
5. In Reports → Client briefings, choose a template, cutoff/timezone, exact source passages and original analysis. Prepare a private Workspace draft, edit it there, then preview the actual edited output. Source/context changes invalidate review. A new edition uses a new request key; retries use the original key.
6. Configure each imported alert family separately. Record every source-category inclusion/exclusion and its basis. Select current verified contacts, dictionary, days/timezone, no-change and source-gap policies. Saving pauses it. Activation is a separate exact-version review. Current email recipients are distinct from the client information scope.

## Scheduled execution and recovery

The report worker uses bounded monitor/configuration batches. Each monitor has a persistent pending window; successful pages are retained, failed pages retry. Do not reset a checkpoint to hide an outage. Each scheduled local day/configuration version owns one leased occurrence. Generated input/output is retained before calling Workspace, so retries do not overwrite authored edits. Inspect `intel_legiwatch_news_run`, `intel_legiwatch_editorial_occurrence` and configuration operational timestamps for actual execution evidence.

Preparation and sending remain separate. Failed source windows hold sending. Limited retained fields may be distributed only with the configured explicit policy and visible source gaps. A quiet day records skipped/held state; it does not fabricate substantive analysis. Outward delivery uses existing recipient isolation and immutable content. Treat provider-accepted, delivered, bounced and uncertain as distinct outcomes. Never blindly resend an uncertain attempt.

## Rollback

Pause the new monitor/configuration states and process controls first. Restore the exact previous scheduler states/targets and compatible service task definitions from the release baseline. Check active recordings before service replacement. Preserve all additive tables, source bytes, imports, manual edits, draft receipts, approved runs and delivery outcomes. Do not delete a migration or resolve a failed migration automatically. A source rollback cannot substitute an older revision under an already reviewed hash. Re-enable only after the current source, scope, audience and configuration have been reviewed.
