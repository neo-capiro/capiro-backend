# Retained-head successor native evidence independent review

Decision: ACCEPTED for the bounded native qualification described below. No remaining evidence, exact-source-pin or cleanup blocker was found. This receipt does not authorize activation, deployment or production changes.

Reviewer: `/root/independent_source_review`, independent of implementation, native execution and publication.
Recorded: 2026-10-17 01:59:57 UTC.

## Exact tested source and run

- Published commit: `81dd0313760c0f18858cb8aa2ad73191da71f138`.
- Git tree: `81a3ea3ed95bdaf2410301a922cf4431acece7d7`.
- Parent: `5591eac08428635bf911a0aa32acea859e2a5d95`.
- Separate draft: https://github.com/neo-capiro/capiro-backend/pull/51.
- Run: `14317236bdb14f3b8c39a39217f6a9c3`.
- Evidence: `objective-retained-head-native-evidence/14317236bdb14f3b8c39a39217f6a9c3`.
- Driver: `run-isolated-retained-head.ps1`, SHA256 `76c30a3fa8a3cf8b4f2ebfb41212db337a0004c58ab6d37de5759a417795b945`.
- Prior exact source review: `objective-retained-head-final-independent-review.md`, SHA256 `e3eec6f7e027d1b4d4b93aef6946abedc3c457106484887186e59af42a561c6d`.
- Publication packet: `retained-head-reviewed-source.json`, SHA256 `9872e514fd972a5e462561a618f2a3100c2fe6c730ffe88741f9f472ee19a0e3`.

The source and native checkouts both independently resolve cleanly to the published commit and exact accepted tree. Their parent matches the previously native-qualified PR50 source. The original `objective-planner` and `objective-native-b8` checkouts remain clean at `5591eac08428635bf911a0aa32acea859e2a5d95`. There is no post-test source commit. Packet, source receipt and frozen driver hashes remain unchanged.

## Test and source-plan evidence

`commands.log` records 52 child exits, all zero. Offline source build/collection/preflight records 13 passed and 19 native cases skipped. The explicitly enabled run records two suites passed and **20/20 tests passed**, with zero failures/skips: seven Core cases, 12 existing native Planner cases, and one default-off case. `outcome.json` records native suite exit zero and this exact published commit.

The enabled Core case includes the strengthened immediate post-consent read over an older v2 anchor, exact current consent/control/receipt, unchanged private resource custody, preservation of an explicit synthetic human edit to an existing native project, and denial of an additional retry with unchanged audit. A separate server runtime then consumes the durable accepted generation without using the browser/request proof callback, produces native v3 accounting and a final Core applied read, and a further real Objective/consent advance exercises the immediate read over complete older v3-to-v2 custody. These assertions passed at this exact source pin; they are no longer inferred from source-only checks or from the parent's earlier run.

All 38 source-plan units were independently recomputed against Git at the tested commit: Git blob IDs, original bytes/SHA256 and selected bytes/SHA256. The plan contains four focused Core selections, all 28 Strategy migration files and six Objective migration files. Its three explicit narrow selections are exact vector-extension omission, ethical-wall DDL before the unrelated embedding backfill, and the exact client composite index; the other 35 units use complete file bodies. This remains a focused baseline, not full Core migration replay.

The plan fixes PostgreSQL 16.15 and task-owned `127.0.0.1:56455/planner_qa` under `objective-retained-native/.objective-planner-native`. It retains installed `uuid-ossp`, `citext` and `pg_trgm`, explicit vector omission, source-built package resolution and capacity/ownership guards. The runtime is the non-superuser, NOBYPASSRLS, NOINHERIT `capiro_app` role without fixture-owner membership. Native catalog/role checks passed, as did the Core suite's explicit immutable-ledger UPDATE/DELETE refusal assertions. No ACL, migration, native guard or driver was relaxed for this run.

The schema2 ownership manifest pins source, native workspace/data path, database OID 16386 and process 26664. Exact PID-file and catalog start fields both equal 1792202318 in this run, before manifest creation `2026-10-17T01:58:45.232Z`. This is valid exact clock equality; the guard still supports distinct independently observed clocks without timing tolerance. The sanitized PostgreSQL log corroborates private startup and orderly shutdown. Its single expected delegation check-constraint negative matches the passing negative test; it is not an ignored suite failure.

## Cleanup and sanitization

`cleanup.json` reports exact cluster removal, private listener removal and retirement of test credentials with the cluster, all true. The pre-finally `outcome.json` marker `cleanupPending:true` is resolved by that final record, `postrun-verification.json` and fresh independent system checks.

Fresh observations confirm process 26664 is absent, the exact native root is absent, and there are no listeners on 56455. Read-only `netstat -ano` retains the original host PostgreSQL listeners on IPv4 and IPv6 port 5432, both PID 4936. Free space was approximately 5.54 GB. The four source/native checkouts remain at their respective clean pins above.

All seven retained evidence files were scanned for credential-bearing PostgreSQL URLs, password assignments and the generated 96-hex password pattern; no matches were found. The manifest ownership token is retained public ownership metadata, not a database password. This is a bounded pattern scan rather than a universal secret-detection claim.

## Remaining qualification limits

The current request-proof adapter/transport, Strategy-generation consent issuer and Meri/provider custody observations remain explicitly synthetic. The human-edit scenario uses a declared synthetic edit of a real existing native output, not an authenticated UI interaction. Running the server consume without a browser proof callback demonstrates the source/runtime separation exercised here; it is not a full browser-process closure or real socket/commit-ack failure test.

No real HTTP/JWT/session custody, protected production issuance, Meri SDK/provider execution, frontend acceptance or full Core migration replay is qualified. The status implementation remains narrow: immediate current consent with no current operation; current terminal/queued/leased cases, intervening unproved consent chains and unknown added output identities remain conservative. Execution remains opt-in/default off. No AWS, production application database, deployment or shipping action was performed by the reviewer.

This receipt qualifies only the exact PR51 source above. The earlier PR50 success and its preserved partial/failed attempts retain their own source pins and outcomes.

## Evidence SHA256

| File | SHA256 |
| --- | --- |
| commands.log | `41b2f1fb694a1cb5b6750485e37711f84c06fa5c5c7a73331f6c4616aeae20f8` |
| sourceplan.json | `43568af44a14700678ed733d07da8475162ec10362b551757ab4c9873f427bf8` |
| owned-target.json | `d4c0a8d99f41980b55cca346f0e0c98f0f0c6f518fa6773e6ba7d8b90a97fcfa` |
| outcome.json | `d72846f865620531882c68e1d33c29aa257fcd6676964715fca8dc9c7b7fd3ec` |
| cleanup.json | `ee76049a5556a44ac365469cbac63cefa78c12548758b11f3266093b18c949d0` |
| postgres-sanitized.log | `4aa3ad70efc9519a013d38757b042ec25929579f7afd24d04e6624eabce7f285` |
| postrun-verification.json | `5ed197e7419cd01590578a1c70c4864add383b9dffd0b510f1e8b5cef5fcd2bb` |

Only this separate evidence review receipt was written during final evidence review. The reviewer did not rerun tests, execute a driver or SQL, create credentials, change source/index, stage, publish or retry any action.
