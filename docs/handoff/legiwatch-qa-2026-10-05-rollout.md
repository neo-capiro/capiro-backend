# LegiWatch October 5 combined web qualification and rollout

The owner authorized resolving the October 4 QA findings, merging and shipping. PR #1967 merged at `33174828a227bffc15829a3202e011593f2afc2d`. This supplements [the original qualification](legiwatch-qa-2026-10-05-release.md); Codex reviewed and operated the release under that authorization, without claiming an independent human review.

## Combined web candidate

- Source: `ec150981cb568a68202c008abbac9f253e507aae`.
- Image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:1daea07266d368a77d09715196f74f2ae52ec41391bec78ad0c4c9662ab71fbe`.
- Successful CodeBuild: `capiro-build-web-dev:ef5d1936-103e-4adc-8e93-665b82b0611c` on October 5, 2026.
- Frozen dependency installation, shared package builds, web typecheck, the complete LegiWatch web test scope plus managed-MCP sign-in tests: **325 suites / 1,122 tests, zero failed, skipped or todo**. Marker: `LEGIWATCH_MERGED_WEB_QUALIFICATION_PASS`.
- ARM64 Docker build, source-label verification, packaged assets and Nginx configuration passed. The local pushed repository digest matched ECR (`LOCAL_REPODIGEST_ECR_MATCH_PASS`).

The original web candidate was prepared while another authorized release deployed a newer connector sign-in fix. Its rollout was stopped through the guarded rollback operator; healthy web revision 395 restored source `ac45312b829615a276dbe654065e7326bcfdaf06`, digest `sha256:ae9f7cff343c17d9977a8e57fe716f2733d1d9e8811e689eac9fab335ef053af`. The replacement candidate above includes that source and the LegiWatch merge. Relative to the original qualified web candidate, its web runtime change is the sign-in popup fix, covered by the additional tests. Shared additions are additive types. No retired Hermes runtime or migration was introduced. The original full API/intelligence/database qualification remains recorded separately.

Guarded rollback receipt fingerprint: `7358f1382d5028cfe60cb883006e4654a8ad18f7ae2bfcf8bd63b799106ff874`. The interrupted original promotion correctly detected the rollback as a concurrent configuration change and did not overwrite it.

## Backend and scheduled owners

API revision 557 and intelligence revision 59 completed guarded healthy promotions. A concurrent authorized Meri release subsequently deployed API revision 559 from the LegiWatch merge commit `33174828a227bffc15829a3202e011593f2afc2d`; it contains these fixes and was healthy with two running tasks. Intelligence revision 59 was healthy with one running task. Existing runtime flags, roles, secrets, networking and scale were preserved.

Eleven scheduled rules were pinned to the qualified API/intelligence images, across six task families. Every target was read back exactly after the update. The Florida calendar target now runs the existing bounded Phase 9 job with its correct `api` container. Its disabled database owner was separately restored to enabled, using an exact locked-row hash and retained before/after evidence. The actual EventBridge schedule is fifteen minutes; the older runtime health metadata said ten minutes. The schedule, archive exclusion and external notification delivery gates were preserved.

The notification-drain acceptance task `f75bed4077cb49a3ba3afc7bcc7da834` ran qualified Phase 9 revision 61 and completed its job with `lifecycleInserted: 0`, zero terminal failures and zero retries. This proves the new lifecycle query executed; it does not claim that a real hearing-start or transcript event occurred during the test window. The four event categories had separate real-PostgreSQL isolation, preference and durable-deduplication checks before release.

Florida calendar acceptance task `7a8ab16650414d1aabfc94fddd0e85ac` also exited zero. It checked 49 Senate and 22 House pages for 2026, completed with zero errors, and explicitly classified requested 2027 as unavailable because the publisher served 2026F. The runtime owner recorded success at 19:59:55 UTC with both enablement controls true and no consecutive failures. This run does not assert a complete 2027 calendar. Both jobs used the ordinary scheduled-owner path (`manual: false`).

Final feed review found one additional retained legal-defense false positive, CA AB 859 (civil procedure / recovery of defense costs). Its exact tenant, client, new-match trigger and sole Defense tag were rechecked under a row lock before suppression, with before-image and correction metadata retained. Together with the original six, seven reviewed historical false positives were corrected; future matching already excludes all of these legal-defense phrases.

Authenticated live checks already confirm HB 1211 is laid on the table with companion substitution, SB 474 is enacted with Chapter 2026-92, Commerce has seven proceedings and 198 referred bills, its February 10 hearing has 13 agenda items and 12 bill links, and Golden Dome identifies Strategic Forces. The original data-repair report describes retained provenance and ambiguous observations left unresolved.

The September 28 week shows a single Ukraine briefing under the Commission on Security and Cooperation in Europe. Jack Smith and USPTO remain distinct September 29 hearings at 09:00 and 14:30 ET respectively. The committee picker contains one entry per canonical committee identity for that week.

## Completed web acceptance

Guarded promotion completed for web revision **398**, deployment `ecs-svc/8201201703346672957`, with the exact combined image above. Manifest fingerprint: `6b993ac4ca2db0a2084b4ea34c37c0b11573b60a355499a09c92f3d9d5dce294`. The operator verified the candidate task, running digest and its actual healthy load-balancer target. Before promotion, the serving source was rechecked as an ancestor of the combined source.

Authenticated production checks confirmed:

- HB 1211's January 8 introduced text compared with the February 24 committee substitute, returning 312 added and 283 removed extracted lines with page locators and original links. The UI distinguishes wording comparison from legal effect.
- All four notification categories show their in-app availability and follow settings, replacing the unavailable labels. External email opt-in remains off.
- Florida Budget lists source amounts directly in the project table, with labels such as “Chamber proposal” and “General Revenue”.
- The active feed resolves L3 Harris, excludes the audited archived/missing clients and the seven corrected legal-defense alerts, and removes legacy fit scores. Distinct bill versions and dated events remain separately visible; exact duplicate observations across clients are grouped.

Acceptance found a remaining supporting-document omission: the records query listed only text versions, even though staff analyses have a separate immutable document owner. The follow-up query includes current supporting-document observations, preserves original links, and uses the latest observation pointer rather than guessing by publication time. A real PostgreSQL regression verifies current-revision rollback, bill isolation, parameter binding, no duplicate text versions and pagination. The official analysis inventory for the three QA bills is hash-bound to `d464694a7df7e6b7206a7c3ecd0e794387e33093f2303cc705137d01da936f32`. Task `406ed23964ca4b7d937904f95d53ebaa` exited zero after completely extracting all 16 supporting PDFs. Current-observation readback confirms HB 1211 has 3 supporting documents plus 4 texts, SB 474 has 7 plus 5, and SB 7002 has 6 plus 4.

## Supporting-document service qualification

- Source: `dbca3cbab55401d21363adb11e928a6673dbec70`.
- Image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/intel-api@sha256:c2305e63d14b50ade9487ac1aaea042e9749a91ae7f734413e6eabb983102ea1`.
- Successful CodeBuild: `capiro-build-web-dev:6ba1a592-750b-4251-8794-8675fc296005`.
- Intelligence typecheck and full LegiWatch intelligence scope: **84 suites / 1,124 tests**, zero failed, skipped or todo. The real PostgreSQL check passed all six behaviors above (`STATE_DOCUMENT_RECORDS_POSTGRES_PASS`).
- ARM64 packaging, source label, runtime module imports and local/ECR digest match passed. This candidate only changes the read-only supporting-document query in the intelligence runtime relative to the qualified serving source. Shared changes are additive types. No migration, retired runtime restoration or flag change is introduced; the existing schema grants already cover the queried tables.

The candidate's guarded promotion and final authenticated supporting-document acceptance are recorded after completion below.

Private logs, before-images and receipts remain outside the repository. The live 2027 calendar remains unavailable from the publisher; forty ambiguous historical notice associations were retained unresolved rather than guessed.
