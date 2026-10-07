# Meeting preparation transport retry qualification

After the bounded-repair fix was deployed (worker 139, API 638), the live standard-depth retry completed eight extraction batches and failed before synthesis. Its worker log at 02:25:32 UTC on October 7 records OpenAI returning an HTML document instead of a JSON response envelope. This is a distinct transport failure, not the original oversized repair. The initial live retry is recorded as failed; deployment alone was not claimed as successful artifact recovery.

[PR #2169](https://github.com/neo-capiro/capirov2/pull/2169), feature source `66f2b85ab4e8d4aa39f597147c9d20f7a968b44f`, retries that failed extraction request once. The retry shares the original stage deadline, recomputes the job's remaining time reserve, and rechecks the actor, assignment, runtime policy, and worker lease through the normal checkpoint. It does not reset the whole workflow or extend the absolute job deadline. Other generation stages keep their existing attempt limits; source-access/lease errors, cancellation, and non-transport errors do not enter this retry path.

Validation: 40 comprehensive-preparation and shared-transport tests passed. Fault injection exercises a non-JSON HTML response through the actual `LlmCompletionService`, successful recovery, the two-attempt limit, access revocation before retry, and a checkpoint consuming the original stage budget. Full API TypeScript checking passed with an 8 GiB heap. The original bounded-repair release had separately passed 66 preparation/persistence/source-access tests.

Each release candidate changes only the two tested comprehensive-preparation source/test files over its exact deployed baseline (worker 139/source `1c980e25407bed85270c313fc0e1bfc6b02c613a`, API 638/source `250fcab8fdc8e051d52000c9d25a091d9d99936a`). Exact blob equality is checked against the tested feature commit. Schemas, migrations, native capture, C2's direct Krisp flow, other tenant flows, flags, credentials, runtime ownership, and client assignment are unchanged.

Native ARM64 build records and network-disabled packaged behavior probes are recorded alongside this report as they complete. The packaged probe covers both the previous 400-omission repair case and the HTML-response retry through the actual shared transport. Exact packaged migration names/checksums must match source. Guarded promotion, exact task/image health readback, and application-scoped recovery acceptance remain required.

Review is by the Codex release agent under the user's explicit authorization to merge and ship to AWS, without a claim of separate human review. The recovery must resume the existing failed job through `MeetingPrepJobService.resume` when its original deadline permits, reusing only checkpoints whose source/model/policy hashes still match. A completed prep must be readable through `EngagementService.getMeeting` before success is reported.

## Deployed follow-up

Both native ARM64 builds succeeded, with `PREP_TRANSPORT_RETRY_PASS`, the earlier oversized-repair behavioral probe, and exact packaged migration parity. The guarded operator promoted worker 141 and API 640, verified their immutable image digests and task/configuration hashes, and confirmed both desired instances and healthy ALB targets. Startup checks found no module or dependency errors.

At 02:47:26 UTC the normal job service resumed the failed job under its original tenant/actor scope. The original deadline of 03:20:47 UTC was retained. Eight saved extraction batches remained available, and the resumed worker advanced to ten completed batches by 02:49:26 UTC. The recovery observer tracks extraction and draft checkpoints and verifies the final artifact through the meeting-detail service; a running job alone is not final acceptance.
