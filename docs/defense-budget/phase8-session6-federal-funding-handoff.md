# Phase 8 Session 6 — Federal Funding Event Foundation: Closeout Handoff

Status: **SESSION6_COMPLETE**, **READY_TO_MERGE_SESSION6** (pending explicit user merge authorization)

## Exact coordinates

- Repository: `neo-capiro/capirov2`
- Branch: `agent/phase8-session6-federal-funding-events`
- Final HEAD: `828531f331078523c7f469b847417f80aca25310`
- PR: [#1137](https://github.com/neo-capiro/capirov2/pull/1137) — OPEN, DRAFT, MERGEABLE
- Base at closeout: `main` @ `3f5ed8db89545b9d54176e7f8ec816293a07cbda` (no drift affecting Session 6 paths — the two commits main gained during this session, `feat(funding-opportunities)` #1139 and `feat: retain 100 X feed posts` #1140, touch only `apps/api/src/intelligence/x-feed/*` and `apps/web/src/pages/funding-opportunities-prototype*`; neither touches prisma, defense-domain, defense-contracts, or defense-api).

## What Session 6 establishes

A global, source-grounded **Federal Funding Event** domain, deliberately separate from the annual Program Element stage ladder:

```
federal_funding_measure  →  federal_funding_provision  →  federal_funding_allocation
```

- `federal_funding_measure`: a funding vehicle/event (regular appropriation, supplemental, emergency supplemental, reconciliation, continuing resolution, rescission, transfer, reprogramming).
- `federal_funding_provision`: a section/account-level fact as the source states it — a broad enacted purpose amount, NOT an allocation.
- `federal_funding_allocation`: the only place authoritative allocated dollars may live, and only under a database-enforced safety gate.

Core semantic rule enforced by the schema (not just application code): Congress broad purpose ≠ OMB apportionment/allotment ≠ DoD/service allocation ≠ Capiro inferred relevance ≠ obligation ≠ outlay.

## Implementation gap closed this closeout

The migration ledger (`apps/api/prisma/migrations/20261120220000_phase8_session6_federal_funding_events/migration.sql`) already created all three tables, roles, and CHECK constraints. The authoritative Prisma schema (`apps/api/prisma/schema.prisma`) did **not** model them — a migration-ledger / Prisma-desired-schema inconsistency. This closeout added:

- `model FederalFundingMeasure`, `model FederalFundingProvision`, `model FederalFundingAllocation` to `apps/api/prisma/schema.prisma`, mapping every column, exact DB type (`@db.Uuid`, `@db.Char(64)`, `@db.Decimal(20,2)`, `@db.Decimal(5,4)`, `@db.Date`, `@db.Timestamptz(6)`), and nullability exactly as the migration SQL defines them.
- `SourceDocument` back-relations (`federalFundingMeasures`, `federalFundingProvisions`, `federalFundingAllocationEvidence`) for the three new FKs.
- Every SQL-owned invariant (value-set CHECKs, the four allocation safety CHECKs, the partial `potential_double_count` index) is documented in the schema as **SQL-owned** rather than restated as a weaker Prisma-level assumption. Prisma cannot express a `WHERE` predicate on an index or a multi-column CHECK; the DB migration remains the source of truth for those.
- **No second migration was created.** `prisma migrate dev` was never run. The single reviewed migration file is unchanged; only the Prisma *desired schema* was brought into sync with it.
- These models were deliberately **kept out** of `apps/defense-api/prisma/schema.prisma` (the curated HTTP Prisma subset) — confirmed by direct inspection of the generated client, which contains zero references to `federal_funding_*`. Session 6 is the domain/ingestion foundation only; the `/api/federal-funding/*` HTTP cutover is future work.
- `scripts/verify-phase8-session6.mjs` was strengthened to permanently assert the authoritative schema models exist, `@@map` correctly, carry required fields, have the SourceDocument back-relations, and that defense-api's curated schema does not regain them — so this exact regression class cannot silently recur.

## Second real bug found and fixed during validation

`apps/defense-api/scripts/ingest-federal-funding.mjs` used `$queryRawUnsafe` with untyped placeholders for every UUID foreign key (`measure_id`, `provision_id`, `source_document_id`, `evidence_source_document_id`). Postgres rejected every real INSERT (`column "source_document_id" is of type uuid but expression is of type text`). This was only caught by actually running the ingestion command against a live disposable database — a static/mocked review would have missed it. Fixed with explicit `::uuid` casts on all four placeholders, verified end-to-end (see Ingestion section below), and a static-verifier regression guard was added so a future edit reintroducing bare-text UUID placeholders fails the build.

## Third fix: DB rehearsal false positive

The Session 6 DB rehearsal's `ProgramElementYear` contamination check used a bare `reprogram` substring, which false-positived against the pre-existing (pre-Session-6, present since the original foundation commit) legitimate `reprogrammed` execution-dollars column — an unrelated field that has nothing to do with Session 6's funding-vehicle contamination boundary. Tightened the regex to the full word `reprogramming` (matching the vehicle-event concept, not the legacy column) and added `transfer` to complete the required contamination list, in both `scripts/verify-phase8-session6-db.sh` and `scripts/verify-phase8-session6.mjs`.

## CI

Added an explicit `apps/api` Prisma validate+generate step to `.github/workflows/phase8-session6-federal-funding.yml` so the authoritative-schema regression class is caught by CI, not only by the static verifier that runs locally.

GitHub Actions on this repository is currently `CI_UNAVAILABLE_EXTERNAL`: every workflow run on this branch (10+ runs across the branch's commit history, including the run for this closeout's push) completes as `startup_failure` at 0 seconds — a repo-wide billing/runner-startup block, not a real pass or fail signal. This handoff relies on fresh exact-head local evidence instead (below), all captured against `828531f331078523c7f469b847417f80aca25310`.

## Fresh exact-head evidence (this closeout)

All commands below were run against a clean detached worktree pinned to `828531f33`, with a real `pnpm install --frozen-lockfile` (not just linked node_modules), and the disposable Postgres containers used for DB rehearsals were removed immediately after each run — the persistent `capiro-postgres` container used by other work was never touched, and no production database was touched at any point.

### Prisma

| Check | Result |
|---|---|
| `apps/api` schema validate | PASS |
| `apps/api` Prisma client generate | PASS (client includes all 3 Session 6 models) |
| `apps/defense-api` schema validate | PASS |
| `apps/defense-api` Prisma client generate | PASS (client contains **zero** `federal_funding_*` references — confirmed by grep) |
| Migration-ledger drift | None — single migration `20261120220000_phase8_session6_federal_funding_events` unchanged; full ledger from zero applies cleanly on a fresh disposable Postgres 16 (`prisma migrate deploy`) |
| Destructive diff against existing defense tables | None observed; no `federal_funding_*` drop proposed, no other table altered |

### Session 6 gates (fresh run on `828531f33`)

- `node scripts/verify-phase8-session6.mjs --enforce-corpus`: **SESSION6_FEDERAL_FUNDING_FOUNDATION_PASS**
- `pnpm verify:phase8-session6:domain`: **9/9 tests pass** (measure types distinct, provision purpose ≠ allocation, account allocation ≠ PE allocation, capability inference → relevance only, obligation requires reference, unmapped carries no identity/dollars, mapping precedence exact-before-inferred, known-total excludes included/double-count risk)
- `pnpm verify:phase8-session6:db` (disposable Postgres 16 rehearsal): **SESSION6_DB_REHEARSAL_PASS (19 checks)**, including every required negative control: capability-dollar injection rejected, inferred-relevance-with-dollars rejected, unverified/candidate dollars rejected, unmapped-with-identity rejected, obligated-without-reference rejected, HTTP serve role INSERT/UPDATE rejected, job role DELETE rejected, fabricated source_document FK rejected, ProgramElementYear leak-free.
- `node scripts/prepare-phase8-session6-federal-funding-corpus.mjs`: **4/4 real corpus sources** materialized from live `govinfo.gov`/`congress.gov` and SHA-256 hashed (P.L. 119-21 Title II reconciliation; P.L. 118-50 Israel, Ukraine, Indo-Pacific supplemental divisions).
- Ingestion command (`apps/defense-api/scripts/ingest-federal-funding.mjs`), run against a real disposable Postgres:
  - Dry run (no `--commit`): `DRY_RUN_PASS sources=4 provisions=7` — no mutation attempted.
  - Missing `PHASE8_SESSION6_COMMIT_AUTHORIZED` + `--commit`: refused (thrown error, no mutation).
  - `PHASE8_SESSION6_COMMIT_AUTHORIZED=false` and `=yes` (invalid values) + `--commit`: both refused — only the exact string `true` authorizes.
  - Tampered/mismatched source SHA-256 + `--commit`: refused (`Expected exactly one registered live source_document`).
  - Real commit (valid authorization, real registered `source_document` rows): **`INGEST_PASS measures=4 provisions=7 allocations=7`**.
  - Re-running the identical commit: **idempotent** — row counts unchanged (upsert on `dedup_key`).

### Session 2–5 regression gates (fresh run on `828531f33`)

| Gate | Result |
|---|---|
| Package builds (`shared`, `auth`, `defense-contracts`, `defense-domain`, `defense-client`) | All clean |
| `verify:phase8-session2` | `SESSION2_BOUNDARY_PASS` |
| `verify:phase8-session2:db` | PASS — 64/64 tests |
| `verify:phase8-session3` | `SESSION3_BOUNDARY_PASS` (49 frozen routes) |
| `verify:phase8-session3:admin` | `SESSION3_ADMIN_BOUNDARY_PASS` |
| `verify:phase8-session3:parity` | PASS — 52/52 tests |
| `verify:phase8-session3:db` | `SESSION3_DB_REHEARSAL_PASS` — 86 checks, 64/64 tests |
| `verify:phase8-session4` `--enforce-replay` | `SESSION4_SOURCE_PARITY_PASS` |
| `verify-phase8-session4-image.sh` | `SESSION4_IMAGE_CONTAINMENT_PASS` — 8/8 checks |
| `node --test apps/defense-parser-orchestrator/test/*.test.mjs` | 84/84 tests pass |
| `verify-phase8-session5.mjs` | `SESSION5_P0_RUNTIME_PASS_NVIDIA_NOT_ADOPTED` |
| `verify-phase8-session5-corpus.mjs` | `SESSION5_CORPUS_READY_PASS accepted=8 blocked=0` |
| `verify-phase8-session5.mjs --enforce-provider-decision` | `SESSION5_COMPLETE_NVIDIA_NOT_ADOPTED` |

Session 5 remains confirmed: `productionParser = DETERMINISTIC_PRIMARY`, `nvidiaRouting = DISABLED`, `liveNemotronOutputs = 0`, `accuracyBenchmarkCompleted = false`. Session 5 was not reopened.

## Authority / role boundary (verified, not assumed)

- `capiro_defense_serve`: SELECT only on all three funding tables — verified by real INSERT/UPDATE attempts against a live database, both refused.
- `capiro_defense_job`: SELECT/INSERT/UPDATE only, no DELETE — verified by a real DELETE attempt, refused.
- `PUBLIC`: revoked entirely (`REVOKE ALL ... FROM PUBLIC` present in migration and asserted by the static verifier).
- No canonical-promotion authority added. No production route or schedule ownership changed. `defense-api` HTTP does not become the Session 6 ingest writer (ingestion runs as a standalone job-role script, not through any HTTP controller).

## Funding-truth invariants (verified, not assumed)

- measure → provision → allocation kept structurally and semantically separate (distinct tables, distinct CHECK-enforced grains).
- Inferred/capability relevance cannot carry authoritative dollars — enforced independently in the database CHECK constraints (`federal_funding_allocation_capability_money_chk`, `federal_funding_allocation_inference_money_chk`) and in the TypeScript domain layer (`assertAuthoritativeFederalFundingAllocation`); confirmed rejected in the real DB rehearsal.
- `ProgramElementYear` was **not** contaminated with `supplemental`/`reconciliation`/`rescission`/`transfer`/`reprogramming` columns — verified by schema regex, by a real database `information_schema.columns` query in the DB rehearsal, and by confirming the pre-existing legitimate `reprogrammed` execution-dollars column (present since before this branch) is correctly excluded rather than mistaken for contamination.
- Source evidence is required and bound: every measure/provision/allocation has a `source_document_id`/`evidence_source_document_id` FK to `source_document` with `ON DELETE RESTRICT`; a fabricated source id was rejected in the real DB rehearsal.

## Production impact

- **Zero** production database mutations. All writes in this closeout happened against disposable, ephemeral Postgres 16 containers created and destroyed for the rehearsal/ingestion tests; the pre-existing persistent `capiro-postgres` container used by other concurrent work was never touched.
- **Zero** production route changes.
- **Zero** production schedule/EventBridge changes.
- **Zero** NVIDIA/GPU changes.
- No canonical PE snapshot promotion occurred at any point.

## What Session 6 explicitly does NOT provide (future work, not started here)

- `/api/federal-funding/*` production HTTP cutover.
- Total Funding Position UI.
- Production lifecycle/watcher ownership for the new domain.
- A shadow or production ingest schedule (ingestion remains a manually-invoked, dry-run-first job script).
- Session 11 product integration.
- Session 7 was **not** started.

## Remaining limitations / known gaps for a future session

- The prepared-corpus pinned-SHA-mismatch branch in `scripts/prepare-phase8-session6-federal-funding-corpus.mjs` (`source.sourceSha256 && source.sourceSha256 !== downloaded.sha256`) could not be independently exercised this closeout because the shipped corpus pins `sourceSha256: null` for every entry (the hash is populated at prepare time, not pinned upfront) — the logic is simple and covered by the static verifier's token check, but has not been driven through a live mismatch in a real run.
- The ingestion command's real-database code path had never been executed end-to-end before this closeout; it is now proven, but only against a synthetic Session 6 corpus of 4 sources / 7 provisions — a larger real corpus may surface further edge cases in dedup-key collision handling or numeric precision at scale.
