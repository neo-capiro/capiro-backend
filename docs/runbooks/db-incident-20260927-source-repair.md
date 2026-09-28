# September 27 development database incident: source repair candidate

This change is under review. It does not authorize a merge, deployment, migration-ledger action, credential rotation, or shared-development database repair. Migration-bearing releases remain blocked pending the complete incident recovery and owner acceptance.

## Problem and resulting behavior

An empty replay of API source at `42942dedad59382f4b4aac6f904b9aee0e02efa6` stopped after 442 migrations. The delivery migration first failed because `capiro_worker` was missing, then because `reject_append_only_mutation()` was not defined in migration history. Separately, read-only PostgreSQL EXPLAIN rejected the dedup migration's `MIN(uuid)` with 42883.

The delivery replacement checks the separately provisioned worker-role prerequisite, preserves a matching existing append-only function, rejects an unexpected definition, or creates the definition verified in both incident clones. It runs transactionally and retains the original delivery DDL bytes. It does not alter role privileges or resolve failed ledger rows.

The dedup replacement proves the existing global non-null `(client_id, source, external_id)` uniqueness invariant using a complete, valid, ready, live, immediate unique btree index. It performs no business-row deletion. Missing, partial or invalid uniqueness fails closed and requires separately reviewed maintenance. This does not waive duplicate repair if real data requires it.

The standalone candidate `scripts/recovery/20260927/audited-dedup-procedure.sql` implements that maintenance algorithm: explicit tenant scope; approved visible-row count, candidate UUIDs and full-row SHA256 fingerprint; a lock against concurrent writes; full-row durable backup before deletion; exact backup/deletion counts; survivor fingerprints; and a no-duplicate check. It keeps the lowest UUID, not the oldest timestamp. Ordinary application/worker roles cannot use its schema/function. It rejects superuser/bypass roles and Aurora `rds_superuser` membership. An approval-reference string is metadata, not an authorization mechanism.

The procedure is **not wired into startup or release workflows**. It requires a separately reviewed invocation manifest, dedicated recovery owner, complete tenant coverage, retention policy and restoration plan. After any required tenant repairs, restore the approved global uniqueness constraint before retrying normal migration. Do not enable a global RLS bypass. Do not run it as the application role or Aurora administrator.

## Exact history-policy exception under review

The integrity guard still rejects deleted/renamed migrations, file-mode changes and all unrecognized byte changes across every migration tree. It recognizes only these two fixed original-to-replacement SHA256 pairs at the exact existing paths with mode `100644`. There is no environment, command-line or manifest override. Changing either original or replacement by one byte fails. After the replacement reaches the comparison base, any subsequent change to it fails normally.

| Migration | Original SHA256 | Replacement SHA256 |
|---|---|---|
| `20281002010000_research_portfolios_phase10_watch_delivery` | `72b628ee6928b17466a53d6d78e32059a3e8939a1eeb0bbc12d6f6e35456d37e` | `b344515e85d90c9363c9cf690e97ce2372fd38baf1b97c5c8b7213409fb6d784` |
| `20281003010000_dedup_client_intel_mapping` | `3f982ab8d2a7dea5ee37cf738317b9eaf4b2b16f248309ff9a1d6968074ee724` | `8189f8a447c6851ca2d342ecab1da1ee822a2451b1610828aa434d99fceaf95b` |

These rules are part of the proposed incident repair and require review with the SQL changes. A passing integrity check does not approve publication of changed history or establish physical completion of any existing database migration. Existing-ledger checksum differences must be handled individually in the reviewed clone-upgrade manifest; never bulk rewrite checksums, mark migrations applied, or retry pending SQL against shared dev.

## Verified evidence and limits

On the isolated private Aurora 16.11 rehearsal cluster, the exact API candidate (445 migrations, 448 source/support files) passed deploy, migration status and a second no-op deploy with exit 0. Independent catalog collection confirmed 445 finished rows, zero failed/rolled-back rows, every candidate checksum, and an unchanged ledger after the no-op. Candidate manifest SHA256: `e6ca14379f4ce8c791b09d08db35f1d93b92e4afc7b01725eaeb6ba872d5feba`. Independent catalog SHA256: `8c54b2593e11dcc801ee6307133e41933911e136f4d18a4f01a8594cf298cc52`.

The durable dedup fixture passed exact-backup restoration, concurrent-writer blocking (55P03), no-op rerun, tenant isolation, app denial and changed-denominator rejection. Receipt SHA256: `ac0f87b6174df009db5410707ca1e59288783f84ab387c482f53a9b2be72ee0f`. Procedure SHA256: `a643f871313eacfb38a3d96efe32b1137051eaacc337c855761ad6bde3fd5748`. The first fixture exposed Aurora administrator bypass despite `rolbypassrls=false`; the revised procedure and successful fixture use a restricted non-login role. All fixture data was synthetic and the exact deleted row was restored; evidence objects remain retained.

The prior two failed rehearsal databases were preserved by rename, not reset or ledger edits. Shared dev and both forensic clones were not modified. The worker role was separately provisioned in the rehearsal cluster. This candidate also imports the seven-file disposable CI prerequisite patch from `6adbdb4505d96aa842a3eb8afa5f7e3da40b5787`, adds its two test suites to ci-pr, and wires the prerequisite into the memory-governance and engagement replay jobs. The helper is restricted to GitHub Actions with an explicit disposable-database marker and a fixed loopback PostgreSQL target; it rejects unsafe existing roles/functions and target overrides. Nine bootstrap tests and five PGlite function tests passed with exit 0. Local PGlite validation used the existing version 0.5.8 runtime with only three file URL substitutions and unchanged assertions; normal CI uses the frozen dependency tree. No package was installed. Release-role provisioning and existing-database upgrade procedures remain separate dependencies.

This evidence proves the proposed API clean replay and synthetic maintenance behavior only. Other service chains, both incident-clone upgrade rehearsals, real-data preservation, application tenant/runtime acceptance, credential rotation and complete consumer restart remain outstanding. PR-wide failing gates must be resolved, and the exact tested candidate must reach both mains through the required approved integration workflow before any shared deployment. Production canaries remain user-run.
