# Phase 6 release qualification and deployment

Phase 6 application source `7404839e5a5a1a3f6543f8651303a00fbf9c60df` (tree `6d5df430e0166bb07df40a64069fe731004a3bbc`) was merged in [PR #1624](https://github.com/neo-capiro/capirov2/pull/1624) and deployed to `capiro-dev`. Main through `99ca7f8b07c7cec4d14b3db60c13094bc37c764e` is preserved, including the newer meeting-preparation and managed-connector changes. Merge commit: `c72ba417ba8cd4bb8c9aa96601c51adae0673f8c`.

## Qualification

- **575 Phase 6 regression tests passed**, zero failures/skips, on exact ARM64 source. Meeting/artifact, API-route and UI checks added 150 passing regression tests.
- API (all release project configurations), Intel, Workspace, Meri and web type checks passed. Related owner/infra tests passed.
- Clean and populated owner/default-ACL rehearsals applied **460 migrations each**. Imported/manual assignment and Phase 5 publication context remained intact; immutable grants were verified.
- Native CodeBuild `capiro-build-intel-api:acd00acf-3bac-46f4-ba79-04a3ca22f3cf` **SUCCEEDED**, including updated API/web image builds and four backend module/native-Prisma probes. Intel, Workspace and Meri retain previously qualified images after verifying their application, Prisma schema and dependency sources are unchanged. The manifest records each image's actual build source.
- Separate immutable-image verification `capiro-build-intel-api:80402356-8c73-476d-8e88-a41ecf32874c` **SUCCEEDED**: owner migration entrypoints, four module/native-Prisma probes, web HTTP 200 and the real report-worker entrypoint with gates off.
- 24 earlier component-browser checks cover desktop/narrow layouts, focus behavior, mixed decisions, stale callbacks and recovery. These use synthetic fixtures.

| Application | Pinned image digest | Deployed task |
|---|---|---|
| api | `sha256:7654ac3cc33e9222e12023ff8a1319d1f299ed43381f3c6965e4f0820cb4238e` | `capiro-dev-api:353` |
| intel-api | `sha256:757fce5914dd516c556f3904bb835187ab1d8feae977644505a7465ca84f94a6` | `capiro-dev-intel-api:38` |
| workspace | `sha256:30dce15462baf9dbf2f08f399120f7a7d83cd837ce74d47298cfce64cd288c3f` | `capiro-dev-workspace:32` |
| meriv2-orchestrator | `sha256:7e3fc96aa22eede0ac5962f69568e120cdae4c3718cd29ec2abf030df8b6105d` | `capiro-dev-meriv2-orchestrator:50` |
| web-vnext | `sha256:8bd160001f617424f03b1917ec222e9805c59edd06b9e8fd9a6b3685627e9c65` | `capiro-dev-web-vnext:281` |

All service deployments completed at their exact digests with the expected healthy target counts. Existing network settings, desired counts, roles and secret references were preserved. Separate API and Engagement releases completed before Phase 6 task registration; their completed state was re-audited and used as the rollout baseline. Phase 6 did not deploy Engagement. All images use registry `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/`.

## Live migration and preservation evidence

API → Intel → Workspace migration tasks exited zero. All eleven Phase 6 migrations are applied with exact source checksums; 11 migration rows were added during the observed release window. No applied migration identifier/checksum or failed-history row was rewritten. The API migration task pins the previously qualified `d64c3576d010a9707ffd9ad09d409785f9a9b9ff` image; its Phase 6 migration files and Prisma schema are identical to this release. This keeps the unrelated `20260913130000_meeting_artifacts_auto_approved` approval backfill outside the Phase 6 operation. The Workspace task invokes the packaged Prisma CLI through the verified TLS launcher, SHA-256 `d7b508fbb359e96ba32ae83b5e7b3095e0097bb55f60bf3c70f627de91fc4d11`, avoiding its legacy auto-resolution wrapper.

- api: `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/9fd92163fc4c4cf789e376e2697e9585` — exit 0.
- intel-api: `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/1d27d3b00b894911a892aab5a5148fe3` — exit 0.
- workspace: `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/1b5f36a839844a928103faa65faf059e` — exit 0.

The final read-only audit verified unchanged counts and content hashes for:

- `intel_legiwatch_folder_bill`: 1738 rows; content hash `940715157484598108fa5ee07524ac01`.
- `intel_legiwatch_folder`: 211 rows; content hash `1e28ef0cf02dac2b8309a3182caaedf0`.
- `intel_legiwatch_staged_configuration`: 1404 rows; content hash `1f339f0711c611023fd9554211fe3a12`.
- `intel_legiwatch_source_mapping`: 3350 rows; content hash `418c96cdccf9974268da8e35dd9ad972`.
- `intel_legiwatch_promotion`: 0 rows; content hash `empty`.
- `intel_hearing_publication`: 5 rows; content hash `5feadae9a79271a9df1d76ebbfd77776`.
- `state_bill_published_record`: 16534 rows; content hash `bbaddd90fc7b09922d90066537a17ff2`.
- `official_hearing_transcript_revision`: 0 rows; content hash `empty`.
- `published_record_source_observation`: 16309 rows; content hash `d89fab9bf380d02499f800a786a801c1`.
- `legiwatch_record_document`: 0 rows; content hash `empty`.

This includes all **1,738 existing folder assignments** (client plus internal fixtures), imported configuration/mappings, public source observations and five retained hearing publication versions. The 190 definitions, ten rules, historical channels, folder-owner counts and existing delivery/report state are unchanged. Zero active browser/server recordings were present during the release audits.

The independent meeting-artifact approval backfill completed before the refreshed Phase 6 registration baseline, at `2026-09-14T00:24:59.518Z`. An additional independent meeting-note approval migration landed on main during rollout; its exact existing-row SQL was inspected and recorded, and Phase 6 did not apply it. Neither changes the qualified application runtime or Prisma schema. The separate web release was also preserved before the Phase 6 web rollout; the final task uses the qualified image and matching `CAPIRO_WEB_RELEASE_SHA` metadata.

## Deployed verification and scope

The registered report-worker task `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/7efb499ea6fc471ba80efc38a43986a6` exited zero with keyword discovery/intents/internal workflows disabled, zero new report work and zero delivery attempts. The two existing report schedule targets now reference the qualified worker revision and remain **DISABLED**. Other schedules and targets were unchanged. This is a manually dispatched check of the registered worker, not a scheduled client pilot.

Fresh, short-lived Clerk sessions for the established internal reviewer verified deployed folders/hearings/client reads, denied unauthenticated keyword access and closed feature gates. Each created session was revoked.

A temporary **internal discovery-only preview** evaluated **1897 canonical Florida bills** in session `2026` across 76 pages. Query `education` matched 59 bills in the explicit title scope; 0 title evaluations were incomplete. The repeated first page was identical and all preview responses reported zero effects. Duration was 10.39 seconds; this is one observed preview duration, not p95 latency or a relevance score. A separate document-scope sample retained visible coverage gaps. Desktop/narrow screenshots show the deployed review panel.

The internal preview flag was disabled afterward and a fresh authenticated session confirmed the route was closed again. Final audit: zero Phase 6 rules, decisions, workflow actions or Workspace source-action outputs; all four new runtime gates and all new tenant features off. No imported rule or client recipient/channel was activated.

## Remaining client acceptance

Deployment and internal preview verification are complete. Client automation remains paused pending chosen current owner/folders/jurisdiction/session/document scope/aggregation, reviewed relevance labels (proposed 100 bills across three folders), a real scheduled pilot, and authorized current staff channels. Full-document automation remains blocked where coverage is incomplete. Alert-35 is empty; alert-38 selects unsupported expression 32340; alert-36 retains end-of-day cadence. No client relevance, manual-versus-assisted timing, p95 latency or provider delivery acceptance is claimed.

GitHub Actions jobs could not start because of the account payment/spending-limit restriction. Successful native CodeBuild evidence is separate. GitHub accepted the ordinary merge; no admin bypass, branch-protection change, fabricated check status or IAM expansion occurred. Build evidence is retained through existing CloudWatch logs and the local release package.
