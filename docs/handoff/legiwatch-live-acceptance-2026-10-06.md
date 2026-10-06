# Federal and Florida LegiWatch live acceptance

Scope: 230 federal and 66 active Florida committee rooms, plus one retained retired Florida alias. The original QA repairs and recording changes are documented in [the October 5 rollout](legiwatch-qa-2026-10-05-rollout.md) and [the detailed October 6 audit](hearing-committee-health-2026-10-06.md). This document records final acceptance separately from that chronological investigation.

## Release qualification

PR #2070 merged at `1d39459a3d6a2fdf009539781807e5db5258325f`. Its exact source passed 591 API and 91 web tests and an ARM64 image build. The first promotion detected a simultaneous API release and stopped without rollback; the concurrent release became healthy on revision 589. A combined candidate at `d6fef85b726e6c7f4c5c674f82a47602894a64f9` preserves both releases. Its build, test and live acceptance results will be recorded here before closure.

## Verified repairs

- Florida companion-substituted bills have terminal dispositions; HB 1211 points to enacted SB 474, Chapter 2026-92.
- Commerce's live room shows seven proceedings, 26 members, 73 agenda entries, seven documents and 198 bill referrals. Its February 10 hearing has 13 agenda entries and 12 linked bills.
- Verified publisher aliases resolve to one committee identity. Unproven same-title hearings remain distinct. Golden Dome identifies the Strategic Forces Subcommittee and shows three witnesses with three official testimony documents.
- Archived/missing client alerts, legal-defense keyword false matches, duplicate cross-client observations, unexplained legacy severity and internal fit labels were corrected. Florida text comparisons and supporting analyses, visible budget amounts, and four in-app notification categories were verified in production. External email remains off.
- The No Flame legacy URL resolves to official event 119527 with committee, time, location and witnesses. Birth Tourism has its published date/time, room, three witnesses and available testimony document.
- Historical Florida room associations require the exact same media entry in an official committee schedule/player and the stored source observation. Live Joint Legislative Auditing Committee acceptance shows November 3, November 17 and December 8 proceedings, 14 members and three linked archive records. Original identities, date precision, recording permissions and history are preserved.

## Recording and data limits

Automatic capture and media workers are enabled. This does not make every source recordable. The October 6 Ways and Means hearing uses YouTube and remains visibly browser-only pending the existing unattended-source clearance. Eleven past outcomes are BLOCKED, not FAILED. Twenty captures are COMPLETE and one is COMPLETE_WITH_GAPS; classifying historical source dispositions did not recover missing recordings. Completed-archive recovery remains outside the current recording gate.

The latest reviewed central RSS run succeeded for 19 of 25 feeds, including all four Florida feeds. Reuters, State, Commerce, DHS, Cato and Brookings retain explicit publisher/format failures. Joint Taxation returns 403. Missing qualified feeds and empty rooms are not evidence that a publisher has no news or proceedings. Parent news is distinguished from committee-specific news. Three roster exceptions and unproven historical associations remain explicit in the committee inventory.

Florida's earlier successful calendar receipts are not used to hide later throttling. Live acceptance at approximately 05:37Z showed a newer Senate HTTP 429 while the House source remained healthy. Final recurrence must be checked after the combined release and scheduled owners are updated.

## Debrief acceptance

The first complete Golden Dome draft was deliberately left unsaved after independent review found speaker and qualification errors. Final acceptance requires correcting the verified Kaine attribution, generating a new seven-section draft with evidence-linked moments, reviewing its factual distinctions and conditional deadlines, successfully refining it through Meri, and saving/reopening the document. These steps remain pending in this draft of the report.
