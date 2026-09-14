# Phase 8 release qualification

Engineering deployment and internal pilot verified at 2026-09-14T11:48:41.949029+00:00. Current client configuration, human acceptance and outward delivery remain pending.

Pending explicit approval: existing Clerk capiro JWT omits the verified organization admin role; normal-template administrative import remains blocked. Internal import used the owned reviewer native signed admin session.

| State                      | Evidence                                                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| implemented                | News/personnel, Florida budget research, three briefing templates, exact review and governed existing delivery path.                                                                                                         |
| merged                     | PR 1635, PR 1636, PR 1637, PR 1641 and PR 1643; exact qualified source 83549b51d38674cdcb3bb7c022c476a07b043fb5                                                                                                              |
| deployed                   | Five application services, two additive owner migrations and existing worker revisions qualified and deployed.                                                                                                               |
| tenantEnabled              | Capiro internal pilot only; three independent Phase 8 feature flags.                                                                                                                                                         |
| clientConfigured           | Current client/category/recipient review pending. 38 definitions and five families applied only to the internal technical pilot.                                                                                             |
| sourceQualified            | Four partial RSS feeds; five fiscal PDFs / 609 pages / 485 projects / 1,945 amount observations; 201 personnel observations. 70 publishers remain unqualified; NewsCatcher inactive.                                         |
| scheduledExecutionVerified | Actual internal EventBridge report-worker executions and durable private preparation receipts; from-now news monitor evidence recorded separately.                                                                           |
| deliveryVerified           | Existing queue tested with synthetic provider acceptance. Live outward delivery remains disabled and unsent.                                                                                                                 |
| clientAccepted             | Pending independent human/client review; optional Analyst workflow excluded.                                                                                                                                                 |
| adminImportIntegration     | Pending explicit approval: existing Clerk capiro JWT omits the verified organization admin role; normal-template administrative import remains blocked. Internal import used the owned reviewer native signed admin session. |

## Qualified source and checks

`83549b51d38674cdcb3bb7c022c476a07b043fb5`; tree `5774f3e0612be0da1c2de93119395388d1873b83`. Implementation [PR 1635](https://github.com/neo-capiro/capirov2/pull/1635), integrity fixes [PR 1636](https://github.com/neo-capiro/capirov2/pull/1636), runtime correction [PR 1637](https://github.com/neo-capiro/capirov2/pull/1637), fiscal units/columns [PR 1641](https://github.com/neo-capiro/capirov2/pull/1641), and scheduled fiscal reconciliation [PR 1643](https://github.com/neo-capiro/capirov2/pull/1643) are merged. These pin current tracked projects through scheduled generation, discover work under its actual tenant/owner row-security context, preserve exact fiscal observations within Meri's evidence budget, and retain the Workspace receipt/link through approval and conversation reload.

717 Phase 6–8 tests and 19 additional Meri approval UI tests passed, along with five typechecks, 467-migration clean/populated rehearsals and actual packaged ARM64 entrypoints. GitHub jobs could not start because of the account billing/spending restriction. Native qualification passed independently.

The first final-source packaging attempt was interrupted by Docker Hub HTTP 429 after source qualification passed. The successful packaging retry reused that exact-source qualification and verified byte-identical official ARM64 base-image manifests through public ECR. Reused application images have identical runtime/dependency sources at the qualified release.

| Application         | Digest                                                                    | Build source                               |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| api                 | `sha256:baa74d87a49ee383695142a9a8cf4acaacd9792b266980d78b246c6b239426cd` | `de56f9bdd3a559331f5b76af0b619a6a91c19781` |
| intel-api           | `sha256:00843567f128f564f11d87abe1de98ec9de69a27c28546b69b5f283171e6b631` | `83549b51d38674cdcb3bb7c022c476a07b043fb5` |
| workspace           | `sha256:bc259f869cfe2bcd89654ec38795d3b85e4452ba4acde2084454bb4a3dcdd806` | `edf05fce65720ed89bc8066b9414bba985d95641` |
| meriv2-orchestrator | `sha256:ff0d26f347ce670a8195826cfc2992cb975d325be435a4317e6e5a3530de0066` | `eb675fc25d46b00f8fb7266be30489066c269f81` |
| web-vnext           | `sha256:f7f7e0556993fd3ead6bf65928a3d17d602c5a79c0566b4822b55d0a10ca8909` | `de56f9bdd3a559331f5b76af0b619a6a91c19781` |

## Live rollout and pilot

Both additive owner migration tasks exited zero. Prior ledger rows and 89 pre-existing checksum discrepancies were preserved unchanged from the accepted Phase 7 baseline. The live ledger retains legacy duplicate names; 467 describes the source rehearsal, not the live row count. All four backend services settled before scheduler targets and Web were updated. Actual task digests and healthy targets were checked.

| Service                        | Initial qualified revision          |
| ------------------------------ | ----------------------------------- |
| capiro-dev-api                 | `capiro-dev-api:357`                |
| capiro-dev-intel-api           | `capiro-dev-intel-api:42`           |
| capiro-dev-workspace           | `capiro-dev-workspace:34`           |
| capiro-dev-meriv2-orchestrator | `capiro-dev-meriv2-orchestrator:52` |
| capiro-dev-web-vnext           | `capiro-dev-web-vnext:289`          |

Internal activation revisions: `capiro-dev-intel-api:43`, `capiro-dev-intel-api-legiwatch-reports:9`, `capiro-dev-api-sync-rss-intel:10`.

Latest Intel correction revisions: `capiro-dev-intel-api:46`, `capiro-dev-intel-api-legiwatch-reports:12`. Their actual image digests, settled services and healthy targets were verified. API, Workspace, Meri and Web reuse images whose runtime/dependency source is unchanged at the final qualified commit.

Only internal tenant `17b63099-bc0f-4ac5-b596-496161e9481e` has the three new tenant flags enabled. Its exact 38 definitions are accounted for with six active RSS monitors and 32 paused definitions. Five alert families remain separate; only the Daily Briefing configuration prepares automatically. No captured recipient list was activated. Current Rubin Turnbull client/category/recipient decisions remain pending.

Two early scheduled drafts failed fiscal factual review; a third was generated by an older worker during scheduler handover. All remain as superseded QA history. The accepted version composes each monetary statement from a qualified observation with explicit chamber, fund, stage, allocation and source references. Original provider output remains auditable; model budget interpretations are omitted and the edition discloses its numerical-analysis limits. Full chat independently passed exact-dollar and original-source citation review.

The existing internal five-minute EventBridge rule produced actual private preparation and Workspace receipts. All six active monitors advanced through a complete from-now window; current-feed coverage remains partial. The global report rule remains disabled. Existing RSS scheduling retains its hourly cadence; NewsCatcher request cap remains zero. No Phase 8 outward delivery was queued or sent.

Authenticated browser evidence covers disabled feature boundaries, exact 38+5 replay, budget comparison and revision conflict, three briefing templates, normal navigation and narrow screens, private draft replay, actual Workspace editing and edited-output preview, immutable internal approval, full-chat Meri budget tools and governed private draft creation with its durable link recovered after reload. Owned reviewer sessions were revoked after each verification.

The user-facing release package contains the completion report, deployment record, source package/reconciliations, five configuration decisions, all 40 source alerts, ten Figma exports, browser/screenshots, native/migration/scheduled logs and a SHA-256 evidence manifest. `phase8-recovery.md` and exact target JSON files provide an unexecuted recovery procedure that preserves additive data and prior RSS work.

Do not infer accepted vendor cutover, full publisher/history coverage, human relevance scores or delivered email from this technical release.

## Final serving state

| Service                        | Task revision                       | Healthy targets |
| ------------------------------ | ----------------------------------- | --------------- |
| capiro-dev-api                 | `capiro-dev-api:357`                | 2               |
| capiro-dev-intel-api           | `capiro-dev-intel-api:46`           | 1               |
| capiro-dev-workspace           | `capiro-dev-workspace:34`           | 1               |
| capiro-dev-meriv2-orchestrator | `capiro-dev-meriv2-orchestrator:54` | 1               |
| capiro-dev-web-vnext           | `capiro-dev-web-vnext:289`          | 1               |

The final read-only service/rule observation was recorded at 2026-09-14T11:48:41.949029+00:00. The accepted scheduled configuration version is 4, with private editable draft `d86f7beb-86f1-4f16-9017-858a56f9d28d`. Earlier rejected editions remain preserved and clearly superseded.
