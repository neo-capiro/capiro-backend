# Hearing recording, debrief and ingestion release — October 6, 2026

## Qualified recording and web candidates

The owner requested automatic server recording, improved hearing debriefs, a live browser/backend health check, and merge/shipping. This record qualifies the recording and web candidates only. API ingestion/news additions and their final production acceptance are recorded separately when complete.

| Service | Source SHA | Immutable image digest | CodeBuild build |
| --- | --- | --- | --- |
| intel-api | 87e6eda32f1e611dcf4848172b2d1e9e326d78c9 | sha256:86ca8cd3c07ab888415e9ad094d354e0a2c33a242dd696ca0a08069a4140d5e1 | f2468885-5135-4eb3-b175-19d2f3747d79 |
| web-vnext | 87e6eda32f1e611dcf4848172b2d1e9e326d78c9 | sha256:e25f9faf252485ce7a39c0a9376b737e57fb0220956f0b3152789cdd511f9f1b | b1442c50-6908-478f-8724-0f4c0907e53b |

Both builds used project `capiro-build-web-dev`, native ARM64, the exact source checkout, revision labels, image runtime checks, immutable SHA tags and local/ECR digest agreement. Intel runtime imports and FFmpeg passed. The web runtime assets and nginx configuration passed.

Full LegiWatch qualification on that exact source passed in CodeBuild `e0fc4066-6651-4d7d-b447-0e1c2039f3fb` at 01:38 UTC. It executed the committed workflow's commands with disposable PostgreSQL/pgvector databases, not production: API 122 suites / 1,443 tests; Intel 85 suites / 1,131 tests; web 323 suites / 1,112 tests, all with zero failed, skipped or todo tests. The separate Phase 1–5 SQL, migration, recording, recovery, private-document and delivery gates passed; final marker `LEGIWATCH_COMPLETE_CI_QUALIFICATION_PASS` was observed. All three app typechecks passed.

The new native PostgreSQL recording fixture verified source eligibility, public/private separation, aliases, jurisdiction, active membership, tenant isolation, permission revocation, durable WAV checkpoints, stale-worker fencing and completed-source recovery. An initial qualification attempt failed because the fixture mixed generated Prisma clients; the corrected exact-source rerun above passed.

The production S3 storage path was tested with an isolated two-second synthetic WAV: 64,078 bytes, byte/hash agreement after upload/read/signed private playback, and cleanup of that owned probe prefix. Task `818bd6503823427eac1c1dc98bc2db28` ran the identical Intel implementation from ancestor `de42a4551facdadeed0e27ed6c7396c848219f98`; the only change through `87e6eda` was the API test-fixture import. This proves storage operation, not a real live hearing recording.

## Recording scope and activation

Previously capture-all generated transcripts but retained no public audio. The new opt-in retains only streams already approved for server capture. It does not convert browser-only, licensed or private sources into server-capturable media. Current user membership and tenant recording access are checked before playback; source approval and fenced capture leases are checked during recording. Failed/recovering attempts no longer produce false successful capture counts.

The reviewed activation sets `HEARING_PUBLIC_AUDIO_STORAGE_ENABLED`, `HEARING_PUBLIC_AUDIO_CAPTURE_ALL_ENABLED`, `HEARING_AUDIO_STORAGE_ENABLED` and `LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED` to true, with `HEARING_PUBLIC_AUDIO_RETENTION_DAYS=30`. Apply to the serving Intel service and capture/media scheduled consumers; media recovery remains enabled. The owner's tenant recording feature is enabled separately. Keep Phase 9 cutover/default/kill-switch controls and outbound email/SMS delivery gates unchanged.

There are no added or changed database migrations relative to the serving API source `f39bf04768f2d4906d55c784f16d6c6a82f89f78`. The candidates include the serving Intel source `dbca3cbab55401d21363adb11e928a6673dbec70` and web source `ec150981cb568a68202c008abbac9f253e507aae`. Runtime imports and reviewed source changes restore no retired Hermes runtime or dropped-table dependency. Promote images only through `scripts/meri-release.mjs`; separately reviewed configuration/consumer plans preserve roles, secret references, network, commands and cadence.

## Debrief and ingestion work in this change

Debriefs preserve unidentified speech and evidence across the full transcript, validate timestamps and quoted passages, derive moment speakers from evidence, distinguish facts from client implications/recommendations, and reject incomplete or unverifiable output. The additional closing-evidence fix reserves the final three passages within the same hard character budget. Nineteen focused debrief tests pass, including long-hearing deadline retention. Golden Dome's 1,237 actual transcript rows become 219 passages / 75,689 characters without truncation; the final two-week response request remains present at 1:23:14. Generated prose still requires live acceptance.

The daily hearing sync was failing because Congress.gov's `NoChamber` joint hearings conflicted with canonical `Joint` rows. Both writers now normalize that publisher value while preserving cross-chamber and cross-state guards. Reviewed official committee URL replacements survive subsequent catalog syncs. Florida committee rooms now project verified same-edition PDF assignments already attached to stable people; mismatched subject, chamber, district, source hash or committee identity is rejected. Focused alias/sync tests and 56 roster/service tests passed, as did the hearing typecheck.

Live browser baseline: House Commerce contains 7 proceedings, 26 members, 73 agenda entries and 7 published documents. Careers & Workforce contains hearings/referrals but had zero linked roster members despite stored official directory assignments. The broader audit found that general committee press releases were not being imported by the hearing/document-only watcher; that expansion is being developed separately.

## Source limitations requiring honest acceptance

The Joint Committee on Taxation returns HTTP 403 to the server and already has a reviewed upstream-access exception. Do not report it healthy or bypass its access controls. Historical disabled failed sources remain in the source registry for evidence and must be distinguished from enabled feed failures.

Ways and Means' October 6 field-hearing page and September 29 advisory both publish **9 AM Central (14:00 UTC)**, contrary to the imported 13:00 UTC. The explicit first-party correction must be persisted through the observation ledger and checked after refresh. The committee advertises a YouTube stream that starts with the hearing; advertised/scheduled does not prove server capture eligibility.

Official references: [field hearing](https://waysandmeans.house.gov/event/full-committee-field-hearing-the-one-big-beautiful-bill-delivering-for-small-business-manufacturing-and-working-families/), [advisory](https://waysandmeans.house.gov/2026/09/29/chairman-smith-announces-field-hearing-on-the-one-big-beautiful-bill-delivering-for-small-business-manufacturing-and-working-families-collierville-tn/), [House Administration joint committees](https://cha.house.gov/joint-committees), [China Select Committee](https://chinaselectcommittee.house.gov/), [January 6 Subcommittee Clerk record](https://clerk.house.gov/committees/QJ00).

At this record's creation, recording/web promotions and final authenticated acceptance were pending. A successful build or this qualification record alone is not a deployment receipt.
