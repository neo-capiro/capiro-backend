# Phase 7 release checkpoint

Recorded 2026-09-14T03:58:59.589489+00:00. The implementation is merged and deployed, with research enabled for the internal and Rubin Turnbull workspaces. **The client rollout is not complete:** current client configuration review, independent human qualification and client acceptance remain pending.

| State | Result and evidence |
|---|---|
| Implemented | Research, exact comparison, legal-source imports, rule dates, selected history, private Workspace drafts and reviewed internal reports. Navigation includes cross-session selection, publisher-stage filters and reload recovery. |
| Merged | [1627](https://github.com/neo-capiro/capirov2/pull/1627), [1628](https://github.com/neo-capiro/capirov2/pull/1628), [1630](https://github.com/neo-capiro/capirov2/pull/1630), [1631](https://github.com/neo-capiro/capirov2/pull/1631), [1632](https://github.com/neo-capiro/capirov2/pull/1632). |
| Deployed | All five services healthy at the immutable images in `phase7-deployment-images.json`. The concurrent Strategies release 1629 is preserved. |
| Tenant enabled | Explicit `legiwatch_research_v1=true` for internal and Rubin Turnbull. The new monitoring process remains false. |
| Client configured | Pending: 174 memberships, 164 raw labels, 35 folders and six distinct rules reconciled. 161 membership rows have a retained qualifying edition; 142 have reviewable canonical requests. No membership or statute-rule promotion was applied. |
| Source qualified | Partial: 11/11 provider-listed documents for the two 2026 pilot bills and 1/1 for selected 2025 HB 823 are retained and extracted. The selected 2025 dataset contains 1,960 imported bills. FAR and legacy Word coverage remain partial; no human accuracy result is claimed. |
| Scheduled execution verified | One actual EventBridge tick of the existing internal schedule exited 0; all new gates were closed and all action/delivery counts were zero. The schedule was restored to disabled. |
| Client accepted | Pending. The recorded browser walkthrough used the established owned internal reviewer. It is technical verification, not client or independent human acceptance. |

## Live runtime

| Service | Task definition | Running | Health |
|---|---|---:|---|
| api | capiro-dev-api:356 | 2 | Healthy |
| intel-api | capiro-dev-intel-api:41 | 1 | Healthy |
| workspace | capiro-dev-workspace:33 | 1 | Healthy |
| meriv2-orchestrator | capiro-dev-meriv2-orchestrator:51 | 1 | Healthy |
| web-vnext | capiro-dev-web-vnext:288 | 1 | Healthy |

Primary API/Workspace/Meri source: `c553e36b31bfb35f98504400065c668d098a112e`. Intel: `ee0659610798b59842f50bec5b12765906ff0adf`. Web: `dc80390190fbf6ccc91e117dedac16abdba0d433`. Native primary qualification passed 649 Phase 6/7 tests and five application typechecks. The activation/history correction passed 12 checks. The navigation build passed 37 Intel and eight UI checks, and both the integrated Web build and the final spacing build passed 25 research/Strategies checks. The chapter-worker correction passed 11 source/inventory/checkpoint tests, the API typecheck and its packaged ARM64 entrypoint check. It uses worker `capiro-dev-api-sync-legiscan-bills:13` for the explicit retry; the serving API image and normal source schedules were preserved. These suites overlap; they are not added together as unique tests. GitHub Actions could not start because of the account billing/spending restriction; AWS qualification is separate evidence.

API evidence migration `20280913030000_legiwatch_research_evidence` and Intel private migration `20260913030000_legiwatch_legal_research` exited 0 through their qualified owners. No Workspace DDL was needed. Existing migration history was retained, including duplicate legacy rows and pre-existing checksum differences. No failed migration was auto-resolved or rewritten.

## Verified user path

The authenticated browser searched the selected documents, opened 395.003 and rule/date evidence, called the deployed Meri exact-comparison tool, rejected a changed revision, saved a private Workspace draft and replayed the unchanged request to the same draft. It explicitly selected the reviewed output into an immutable internal report and replayed that selection. It also used the actual right-bill/session controls with the 2025 source, recovered typed analysis and its saved draft link after reload, and captured wide/narrow layouts without horizontal page overflow. Existing folder, hearing and client reads returned 200; unauthenticated research returned 401. Explicit disabled research returned 404 in the earlier rollback check.

Measured automated cached calls in this run: search 235 ms, comparison 571 ms. This is not a measured human task-completion time. Original technical Workspace draft: `be3f148c-6115-4890-b093-dce065c12d56`. Reviewed internal report: `2ee531ee-65ca-4547-af05-eb7a90cdee05`. No external report, email, SMS, capture or outreach was sent.

## Remaining client work

Select the Rubin Turnbull workspace and open [Review imported setup](https://os.capiro.ai/legiwatch?tab=research&researchView=imports&jurisdiction=FL&session=2026&edition=2026). A current client administrator must own and apply the reviewed setup. The supplied review JSON contains exact staged IDs, hashes, revisions and expected versions for eligible rows; it does not apply them. Ten proposed corrections and nine unresolved identities remain explicit. Archived/read-only folders, unnamed rules, empty selections and unknown cadence remain preserved.

Complete the independent human source-review packet and its missing held-out coverage before activating matching. Its pinned JSON file SHA-256 is `868a2b0f399f2ca60d3ecba1438deb6396cb7896fab5357a31760f1162ab547c`; its review sample SHA-256 is `1a5272a201c2335962819f04268bfe9ad209a2531bed0c389291e790176ef2fc`. Do not create a human-qualification receipt from these automated checks. Then configure each of the six rules separately, confirm current recipients and cadence, establish a from-now baseline, and complete the actual client walkthrough. Outward delivery remains unrequested. A separate client historical export is required to migrate prior-session client assignments.

The package includes the source coverage matrix, all-row ledgers, historical manifest, exact-image and worker receipts, browser screenshots, Figma links, source-backed example, human review packet and operator runbook.
