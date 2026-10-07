# Planner personal sections and activity release

Status: live and verified. Strategies revision 34 and web-vNext revision 443 are stable with one healthy task each and completed deployments. The public web runtime configuration reports the corrected source. This continues the live core recorded in [RELEASE-20261006.md](RELEASE-20261006.md). Full parity remains open in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Changes

- Private My Tasks sections, names, section order, per-task placement and task ordering. List selection and board moves update only an owner-only settings resource. Shared project membership/status/version is unchanged. Reassignment removes placements from the previous owner's visible settings. Settings require the expected resource version.
- Paginated task/project activity and active/archived inbox. Database cursors retain timestamp precision and break timestamp ties by identity. Older updates remain reachable after intervening new activity and after an entire page's grants are revoked. Legacy array API callers remain supported.
- Public/internal form input handlers capture values before React defers state updates. A live public-form input check exposed a null `currentTarget` access; the new regression batches text, paragraph, choice, date and numeric input before submitting. A different capability resets the draft and submission state.

No migration, IAM, canonical API, authentication or routing changes are required. Existing Planner tables store the private configuration. This release stays on the signed-in organization and preserves the approved integration choices.

## Validation

21 real PostgreSQL checks passed, including cursor ordering, revoked inbox pages, private settings, reassignment and stale writes. The routing/core API run passed 61 checks; resource validation passed eight checks. Seventeen focused web checks passed, including public input and cross-capability draft isolation. Strategies/shared/web typechecks and production builds passed, including the corrected production web image. Synthetic browser checks passed list placement, section rename and the private board. The local Vite prebundle required rebuilding after the shared contract changed; the rebuilt fixture renders correctly.

## Immutable images

- Strategies source `cba98ec5f9d16bd4c1bd2b0f2cd3bd530ccc982e`, ARM64 image `capiro/dev/api-strategy@sha256:3567fd0991befeb18dac6b641d0271b166b2c85c0cfb1d048886baf76d69ea58`, task revision 34, CodeBuild `capiro-build-web-dev:3408c420-c169-442b-9865-13d9cd7d228b`. Startup and health passed. Legacy web consumers loaded/restored a task and its array activity successfully during the rollout.
- Corrected web source `10b6387a06a9f9c282b702639a189e6f9b616814`, ARM64 image `capiro/dev/web-vnext@sha256:c5cff486565df271fb33375d57527410156b153bf44e8313b660bae842a65933`, task revision 443, CodeBuild `capiro-build-web-dev:97846ee2-c2df-43dc-8860-0b0cf4c2c633`. The earlier `cba98ec5` web image was superseded before promotion.

Builds used exact-source per-build overrides of the existing ARM project, without changing its configuration or IAM role. Task definitions were cloned from Strategies 33 and web-vNext 442; only immutable images and release identifiers changed. No migration tasks or canonical service releases ran.

The promotion preserved concurrent work, cloned only the existing Strategies and web-vNext definitions, and changed only their immutable images/release identifiers. Strategies was promoted before web-vNext. The concurrent Meri web release moved the baseline to revision 442 (`d6efc8adc9ce841b0639bd03b7b2a6977858ede9`); its code and release documentation are merged into this branch. Later Meri V2 auditor and release-document changes are also merged; neither promoted runtime consumes that auditor module. Rollback restores Strategies revision 33 and web-vNext revision 442 unless a newer concurrent baseline must be retained; keep private settings and work records.

## Live verification and cleanup

Signed-in verification passed private list placement, private board columns, section rename and reload persistence. Moving the synthetic task left its shared project section at To do. Existing comments, time entries and attachments remained visible in paginated task activity, and the legacy array consumer loaded successfully during the Strategies-first rollout.

Anonymous intake passed text and paragraph input, submission receipt, and the resulting signed-in task contents after the input-handler fix. Revoking the capability immediately closed the public form on reload. Both short-lived synthetic capabilities are revoked; the form is archived.

The private QA project `ef8a32db-0748-4b52-8655-0fd5f8fd554c` and the two restored/created tasks `7bf3caf1-78fa-4807-9575-506a1d15a133` and `645d6895-76f2-46d2-8e02-98105f849c0a` are recoverably archived. The older synthetic subtask and internal intake task remain archived. Temporary private section names were restored to Today, Upcoming and Later; the restored task was moved back to Recently assigned before archive. The Dashboard Work Queue and Planner My Tasks are clear of this synthetic work. Canonical client/meeting records were not edited and no colleagues were notified.

Browser evidence: `artifacts/planner/live-my-tasks-qa.png` records the populated private board before cleanup.
