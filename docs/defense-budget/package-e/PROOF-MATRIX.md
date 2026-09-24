# Package E proof matrix

## Scope and evidence boundary

This document retains the source-tree and disposable-infrastructure proof from
2026-09-20 and adds the Package 0 release disposition from 2026-09-24. Package E
is merged and deployed dormant; no production ingestion is claimed or
authorized.

The current release-code baseline is
`4b118bc148df9ae168585ebd8ad0dd595cb6a230`: API task definition
`capiro-dev-api:439`, API digest
`sha256:2ac7524cde4e4dcdf01f0dcebda177a2c777a44bb313e2e28112205e27383e67`,
parked drain task definition `capiro-dev-defense-budget-ingestion-drain:27`, and
drain digest
`sha256:8ac2255706e08a74baa3e7cb7ec3021ba9f34841a76e52134aee9344b27be461`.
The drain manifest contains all 32 API layers as its exact prefix. Air Force
FY27 RDT&E Volume I remains excluded after its earlier deterministic failures.

## Executed source-tree and disposable-infrastructure proof

| Proof | Result |
| --- | --- |
| Immutable contract | 21/21 Jest tests passed. Covers canonical self-hash, strict schema, exact command/container, capiro-dev, revisioned task definition, archive/source binding, one worker, bounded attempts/time/resources/cost, exclusions, zero protected-write expectations, and presigned-reference refusal. |
| Controller behavior | 5/5 Jest tests passed. Covers valid–deterministic-failure–REVIEW–valid continuation, bounded transient retry with later-member progress, terminal-checkpoint adoption without reparse, refusal to resume an unknown operation, and a hard deadline race against a bridge that never resolves. |
| CLI/immutable delivery | 6/6 Jest tests passed. Covers preview default, version-pinned S3 GetObject, independent object SHA-256, invalid/mutable input refusal, exact and non-conflicting `us-east-1` region bindings, and exact ECS account/region/cluster/task-definition/image/resource attestation. |
| Bridge forwarding | 28/28 bridge tests passed, including exact governed execution identity on initial and replay handoff. |
| Archive cancellation | 2/2 S3 archive-read tests passed; the governed abort signal reaches the version-pinned GetObject call and a pre-aborted read performs no request. |
| Legacy/runtime regression | 39/39 affected adapter, parser-launcher/runtime, and outbox tests passed. The legacy global and exact-row claim SQL excludes rows reserved by an active manifest. |
| Type/schema/build | Package E targeted TypeScript passed; `@capiro/defense-api` typecheck passed; Prisma schema validation passed; `@capiro/api` build passed. |
| Fresh migration rehearsal | All 412 migrations, including current-main Hermes migrations followed by `20280920060000_governed_ingestion_manifest_v1`, applied successfully to new disposable database `ingestion_manifest_test_pkg_e_v3` at base `865ecec16a577459d5f3009d0ccda9453f539779`. The two subsequent current-main commits changed only the OpenStates event reconciler; after rebasing to `91b7a56ea1149f995bcebdb542fc1db54499adf2`, the migration timestamp guard passed again. |
| Real PostgreSQL matrix | 14/14 tests passed against `ingestion_manifest_test_pkg_e_v3` on disposable PostgreSQL in 91.112 seconds. |
| Real storage/parser path | The existing FY2024 Army R-2 Volume 1 BA1 source fixture passed through a versioned MinIO archive read, Package E controller, real bridge, real Python parser, fenced PostgreSQL persistence, and ingestion-only finalization. One selected row completed in 43.630 seconds; the full Jest invocation completed in 90.687 seconds. |

The final bounded Hermes review identified non-cooperative deadline waiting,
inconsistent region-variable precedence, and protocol-relative URL userinfo as
release blockers. The final tree closes each with regression coverage. Hermes
found no remaining blocker in atomic item/outbox ownership, stale-owner
fencing, or outbox due-time enforcement.

The local infrastructure was deliberately disposable. It is not evidence for a
future image digest or production source.

## Recovery and isolation scenarios

| # | Required behavior | Executed result | Remaining final-image work |
| ---: | --- | --- | --- |
| 1 | Older unlisted pending row is untouched. | Passed in real PostgreSQL. | Repeat smoke check using the qualified image. |
| 2 | Simultaneous controllers have one owner. | Passed in real PostgreSQL; one claim won and one reported busy. | None beyond final-image smoke. |
| 3 | Overlapping manifests cannot process the same row/source. | Passed in real PostgreSQL; registration refused with `ACTIVE_RESERVATION_CONFLICT`; partial unique indexes enforce the invariant. | Prove the deployed legacy worker also skips a reserved row. |
| 4 | Expiry recovers safely and fences a stale owner. | Passed in real PostgreSQL. A committed checkpoint was adopted, the stale generation could not persist/finalize, and candidate count remained one. Uncheckpointed loss became `uncertain`. | None beyond final-image smoke. |
| 5 | Work longer than the initial lease retains ownership. | Passed with a controller-driven slow bridge spanning the test lease; heartbeats renewed both item and outbox leases and a competitor stayed busy. | Observe at least one final-image parse and retain heartbeat/task telemetry. |
| 6 | Ambiguous task loss does not trigger a blind retry. | Passed for durable uncertainty and exact task-ID reconciliation. Start/resume records the ECS metadata-attested TaskARN. | ECS terminal-state reconciliation remains a deliberate read-only operator step, not an automated AWS lookup. Exercise it during final-image qualification. |
| 7 | Candidate commits before acknowledgement. | Passed in real PostgreSQL: exact operation/result correlation was adopted without reparsing or appending a second candidate. | Add a crash injection around a final-image parser task if qualification infrastructure supports it. |
| 8 | Transient failure is bounded while another member advances. | Passed in controller tests; retry ceiling/quarantine and later-member progress were asserted. | Final-image negative control. |
| 9 | Deterministic failure is isolated and later work completes. | Passed in controller tests with PASS → deterministic quarantine → REVIEW → PASS. | Final-image negative control. |
| 10 | Source, row, candidate, approval, or correction drift refuses stale execution. | Passed in real PostgreSQL for source hash, outbox state, candidate, active approval, and correction drift. | Capture production preview immediately before any future authorized start. |
| 11 | Stop prevents new work but preserves the in-flight owner. | Passed in real PostgreSQL; the owner could heartbeat and the next member remained pending. | Exercise controlled stop/resume during an authorized pilot, not by corrupting production state. |
| 12 | Execution is ingestion-only. | Passed through the real archive/bridge/parser path. No mutable source fetch, source registration/archive write, readiness, approval, correction, canonical promotion, or out-of-manifest enqueue was permitted; protected approval and promotion-audit counts were unchanged. | Repeat on the exact final image and retain before/after identities, including the protected approval snapshot. |
| 13 | Resume never invents a batch or repeats terminal extraction. | Passed in controller tests: unknown operation refused; persisted terminal evidence finalized without bridge invocation. | Exercise with the final CLI/image. |

## Release and production gates

| Gate | Status |
| --- | --- |
| Reviewed merge commit | Complete. Package E was reconciled through PR #1759; superseded PR #1716 is closed. Release hardening landed through PRs #1762 and #1763. |
| Post-merge ARM64 API/drain images and provenance | Complete for Package 0. Both images were built from exact release SHA `4b118bc148df9ae168585ebd8ad0dd595cb6a230`, pinned by digest, and the drain's API-layer prefix was verified. |
| Final-image isolated qualification | Release smoke complete for the representative immutable FY2024 Army R-2 source. Two independent revision-33 tasks plus the missing-credential negative control ran on the exact final drain digest; both positive reports passed the formal release verifier with identical substantive projections. This does not qualify the three proposed future first-batch members. |
| Dormant `capiro-dev` deployment | Complete. Both additive migrations applied, API revision 439 is stable, drain revision 27 is parked at `echo no-op-default-command`, and the ECS/EventBridge/Scheduler consumer audit found no drain or manifest activation. |
| Runnable manifest | Not available. The proposal has `qualificationOnly: true`, `executionAuthorized: false`, and no runnable members. The three proposed non-Air-Force sources still lack current-image qualification and existing lifecycle/outbox bindings. |
| Production pilot | Not authorized. No production batch task may be launched. |

## Truthful status

The current state is **engineering merged, exact images built, representative
release qualification passed, and dormant deployment complete; production
pilot not authorized**. The proposed first-batch sources still need their own
exact-source qualifications, lifecycle/outbox bindings, reviewed manifest and
explicit authorization before `ENGINEERING_COMPLETE_PILOT_AWAITING_AUTHORIZATION`
can be claimed.
