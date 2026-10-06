# Federal and Florida hearing and committee health — October 6, 2026

The owner requested fixes, merge and shipping, automatic server recording, a grounded debrief, and live browser/backend verification across federal and Florida committees. The explicit committee scope is 230 current federal registry rows (including subcommittees) and 67 active Florida committees. Codex operated the release under that authorization; this record does not claim a separate human reviewer.

## Recording and web activation already verified

PR #2047 merged at `c201cd3118428be998f5ad5a1e22ffce95278dd8`. The [initial qualification](hearing-capture-debrief-2026-10-06.md) records the full passed workflow, private storage proof and immutable images.

- Web revision 400 completed its guarded promotion with image `sha256:e25f9faf252485ce7a39c0a9376b737e57fb0220956f0b3152789cdd511f9f1b`.
- Intelligence revision 63 completed its guarded image promotion. Revision 64 then enabled the separately reviewed public-audio configuration, retaining that qualified image, 30-day retention and the existing security and rollout controls. Independent ECS and load-balancer checks confirmed one healthy running task and a completed deployment.
- Capture and media schedules were pinned to qualified revisions 32 and 33. Actual automatic tasks `d9fb793de6604f67a876eda677a8f1f5` and `38e5f451098448c2950e67e90d9493a1` pulled the exact image and exited zero. Fresh capture, media, intelligence and preflight heartbeats had zero consecutive failures.
- Ten expired, exhausted preflight leases belonging to five completed September hearings were atomically retired. Exact state guards, before-images and a rollback script were retained. Independent readback found zero expired queue leases; historical capture outcomes and all five upcoming preflight jobs were unchanged.
- The media heartbeat's interval and owner metadata now match its existing two-minute schedule. A subsequent successful automatic heartbeat preserved those values. Enablement, schedule and delivery controls were not changed by that metadata repair.

Automatic recording retains approved public server-capture sources. A published browser-only or licensed stream is not silently granted server recording permission. The isolated synthetic audio check proves storage and private playback, not a newly completed real hearing recording.

## Source and data findings

The October 6 Ways and Means field hearing was imported an hour early. Its official page and advisory both specify 9 AM Central. A reviewed observation and canonical reconciliation corrected the event to `2026-10-06T14:00:00Z`, `America/Chicago`, without creating a duplicate. The live calendar now shows **9 AM CT (10 AM ET)**. The committee publishes a YouTube stream; server-capture eligibility remains a separate check.

Live Commerce acceptance shows seven proceedings, 26 members, 73 agenda entries, seven published documents and 198 bill referrals. The API addition projects verified Florida directory assignments into rooms whose roster join was empty, using stable person identity, matching source edition/hash and exact committee identity.

The 2026 House and Senate calendar receipts both completed successfully. A newer optional 2027 check reported that the publisher served another session; the old presentation mistakenly let this mask the relevant 2026 receipt. The final API filters coverage by the requested year/session and retains the actual future-session limitation. Active source counts exclude disabled historical sources, which remain available separately.

The news watcher now discovers official article links, follows bounded linked news indexes, normalizes duplicate URL identities and monitors active Florida committee pages. Shared chamber and joint-committee pages require explicit committee attribution for news, documents and hearing notices. Unknown publication dates remain unknown, and historical or undated news intake cannot generate fresh publication alerts. Parent committee publications are identified as inherited coverage for subcommittees.

All 67 inspected Florida committee pages were reachable; none exposed a separately attributable news article under the verified rules. Their calendar notices, agendas and published records remain the primary activity feed. All four configured Florida publisher RSS feeds retained articles in the audit. The broader RSS audit found six external failures: Reuters and DHS returned 404; State, Commerce and Cato blocked access; Brookings returned malformed XML in production. No verified replacement endpoint was found. These failures are not represented as working feeds.

Joint Taxation returns HTTP 403 and has a retained upstream-access exception. Library's obsolete URL and two missing House registry URLs have reviewed official replacements awaiting the final API/consumer activation. No unavailable source content, membership or news is invented.

## Final service candidate and acceptance

Web and intelligence source: `645cb5a7c00376caf6cf298f0275b20961ecb2f6`. API source: `c91bbe29f971630d584768a91de47623d1bb5098`. It preserves concurrent serving source `30fd674d091f4e86b266e5a5c9e22086e5c26194` and main's subsequent `4b14a1109` Meri capability fix. The first two affected Meri suites passed all 44 tests. The default local ts-jest run exceeded its 4-GB heap; the retry used isolated transpilation with unchanged assertions. A later broader local Meri service test was stopped when workstation free memory reached 72 MB; it is not claimed as passed. The final cloud gate includes the producer-input regression, and API image compilation is the separate source typecheck gate.

| Service | Immutable digest | Successful CodeBuild |
| --- | --- | --- |
| API | `sha256:d10c4536a371a2a80f26086da1f943ac21318d0c1a7969ec2113fa21f31fe330` | `ccb17134-882c-4dec-a9c1-822a727a6e60` |
| Web | `sha256:97c36b6579334e87b7e266c46063834f28392e0ac5c5d48338015ffebc87ee55` | `c965490a-1b54-4260-b7ec-5679dd8cc108` |
| Intelligence | `sha256:4605a59a8573362f444910e209608a7ad37900be042d89dd29be6423ffc6d78d` | `0948f6b0-5d09-4fa2-90b4-4fe70a89dd74` |

The intelligence ARM64 image passed revision-label, runtime import, FFmpeg and local/ECR digest checks. Full qualification **passed** against `def8e259cece48f8493d2c79b65c65f9fdfb0cb7` in build `a9062051-42f8-4777-8cbb-7a34831121f3`: API 124 suites / 1,484 tests; intelligence 85 / 1,134; web 323 / 1,112, all with zero failures, skips or todos. The separate database, recovery and Phase 1–5 checks also passed. Exact assertions are retained in [the sanitized qualification receipt](hearing-committee-health-2026-10-06-qualification.json). This is a full-suite baseline plus explicitly tested deltas, not a claim that the entire workflow ran at the final source SHA.

The five-file debrief delta extends only this model call to 300 seconds, explicitly sets its browser request to 420 seconds, targets 1,000–1,400 output words, and corrects progress copy. All 31 focused API/dialog tests and both relevant typechecks passed. Evidence selection, closing passages, citation validation and incomplete-draft withholding are unchanged. The production load balancer was independently read as 4,000 seconds; no ingress setting was changed.

The metadata delta passed four suites / 41 tests, the hearing typecheck and full API source typecheck. It accepts an event-specific committee page only from the canonical event or an already-associated official observation with matching parent/subcommittee, Congress, chamber, date and exact start when available. Shared player URLs are not identity proof. A bounded rotating slice of recent completed hearings can receive subsequently published testimony. The actual Golden Dome source yields three clean witness names and three individually titled testimony links; its explicit event-page provenance requires the separately reviewed observation seed. Undated testimony and memo backfills for completed hearings are suppressed at alert intake and final recipient recheck.

The Florida notice parser requires both a meeting-specific secured-briefing agenda and the explicit members/approved-staff restriction before setting canonical `private` visibility. All three retained official notices meet both conditions. Omitted or lower-authority visibility cannot reopen the event. The first PostgreSQL check correctly rejected an unsupported `closed` storage value; it was corrected to the existing `private` contract, which the recording resolver already maps to CLOSED. No visibility schema change is needed. Local parser/projection tests passed 33/33; final combined qualification **passed 5 suites / 77 tests** in build `32e0aa57-d644-4c9f-89d6-affa01abe3a4`, with zero failures, skips or todos. It covers real PostgreSQL visibility persistence and notification isolation, parser/projection behavior and the preserved Meri capability change.

All three final ARM64 images completed successfully. API runtime imports, packaged Meri/native dependencies and source compilation passed; web assets and Nginx configuration passed; every local digest matched ECR readback. The final API migration inventory is byte-identical to the exact-source migration rehearsal above. Intelligence runtime and shared dependencies are unchanged from the full-suite baseline; web differs only by the focused debrief request/progress change. No retired runtime is restored.

An earlier cloud run exposed the missing database allowance for `committee_news_published` in a real PostgreSQL notification regression. No news writer was promoted before this was fixed. Migration `20281008020000_legiwatch_committee_news_update_type` preserves all sixteen existing allowed values and adds that one type. Its final checksum is `faf5ff39d72bf15445d4aa593724d8aa81ea4dcef3e1bef3f6bf06c6bc18f46a`. The single constraint replacement is inside one explicit transaction with a five-second lock limit and thirty-second statement limit. A mandatory fresh-database and retired-schema upgrade rehearsal is part of the final workflow. The exact `718361f129a377ddae0af177bfa3c2ea49912308` migration delta passed build `06926826-a2ee-4c06-9152-610ff314f4f0`, including both actual Prisma migration scenarios and all four committee-notification PostgreSQL regressions, with no skipped tests. The rehearsal preserved existing rows and catalog, rejected invented update types, retained retirement, and confirmed a second deployment is a no-op.

Production preflight found only that new migration pending and no unfinished migration. The 61 historical checksum differences exactly match the October 2 committed closeout record. Every existing migration file is byte-identical between serving `fd6a8b557` and the candidate. The reviewed standard Prisma deployment wrapper binds the complete prior ledger hash, exact inherited difference list, table identity, owner, grants, row-security state and other constraints. It permits one new ledger record and does not edit historical ledger entries. This is an explicitly inherited history limitation, not a clean-history assertion.

The first actual Golden Dome/L3 Harris generation attempt reached the prior 120-second provider limit. The app withheld the unfinished draft and displayed a retry message. Live acceptance after the timeout correction remains required.

Release sequence: promote the API and intelligence through the guarded operator; pin the notification consumer separately; verify old API and notification tasks have drained; then pin the ten ingestion owners and the capture/media workers. Only afterward apply reviewed source/tenant-feature repairs and refresh the sources. Preserve existing roles, secrets, networking, cadence, rollout flags and external delivery gates.

Final production API/worker acceptance, the 297-row committee coverage readback, and actual generated Golden Dome debrief acceptance are pending. A built image is not a deployment receipt.


## Follow-up acceptance fixes — source 567ef73ada87bf1aeeafad1c34d8b80596b99096

The final cloud regression build `dd644672-7b82-4d52-8b9c-62ec5b5fc9c5` passed **17 API suites / 305 tests** and **91 web tests**, with zero failures, skips or todos. The API tests include real PostgreSQL calendar and committee-notification checks, debrief generation/evidence/JSON, federal readiness, alias handling, Meri compatibility, Florida identity and publisher backoff. The web tests cover metadata normalization, recording policy and actual hearing-detail navigation. The prior combined source `2e4381b69` also passed 266 API tests and 13 web tests in `f8e89d20-3497-4b8f-8a8c-1b6831438be9`.

Live inspection found three additional presentation gaps. String-form witness names were discarded by the browser, official testimony updates appeared without document links, and a pending capture request concealed a browser-only source restriction. The follow-up preserves and displays witness names, merges verified calendar and testimony documents in event and room responses, keeps unknown publication dates null, and displays current source restrictions before pending recording status. Completed or failed recording outcomes remain visible. Synchronization no longer clears enriched witness names when a House/transcript payload omits them.

A second live Golden Dome debrief attempt passed the former timeout but returned literal unescaped paragraph breaks inside JSON strings. The parser now losslessly encodes those control characters inside strings only. Invalid syntax, truncation, missing sections and unsupported citations remain rejected; this is not a content-repair or grounding bypass. Successful live generation and saving remain an acceptance requirement.

The Florida scheduled Senate crawl was genuinely throttled, while House 2026 completed. The follow-up raises normal request spacing to one second, permits `FL_CALENDAR_DELAY_MS` from 1,000 to 5,000 milliseconds, respects publisher retry delays within the bounded request budget and stops subsequent requests to a throttled host within that run, including additional sessions. It does not provide distributed throttling across independent news and probe jobs. Recovery must be demonstrated by a new complete 2026 calendar receipt, not inferred from unit tests or a source-only probe.

Federal readiness now excludes Florida observations from its federal directory checks. An explicit no-public-stream or blocked rollup counts as an explained non-capture outcome only when no capture or stream candidate exists. Failed captures, unresolved candidates and historical first-party streams without a recording remain visible gaps. Four reviewed same-ID Senate duplicate pairs were repaired through the standard alias validator with exact plan hashes, retaining rows, references and history. The two closed legacy copies were first restricted to the visibility proven by their authoritative Senate observations in the same transaction. The separate House pair 119524/119525 remains unresolved: one official page exists and the other is missing, without an authoritative cancellation or duplicate statement.

The full federal synchronization completed with 3,835 updated records, including 2,766 meeting records and 1,068 hearing/transcript records; it processed 2,731 agenda-to-bill links. Detail-fetch and House-day failures were zero; two transcript source entries lacked dates and were skipped. The news audit retained 774 official articles with zero source-identity mismatches and zero undated-news notifications. Foreign Affairs has all ten verified current articles despite a broken secondary category link. The subsequent RSS run succeeded for 20 of 25 feeds and retained 401 articles; all four Florida feeds succeeded, and Brookings recovered. Reuters, DHS, State, Commerce and Cato remain explicit publisher exceptions.

The URL-provenance migration's fresh-database, retired-upgrade and replay qualification passed in `865514bd-09a7-4759-bfc3-22b6a95a1c83`. The final source's complete 457-file migration inventory is byte-identical to that qualified inventory. Its production wrapper binds the existing 613-row ledger and permits exactly the new official-review allowance, without rewriting historical migration evidence. Production application, new API/web deployment, Florida joint-committee refresh/retirement and final live debrief acceptance are still pending at this entry.


Both final ARM64 images passed compilation, runtime checks, source-label validation and immutable ECR readback:

| Service | Final immutable digest | Successful build |
| --- | --- | --- |
| API | `sha256:0eaa3d78e07254af7351298bbb03573b819ee1096956230071dae1dda1d0d19a` | `02d83e20-8d24-4941-8b36-762200048db3` |
| Web | `sha256:671bcd1586b01327df9e9fcde60525d89679920ba51c18d77f01ce79a807822f` | `35c3d83e-c45c-486d-920e-18404542a77c` |

Independent readback after the full federal synchronization confirmed all four Senate aliases, both closed visibility restrictions, retained canonical observations and unchanged protected history. The final images are qualified for guarded promotion; this statement does not yet assert deployment or successful live debrief generation.
