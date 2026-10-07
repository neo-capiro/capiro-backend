# Optional preparation review timeout preservation

[PR #2173](https://github.com/neo-capiro/capirov2/pull/2173), feature source `6ab537d0498db8a94fb97e02e1d1e509f679488f`, includes the shared transport's provider-timeout message in the existing optional-refinement fallback. A valid draft may be retained with an explicit limitation after either provider times out, while an aborted job, expired absolute deadline, changed source/assignment, or lost lease still rejects persistence.

This is one production-line change plus two test cases. All 26 comprehensive-preparation tests pass, including both provider timeout prefixes, cancellation, scope/lease rejection, bounded extraction retries, original stage budgets, encrypted checkpoint resume, and oversized repairs. The native ARM64 packaged probe also exercises a timeout after a valid draft, alongside the earlier HTML-response and 400-omission cases. Exact packaged migrations must remain identical to source.

Full API TypeScript checking passed with an 8 GiB heap. The exact native ARM64 candidate build succeeded, including the packaged timeout/transport/oversized-repair behavior probes and migration parity. PR #2173 is merged. The affected live preparation completed and was read back successfully at 03:07:30 UTC on October 7, before this final worker promotion.

Only the engagement worker is deployed for this final refinement. Source inspection shows that `MeetingPrepJobService.process` is the only production caller establishing `withMeetingPrepExecution`, which comprehensive preparation requires. API 640 already has the prior bounded-repair and transport-retry fixes and retains its healthy deployed image. No browser, schema, credential, flag, notetaker, debrief, client-association, or C2 direct-copy behavior changes.

The candidate changes only the two tested files over worker 141/source `601c7b45476e8efdd2c34172ba2de25c88dc8631`. The exact feature blobs and unchanged migrations are checked before building. Review is by the Codex release agent under the user's explicit authorization to merge and ship to AWS. Promotion uses the guarded operator and waits for the current meeting preparation to finish, preserving the active run. Build success alone is not rollout acceptance.

## Production readback

The guarded promotion completed successfully on October 7 at approximately 03:17 UTC. Worker task definition 143 runs source `ae744c83829394dd745cf7accc413ae518ae695c` and immutable digest `sha256:3fd622817ff025e0c35762554f487125aeca02574ba7ddeb590fc64a1611ff5d`. Both desired tasks are healthy; the deployment is completed, their application startup logs contain no dependency/module failures, and the operator verified exact task/configuration hashes and their ALB target health. API 640 was not redeployed for this final change.

Application acceptance for the actual meeting is the successful normal-service recovery/readback recorded in `../meeting-prep-retry/meeting-recovery.json`, completed on worker 141 before this promotion. The only further behavior, preserving an existing draft on the shared transport's provider-timeout message, was verified in the exact candidate's packaged behavior probe. A second paid generation was not run solely to repeat that acceptance, and no authenticated browser check is claimed.
