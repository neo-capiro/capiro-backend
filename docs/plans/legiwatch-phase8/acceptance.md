# Phase 8 verification and acceptance

## Automated evidence

Run `scripts/legiwatch-phase8-qualification.mjs` with explicit local disposable database settings. It includes the prior Phase 6/7 regression runner plus new news-access, exact fiscal/query/schedule, PostgreSQL/Workspace/queue and UI tests. `scripts/legiwatch-phase8-upgrade.mjs` separately checks clean and populated upgrades. Five application typechecks are required, followed by packaged ARM64 module/database smoke tests and authenticated deployed browser verification.

New checks cover exact phrase/AND behavior and field boundaries, missing bodies, canonical URL handling, integer money and incompatible bases, DST occurrences, untrusted-source generation constraints, tenant/client memory walls, coalesced cache revocation, exact 38+5 replay with manual precedence, optimistic tracking, paged failure/retry, lost Workspace acknowledgment, preservation of edited drafts, internal audience enforcement, edited-output approval invalidation, one scheduled occurrence, current article corrections, one accepted synthetic sender receipt and held dispatch after a draft edit. UI checks cover disabled lanes, honest empty coverage, scoped optimistic tracking and exact cited-page excerpts.

Automated fixtures are synthetic and never presented as human-labeled relevance cases. The actual sender is stubbed in tests. A successful simulated provider receipt is not proof of delivered email.

## Human and client gates

The proposed 60 news, 15 temporal-personnel, 30 fiscal and five cutoff human-review targets remain pending. A real client must review the three templates, current recipient/category/scope decisions and repeated sample days (quiet day, outage, late correction, overlapping coverage and a budget change). Neither internal technical verification nor a from-now scheduled pilot establishes client acceptance or full vendor replacement. Optional Analyst 8D is excluded from this release.

Walkthrough: choose client/folder → News coverage/monitor/personnel → Budget project and exact comparable observations → original bill/document/person link where qualified → include evidence in Reports → choose exact passages → prepare/edit in Workspace → preview current output → approve the appropriate audience → review exact recipients through the existing delivery path. Automatic sending requires its own current standing approval; the internal technical pilot leaves it disabled.
