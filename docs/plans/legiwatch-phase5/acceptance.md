# Phase 5 acceptance record

## Required distinctions

Implemented, tested, deployed, enabled and client-accepted are separate states. The code and local provider/database/UI evidence are a release candidate. No Phase 5 shared service deployment, source-budget activation, recipient activation or outward message was performed by this execution before release approval.

| Gate                        | Candidate evidence                                                                                                                                                        | Remaining release proof                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 5A source correctness       | Same-total vote corrections retain member IDs/history; explicit/missing amendment disposition; exact document snapshots and extraction locators; published-action history | Pinned native API/sync image and approved source budgets                             |
| 5B event/source scope       | Exact event/jurisdiction/session/agenda boundaries, visible per-kind receipts, bounded event revisit; CHRG continuation, checkpoint lease and held-date tests             | Current source grant/agreement and production resolver scope                         |
| 5C reconciliation           | Immutable atomic runs/reviews, exact references, owner RLS, source-commit races, restoration staleness and fair maintenance                                               | Approved tenant enablement and operational heartbeat                                 |
| 5D Capiro brief             | Record-only generation, current client/folder/retained-observation checks, immutable edits, approved DOCX provenance and governed Meri reads                              | Deployed authenticated end-to-end client acceptance                                  |
| 5E corrections and delivery | Preserved earlier text, correction classifications, affected-recipient checks, stale-work holds, explicit daily composition and concurrent dedupe                         | Exact approved recipients/channels and provider acceptance proof                     |
| 5F release/design           | Local 368-test matrix; populated upgrade preserves legacy snapshots; real Florida/GovInfo/Meri samples; browser/Figma/DOCX visual evidence                                | Exact native images, drift-checked release/rollback plan and final external approval |

## Reproduction

Use disposable PostgreSQL named capiro, never a shared database. Set LEGIWATCH_PHASE5_TEST_DATABASE=disposable and a localhost DATABASE_URL. Generate both Prisma clients, build shared/core/auth dependencies, deploy API migrations before Intel, then run `node scripts/legiwatch-phase5-qualification.mjs`. JSON reports reject missing suites, skipped tests and an unexpectedly low count. Source/provider scripts require separate explicit credentials and bounded selected scope.

For the populated upgrade, start a second empty localhost PostgreSQL database with owner capiro_master, set LEGIWATCH_PHASE5_UPGRADE_DATABASE_URL to its distinct URL, and run `node scripts/legiwatch-phase5-upgrade.mjs`. It applies the Phase 4 migration subset, inserts synthetic legacy evidence, applies Phase 5 and verifies byte-for-byte preservation and default-ACL restrictions. Do not reuse the populated upgrade target for another run.

Local final matrix: API 173, Intel 26, core 51, orchestrator 64, web 54; 368 passed, zero failures/skips. This count is one matrix, not a sum of repeated runs. Earlier failed provider/test attempts are retained in the execution logs. Native outcomes and immutable image digests belong in the final sealed release manifest.

The Phase 4 dependency separately records native server endurance success and a still-active deployed browser endurance run at its latest checkpoint. Phase 5 does not change capture implementation or reclassify an unfinished capture as accepted. Live runtime must be checked immediately before any rollout.
