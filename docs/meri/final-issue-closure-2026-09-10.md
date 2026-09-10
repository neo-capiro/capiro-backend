# Meri undocked workspace: final issue completion

**Current closeout status:** See [September 10 execution continuation](closeout-execution-continuation-2026-09-10.md) for the refreshed main, CI investigations, verified running images, repairs, and separate MW-01–MW-15 release/acceptance ledger. The observations below are historical; final release and operational acceptance remain open.

## Scope and baseline

Original findings: MW-01 through MW-15 from the September 9 live QA. Phases 0–1 merged in PR #1552; phases 2–4 merged in PR #1557. This change is based on main `2dc38493c540a98bd755d9d150c277f3b22b66ec` and completes the remaining PDF implementation, document reopening, release build repairs, and recovery of evidence for historical memory corrections.

Concurrent main `c27222b1c5fea2b6279791e703451e18278a8cbb` was integrated before handoff. Its LegiWatch changes overlapped the workspace file; the merge preserves both the new handoff and these archive/PDF changes. Forty route/handoff tests passed after integration. Typechecking also caught incorrect relative imports in the newly merged reviewed-partial PE totals page; this release corrects those import paths as a web build prerequisite.

Code completion is distinct from live acceptance. The September 10 browser session initially exhibited older behavior; a later full reload exposed the phase 4 controls. The exact backend deployment revision was not available, and this document does not claim all production issues are closed.

## Changes in this release

- Native PDF generation and Word/PDF alternate downloads share the same persisted canonical document specification, artifact identity, and authenticated download route. No second model-generated copy or new storage system is introduced.
- Saved document references survive streaming, thread reload, and reopening. Both document canvases and inline download links use authenticated downloads with cancellation and actionable conversion errors.
- Historical `sandbox:/api/clio/artifacts/.../download` aliases are rewritten to the exact canonical app route before Markdown sanitation. Arbitrary sandbox files, hosts, traversal and extra parameters remain rejected.
- An archived thread's exact link can discover only its owned row and offer explicit restoration after reload. Transcript reads and new turns remain restricted to active conversations; restoration uses the existing authorized endpoint.
- The PDF renderer preserves paragraphs, tables, citations, and embedded images, paginates long content, and rejects unsupported text or oversized content explicitly instead of silently omitting it.
- The two vNext build workflows now match the existing Docker Node heap budget of 6 GiB. Foundation CI builds the strategy-verifier prerequisite before web validation.
- The existing governance detail reader exposes authorized original CRM evidence for metadata-only historical records. Source facts remain separate from approved memory; corrections and approvals continue through immutable versions.
- Explicit Meri data searches now enter the adopted Context Plane gateway. Server-side authorization is recomputed for each page; exact memory and hearing selectors, complete source bodies, cursors, and coverage survive the gateway. An explicitly empty mailbox grant denies mail reads while other authorized sources can report their results.

## Original issue ledger

| ID    | Issue                                | Implementation coverage                                                      | Remaining acceptance                                                                                             |
| ----- | ------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| MW-01 | Word download failed                 | Phase 2 authenticated downloads; this release adds format/reopen coverage    | Capture actual deployed downloads from both entrypoints                                                          |
| MW-02 | Historical scope changes with picker | Phase 2 persisted turn scope                                                 | Live portfolio-to-Anduril switch preserved the earlier turn's General scope; client-to-client regression remains |
| MW-03 | Full source remained truncated       | Phase 3 authorized full-source reader                                        | Deployed full-source navigation                                                                                  |
| MW-04 | Memory returns event metadata        | Phase 3 meaningful fact handling; this release adds governed source recovery | Recover original facts and approve corrections for affected historical records                                   |
| MW-05 | Proposal target unclear              | Phase 2 explicit target and scope                                            | Deployed proposal/save receipt checks                                                                            |
| MW-06 | Workspace assignment absent          | Phase 4 thread move flow; this release repairs archived-link recovery        | Live move and reload passed; archived-thread restoration awaits deployment                                       |
| MW-07 | QA/PDF/READY classified as companies | Phase 4 intent/entity classification                                         | Initial browser state showed Qa; fresh multi-attachment turn retained portfolio scope                            |
| MW-08 | Completed inspector says WORKING     | Phase 4 terminal lifecycle                                                   | Fresh live answer and turn inspector show Completed; cancelled inspector acceptance remains                      |
| MW-09 | Unavailable add-guidance wording     | Phase 4 truthful busy-state wording                                          | Fresh reload showed correct Stop-then-send wording during actual turns                                           |
| MW-10 | Coverage/counts/freshness unclear    | Phase 3 coverage states and bounded mail retry                               | SAM source repair and deployed source/coverage checks                                                            |
| MW-11 | No PDF export                        | This release                                                                 | Deployed Word/PDF file bytes and reopen checks                                                                   |
| MW-12 | Save prompt absent                   | Phase 4 saved prompt workflow                                                | Live save and reuse passed; reuse filled the composer without sending                                            |
| MW-13 | Feedback not hydrated                | Phase 4 durable feedback                                                     | Helpful feedback survived live reload; second-identity checks remain                                             |
| MW-14 | Attachments and client filing fail   | Phase 1 canonical text/DOCX/PDF/OCR ingestion and governed filing            | Dan bulk save, Tom advocacy regeneration, partial/pending/failure variants on deployment                         |
| MW-15 | Notes falsely claimed saved          | Phase 1 content/write outcome safeguards                                     | No-content browser inquiry passed; actual governed write/retry acceptance remains                                |

## September 10 live evidence

Isolated QA thread: `https://os.capiro.ai/meri/t/c18908a2-24cf-45ba-8d4c-9f72ddaa9a08`, titled **QA Sep 10 — final acceptance**.

- Exact READY response passed; clipboard contained exactly READY. The thread initially displayed `EXTERNAL RESEARCH · Qa`, reproducing MW-07 on the current deployment.
- Sightline/Wyden inquiry explicitly said no notes had been supplied. Meri requested the content and said it would not create a placeholder or infer engagement details. No write tool was displayed.
- Glass Harbor synthetic briefing retained the amount, fiscal year, draft status, meeting date/time, owner, deadline, and BLUE-ORBIT-47 checksum in the Word preview. Artifact clipboard contained the checksum. The live assistant stated PDF generation was unavailable.
- Live Word download returned from its busy state without a visible error, but the browser download event timed out. Actual downloaded bytes were not verified, so this is not a download pass.
- Governance Center opened the L3 Harris record titled `learning-signal:crm.fill_with_meri:crm_finding_accepted:1856cdaa-4f9e-4b05-8634-472296854e0a`. Its approved content still contained event metadata only. Provenance identified source `5d10b40f-611a-4f94-928a-5dbaa77fc8c1`, with no underlying fact or run link. No records were changed.
- Archiving the isolated QA thread succeeded. Reloading its exact link then failed with unavailable-history messaging because its transient Undo control was gone; this directly motivated the explicit recovery change. Its history remains retained and was not deleted.
- A second isolated thread, `https://os.capiro.ai/meri/t/d326bc04-c645-44d4-9488-3d7893a6b336`, accepted a real one-page synthetic PDF and a 182-character advocacy letter together. Both reached PARSED. The answer retained Glass Harbor values, BLUE-ORBIT-47, FortressHUMS / UH-72 LUT, LETTER-47, and the not-enacted/not-approved distinction. No notes, memory, or external messages were requested. Fresh controls showed Save prompt, correct busy-state wording, and a completed response state.
- Regeneration retained both attachments and both checksums without requiring pasted file contents. The personal prompt **QA — attachment extraction** saved successfully and reuse populated only the composer; no automatic turn was sent. The reused draft was cleared afterward.
- The second thread was renamed **QA Sep 10 — attachments and workspace**, moved into the new **QA — Meri acceptance** workspace, and remained there after reload. The workspace filter showed the correct thread and count. Helpful feedback remained selected after reload. Clearing the reused draft with keyboard input also persisted correctly.
- Switching that QA conversation from portfolio to Anduril left the previous turn inspector labeled GENERAL and COMPLETED. The conversation picker was restored to portfolio afterward; no new client-scoped turn or write was sent.

## Release and data operations

The prior vNext release run `34415255333`, job `102678601796`, failed from V8 heap exhaustion before AWS configuration or deployment. Foundation run `34417155130`, job `102684455294`, failed to resolve strategy-verifier. Both causes are repaired here.

API and orchestrator workflows build and publish images only. The existing MeriV3 rollout requires the reviewed revision to deploy orchestrator, then API, then web while preserving current tenant flags and task configuration. Do not use the older broad dark-release scripts or deploy the drifted Compute stack. This workspace has no AWS credentials or configured AWS CLI profile, and no AWS deployment connector was found. Do not represent image publication as a backend deployment.

Historical memory repair must recover the accepted source finding, submit **Suggest correction**, and use the existing approval action to activate the immutable version. A missing source is a repair blocker, not permission to infer a fact. The original records and provenance remain preserved.

SAM repair requires current SyncRun/task error evidence and authorized verification of `SAM_GOV_API_KEY` configuration. A September 6 runbook records an invalid key on September 4; that does not establish the latest failure cause. All-federal schedules remain gated by backfill and canary readiness. Validate the actual live schedule and task image before a bounded canonical backfill; do not enable schedules blindly.

## Validation

Completed focused checks: 111 PDF/API tests across six suites; 59 memory API tests; 30 orchestrator tests; six core registration tests; 286 Meri interface tests across 25 suites; three memory UI tests; 25 workflow tests; 86 targeted historical-link tests; and 31 archive-recovery tests (20 route, 11 API lifecycle). Some runs overlap, so these are not summed as a distinct total. Shared/strategy builds, web TypeScript and the PDF/memory/static-asset Vite production bundle passed (8,817 modules, 2m15s). The bundle predates the historical-link and archive-recovery follow-ups, both of which passed targeted integration tests and web TypeScript. Independent review found no remaining P1/P2 issue in the final patch.

The final API follow-up resolves all 17 diagnostics reported by current-main CI. Fifty focused tests across ten suites passed for revision fixtures, constructor/request fixtures, and imported CLI regressions. General validation still checks 548 test entrypoints; the production build keeps its source root and `dist/main.js` layout. Fresh local API TypeScript has one dependency mismatch diagnostic from installed `simple-statistics` 7.12.0; the lockfile specifies 7.8.9 and the locked CI run did not report it. Current-schema Prisma was regenerated with the existing CLI; dependencies were not reinstalled.

The local runtime uses Node 24 and pre-existing shared dependencies; GitHub's Node 20 locked-install checks are still required for exact release qualification. The actual PDF renderer produced a visually inspected one-page Glass Harbor PDF with all fixture values, plus inspected multipage tables and images. Unsupported Unicode scripts and emoji return an explicit conversion error with Word recovery; they are never silently replaced or omitted.

## PR release qualification

PR #1571 is open and held before merge/deployment. Initial integrated head `bf692215a24eb5a8d5b4e169b25d23fa8851d650` passed the foundation TypeScript checks and production build (8,857 modules, 35.86s). Its visual capture then failed because Node 20 requires its WebSocket flag. This release enables that flag for the capture step and preserves the existing visual gate.

Exact-head CI also exposed a prohibited direct retrieval dependency, stale API test constructors, a test/source-root mismatch, missing pnpm setup, a conflicting pnpm version, insufficient checkout history, and a missing shared build prerequisite. The follow-up repairs these causes while retaining existing assertions and release gates. The vector architecture contract passed all three tests locally with the repaired 6 GiB budget. Gateway validation passed 181 tests across six suites, including the real enforcement/resolver/retrieval/mail path and existing resolver regressions. The exact Context Plane architecture checker passed without allowlist changes; independent gateway review found no blocking issue.

Other repository-wide checks still report broad formatting drift, fixed historical phase-scope violations, and unrelated defense database acceptance failures. These are not marked passed or hidden by changing their gates. Full CI qualification and the ordered backend rollout remain prerequisites for production closure.
