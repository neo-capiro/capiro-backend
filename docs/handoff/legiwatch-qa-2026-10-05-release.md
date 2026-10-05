# LegiWatch October 5 release qualification

Release requested by the repository owner: resolve the October 4 QA findings, merge and ship. Codex performed the code review, source-data review and operational checks under that instruction; this record does not claim a separate human review.

## Candidate provenance

| Component | Source commit | Immutable image digest | CodeBuild build ID |
| --- | --- | --- | --- |
| API | `ccd28769dc6e3b055a0b22ff19b6935f90186b4d` | `sha256:0405969bac71567bbd2d3e4d21d0ad10d804dc1c813252dbc875970dfa76db30` | `e64937b9-7c94-40e4-a8c6-2b7bb3b44c74` |
| Intelligence API | `850587f5ea8c38d591338d691f3a1b4d15d87f5d` | `sha256:56307cfc9e2b56d285aaaca1ccab56a6db8d4b255fffe011162351109970eb8e` | `d95a65bb-df7e-4ba0-984c-96cb02bbd5b1` |
| Web | `ccd28769dc6e3b055a0b22ff19b6935f90186b4d` | `sha256:dceaf24b6652e9262adc7b83f2c89c423ca896d1c50062491bfcfbd66e3275b7` | `86d13245-0299-47e3-be7d-3d72b2f9c7cb` |

All images are ARM64 and published only under their immutable source tag. Local image digests matched ECR readback. API packaging also exercised the existing Meri save-memory/native-runtime checks and imports the official-hearing repair script. Intelligence imports and the web Nginx configuration passed their packaged checks. Build jobs did not update production services or mutable tags.

The full LegiWatch workflow **passed** at test commit `5895a396abd2684e4e6ec3ebc5843d3edcbbe386` in CodeBuild project `capiro-build-web-dev`, build `e5a16d4d-ed02-4e3d-b311-3726f5f19bcd`. GitHub Actions did not start jobs, so it is not represented as passing. The test commit differs from the API/web image commit only in two database test fixtures: exact numeric official IDs replace artificial prefixed IDs, and the detail fixture expects the official directory name. The intelligence component is unchanged between its image commit and the tested commit; the intervening API change only refines the maintenance repair script and its test.

The completed scope includes API 121 suites / 1,438 tests, intelligence API 84 suites / 1,124 tests and web 323 suites / 1,112 tests, all with zero failures, skips or todos. Additional Phase 4 and Phase 5 recording, document, source revision and private-delivery qualification passed their independent floors, as did the disposable PostgreSQL migration, folder, report and calendar workflows. The final marker was `LEGIWATCH_COMPLETE_CI_QUALIFICATION_PASS` at 19:36 UTC. Sanitized pass markers are retained in [the qualification record](legiwatch-qa-2026-10-05-qualification.json).

## Schema and retirement compatibility

No migration is added or changed relative to the currently serving API source `be4d886ffa774f72e0ed5c5268995109cbd11220`. All 454 source migration identities are already present in the live completed ledger, with no unfinished migration. The live ledger retains older/retired migration history and historical checksum differences; this release neither rewrites that ledger nor runs migrations. Those differences are inherited unchanged from the serving source. The two latest Krisp and XLSX migrations were independently confirmed complete. The qualification workflow rehearses the current migration chain on disposable PostgreSQL databases.

The API and web candidate include the serving `be4d886ff` source, and the intelligence candidate includes the serving `fc8133d50` source. Existing flags, roles, secrets, networking and scaling are preserved by `scripts/meri-release.mjs`. Full qualification passed. Fresh pre-promotion snapshots confirmed healthy API, intelligence API and web tasks and load-balancer targets.

## Completed data repairs

- The seven unexpected alert organizations are archived clients, not foreign-tenant clients. The audited tenant has 15 active and 44 archived clients. Uppercase UUIDs caused the historical L3 attribution. Six reviewed legal-defense keyword false positives were suppressed with retained before-images and correction evidence.
- 169 Florida notice observations were linked to unique official 2026 directory identities. Forty ambiguous/unmatched observations remain unresolved. Commerce now visibly has seven proceedings, 73 agenda items and seven published documents. The February 10 detail visibly contains 13 agenda items and 12 bill links.
- All 13 retained official versions for HB 1211, SB 474 and SB 7002 were extracted completely from their first-party PDF/HTML sources. A quota-held LegiScan request and a failed bounded inventory refresh were not substituted for successful retrieval. Provenance explicitly identifies the Florida Legislature.
- Thirteen federal source observations across eight distinct numbered-event pairs were reassigned to their correct events; titles, times, committee identities and closed-session visibility were restored. A post-repair read found zero remaining numeric source/event-ID conflicts.
- Eleven media candidates moved using exact official event URLs or an exclusive retained source identity. Shared committee/day media URLs and existing capture artifacts were not guessed or reassigned.
- The Ukraine briefing's Senate alias now resolves to its existing Joint canonical event. Both terminal no-stream capture records, completed/exhausted jobs and calendar histories remain intact. No transcript or capture artifacts existed on either alias side. The hash-bound integration moved only source observations, media candidates and publication updates.
- The standard state-status derivation completed with 427 updated records, 75,901 unchanged and zero errors. Florida now has 201 superseded bills. Authenticated live HB 1211 visibly shows Superseded, March 9, 2026 and the recorded referral to CS/SB 474; the incorrect Committee action next step is absent.

The five hearing-import schedules were paused only for the atomic identity repairs and restored to their prior enabled state. Raw tenant inventories, before-images, task definitions and receipts are retained privately outside the repository.

## Deployment and acceptance

At qualification time, guarded promotion, scheduled-consumer updates and final authenticated live acceptance had not yet run. Their operator receipts and subsequent PR release report supply the deployment result. The reviewed scheduled-consumer plan pins eleven rules to the qualified images and corrects the Florida calendar's obsolete container/command override to `api` running `legiwatch-phase9-job florida-calendar`. Readback also found the Florida runtime owner disabled despite its enabled EventBridge rule. The separately reviewed configuration change enables only that bounded calendar job and records its existing rule/family; it retains the ten-minute cadence and excludes archive work. No external notification delivery gate or IAM permission is expanded.
