# Phase 5 operator runbook

## Owners and safe activation order

API owns public record ingestion, existing provider drains, GovInfo transcript sync, approved Documents and inbox persistence. The separate Engagement API serves attachment reads and outbound attachment resolution; its image must include the current private-brief access checks while preserving its serve-only entrypoint and runtime policy. Intel owns private reconciliation/brief/review/delivery context and the existing hearing/report worker. Meri remains the registered request-scoped reasoning owner. Web adds views inside the existing hearing detail, bill context, folders, Documents and reports.

Before release, refresh main/Phase 4 PR state, all affected running task revisions/digests, source and worker schedules, migration failures, active captures, pending deliveries and source/recipient grants. Compare against the sealed release manifest. Stop for drift affecting those facts; do not overwrite intervening deployments or interrupt a retained recording. Preserve the later main meeting-preparation fix and Phase 4 combined-panel/quote/progress repairs.

Build and qualify immutable native ARM64 images from the exact pushed source. API migrations run first, Intel second, as the established master owner. Rehearse clean and populated upgrades before using the shared migration task. Roll out the API/Engagement API/Intel/Meri/web candidate in a compatible sequence with Phase 5 flags and outbound gates off. Repoint existing sync/worker task families only to compatible pinned images; do not add another provider poller, schedule or messaging vendor.

Enable the published-record read feature for an explicitly approved tenant, then reconciliation/brief generation. Validate an exact record-only event, source locators, client/folder boundaries, current/as-of Meri reads and approved DOCX save/export. Only after source freshness, worker health and explicit audience approval should record delivery be enabled. Correction recipients must remain eligible and tied to the preserved earlier delivery. Never use an operational test to send to unapproved client recipients.

The Engagement deployment config supports `publishedRecordRead.internalServiceSecretArn`, using the same exact internal service secret as API/Intel and listing it in `requiredSecretArns`. Synthesis grants that secret to the execution role and injects `INTERNAL_SERVICE_SECRET`; it changes no Engagement promotion or outward-action controls. Without this credential, private brief attachment reads fail closed. Preserve this explicit config in the deployment owner to prevent a later CDK release from removing it.

## Budgets and freshness

LEGISCAN_VOTE_REFRESH_CAP has a code default of 200 details per drain, capped at 1000; this deployed release explicitly sets 25. LEGISCAN_DOCUMENT_EVIDENCE_ENABLED defaults off; its document cap defaults to 10 and is bounded at 100. The existing monthly provider quota still governs all calls. Same bill hash plus fresh detail skips work; equal vote totals do not skip a due content check.

An explicit event refresh coalesces with the existing bill queue and event watch. Up to 100 agenda bills are selected, with a three-hour coalescing interval and a 30-day watch window. Unavailable evidence remains pending/failed/partial; expiration of a revisit window never establishes that an action did not happen.

GovInfo uses a per-congress/year lease, bounded package/page work, safe continuation and a frozen modified-since window with 48-hour overlap. The default package budget is 25, capped at 100; the default page budget is three. Check the dedicated checkpoint and transcript-check receipt after failures. A changed package appends content/extraction evidence; a restored old version appends a source observation. Do not clear checkpoints to force an unbounded rescan.

LEGIWATCH_RECORD_RECONCILIATION_ENABLED defaults off. Existing hearing maintenance selects 25 least-recently-scanned owners, five event snapshots per owner and at most two retry jobs per owner. New work waits for a two-minute committed-source debounce. Leases renew during long work, expire after three minutes and stop automatic retry after five attempts. Review/source freshness for outward composition is 24 hours. Reapproval is explicit; unsent obsolete work is held rather than silently replaced.

## Inspection and rollback

Review the immutable state_bill_published_record and official_hearing_transcript_revision ledgers alongside published_record_source_current. Inspect state bill document/vote receipts and official_hearing_transcript_check separately from claim outcomes. Intel history exposes paged runs, briefs and jobs; delivery history exposes sanitized current states and failures. Use exact event, actor, client and content/source hashes when investigating.

For a delivery incident, turn off only the new record delivery process gates and tenant feature. Hold affected unsent record_brief/record_correction work and explicit daily compositions that contain it. Keep delivered/unknown receipts and immutable bodies. Do not retry uncertain provider outcomes automatically and do not stop unrelated capture or report kinds.

For a code rollback, restore the previously pinned compatible images/task definitions after checking capture state. Keep additive migrations and immutable rows. Reverting to an API/sync writer predating the source-observation contract while new canonical source checking remains active is unsafe: suspend the affected source budget or keep the compatible source writer. Do not delete history, edit the migration ledger, expand source grants or replay imported bill events as a rollback shortcut.

The final deployment package contains source/image hashes, exact task and environment deltas, existing schedule targets, preflight checks, migration order, rollout verification and conditional reverse task-definition changes. Use the execution receipts as the applied state; the nested implementation package preserves historical preparation evidence.

## Deployed release scope — September 13, 2026

The executed `release/plan.json` seal is `3a491af2b7e1be1f9a620f4bc7f8d65733a873b1a9bd7661f1cde780bc1bc4c4`. Compared with approved preparation seal `5a82ddabdd1a3db0d0c13ed1bf4e10c68eed2cfde829a8fdebc75a8e645fcdd6`, only existing release-identity fields in 14 task variants were corrected to the qualified image source. All 19 task variants were registered in account 967807252336 / us-east-1 / capiro-dev. Five services, 24 existing rule targets and API-then-Intel migrations are deployed, with Phase 5 tenant features and new outward gates off. Engagement received the exact existing internal service secret and one scoped execution-role policy; the reports worker received the existing hearing encryption secret under its already-authorized role. No CodeBuild S3 permission was changed.

Use the engineering note's exact source/digests and execution seal. Task revisions are API 337, Engagement 89, Intel 36, Meri 48 and web 277. The API migration task 116 and Intel migration task 8 exited zero; all 17 migrations and nine immutable relation ACLs were verified. All service targets are healthy and runtime digests match. Existing schedules retain their prior state/cadence/input/network/role. The deployed read checks passed (existing hearings/clients 200, disabled Phase 5 404, unauthenticated 401); the created Clerk session was revoked.

PR #1616 and #1617 merged normally after the user authorized shipping. The Phase 4 owned browser endurance fixture completed, and fresh read-only capture checks preceded every runtime mutation. Native image verification succeeded; GitHub checks remain failed under the billing gate, without relabeling or a protection bypass. After Phase 5 private Documents exist, retain compatible API/Engagement access guards during rollback. The source-boundary check found zero new snapshots lacking source observations as of 10:36:39 UTC; future rollback decisions require a fresh audit. Tenant activation and exact-recipient delivery acceptance remain separate operational scopes.
