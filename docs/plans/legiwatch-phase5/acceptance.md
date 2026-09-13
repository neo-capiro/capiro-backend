# Phase 5 acceptance record

## Required distinctions

Implemented, tested, deployed, enabled and client-accepted are separate states. Phase 5 is implemented, qualified, merged through PR #1617 and deployed to capiro-dev after the user explicitly authorized release. All five services are healthy, 17 migrations applied, and 24 existing schedule targets updated. Phase 5 tenant features, document/event-revisit/reconciliation process gates and new recipient delivery remain off. Live client workflow acceptance and recipient activation are separate.

| Gate                        | Candidate evidence                                                                                                                                                        | Remaining release proof                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 5A source correctness       | Same-total vote corrections retain member IDs/history; explicit/missing amendment disposition; exact document snapshots and extraction locators; published-action history | Existing vote drain cap 25; optional document ingestion remains off      |
| 5B event/source scope       | Exact event/jurisdiction/session/agenda boundaries, visible per-kind receipts, bounded event revisit; CHRG continuation, checkpoint lease and held-date tests             | Current source grant/agreement and production resolver scope             |
| 5C reconciliation           | Immutable atomic runs/reviews, exact references, owner RLS, source-commit races, restoration staleness and fair maintenance                                               | Approved tenant enablement and operational heartbeat                     |
| 5D Capiro brief             | Record-only generation, current client/folder/retained-observation checks, immutable edits, approved DOCX provenance and governed Meri reads                              | Deployed authenticated end-to-end client acceptance                      |
| 5E corrections and delivery | Preserved earlier text, correction classifications, affected-recipient checks, stale-work holds, explicit daily composition and concurrent dedupe                         | Exact approved recipients/channels and provider acceptance proof         |
| 5F release/design           | Local 368-test matrix; populated upgrade preserves legacy snapshots; real Florida/GovInfo/Meri samples; browser/Figma/DOCX visual evidence                                | Release authorized and deployed; live tenant workflow acceptance remains |

## Reproduction

Use disposable PostgreSQL named capiro, never a shared database. Set LEGIWATCH_PHASE5_TEST_DATABASE=disposable and a localhost DATABASE_URL. Generate both Prisma clients, build shared/core/auth dependencies, deploy API migrations before Intel, then run `node scripts/legiwatch-phase5-qualification.mjs`. JSON reports reject missing suites, skipped tests and an unexpectedly low count. Source/provider scripts require separate explicit credentials and bounded selected scope.

For the populated upgrade, start a second empty localhost PostgreSQL database with owner capiro_master, set LEGIWATCH_PHASE5_UPGRADE_DATABASE_URL to its distinct URL, and run `node scripts/legiwatch-phase5-upgrade.mjs`. It applies the Phase 4 migration subset, inserts synthetic legacy evidence, applies Phase 5 and verifies byte-for-byte preservation and default-ACL restrictions. Do not reuse the populated upgrade target for another run.

Local final matrix: API 173, Intel 26, core 51, orchestrator 64, web 54; 368 passed, zero failures/skips. This count is one matrix, not a sum of repeated runs. Earlier failed provider/test attempts are retained in the execution logs. Native outcomes and immutable image digests belong in the final sealed release manifest.

The Phase 4 dependency records native server endurance success. Its owned deployed browser recording completed the planned 250-minute run, scheduled assembly and fresh-page playback, with 14,987,180 ms decoded audio, no page errors and exit zero. Phase 5 waited for a fresh capture-clear check before migrations or service replacement. This does not establish broader Phase 4 source/client acceptance.

## Qualification and deployed evidence

- Image source `97c30ac4230bd52ec08ffb57198220eaf1045b7c`; five Linux ARM64 digests are listed in the engineering note. Later review commits change documentation only.
- Native Phase 5 matrix: 368 passed, zero failures/skips. Native Phase 4: 226 passed. Earlier broad regression: 2,724 passed. These scopes overlap.
- Final actual-image verification `capiro-build-intel-api:b939b39d-66b7-4f91-b91b-21af50bc2929`: SUCCEEDED; API/Intel entrypoint migrations, four compiled backend/native database probes and web HTTP 200 passed. Populated upgrade preserved two source records and one unofficial publication exactly across 435 migrations.
- Complete record-only workflow used the existing live Meri route, synthetic private client and actual review/Document/retrieval services. One private document resulted from concurrent saves; current-access withdrawal checks passed. It is not deployed S3/Clerk client acceptance.
- 22 desktop/narrow browser states, seven Figma frames and the generated reviewed DOCX/PDF were inspected. The long hash wrap correction passed both widths.
- Ten provider atomic claims had zero false support/contradiction and one pending-records/not-addressed label disagreement. Coverage remains explicitly bounded; no universal accuracy or complete minutes claim.
- Execution plan SHA-256 `3a491af2b7e1be1f9a620f4bc7f8d65733a873b1a9bd7661f1cde780bc1bc4c4`: five services, 19 registered task variants, 24 preserved rules, 17 new migrations, one exact-secret IAM policy and two credential injections. It supersedes preparation seal `5a82ddabdd1a3db0d0c13ed1bf4e10c68eed2cfde829a8fdebc75a8e645fcdd6` only by correcting existing release-identity fields in 14 task variants. Images and product controls are unchanged.
- Deployed task revisions: API 337, Engagement 89, Intel 36, Meri 48, web 277. Every service is stable with expected running count, healthy ALB targets and matching pinned image digests. Both migration tasks exited zero; all 17 Phase 5 migrations and nine immutable ACLs were verified. The post-migration source-boundary audit found no missing observations for new snapshots.
- Public web health/source SHA, authenticated existing hearings/API clients (200), authenticated disabled Phase 5 records (404) and unauthenticated records (401) passed. The created Clerk verification session was revoked. These checks establish deployed routing and access gates; tenant-specific generation/save/export acceptance remains unperformed.
- The repository architecture guard and 89 additional Context Plane/retrieval tests passed before the normal merges of PR #1616 and #1617.

GitHub jobs remain failed because the account billing gate prevented startup. The supplemental/final image-build jobs remain failed at S3 evidence archiving after successful test/image stages. Their logs and the separate successful native image verification are preserved in the evidence package. Shared deployment is complete. Phase 5 feature/recipient activation, real client workflow acceptance and outward messages were not performed.
