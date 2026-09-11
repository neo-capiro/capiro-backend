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
published-record rules, and Capiro UI entry points. Additive API and Intel
migrations replayed sequentially on disposable PostgreSQL. The latest dedicated
report qualification passed 32 tests; source PostgreSQL passed 3; the pure
source suite passed 3; Intel's broader scope passed 71 suites / 763 tests; report
UI passed 6 tests. All three package typechecks passed during implementation.

Broader release gates are still being qualified: the Windows API regression
run found transaction-start timeouts in existing concurrent hearing/digest
fixtures, while the web run exposed mounted-root cleanup across reused test
workers. These are recorded rather than treated as clean gates. The web setup
now registers explicit cleanup per environment; Linux CI provides the release
check. Separate fixture import duplication in main was repaired as a prerequisite.

No Phase 2 cloud migration, deployment, promotion, subscription activation or
external send has occurred at this candidate checkpoint. Capture totals are
not operational totals. See [acceptance.md](./acceptance.md) for P2-01–P2-23 and
[operator-runbook.md](./operator-runbook.md) for deployment, operation and rollback.
