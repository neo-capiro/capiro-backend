# Backend-only repository inventory and first safe removal

## Measurement and scope

This inventory is measured from the committed Git tree of report JPEG cleanup
PR #69, `b90b3ddb9d4db5e7077473b5191173e2543db18d`. The source checkout is
sparse; working-tree folder sizes would omit most of the repository. The tree
has **28,333 tracked files and 571,821,754 committed blob bytes** (571.82 MB,
decimal). The categories below are disjoint and sum to that total. They are
inventory labels, not recommendations to remove whole directories.

| Tracked category | Files | Blob bytes |
| --- | ---: | ---: |
| Other documentation | 9,454 | 162,203,358 |
| Session 5 live corpus | 32 | 80,950,215 |
| Meri documentation and release evidence | 6,486 | 79,705,337 |
| Workspace tests and fixtures | 3,085 | 55,921,630 |
| Frontend apps and marketing | 2,469 | 53,472,412 |
| Workspace scripts and data | 807 | 37,172,868 |
| Backend and shared non-test `src` | 3,316 | 33,799,630 |
| E2E app | 414 | 30,348,073 |
| Deliberate defense API runtime-source mirror | 749 | 23,276,865 |
| Migrations and schemas | 612 | 3,644,843 |
| Other root scripts, config, legal, infra, tests, artifacts | 909 | 11,326,523 |

There is no tracked `node_modules`; task-local dependency installs are
excluded. The 612 migration/schema files are part of application and recovery
history. `docs/runbooks` and `THIRD_PARTY_NOTICES` remain retained.

## Reachability from actual entrypoints

The default web Dockerfile is `apps/web/Dockerfile` and
`infra/deploy/codebuild-web-dev.json` builds it. Root `package.json` invokes
`marketing/build.mjs` and frontend parity scripts; CDK instructions also use
the web Dockerfile. The web, onboarding, and marketing trees therefore need a
separate build/deploy migration before deletion, even though this repository's
desired destination is backend-only.

The Meri orchestrator, older Core Meri modules, and
`apps/defense-api/runtime-source` are wired into Nest providers, container
builds, runtime adapters, or source-parity checks. A directory name alone does
not prove them unused. Meri release evidence also includes an RDS CA bundle
referenced by first-chat deployment/audit material. No Meri or Planner-owned
source, PR #68 read-mode source, migration, or release-evidence path is changed
in this commit.

## Removed group: generated Session 5 provider requests

The seven files formerly under `.session5-live/materialized/` contributed
**3,019,411 bytes**. They are output from
`apps/defense-parser-orchestrator/scripts/materialize-live-inputs.mjs`, which
requires an explicit `--request` and `--out`. The retained
`.session5-live/requests/*.json` files identify the retained source PDFs and
rendered PNG pages. The materializer checks source PDF hashes and records
rendered-image hashes before writing. All seven outputs were regenerated from
those retained inputs into a temporary directory and matched their committed
SHA-256 bytes exactly:

| Output | SHA-256 |
| --- | --- |
| `army.json` | `133caf8127c75a6042e654d4d2bf82d41ca8a83943b2c0db5ca70dd0fb5420af` |
| `dw.json` | `46a2c1f68796730c2fe5a69b71f97c50e261b1d3313a0ce0b1775628e98c1429c` |
| `navy.json` | `ace22c9f7f2effdf2db267bc14cb971293ae7ab805cddb79587813ffc8a2e057` |
| `o1.json` | `10cadbb1e62e25379fb481b485f57620219a9e5a463bedc7b74777670fa64b1b` |
| `p1.json` | `ac2cb1c84fb8c2587afe52acd0714f989d8f9cff215355eccf8b68317e0caa5a` |
| `r1.json` | `b2563507ce008c14de35445a88d9de770097bc6018734a6ca6217751a09dfc6e` |
| `scanned.json` | `869b1370e321cb744fb3dd008c4336f5eaa03c705337d5f4073afc05bf2a9da3` |

Production, scripts, CI, infra, root package, and defense-budget source scans
found no literal reference to `.session5-live/materialized`. The parser
orchestrator Dockerfile copies its source and README, not this corpus. Its CLI
accepts explicit input paths; no implicit materialized-path default exists.
The existing Phase 8 corpus verifier and five corpus-review tests passed before
removal. The retained `frozen-corpus.json` is referenced by validation evidence
and remains committed, as do all source PDFs, request manifests, and rendered
PNGs. `.gitignore` prevents regenerated materialized outputs from being
accidentally recommitted.

After removal, the Phase 8 Session 5 corpus verifier still accepted 8/8
strata with none blocked; the corpus-review test passed 5/5. The materializer
regenerated each removed file from retained inputs with the **same Git blob
ID** as its PR #69 version. Its script and the container CLI passed Node 24
syntax checks, and the CLI help/import path exited 0. The broader
`verify-phase8-session5.mjs` also passed after its referenced Core, contract,
and CDK files were materialized in the sparse checkout. Its first run reported
20 missing-file assertions solely because those tracked paths were outside the
initial sparse selection. No application TypeScript, image, database, or
deployment qualification is implied by these source-only checks.

Restore the committed outputs at any time with:

```sh
git restore --source=b90b3ddb9d4db5e7077473b5191173e2543db18d -- .session5-live/materialized
```

## Remaining cleanup work

This commit is one recoverable removal, not completion of the backend-only
conversion. The remaining frontend, marketing, E2E, old Meri, mirrored defense
runtime, large documentation, and script/data groups need individual runtime,
build/deploy, parity, and evidence-retention decisions. Keep active migrations,
schemas, licensing, runbooks, and deployment material while their consumers
remain. Resolve the application/build owner for each group before removing it;
do not purge directories based solely on the inventory table.
