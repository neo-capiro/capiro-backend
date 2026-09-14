# Phase 6 release qualification

Application source: `a9da9680e802e85c0318d7fe4a5cdbb99cbbe536`. Git tree: `ca5c2c7683675922b11a644ee8bb45bad7b7acbd`. [Draft PR #1624](https://github.com/neo-capiro/capirov2/pull/1624). Refreshed base: main `84c761590cab87c1d78a6e425ef08fd901603235`, including Phase 5 and the intervening Meri/meeting-preparation releases. Documentation added after qualification does not change apps/packages/scripts.

## Passed checks

- Exact raw source blobs/modes and target tree verified before native ARM64 qualification.
- **575 tests, zero failures/skips** in one native matrix: api 224 / intel 152 / core 51 / orchestrator 87 / web 61.
- API, Intel, Workspace, Meri and web release type checks; affected dependency builds and existing related owner/infra safety tests passed.
- Clean and populated owner/default-ACL migration rehearsals: 458 migrations each, including 11 Phase 6 migrations. Imported/manual context and retained Phase 5 source/publication payloads preserved; immutable history grants verified.
- Separate immutable-image job **SUCCEEDED**: `capiro-build-intel-api:d79cc188-5927-41c5-b281-e96a5c471268`. API/Intel migration entrypoints and the direct packaged Workspace Prisma launcher applied all 458 migrations. Four backend module/native-Prisma probes passed; web HTTP 200 returned HTML.
- Actual registered `task run-report-updates` completed against the isolated database with new gates off: zero created/processed/attempted/held, disabled keyword discovery/intents/internal workflow detection/execution and zero keyword delivery attempts. This is a closed-gate packaging check, not a live pilot.
- 24 actual-component browser checks at 1440 and 390 px; six Figma reference frames. Synthetic fixtures are not client labels or real delivery evidence.

| Image | Immutable digest |
|---|---|
| api | `sha256:c5d74b0c538cf46b4f4402a79d3027ec73c0b159f744c3aacc8b24161f3e6547` |
| intel-api | `sha256:332e9706ffb1a9555a11c40ed11066e0c390a0122ee1551295376987945b1fd7` |
| workspace | `sha256:4e1856b2027714421218487723cd56e1df2097b1efb19a4991f094c75a075aa0` |
| meriv2-orchestrator | `sha256:bd9c4123f0b55ad1965d7d8ac4fc8859882730f890f98d64be541a6799d73b5c` |
| web-vnext | `sha256:30c2a3b417f672c0015f23fa73157457c72c1dfd1e662dbbeaf385eb5510ec23` |

All images are in `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/<image>` and are tagged with the qualified source SHA. Pin the digests for rollout. The Workspace migration launcher uses the existing DB fields to compose TLS without printing credentials; verified launcher SHA-256 is `d7b508fbb359e96ba32ae83b5e7b3095e0097bb55f60bf3c70f627de91fc4d11`. Its exact invocation is in the private release package; see [operator-runbook.md](operator-runbook.md).

## Infrastructure result and retained evidence

Primary native build `capiro-build-intel-api:98696c9e-f59f-4cde-a8d1-b433abe828c3` finished **FAILED** because the CodeBuild role cannot `s3:PutObject` to the new Phase 6 evidence prefix. All qualification, five-image build/push and four backend module/Prisma commands completed before that upload. Both failed commands were evidence-upload commands. This is not relabeled a successful CodeBuild run. No IAM permissions were expanded. Existing CloudWatch logs and normalized results are retained in the local release package; the separate immutable-image job above succeeded.

GitHub's LegiWatch check on the qualified source [did not start](https://github.com/neo-capiro/capirov2/actions/runs/34780850911/job/103787474690): its annotation reports failed recent payments or an insufficient spending limit. Native checks do not override branch protection, and no merge bypass occurred.

Read-only live audits at 2026-09-13T12:24:40.714Z and 2026-09-13T20:33:35.723Z found unchanged staged rules/definitions/channel snapshots/mappings/promotions/folder-owner counts: 190 definitions, ten keyword rules, zero alert promotions. The later read found zero active browser/server captures. Refresh this state immediately before any authorized deployment.

## Not deployed, enabled or accepted

Nine local task-definition proposals cover five services, the existing report worker and three migration owners. Two existing report schedules remain disabled. No proposed task was registered, no service or scheduler was updated, no live migration ran, and no new flag/rule/channel was enabled.

Remaining gates are current deployment authorization and required GitHub check startup; then chosen current owner/folder/scope/aggregation/channels, client labels (at least 100 bills across 3 folders), full-document source qualification where required, a real scheduled pilot, provider receipt/opt-out/pause evidence, relevance and manual-versus-assisted timing/latency acceptance. The ten-rule ledger retains the empty alert-35 and selected unsupported definition 32340 in alert-38. Do not count these as activated or infer SMS consent.
