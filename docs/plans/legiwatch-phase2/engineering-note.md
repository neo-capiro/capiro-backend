# LegiWatch Phase 2 — implementation record

Implementation base: `c3961988df0403061a1048fe3a2fbf60eee1c021` on
`agent/legiwatch-phase2-client-reports`. All 84 packaged evidence hashes and
the separate handoff hash were verified. Captures and real mappings remain
outside source control. No AGENTS.md exists in this repository or workspace ancestors.

## Ownership and contracts

Intel owns operational report definitions, immutable runs, distribution aliases,
subscriptions, occurrence claims and delivery intents alongside its existing
folders. API retains canonical legislative facts and its hearing digest. The
Digest entry point uses a typed bill-report adapter to Intel; it never directly
reads private Intel report tables. There is one authoritative bill-report run.
External contacts are distribution aliases, not new users or duplicate CRM
records. Source aliases with the same destination retain separate identities.

Reports use live authorized memberships and source repository batch reads.
Captured staging rows remain inactive historical evidence; promotion records
link them to draft operational definitions without overwriting local edits.
Two explicit flags default off, including internal tenants:
`legiwatch_reports_updates_v1`, `legiwatch_report_delivery_v1`.

## Entry check

Phase 1 PRs #1591 and #1592 are merged. Read-only AWS inspection confirmed account
967807252336, us-east-1, cluster capiro-dev, completed HTTP rollouts:

| Service | Task revision | Running image digest                                                    |
| ------- | ------------- | ----------------------------------------------------------------------- |
| API     | 320           | sha256:f84f9362557e3a2277935a948d331d84e50351ff6ca40cdf2309114d01cd2545 |
| Intel   | 29            | sha256:36f8be7628330dcd1316d8213452fdebf0ce729b5760805166057298bab5f5d6 |
| vNext   | 263           | sha256:0e1b02098389cd52bf3a1fe2b2199d252752960c58e6ade17c845206cc07a587 |

Read-only database inspection confirmed all three Phase 1 migrations applied,
210 folders (81 archived), 1,736 assignments / 798 distinct mapped FL 2026 bills,
and seven resolved folder owners in the pilot tenant. Phase 1 folder and Intel
ownership flags are enabled. Six report definitions, 25 lists, 80 contacts and
51 memberships remain staged. All 1,897 canonical FL 2026 bills inspected had
unknown source-check state, so report delivery is not yet source-qualified.

The existing detector runs every six hours in API; emission runs twenty minutes
later in Intel. Intel daily/weekly digest targets share an older worker image,
digest `996d4e49a00df668a3a2aa5c835c6a5eb0e49eeb57cef8b41106b52deeca5207`.
HTTP deployment alone does not upgrade these jobs. The existing LegiScan drain
runs hourly at minute 30. None of these observations proves five-minute
source-to-alert latency. Phase 2 must not release old shadow notifications or
change hearing schedules. Runtime snapshots and real user mappings stay outside Git.

The operator inspected has no current pilot tenant membership. Qualification
must not impersonate one of its mapped staff owners. The internal-only controlled
draft command verifies actual membership, a fresh canonical bill, and uses the
operator's own folder with no recipients.

## Qualification status

The implementation includes report generation/export, versioned recipient
review, durable daily occurrences, recovery, scoped source refresh, exact
published-record rules, and Capiro UI entry points. Runs retain the exact HTML
and plain text together with their source facts. Later rendering changes cannot
alter historical exports or approved delivery content.

Native ARM64 qualification of `e43d9d3d412fa845ee86db480410f02dba652dd9` passed:

- 34 report/domain/PostgreSQL tests and 6 canonical source tests;
- 17 saved-hearing SQL tests, 17 Phase 1 folder/import tests and 2 source-document tests;
- 75 API suites / 989 tests, 71 Intel suites / 763 tests and 84 web files / 800 tests;
- sequential API then Intel migration replay and both migration-entrypoint/import-runner checks.

All in-scope test groups have zero failures, skips and todo tests. CodeBuild
`78a38590-6237-459f-b83a-d079c14122a0` records the complete qualification results.
The three scoped package typechecks and five dependency builds passed in native
build `381ee075-8445-4f0b-bdc3-219471c9c5f0`; subsequent application source is
identical. The only later test change replaces elapsed-runtime assumptions with
explicit record-activation timestamps. Native vNext build
`791967c5-1b1b-47af-b04c-e7fca8ac26ab` also passed 92 foundation/strategy compatibility
tests and a production web image build. Main's subsequent documentation cleanup
is retained without changing qualified application source.

The Windows API run's transaction-start timeouts did not recur on native Linux.
Explicit web cleanup and fresh matchMedia defaults isolate reused test environments.
The native harness preserves the localhost guard and uses a separate empty
database for saved-hearing fallback tests. An early harness encoding issue and
the timing fixture failure were corrected before the complete passing run.

GitHub Actions jobs did not start because the account reports a billing/spending
limit problem. These are not code-test failures, and independent CodeBuild
evidence does not mark those GitHub checks green. The source bundle was verified
against every Git blob and file mode before extraction/build; no GitHub credentials
or IAM permissions were changed.

Fresh runtime inspection found that both existing LegiScan workers referenced
missing API image `12a2ae760b31…`, causing a container-pull failure before ingestion.
Release preparation includes replacing both source-drain and priority-masterlist
images while preserving their hourly schedules, source scopes and quotas. The API
repository's five-image cleanup policy now has a bounded exception for up to 20
explicit `legiwatch-runtime-*` service/worker/rollback images. Existing protections
remain intact, and the available Phase 1 rollback/detector images were retained.
Restoring the missing old source-worker digest is not a valid rollback.

No Phase 2 cloud migration, service/worker rollout, promotion, subscription
activation or external send has occurred at this qualification checkpoint.
SES production sending is enabled and the existing sender domain is verified;
this is configuration evidence, not delivery acceptance. Capture totals are not
operational totals. The release record must separately list actual task/image
revisions, flags, scheduled execution, source coverage and client acceptance.
See [acceptance.md](./acceptance.md) for P2-01–P2-23 and
[operator-runbook.md](./operator-runbook.md) for deployment, operation and rollback.
