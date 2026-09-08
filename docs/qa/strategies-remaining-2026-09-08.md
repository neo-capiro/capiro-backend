# Strategies QA repair status — September 8, 2026

Scope: finish the Strategies report except **QA-02 (officeholders and outreach targets)**. This change follows merged PR #1528, main `dfbce4baf088fa480128b11557b232aee2cf8172`. No QA-02 record corrections, outreach sends, artifact execution, context approval, or owner assignments were performed.

## Code repairs

- QA-05/06: shared health and UTC due-date policy across editor, report preflight, current-plan Markdown, DOCX/PPTX content and Watch. Absent gates/due dates are not represented as 100% grounded/on time; completed and suggested work do not become committed overdue work. Report scope and source standards remain explicit.
- QA-08/09/10: consistent effective client scope, explicit archived association state, reviewed same-client reassignment through a checksum-bound superseding working-draft revision, and “not assessed” context state when no facts exist. Preserve source/approval history and tenant boundaries.
- QA-11/12: monitoring configuration and check controls separate from timeline visibility; canonical Watch mission selection; execution eligibility before starting an action; recover recorded overdue run status without automatically rerunning work or enabling sending.
- QA-13: use the existing verifier for saved-plan prerequisite/order/overlap review. Missing gate prerequisites are advisory; no inferred edges or automatic retiming.
- QA-14: readable context documents with technical source detail expandable, named strategy links and understandable agent status/governance copy.
- Additional live blocker: vNext Meri sent a non-UUID `clientMessageId` although the assistant DTO requires UUID. Correct generation and retry identity handling.
- Release prerequisite: web deployment now builds its shared verifier dependency before tests/typecheck/build and triggers when that package changes.

## Live actions and limitations

The authenticated live web still showed the older UI (minute-only save age, old library metrics, no manual full-step editor). Merging #1528 did not establish that the web/API/migration were deployed.

**Saved and confirmed through the existing firm phase UI:** Discovery moved to FY26 Q1–Q2, Strategize to FY26 Q2–Q3; “Executepost-budget” became “Execute post-budget”; “Monitorsupport” became “Monitor support.” The save stamp updated and reopening the strategy displayed the corrected order/labels. Execute remains FY26 Q3–Q4, Monitor FY26 Q4–FY27 Q1 (ends exclusive). This is shared firm configuration, affecting all strategies. Future-year coverage is still unspecified; do not stretch Monitor over several fiscal years to hide the gap.

**Calendar/dependency corrections were not saved.** A narrow sourced correction submitted through the existing Meri UI returned HTTP 400. The non-UUID message ID above is a concrete client/API mismatch. The currently deployed inspector offers Meri-assisted changes but no manual date/dependency editor. Do not report the failed request as a successful repair.

Context approval/reassignment and execution/monitoring writes were not exercised against live business records. In particular, the brief association must be re-read after release to establish whether it is archived and choose the correct same-client active strategy; do not automatically approve a working draft or infer an owner.

## Supported calendar corrections awaiting the working revision workflow

Plan: `59cade7b-3baa-4b3f-90ce-7d00e6fb0bde`, “authorization and appropriations ask for fy27.” Re-fetch each record and its revision before updating. Preserve client work status; external events having occurred does not prove team work was completed.

| Record/event | Supported timing and handling |
| --- | --- |
| President's Budget reference; analysis step `c8664b0d-fc83-4216-b6fd-b844b332bccb` | Budget released April 3, 2026. This is availability, not the team's analysis completion date. Replace the unsupported Jan–Feb 2027 source window; select an explicit current analysis deadline separately. |
| Appropriations requests `83410e7f-fb88-4727-a55e-78d2c7513f33` | House Defense committee deadline March 20, 2026, 6 p.m.; Senate programmatic deadline May 12, 2026. Distinguish chambers and office intake deadlines. House requests preceded the April 3 budget release, so finished budget analysis cannot be a universal prerequisite. |
| HAC-D markup `07515da3-1fab-4050-82d3-89660d9c4b5d` | Subcommittee June 11, 2026. Full committee June 24 is a different event and requires an explicit title change if intended. |
| HASC markup `d2733d5b-5551-4a9a-a0b6-dc554c5cc67f` | June 4–5, 2026. |
| SASC markup `389ad0eb-69d0-4554-a6fc-67e82236bf03` | June 8–11, 2026. |
| SAC-D markup `69f339f0-3e25-4382-a148-b0706036e2af` | No exact verified date established. Do not copy a House date or represent the current 2027 estimate as official. |
| House NDAA floor reference | July 21–22, 2026. Separate retrospective assessment from remaining Senate/negotiation work. |
| CR risk `9108c403-29b0-4afb-8742-e65f5d6cb975` | H.R. 6500 signed September 2, 2026, interim funding through December 11, 2026. Update to current CR restrictions/expiry monitoring, separate from full-year enactment. |
| Authorization request/testimony, conference and signing milestones | Exact office/hearing/negotiation/signing dates remain unverified. Use explicit uncertainty and choose current-cycle recovery versus delayed/supplemental intent; do not shift every date by one year or change the goal to FY28. |

Both appropriations markup gates currently reference authorization preparation. Review the actual purpose: a client readiness gate can depend on appropriations preparation; a historical external committee event should not falsely depend on unfinished client tasks. Review the second plan `b693b2ff-8e61-447c-838a-01afba2a04a3` as well: it had no dependency edges at audit. Use Meri's existing evidence-grounded edit workflow and inspect the resulting changes; do not infer edges from row order.

Sources checked September 8, 2026:

- [Federal fiscal-year boundaries](https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title31-section1102): FY27 is October 1, 2026–September 30, 2027.
- [Official FY27 budget](https://www.whitehouse.gov/wp-content/uploads/2026/04/budget_fy2027.pdf), [April 3 committee release](https://armedservices.house.gov/news/documentsingle.aspx?DocumentID=6460).
- [House request guidance](https://appropriations.house.gov/fy27-member-requests/fy27-guidance-overview), [Senate request guidance](https://www.appropriations.senate.gov/imo/media/doc/fy_2027_full_committee_general_guidance.pdf).
- [HAC-D subcommittee](https://appropriations.house.gov/news/press-releases/defense-subcommittee-advances-fy27-appropriations-bill), [full committee](https://appropriations.house.gov/news/press-releases/committee-approves-fy27-defense-appropriations-act).
- [HASC start](https://armedservices.house.gov/news/documentsingle.aspx?DocumentID=6614), [completion](https://armedservices.house.gov/news/documentsingle.aspx?DocumentID=6713), [SASC completion](https://www.armed-services.senate.gov/press-releases/sasc-completes-markup-of-national-defense-authorization-act-for-fiscal-year-2027).
- [House floor record](https://rules.house.gov/bill/119/hr-8800), [July 22 passage](https://armedservices.house.gov/news/documentsingle.aspx?DocumentID=6737).
- [CR signing and expiry](https://www.whitehouse.gov/briefings-statements/2026/09/congressional-bill-h-r-6500-signed-into-law/).

## Release and acceptance

Use the existing API image/release process. Apply #1528's additive `20260908030000_sp_node_completed` migration before serving code that writes Completed, and this change's additive `20260908090000_watch_mission_purpose` migration before serving monitoring configuration. The nullable mission purpose preserves custom Watch names when changing schedules; existing rows remain discoverable through their schedule or check history. Generate the normal deployment-platform Prisma client; the local test client is generated without an engine and is ignored, not a deployable artifact. API image builds do not themselves deploy the API. See `docs/runbooks/api-strategy-g1-deploy.md` for the existing service/run-task provenance; discover current task definitions and health before any rollout rather than replaying its historical one-time provisioning commands.

No AWS release access was available in this session. After API/web/orchestrator release, confirm running SHAs and test the repaired flows with authenticated live access, including real DOCX/PPTX rendering and approval-derived fact inclusion. Then finish the record corrections above, brief association review, and the firm's future phase schedule. QA-01/13/15 data work and live acceptance must remain open until those actions are evidenced.

## Validation evidence

The self-review compared all 79 published files with the local tested snapshot and confirmed PR #1532 remained open and unmerged; the authenticated live app still served the old Watch review copy. Four additional defects were reproduced with failing regression tests and corrected:

- A successful Watch retry could revert to its failed ancestor on the next explicit check, including after an unrelated scheduled run. Rechecks now retain the successful attempt within the same idempotency-key family.
- The firm-only context view filtered after the 200-row limit, allowing newer client records to hide firm documents, facts and conflicts. All three endpoints now filter firm scope before limiting, keep firm/all-client caches separate, and exclude unbound non-firm records. The firm selector remains available even when no firm records appear in the current page.
- Navigating between cached documents retained the prior document's reassignment form. Reassignment review state now resets for each document.
- Valid frontmatter fences with trailing whitespace remained in the reading view and shifted citation highlighting. The reader now accepts the same whitespace convention and preserves CRLF source coordinates.

No additional live business records were changed during this self-review. The release and data acceptance items above remain open.

- Shared verifier build passed.
- Strategy API and web TypeScript checks passed.
- All 18 vNext Strategies test files passed (146 tests), including timestamp, scope, monitoring, link, assistant retry and inspector-state regressions.
- The complete Strategy API suite passed: 85 suites, 1,535 tests; 4 integration suites / 17 tests remain skipped by their existing environment gates. Coverage includes report renderers, context review/reassignment, monitoring, execution, dependency verification, route/DI boot and additive migration checks.
- Production Vite build passed. Existing bundle-size warnings remain.
- Live DOCX/PPTX exports and post-deployment workflows have not been verified in this session. Local renderer tests are not a substitute for that acceptance.
