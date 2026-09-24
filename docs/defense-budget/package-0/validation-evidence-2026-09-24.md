# Package 0 validation evidence — 2026-09-24

This record separates repository checks from live-environment proof. No skipped test is counted as a pass.

## Repository and disposable-infrastructure checks

| Check | Result | Evidence |
| --- | --- | --- |
| Initial combined Package C, Package E, observation bridge and Package 0 snapshot suites | PASS | 12 suites passed, 1 database-gated suite skipped; 148 tests passed, 14 skipped. |
| Exact post-rebase merge candidate focused regression | PASS | 12 suites and 133 tests passed with no skipped suite. |
| Package C disposable PostgreSQL 16 pre-migration upgrade | PASS | A real legacy scoped review and correction were migrated; 4 of 4 upgrade checks passed. |
| Package C disposable PostgreSQL replacement/reconciliation | PASS after repair | 74 of 74 tests passed. The first run found that `--acknowledge-revoked-scope` was implemented but missing from the CLI allow-list; Package 0 added the flag and the complete rehearsal then passed. |
| Prisma schema | PASS | `prisma format`, `prisma validate` and client generation completed. |
| Governed manifest TypeScript boundary | PASS | The manifest-specific TypeScript project compiled without emission. |
| Package E local Postgres/MinIO qualification | Not counted | The rehearsal stopped before mutation because workstation port 5432 was already allocated. Exact-image qualification is performed in the isolated AWS Fargate qualification task instead. |
| Snapshot relation-name regression | PASS | The release snapshot exposed an incorrect guessed relation name; PR #1762 corrected it to `defense_budget_ingestion_manifest_v1`. Its focused Jest suite (3/3) and manifest TypeScript boundary passed. |
| API container build | PASS | Native ARM64 CodeBuild from exact source `4b118bc148df9ae168585ebd8ad0dd595cb6a230` completed and pushed digest `sha256:2ac7524cde4e4dcdf01f0dcebda177a2c777a44bb313e2e28112205e27383e67`. |
| Drain container build | PASS | Native ARM64 CodeBuild used the exact API digest as its base. All 32 API manifest layers are the exact prefix of the 51-layer drain manifest; drain digest is `sha256:8ac2255706e08a74baa3e7cb7ec3021ba9f34841a76e52134aee9344b27be461`. |
| Final drain image qualification | PASS | Two independent isolated Fargate tasks on qualification revision 33 exited zero. Both formal verifier replays emitted `RELEASE_IMAGE_QUALIFICATION_PASS`, with identical assertion/omission counts, PE identities, totals, `REVIEW` disposition and successful DB verification. |

## Live read-only checks before release

- AWS account `967807252336`, region `us-east-1`; `capiro-dev` is the only cluster with the defense-budget archive, extraction-artifact and drain topology.
- A diagnostic ECS task queried PostgreSQL inside `BEGIN READ ONLY` and exited zero: `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/5055a48296364d78bba241ac9e431a2d`.
- The complete aggregate result is stored in `approved-data-snapshot-2026-09-24.json`; it contains no source bytes, reviewer rationale or other row-level payloads.
- The pre-release snapshot found 43 active scoped approvals, zero canonical snapshots, zero governed manifests, nine pending outbox rows and four dead-letter rows. These are preserved baselines, not completion claims.

## Completed release checks

- Package C and E reconciliation merged through PR #1759. Release-found fixes merged through PRs #1762 and #1763. The superseded PRs #1704 and #1716 are closed.
- Additive migrations ran first in task `583f09a60f9a4ce09fcf03feb1cd95f8` and exited zero.
- API task definition `capiro-dev-api:439` is stable at two healthy tasks on the exact API digest.
- Drain task definition `capiro-dev-defense-budget-ingestion-drain:27` is parked at `echo no-op-default-command`; no service, running/pending task or automatic schedule targets it.
- Final qualification tasks `784429653dfd456ab76a0a4ec5488fb8` and `7e8595e947574e179d3a4d2ecba5a101` exited zero on the exact drain digest and passed the repository release gate.
- Read-only snapshot task `90e471a5d5324338b56925150bb123aa` exited zero. It preserved 43 active approvals, reported empty governed manifests and canonical projections, and observed the same nine pending/four dead-letter queue rows.
- GitHub Actions jobs failed before scheduling (`runner_id: 0`, no steps); they are recorded as infrastructure failures, not test failures. Local/disposable/AWS evidence above supplied the reviewed release gate.

The two final reports have different artifact and current normalized-artifact hashes because the parser output hash domain includes fresh-container job identity and derived hashes. Their substantive projections match exactly. This instrumentation limitation is assigned as `P3-QUALIFICATION-HASH-NORMALIZATION`; it is not hidden or represented as byte-level determinism.
