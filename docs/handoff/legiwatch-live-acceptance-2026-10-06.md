# Federal and Florida LegiWatch live acceptance

Scope: 230 federal and 66 active Florida committee rooms, plus one retained retired Florida alias. The original QA repairs and recording changes are documented in [the October 5 rollout](legiwatch-qa-2026-10-05-rollout.md) and [the detailed October 6 audit](hearing-committee-health-2026-10-06.md). This document records final acceptance separately from that chronological investigation.

## Release qualification

PR #2070 merged at `1d39459a3d6a2fdf009539781807e5db5258325f`. Its exact source passed 591 API and 91 web tests and an ARM64 image build. The first promotion detected a simultaneous API release and stopped without rollback. The combined source `d6fef85b726e6c7f4c5c674f82a47602894a64f9` preserves both releases, passed 656 API and 91 web tests, and became healthy on API revision 592. Its qualified digest `045ee466e2dffcc2b7248691c3dfdf3dc6c2fde8e103b6f2974fe353d363013c` also runs the ten API ingestion owners and notification consumer.

PR #2075 merged at `988442784332cd6281bfa79048fab42fd762ae94`, followed by the complete-context editor repair in PR #2077 at `6dc19fc58e77aaced4073d99441880dc72e0ecc6`. Final API source `c83a0f44a7fb8bc713bb6fc02bdb7b14ea0da59d` passed 662 API tests. Final orchestrator source `5f674222964bb00dccd05c5099c67caf14ba9acf` passed 1,520 runnable tests; two unchanged live tenant-fixture placeholders remain explicitly unexercised. The byte-identical web runtime previously passed 1,125 tests with no failures, skips or todos. Final ARM64 builds, runtime imports, digest checks and guarded promotions passed with no migration or permission changes. Independent readback at 06:53:42Z confirmed every service healthy, with no pending tasks:

| Service | Revision / healthy tasks | Immutable digest |
| --- | --- | --- |
| API | 594 / 2 | `249c7a801cebff94c824b3673aef20218e77ccfb7398d9ffe127a6d01fb12487` |
| Editor orchestrator | 159 / 1 | `8f6fed3b5ffcc5aa3956bf4eaa9fc98367efe78c242877547950bf9cfd5a3e7d` |
| Web | 410 / 1 | `c662009020227ae02bb0e0a3e4044eb5363d545f0d8dc3cb64b8524a3a3c8fbf` |
| Intelligence / capture | 66 / 1 | `4605a59a8573362f444910e209608a7ad37900be042d89dd29be6423ffc6d78d` |

Live browser acceptance confirms Proceedings 1 for January 6 and Proceedings 10 for China Select, matching the recent rows. The ingestion owners retain their proven `045ee466` digest because the final runtime delta affects debrief generation/editor requests only.

## Verified repairs

- Florida companion-substituted bills have terminal dispositions; HB 1211 points to enacted SB 474, Chapter 2026-92.
- Commerce's live room shows seven proceedings, 26 members, 73 agenda entries, seven documents and 198 bill referrals. Its February 10 hearing has 13 agenda entries and 12 linked bills.
- Verified publisher aliases resolve to one committee identity. Unproven same-title hearings remain distinct. Golden Dome identifies the Strategic Forces Subcommittee and shows three witnesses with three official testimony documents.
- Archived/missing client alerts, legal-defense keyword false matches, duplicate cross-client observations, unexplained legacy severity and internal fit labels were corrected. Florida text comparisons and supporting analyses, visible budget amounts, and four in-app notification categories were verified in production. External email remains off.
- The No Flame legacy URL resolves to official event 119527 with committee, time, location and witnesses. Birth Tourism has its published date/time, room, three witnesses and available testimony document.
- Historical Florida room associations require the exact same media entry in an official committee schedule/player and the stored source observation. Live Joint Legislative Auditing Committee acceptance shows November 3, November 17 and December 8 proceedings, 14 members and three linked archive records. Original identities, date precision, recording permissions and history are preserved.

## Recording and data limits

Automatic capture and media workers are enabled. This does not make every source recordable. The October 6 Ways and Means hearing uses YouTube and remains visibly browser-only pending the existing unattended-source clearance. Eleven past outcomes are BLOCKED, not FAILED. Twenty captures are COMPLETE and one is COMPLETE_WITH_GAPS; classifying historical source dispositions did not recover missing recordings. Completed-archive recovery remains outside the current recording gate.

Hermes's final read-only snapshot at 06:56:34Z confirmed capture-all and Florida server-capture flags enabled, zero eligible upcoming public hearings missing scheduling, and successful latest capture/media worker exits. The only upcoming public hearing was 119575; it had five source-preflight checks, no capture jobs, no automatic demand, and no effective server-source permission. Thus there were zero currently eligible upcoming events, rather than a successfully recorded upcoming hearing. The final browser reload independently displayed Browser recording only. No permission was widened.

The latest reviewed central RSS run succeeded for 19 of 25 feeds, including all four Florida feeds. Reuters, State, Commerce, DHS, Cato and Brookings retain explicit publisher/format failures. Joint Taxation returns 403. Missing qualified feeds and empty rooms are not evidence that a publisher has no news or proceedings. Parent news is distinguished from committee-specific news. Three roster exceptions and unproven historical associations remain explicit in the committee inventory.

After the combined release and scheduled-owner update, the actual recurring Florida calendar run completed at 06:00:30Z on the qualified image: 49 Senate and 22 House 2026 pages, zero issues. An ordinary operator run independently completed at 05:53:55Z with the same result. The earlier Senate HTTP 429 remains recorded as historical evidence. The 05:59:56Z committee-news run processed 141 sources without a Florida 429; it retained the JCT 403 and Foreign Affairs secondary news-index 404 as explicit errors. Florida's unpublished 2027 session is not substituted for its verified 2026 calendar.

The [committee inventory](legiwatch-committee-health-2026-10-06.csv), [full inventory evidence](legiwatch-committee-health-2026-10-06.json) and [ingestion-owner report](legiwatch-ingestion-owner-health-2026-10-06.json) cover all 297 retained rooms and 15 enabled owners. Of 296 active rooms, 275 have retained canonical proceedings and 293 have ingested rosters. News coverage distinguishes 45 direct, 180 parent-only, 70 with no qualified articles, and one JCT source failure. Counts describe the ingested corpus, not publisher completeness; all 790 official news links have unknown publication dates and produce no undated notifications. The final source probe completed at 06:10:12Z with 152 examined sources, 148 updated, four skipped, one JCT failure and no Florida throttling. Thirteen owners have actual completions on their configured images; the two daily federal sync owners retain earlier successful receipts explicitly.

The readiness and recording counts use the August 7–November 5 window, distinct from whole-corpus committee counts. The readiness audit represents all 240 official observations and has provenance for all 126 canonical events, but remains BLOCKED: 14 of 111 due public events lack explicit outcomes. Eleven other historical public rows are BLOCKED (one browser-only, ten no-public-stream dispositions); these are not eleven transport crashes. Four Florida archive associations lack exact publisher identity proof and remain unmodified.

## Debrief acceptance

The incorrect Golden Dome speaker label was corrected through the live UI to Senator Tim Kaine. Independent readback confirms manual confidence 1, stale role/person reference cleared, and unchanged transcript/capture/other speaker rows. The first complete drafts were left unsaved after review found factual qualification errors. Quotation validation correctly withheld two later drafts with unsupported quotation marks. The paraphrase prompt and safe rejection diagnostics address this without weakening quotation checks.

The bounded editor repair passed qualification and deployment. Fresh live generation then produced all seven sections and 12 evidence-linked moments without a quotation error. Independent review confirmed the key moments and identified section wording requiring correction: speaker attribution within an exchange, estimates versus appropriations, separate allied munitions discussions, development epochs versus full capability, analyst implications and transcript coverage.

Live refinement returned and applied edits without the former timeout, but acceptance caught a second defect: the editor prompt supplied only the first 1,500 characters of each section, so full-section replacements copied ellipses and omitted unseen tails. The draft was not saved. The live Undo action restored the full original sections, including their endings. PR #2077 now supplies complete section HTML and context and explicitly refuses requests above the serialized 120,000-character limit before requesting edits.

After orchestrator revision 159 deployed, live refinement preserved complete sections and applied the reviewed factual qualifications. Independent content review passed. The seven-section, 1,371-word Golden Dome recap was saved to Workspace and reloaded successfully; all seven reviewed states and the complete section bodies persisted. Its context retained all 12 key moments and the source packet. This validates the reviewed saved example, not a claim that future model outputs are flawless.

Opening the saved context exposed a separate frontend array-shape error, and marking a section reviewed emitted an unsupported toast-method error despite successfully persisting the change. PR #2078 normalizes wrapped and legacy draft lists at the shared hook and uses the active app's supported notification provider throughout Workspace. Client/status filters, document bodies, autosave and modal confirmation behavior are preserved. Nine focused regressions and the full frontend typecheck passed; independent code/test review found no material issue.

Exact source `f63686c95b85e2c5b7168225fd9fda874c86de0d` passed CodeBuild `02039b1f-0d1e-44da-8950-234db868319f`: **363 suites / 1,207 tests, zero failures, skips or todos**, production compilation, ARM64 runtime startup and source-label checks. Immutable ECR digest is `sha256:d2dc72d6e35a454283cf1095cef84cd9391599f606b69e5df38d909f39a6abc1`. The preceding `8907c1da` build was stopped before qualification after two test-only query options failed local typechecking; its receipt is retained. Only web changes in this follow-up; backend services, ingestion schedules, migrations, permissions and retirement controls remain unchanged. Guarded promotion and final live context/review acceptance are pending.
