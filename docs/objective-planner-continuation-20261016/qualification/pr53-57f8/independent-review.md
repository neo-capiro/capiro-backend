# Independent final native evidence review: PR53

Review completed **2026-10-17 02:49:28 UTC**. This receipt is separate from, and does not alter, the immutable Meri portable handoff or its earlier recorded pending-native status.

**Decision: ACCEPTED. The evidence qualifies the bounded native Core/Planner behavior of the exact published head below. No remaining material findings in this run.**

## Exact source and reviewed procedure

- PR53 published head: **`57f8c8047a73df6d4a73351a98a5239f38240a24`**.
- Exact tree: **`cb2ac7d883290741e95d4dffa0f67406ed8e87e4`**.
- Parent: `81dd0313760c0f18858cb8aa2ad73191da71f138`.
- Source packet: `flow-integration-reviewed-source.json`, SHA256 `f5a8c04850bbd2c9d6486cbe54d6de9c6f8788ca4d5dbfd48cb998d7723ef9ba`.
- Independent source receipt: `objective-flow-final-independent-review.md`, SHA256 `f98d40ace3c408ab644ceb040b389929e5ef6a7c03a75161c31e161791f0136c`.
- Driver: `run-isolated-flow-integration.ps1`, SHA256 **`c7740fc37943e6c7bcdd4e1008b0e1b501d47ec2e3865cfbf814c168a9ae1279`**.
- Driver review: `objective-flow-native-driver-review.md`, SHA256 `15b14ad42a421d0ca165805e876679c0885f98e7072ede0646ee7cf80394458b`.
- Final run: **`objective-flow-native-evidence/8ad115502b154a41b33f9d59c38fc628/`**.

Before the coordinator's sole execution, I freshly checked both source and native checkouts clean at this exact head/tree. All 11 committed packet blobs match the reviewed source in both checkouts; the narrow native checkout materializes eight of them and intentionally omits only the Node-only owner test and two documentation files. Both full source and native checkouts remain clean at the tested head after the run. No post-test source or documentation commit is included in this qualification.

The driver hash remains unchanged. A second independent reader confirmed exact byte equality to the previously reviewed retained-head driver after only the three allocated workspace/plan/evidence path substitutions. PowerShell syntax parsing reports zero errors. The source-pin, role, port, ownership-token, PID/catalog-time, capacity, reparse-point and exact-path cleanup guards remain intact.

Fresh preconditions at 02:43 UTC showed the owned cluster root absent, private port 56455 free and 5,257,392,128 bytes free. The runner preserves its 2 GiB pre-start floor, 1.5 GiB runtime floor and 400 MiB cluster cap.

## Observed result

I read all seven final evidence files, the applicable checked-in native test bodies, and the procedure. A second independent reader also checked the evidence and qualification boundaries and reported no contradictions. Independent verification finds:

- **Offline preflight: 13 passed, 20 skipped**, across three passing suites and one skipped suite. This includes exact-source package builds and diagnostic-enabled native import/fixture collection before database initialization. Skipped native tests are not counted as native qualification.
- **Enabled execution: two suites, 21/21 passed**: 12 existing native runtime cases, eight native Core cases and one ordinary default-off case. Thus **20 actual native cases plus one default-off check** passed.
- **52 recorded external child exits, all zero**. The log identifies Node 22.23.3 and PostgreSQL 16.15. No failed test suite or unexpected permission failure appears.
- The frozen outcome records `nativeSuiteExit: 0` and the exact tested source pin. Its pre-finally `cleanupPending: true` is resolved by the separate final cleanup and fresh post-run observations; it is not left as an unconfirmed cleanup result.

The new native recovery case uses an actual immutable two-second C1 consent and waits for expiry using the database clock. Actual Core command handling issues C2 for the same current ready source, checks exact replay and payload conflict, reads the retained C2/C1/applied ancestry, and preserves the previous resources, consents, command receipts and Strategy control. A separate runtime applies a newly seeded saved generation under C2. The test checks that the original operation remains unchanged, all immutable consent/receipt rows remain intact, the new operation uses C2's exact identity and current source, and its deadline stays within current consent, admission, accepted issuance and publication ceilings. Actual Core read subsequently returns accounted state with the exact C2 command receipt.

The retained old operation remains readable without another effect. These checks qualify the bounded expired-unused-consent recovery; they do not renew the old saved generation or its deadline.

## SQL, role and authority boundaries

The source plan selects exactly **38 source units**: four focused Core baseline selections, 28 whole Strategy migration files and six whole Objective migration files. I independently reconstructed each original and selected byte sequence from Git at the tested head and matched all recorded Git blob IDs, SHA256 values and byte counts. These SQL source selections also equal the previously qualified plan's selections. The plan's historical `NOT_EXECUTED_SOURCE_PLAN` label describes the derivation artifact; the command log separately records the actual successful SQL execution.

The owned target is PostgreSQL 16.15 at `127.0.0.1:56455`, database `planner_qa`, beneath `objective-flow-native/.objective-planner-native/postgres-data`. Runtime role `capiro_app` is non-owner, NOINHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE and NOREPLICATION, without membership in `capiro_planner_fixture_owner`. Native tests exercise actual tenant-scoped Prisma transactions, immutable ledger privileges, membership/wall/source checks, full owner/receipt decoding, command kernel, runtime application and rollback/release fences. Immutable UPDATE/DELETE privileges are not broadened.

This is a focused baseline, not a complete Core migration replay. Installed SQL extensions are `uuid-ossp`, `citext` and `pg_trgm`; unavailable `vector` remains explicitly omitted. Exact-source shared and verifier packages are built into the owned directory; borrowed dependency installations do not supply newer package implementation output.

The sanitized PostgreSQL log contains the expected negative delegation-enabled check-constraint rejection, followed by successful suite completion and normal fast shutdown. The shutdown worker exit line is not an external driver or native suite failure.

## Sanitization and fresh cleanup

All seven files decode as UTF-8 and contain no disallowed control characters. Independent credential-value scanning found zero private keys, AWS key values, compact JWTs, literal password/database credentials or generated secret values. The ownership token is target metadata, not a database credential. No live credential files were read.

The schema-2 manifest independently records exact PID and catalog startup clocks, both `1792205077`, in the required chronological order before manifest creation. The recorded owned PID is **18236**. The PostgreSQL log agrees with that PID, version, loopback address, private port and completed shutdown.

Final `cleanup.json` records all three outcomes true: exact cluster removed, listener removed and credentials retired with the cluster. I independently observed at **02:46:41 UTC** that PID 18236 was absent, the owned root was absent and no 56455 listener existed. Both existing host port 5432 listeners remained on PID **4936**, IPv4 and IPv6. The coordinator's final post-run record at 02:47:42 UTC agrees and records 5,107,433,472 free bytes and clean source/native checkouts.

A further independent Git check at 02:48:23 UTC confirms the prior PR50 source/native checkouts remain clean at `5591eac08428635bf911a0aa32acea859e2a5d95` and prior PR51 source/native checkouts remain clean at `81dd0313760c0f18858cb8aa2ad73191da71f138`. Their historical packets and review receipts are preserved.

## Evidence hashes

| Evidence file | SHA256 |
| --- | --- |
| `commands.log` | `8ce67c1d7325a8d0b4c0d4987f7cf7ca68a82cf9c10baa76022026aaefc3aa73` |
| `sourceplan.json` | `a1c290f893a3bd935a08a89fc76bc14dbba5a3d4d110de6b4fec2742880f1a09` |
| `owned-target.json` | `2500fc6e36d139a01ebb43a782677c60ca723329e4e9c9c1910df6775cd27edd` |
| `outcome.json` | `ec6a174c524f97f54388dbc0efc2d3a6e4213aa62b7e2a2d6056e45160e03b7b` |
| `cleanup.json` | `ee76049a5556a44ac365469cbac63cefa78c12548758b11f3266093b18c949d0` |
| `postgres-sanitized.log` | `fa51d60d689f90fda50fcdbeb5728935c45fa339c757d5465ab78e180d74e8b9` |
| `postrun-verification.json` | `a484eaeee2743cde585655d11b76320eb66d019584371160a5cfe2518ba2ad78` |

Independent machine-verification result: `objective-flow-native-independent-verification.json`, SHA256 `0cd84b9922a70228be029964d7e92480ad8d1f86fbc34bdcd1eedb38f0f04e3e`.

## Remaining qualification limits

The native suite deliberately supplies synthetic request-local proof and generation-issuer/provider fixture ports. It does not qualify live HTTP/JWT/session custody, protected native Strategy issuance, Meri SDK/provider execution, a frontend flow, browser process termination, network commit-ACK delivery, complete migration replay or production deployment. The missing public-flow and native Strategy authority seams remain listed in the source checklist. No AWS or production operation occurred.

The coordinator alone executed the native procedure. This reviewer performed read-only source/driver/evidence, Git-byte, process/listener and sanitization checks and wrote outside-repository review artifacts. No source/index mutation, staging, publication, database command, credential creation, native rerun or Meri/handoff change was performed by this review.
