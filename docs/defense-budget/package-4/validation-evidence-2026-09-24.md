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
