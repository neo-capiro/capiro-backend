# C1 mailbox-list release review

Both previously approved operations completed: orchestrator107 serves the classification repair and forward452 is verified. Mail search and task checks pass, and all eight answers persisted after reload. One remaining list defect was traced to an edge SQLi false positive on the legitimate minimal JSON request `{"limit":1}`.

**Ready for approval:** promote one new orchestrator image. It spells out the mailbox owner's existing `folder: all` and `offset: 0` defaults before sending list/search requests. The same explicit defaults already succeeded through the signed-in app. The change preserves requested filters and limits, and changes no WAF rules, permissions, model configuration or database schema.

| Release binding | Exact value |
| --- | --- |
| Source | `c8e2b8fbfe921fd43a1bd1d4d744a26db138e985` |
| Image digest | `sha256:27418fb841c03bc1637949c45d9deda1d4de8fd5be423d05beaf83e5d1025be6` |
| Manifest fingerprint | `991d367383b418a7a91a0d1d1c005652d29a96a3ca1ce933cff916319c3db211` |
| Current healthy baseline / rollback | orchestrator107, image digest `sha256:23ccef8051ad386b4cc6635b5e79559b6111b16121537b187bf09cdcca932213` |
| Configuration fingerprint | `3a4fabd2139e347cd8b45192579f2a3fbaaa6fc3678762b5252f727a4461951b` |
| Prepared / expires | October 3, 2026, 05:37:08 / 06:37:08 UTC |

Qualification passed: 1,500 orchestrator tests with two existing skips, 50 focused executor tests, 26 offline cases, real owner default equivalence and controlled failure/recovery, plus native ARM64 packaged startup/authentication and request-default checks. Independent review found no actionable issues. The GitHub Actions run failed before starting jobs; the approved build-only CodeBuild fallback succeeded on the exact merged source. [Qualification](mail-defaults-qualification.json), [build](mail-defaults-build-readback.json), [review](mail-defaults-independent-review.json).

Promotion replaces the one orchestrator task through the existing controlled rollout. The manifest binds the healthy baseline and pinned rollback image; changes or uncertain outcomes stop for reconciliation. Retain the already-applied index on rollback. [Manifest](orchestrator-mail-defaults-manifest.json), [preparation receipt](mail-defaults-release-preparation.json), [candidate qualification input](orchestrator-mail-defaults-qualification.json).

After promotion, rerun the minimal list request, affected search/task/coverage checks and reload in the already-approved account with counts only. Observe first useful content and terminal state separately, retaining tool count, failure state and coverage; the earlier browser observations measured only a combined upper bound. [Saved server timings and limits](post-release-request-timings.json). C1 remains open until the served automatic fix passes. Original 75-case/CD/CW acceptance remains unchanged.

The [release procedure](../../../deployment-prerequisite.md#release-operator-and-safety-contract) requires an approved manifest fingerprint. The earlier “Approve both” remains bound to the two completed artifacts; this new image has not been promoted or approved.
