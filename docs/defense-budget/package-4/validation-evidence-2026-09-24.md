# Package 4 validation evidence

## Executed gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused API regressions | PASS | 5 suites / 127 tests: exact/alias mention matcher, congressional action inventory, pure evidence reconciliation, qualified readers, and GovInfo pagination/qualification. |
| Schedule and dispatcher contract | PASS | 1 suite / 13 tests, including all Package 4 rules disabled and both worker verbs registered in the API image entrypoint. |
| Fresh-schema migration | PASS | All 423 migrations applied to a newly created disposable PostgreSQL database, including `20280924030000_federal_legislative_evidence`. |
| Package 4 database qualification | PASS | Unknown-code replay, historical suppression, same-code changed language, retry no-op, uncertain-delivery retry, partial-response safety, removal/reinstatement, first action after an explicit baseline, qualified current reads, lifecycle reads, append-only trigger rejection, and fully processed outbox. |
| Qualification counts | PASS | 3 revisions (two complete, one partial), 5 observations, 2 mentions, 6 lifecycle events, 6 processed outbox rows, and 5 delivered tenant alerts. |
| Prisma schema | PASS | `prisma validate` and client generation. |
| CDK TypeScript | PASS | `tsc --noEmit`. |
| API TypeScript | SCOPED PASS | The full command reached only pre-existing/unavailable workspace package errors under `@capiro/defense-domain` / `@capiro/defense-contracts`; no Package 4 file reported a type error. Focused Jest compilation and the executable database qualifier compiled and ran the Package 4 paths. |
| Patch hygiene | PASS | `git diff --check`. |

The exact machine-readable qualification is [qualification-2026-09-24.json](./qualification-2026-09-24.json), run `f75f81cf` against disposable database `capiro_package4_20260924`.

## Independent review corrections

The final Hermes review found and the release fixed two gaps before merge:

1. Partial/unreadable receipts are now non-current observations. They retain publisher evidence while the current complete revision, qualified relationships, and compatibility projection remain unchanged.
2. Congressional action alerts now use a durable completed-inventory checkpoint. A complete empty baseline can therefore emit the first later action, while first-time historical hydration remains quiet.

## Dark-release posture

All Package 4 collection/delivery schedules have `enabled: false`. The collection worker additionally refuses `--commit` unless `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED=true`. The recurring commands contain no `--historical`; activation requires a deliberate manual `--full --historical` baseline first.

The Package 3 congressional governed-input/proof gap remains unresolved. Package 4 runtime deployment therefore does not constitute source activation, production corpus qualification, or a claim that congressional semantic publication is complete.

## Source control and AWS deployment

- Pull request [#1776](https://github.com/neo-capiro/capirov2/pull/1776) merged to GitHub `main` at `a57150eaa973b93b8871bdcd8c03b1994230dcfe`; local `main` was fast-forwarded to the same commit.
- GitHub-hosted checks failed before acquiring a runner (no runner name and zero steps), matching the repository billing/spending-limit outage. This is CI infrastructure failure, not a passing signal; the executed local and AWS gates remain the release evidence.
- Native ARM64 CodeBuild `capiro-build-intel-api:183f0e1f-d92c-4165-b292-ff69f4d5d79e` resolved the exact merge commit and succeeded. It pushed API digest `sha256:f50d5f796534596a6d1c3581381c51fbcfca3d0caa84a48bfb488ec4451f1934` under the immutable SHA and Package 4 tags.
- Migration task `dbb54ed4b0304c5b9e301df6ab3b7f86` used task definition `capiro-dev-api-migrate:132`, applied `20280924030000_federal_legislative_evidence`, and exited 0 before the API service changed.
- API task definition `capiro-dev-api:446` binds the exact digest and merge identity. ECS completed the rollout at 2026-09-24T19:26:11Z with desired/running/pending `2/2/0`; both tasks and both replacement load-balancer targets are healthy.
- Sync task definition `capiro-dev-api-sync-jobs:32` binds the same digest and merge identity with `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED=false`. Read-only one-off proofs `4d3f5992705147d6b56846eb85b71bf8` and `a505c1759b874255a5ac65ab755b0402` exited 0: the outbox had zero pending rows, and BILLS sync stayed in `DRY_RUN` with no checkpoint/source call.
- Live EventBridge inventory returned no Package 4 collection, reconciliation, or outbox-drain rules. No production corpus fetch, lifecycle event, alert, or canonical financial write occurred during deployment.
