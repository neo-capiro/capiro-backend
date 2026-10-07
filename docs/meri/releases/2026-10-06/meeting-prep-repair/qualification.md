# Meeting preparation repair qualification

Production investigation for RT | Capiro Onboarding (October 6, 2–3 PM Eastern) found three failed standard-depth preparation jobs. The most recent ran for 21 minutes 49 seconds. CloudWatch shows a completed initial synthesis followed by 155 reported omissions, then `meeting_prep_model_context_budget_exceeded` before a repair request could run. Provider fallback repeated expensive work, and the public failure classifier incorrectly labeled the context limit as a deadline despite time remaining. No preparation artifact was saved.

[PR #2163](https://github.com/neo-capiro/capirov2/pull/2163), feature source `530ebf6d5f4a8d7e73c283afda77f71c559bfa34`, bounds the entire repair and review payload, including the previous draft and feedback. Later passes use compact fact projections while full quotes and source metadata remain in the saved evidence ledger. Valid drafts are checkpointed with encryption and an input hash and survive optional model-refinement failure with an explicit limitation. Coverage review uses medium reasoning; synthesis keeps its configured model and reasoning. Context errors have their own public classification.

Cancellation, membership/client/source access, assignment changes, runtime action policy, worker lease fencing, and the absolute job deadline continue to prevent unauthorized persistence. C2 Strategies' direct Krisp notes/debrief path, other tenants' generated flow, native Meri capture, schemas, feature flags, client assignments, and existing artifacts are unchanged.

Validation:

- 28 comprehensive preparation and durable job tests passed, including 400 omissions within the whole-request budget, optional provider failure, checkpoint resume, cancellation, scope/lease failures, and public error classification.
- 38 persistence, source-access, and evidence tests passed.
- Full API TypeScript checks passed with an 8 GiB heap; build-isolation validation and whitespace checks passed.
- Both candidate trees contain exactly the four tested source/test files over their currently deployed baselines. Every changed blob matches the feature commit; schemas and migrations are identical to each baseline.

The worker baseline is revision 137/source `786e4d4940bcddc6c48d31f112c69d82275529ae`. The API baseline is revision 636/source `ca8c114efcfcdd1a536ec55b140d4d6732d9933a`, preserving newer unrelated releases. Exact candidate sources, immutable images, native ARM64 build results, packaged behavior probes, and migration parity results are recorded alongside this report when completed. A build does not by itself constitute deployment acceptance.

Release review is performed by the Codex release agent under the user's explicit authorization to merge and ship to AWS. This does not claim a separate human review. Guarded one-service preparation, promotion, exact task/image readback, and healthy ALB targets are required. Recovery must use the normal tenant/actor-scoped job service, preserve deadlines and authorization, and verify the completed prep through the real meeting-detail service before reporting success.

## Deployed backend

Both native ARM64 CodeBuild builds succeeded, including a network-disabled behavioral probe that processes 400 omissions without exceeding the complete request budget, preserves source quotes, checkpoints a valid draft, and returns that draft when optional review fails. The probe also verifies C2 direct-copy versus other-tenant generation mode. All packaged migration names and checksums match each candidate's source tree.

The guarded operator promoted engagement worker revision 139 and API revision 638. It verified the exact image digests, task/configuration hashes, desired counts, and healthy ALB targets. Both instances of each service started successfully without dependency or module errors. Runtime ownership, provider configuration, flags, networking, secrets, and scaling settings were preserved.

The failed job's absolute deadline was not extended. Once the worker rollout finished, the normal `MeetingPrepJobService.submit` created a fresh standard-depth job for the original tenant, actor, meeting, and focus; its idempotency key prevents duplicate operator submission. Application authorization remains in force throughout generation and persistence. The isolated recovery task monitors this job and will verify the saved prep through `EngagementService.getMeeting`; generation is not yet accepted merely because deployment succeeded.

The separate automatic-notetaker record for this meeting ended without a recording or transcript. That historical capture is not represented as repaired by the preparation fix, and no substitute meeting notes or debrief were fabricated.

## Live retry finding

The first live retry failed at 02:26:38 UTC after eight completed extraction batches, before synthesis. The worker log shows OpenAI returning an HTML document instead of JSON at 02:25:32 UTC; the no-retry transport policy then fell back to another provider and the job ultimately failed. This run does not validate artifact recovery. The separate transport fix and subsequent acceptance are tracked in [meeting-prep-retry/qualification.md](../meeting-prep-retry/qualification.md).
