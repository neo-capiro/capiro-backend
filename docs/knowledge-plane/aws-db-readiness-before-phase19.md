# Knowledge Plane — AWS/DB Readiness Checkpoint Before Phase 19

Date: 2026-08-18
Scope: Post-Phase-18 (Context Plane Enforcement) readiness gate, before Phase 19 (Meri integration) may begin.

## Executive status

**READY FOR PHASE 19.**

Phases 16-18 are merged to `main`, the Phase 17 migration is applied to the live `capiro-dev` Aurora cluster, and `capiro-dev-api` is running the new image (task-def `:158`, image `d14e1d161`, digest `sha256:56bf95a7…`) with 2/2 tasks healthy, rollout `COMPLETED`, both `app.capiro.ai` and `os.capiro.ai` returning HTTP 200 and zero exceptions or schema errors in the post-deploy log scan.

Two corrections to earlier drafts of this document are recorded honestly below rather than quietly edited away: the live migration gap was **1 migration, not 8** (§3), and the `CONCURRENTLY` index risk was **not** the High-severity blocker first assessed (§5). Both errors were caught by measuring the real environment instead of trusting inference.

The one genuinely open item is a **product decision, not a readiness defect**: live mailbox ingestion is switched off at the feature-flag level and its drain schedule (created here, disabled) is awaiting an explicit enable decision (§8).

## 1. Phase 16–18 reconciliation

| PR | Branch | Base (after retarget) | Merge commit | Files | Result |
|---|---|---|---|---|---|
| #1037 Phase 16 — five context layers | `agent/knowledge-plane-phase-16-five-context-layers` | `main` | `5d1d614c8df3b22dc147a2713031318d6c2aa803` | 7 | Squash-merged |
| #1038 Phase 17 — coverage-aware ContextPacket V2 | `agent/knowledge-plane-phase-17-coverage-aware-context-packet-v2` | `main` (retargeted from Phase 16 after rebase) | `6c668c2990dd911b700b149eb58cf5a7759e6f24` | 13 | Squash-merged |
| #1039 Phase 18 — Context Plane enforcement | `agent/knowledge-plane-phase-18-context-plane-enforcement` | `main` (retargeted from Phase 17 after rebase) | `421373dd5e0550a9dc092c9e94e4aec394b43654` | 15 | Squash-merged |

`main` subsequently advanced to `d14e1d161` via PRs #1041 and #1042 (other authors, outreach-v3 UX and Meri research budgets). Those commits add **no migrations**, and the Phase 16-18 context suite was re-run at that tip — 75/75 still passing — before deploying from it.

All three PRs were still in **draft** state and carried explicit "do not merge until approved" language in their own bodies; all three had empty `statusCheckRollup` (zero CI checks ever ran). Repo-wide GitHub Actions is confirmed still down as of this session — a run on `main` itself, at the moment of this audit, also terminated `startup_failure` before any job was scheduled. This is a runner/infrastructure condition, **not** a Phase 16-18 test failure; no CI result is claimed for these merges.

In place of CI, local validation was run directly:
- `prisma generate` + `tsc --noEmit` on `apps/api`: clean on every file touched by these three PRs (16 pre-existing errors remain in unrelated files — `tracker/*`, `meri/governed-meri-tools.*`, `reviews/*`, `memory/memory-review-revision.*` — none overlap the Phase 16-18 diff and none are fixed here as out of scope).
- `jest` on `apps/api/src/context/` and `packages/meriv2-core/src/context/`: **14 + 8 = 22 suites, 75 + 68 = 143 tests, all passing**, covering the new Phase 16/17/18 specs together with the existing Phase 15 resolver/compiler regression suite.
- `scripts/check-context-plane-new-bypasses.mjs` (the new architecture guard): passes clean.

Rebase mechanics: after each squash merge, the next branch in the stack was rebased with `git rebase --onto main <old-base>`, force-pushed, and its PR retargeted to `main`. Each retarget was diff-verified to still show **only** that phase's own files (7 / 13 / 15, no duplication of already-merged content) before merging. Combined diff from pre-merge `main` (`8e9ec718a`) to post-merge `main`: **31 unique files, +4173/-3** (35 raw touches across 3 PRs minus 4 files — `context.module.ts`, `packages/meriv2-core/src/index.ts` — each touched by more than one phase).

No unexpected content: no Phase 19+ product code, no historical mailbox backfill, no NVIDIA infra provisioning, no broad feature-flag flips. Confirmed by direct file-list diff, not by trusting the PR descriptions.

## 2. Migration inventory

The repo has 290 Prisma migrations total (291 directory entries minus `migration_lock.toml`). The Knowledge-Plane-relevant subset is below. A separate, non-blocking finding: the batch of migrations timestamped `20261120*` (Nov 20) is a clock artifact — `git blame` shows they were actually authored 2026-08-11 through 2026-08-17, in correct relative order to each other, just under a wrong shared date. This makes Phase 17's correctly-dated `20260817233500` migration lexicographically sort *before* the whole `20261120*` batch even though it's architecturally later. Verified this causes no real dependency break (Phase 17's migration only touches the pre-existing `context_packet` table, created back in July) — cosmetic, not functional, but worth a hygiene fix at the source (whatever generates these sandbox clocks) so it doesn't compound.

### Early/foundational Knowledge Plane migrations

| Migration | Tables/objects | Indexes | RLS | Additive/destructive | Notes |
|---|---|---|---|---|---|
| `20260525213000_kg_views` | Views `kg_edges`/`kg_canonical_edges`/`kg_tenant_edges`; fns `kg_neighbors`/`kg_walk` | 6 supporting indexes on existing tables, **no CONCURRENTLY** | Views can't carry RLS; relies on definer-rights functions | Additive (opens with `DROP VIEW ... CASCADE`) | 6 `CREATE INDEX` on already-populated tables (`fec_contribution` etc.) without CONCURRENTLY — already applied to prod long ago, risk already incurred, not a blocker now |
| `20260527021119_context_embeddings_v2` | `context_embeddings` (DROP+CREATE) | `context_embeddings_embedding_hnsw` (hnsw, vector_cosine_ops) | ENABLE+FORCE RLS, nullable-tenant policy (global rows readable, not writable, by normal tenants) | Destructive DROP TABLE (justified: table was never populated) then additive | 1024-dim vectors (Titan v2) |
| `20260630120000_meriv2_claim_evidence_compliance` | `claim`, `evidence`, `compliance_check` | tenant/subject/artifact indexes | FORCE RLS, tenant-isolation policies | Additive | MeriV2 claim/evidence/compliance ledger |
| `20260712000000_meri_audit_ledger` | `meri_audit_ledger` | 2 indexes | FORCE RLS, 4 policies | Additive | Grounding-auditor verdict ledger |
| `20260713010000_context_packet` | `context_packet` | 2 indexes (+ more added later, see below) | FORCE RLS, 4 policies | Additive (note: `id` originally had no DEFAULT) | Now has 34 columns total — later migrations (Phase 15-18) added `packet_version`, `effective_tenant_id`, `trace_id`, `retrieval_context_jsonb`, etc. |
| `20260722010000_kg_edge_cache` → `20260723030000_kg_edge_cache_fec_employer_kind` (5 migrations) | `kg_edge_cache` materialized view + fns | 3 indexes, WITH NO DATA | MVs can't carry RLS — isolation via withheld GRANT only | Mixed | **Historical fail-open window, already closed**: `ALTER DEFAULT PRIVILEGES` auto-granted `capiro_app` SELECT on this un-tenanted, un-walled 578k-row cache despite no explicit GRANT; caught by an ad hoc dev probe and REVOKEd in the 4th migration of this chain. Also fixed a silent `fec_employer` node-kind mapping bug that had disconnected every client from the FEC subgraph. Both already resolved; flagged here so the pattern (any future DROP+CREATE of this MV must re-REVOKE) isn't lost. |

### Phase 3–11 core Knowledge Plane migrations (the `2026112***` batch)

| Migration | Tables | Key indexes | RLS/triggers | Additive/destructive | Live status |
|---|---|---|---|---|---|
| `knowledge_events_assertions` | `knowledge_events`, `knowledge_assertions` | GIN on actor/entity/client refs; **no index on `supersedes_assertion_id`/`contradicts_assertion_id`** (self-referencing FK) | FORCE RLS + append-only reject-triggers; **header comment states the app role "can bypass RLS" — verified this refers to the `app.bypass_rls` session GUC, not a Postgres role attribute (see §6)** | Additive | Applied (live) |
| `knowledge_evidence` | `knowledge_evidence` | assertion/event/source indexes | FORCE RLS; deferred constraint trigger requires evidence before an assertion can commit | Additive | Applied (live) |
| `mailbox_knowledge_ingestion` | `knowledge_mailbox_jobs`; trigger on `mail_messages` | due/tenant/result indexes | FORCE RLS; `AFTER INSERT/UPDATE` trigger with **no exception handling** — an enqueue failure rolls back the mail write itself | Additive + new trigger on an existing hot table | Applied (live) |
| `drop_knowledge_assertions_created_by_fkey` | `knowledge_assertions` | — | — | Destructive (DROP CONSTRAINT) — deliberate, ~1-day window where a user deletion could have nulled `created_by` before this landed | Applied (live) |
| `mailbox_knowledge_incremental_only` | (redefines a function/trigger) | — | Tightens the enqueue gate to require explicit `incremental`+`full-body` markers | Non-destructive logic tightening | Applied (live) |
| `universal_entity_resolution` (+`_hardening`) | `canonical_entities`, `entity_aliases`, `entity_identifiers`, `entity_resolutions` | `entity_identifiers_{global,tenant}_identity_unique`; **`entity_aliases` has no general unconditional `entity_id`-leading index** (asymmetric vs. `entity_identifiers`) | FORCE RLS, global/tenant scope-consistent policies; hardening migration adds a CHECK **without NOT VALID** (would abort on any pre-existing violating row — did not, since this environment applied cleanly) | Additive | Applied (live) |
| `canonical_entity_merge_ledger`, `canonical_entity_terminal_lifecycle` | ledger + lifecycle columns | — | conditional purge-delete under `rls_bypass() AND app.knowledge_purge='on'` | Additive | Applied (live) |
| `entity_identity_governance` (+`_concurrency`) | `entity_identity_governance_events`; **REVOKEs UPDATE on `entity_aliases`/`entity_identifiers` from `capiro_app`** | — | Two new SECURITY DEFINER functions (`govern_entity_alias`/`govern_entity_identifier`) become the *only* app-role mutation path. **Verified directly against the DB: `capiro_app` genuinely cannot UPDATE either table (confirmed `has_table_privilege` = false) — the boundary is real, not just documented.** A TOCTOU race in the first migration is closed by the very next one — both must deploy atomically (they did, and do here). | Additive + privilege narrowing | Applied (live) |
| `resolution_governance_projection`, `canonical_entity_backfill_checkpoints` | projection + checkpoint tables | — | `canonical_entity_backfill_checkpoints` DELETE policy is `USING (false)` with **no purge escape hatch at all** (inconsistent with its sibling `canonical_entity_merges`) — likely intentional (no PII), flagged for a conscious decision | Additive | Applied (live) |
| `mailbox_knowledge_extraction`, `knowledge_episodes` | extraction pipeline; **both attach independent `AFTER UPDATE` triggers to the same `knowledge_mailbox_jobs` row on the identical condition** | — | Narrow race: an exception in one trigger rolls back the other's enqueue *and* the job's own success transition, undercutting the stated "Phase 7 independent of Phase 6" design intent | Additive | Applied (live) |
| `temporal_knowledge_graph` (+ 2 continuity fixes) | temporal graph tables | — | — | Additive | Applied (live) — verified present before this session |
| `meri_vnext_library` | `meri_saved_prompts`, `meri_workspaces`, `meri_vnext_preferences` | `clio_conversations_tenant_user_workspace_updated_idx` — **no CONCURRENTLY, on a live chat table** | No explicit `capiro_app` GRANT on the 3 new tables — **verified this is a false alarm**: `ALTER DEFAULT PRIVILEGES` already covers it (confirmed `has_table_privilege` = true for SELECT/INSERT/UPDATE on all 3) | Additive | Applied (live) — verified present before this session |
| `retrieval_v2_exact_lexical_indexes` (Phase 11) | Adds 14 `CREATE INDEX IF NOT EXISTS` — **zero CONCURRENTLY** — on `canonical_entities`, `clients`, `client_capabilities`, `federal_award` (×4), `sam_opportunity` (×2), `congress_bill`, `program`, `sec_filing` | see above | No new RLS (index-only migration) | Additive by DDL type; CONCURRENTLY concern downgraded to Low after measurement (§5) | Applied (live) — all 14 indexes verified present by name |
| `phase8_defense_runtime_roles` | Creates `capiro_defense_serve`/`capiro_defense_job` (both NOLOGIN), 3 SECURITY DEFINER functions | — | No REVOKE/ALTER touches `capiro_app` or any pre-existing role anywhere in the file — confirmed by direct read. Both roles are inert (NOLOGIN) until a separate, not-yet-written cutover step. Every grant is guarded by `to_regclass(...) IS NOT NULL`, so a missing table silently no-ops the grant rather than erroring | Additive, safe as written | Applied (live) — both roles verified present, still `NOLOGIN`/`NOBYPASSRLS` |
| `context_packet_retrieval_context` (Phase 17) | `context_packet.retrieval_context_jsonb` | — | — | Purely additive (`ADD COLUMN IF NOT EXISTS ... DEFAULT '{}'::jsonb`) | **Applied this session** — the only migration this deployment applied (§12) |

## 3. Actual migration state (readiness matrix)

Queried directly via `prisma migrate status` (read-only, `migration-status` verb) against the **real, live** `capiro-dev` Aurora cluster (`capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv`, the cluster actually serving `app.capiro.ai` and `os.capiro.ai` — confirmed by DNS + live `runtime-config.js` `releaseSha`). Never guessed.

### CORRECTION: the live gap was 1 migration, not 8

An earlier draft of this document claimed 8 migrations were outstanding on live `capiro-dev`. **That was wrong, and the error is worth recording.** The 8-migration gap was measured against the *local disposable Postgres*, then mislabelled as the live Aurora gap. The live evidence actually available at the time (`289 migrations found in prisma/migrations` / `Database schema is up to date!`) meant the opposite: every migration present in the then-deployed image was already applied to live Aurora.

The real situation, confirmed by running the migration and reading its log:

| Migration | In repo (`main`) | Applied on live `capiro-dev` before this session | Applied now |
|---|---|---|---|
| All 289 migrations present in the prior deployed image (`74038d6e3`) — including `add_client_account_owner`, the 3 temporal-graph migrations, `meri_vnext_library`, `retrieval_v2_exact_lexical_indexes`, and `phase8_defense_runtime_roles` | Yes | **Yes — already applied** | (no-op) |
| `20260817233500_context_packet_retrieval_context` (Phase 17) | Yes | No | **Yes — applied this session** |

`prisma migrate deploy` output, verbatim: `290 migrations found in prisma/migrations` → `Applying migration 20260817233500_context_packet_retrieval_context` → `All migrations have been successfully applied.` Exactly one migration applied, exit 0.

Independently confirmed against live Aurora afterwards: `context_packet.retrieval_context_jsonb` exists (jsonb); **all 14** Phase 11 exact/lexical indexes exist; `capiro_defense_serve` and `capiro_defense_job` exist (both `NOLOGIN`, `NOBYPASSRLS`, i.e. still correctly inert); all 12 expected Knowledge Plane tables exist.

### Migrations recorded as failed or rolled back

The live ledger contains **22 rows with `finished_at IS NULL` and `rolled_back_at` set**, dating from 2026-05-03 through 2026-08-07 (`directory_contact_notes`, `gin_trigram_indexes`, `intel_pipeline_tables`, `user_title`, `kg_views` ×5, `add_program_element` ×5, `institutional_memory` ×2, `pe_watch_s3_archive_and_parse_job`, `client_memory_walls`, `bill_dossier_client_context`, `budget_verification_v1`, `pe_budget_phase7_canonical_promotion`). These are historical failed attempts that were subsequently marked rolled-back and re-applied under the same name; Prisma ignores rolled-back rows, `migrate status` reports the schema as up to date, and none blocked this deployment. Two notes: `20260724120000_bill_dossier_client_context` no longer exists in the repo at all (a migration that failed, was rolled back, and was later removed), and `_prisma_migrations` holds 343 applied rows against 290 on-disk migrations because of these historical re-attempts — row count is not a migration count.

`capiro-prod-os-capiro` (a second, genuinely separate, actively-running AWS environment — see §7) was intentionally **not** queried for migration state: the repo's own `docs/plans/radar-cutover-rollout.md` (2026-07-04) explicitly documents it as "NOT in scope... users are on capiro-dev," and probing an environment whose ownership/purpose is outside this checkpoint's mandate wasn't warranted.

## 4. Staging validation (disposable Postgres)

Used the existing local `pgvector/pgvector:pg16` disposable container (`capiro-postgres`, already running, matching the established recipe) rather than standing up new infrastructure.

- **Clean database, all 290 migrations from scratch**: created a fresh `capiro_readiness_clean` DB with the 5 required extensions pre-created, ran `prisma migrate deploy` end-to-end. **Result: "All migrations have been successfully applied."** No ordering failures (including across the clock-skew quirk above), no duplicate objects, no invalid SQL.
- **Realistic prior-state, outstanding migrations only**: the existing `capiro` DB was already at 290/298 migrations applied (last synced ~2 days ago) with real non-empty tables. Ran `prisma migrate deploy` — all 8 outstanding migrations (the same ones missing on live `capiro-dev`) applied cleanly against populated tables. This is the more rigorous of the two tests since it exercises `ALTER`/`CREATE INDEX` against non-empty tables the way production actually would.
- Also found (informational, not blocking): this same disposable DB carries 8 applied migrations that don't exist anywhere in `apps/api`'s migrations folder (`ws_*`, `document_agent`) — almost certainly `apps/workspace`'s own separate Prisma schema having been tested against this same physical database at some point, sharing its `_prisma_migrations` table. Doesn't affect `apps/api`'s `migrate deploy` (which only reasons about its own folder), but is a minor hygiene note for whoever owns that disposable DB.

## 5. pgvector and exact/lexical retrieval — verified against a real database, not just schema inspection

Seeded 200 real `context_embeddings` rows per tenant (1024-dim, matching `vector(1024)`) plus a `federal_award` and a global-public `canonical_entities` row, then ran `EXPLAIN (ANALYZE, BUFFERS)`:

- **pgvector**: `context_embeddings_embedding_hnsw` (hnsw, vector_cosine_ops) is real, present, and dimensionally correct. At the test's small scale (200 rows/tenant) the planner correctly chose a sequential scan over the index — expected, cost-based behavior, not a defect. Forcing `enable_seqscan = off` confirmed the index **is** valid and usable for the exact query shape Retrieval V2 issues (`ORDER BY embedding <=> $1 LIMIT n`), executing in 1.7ms via `Index Scan using context_embeddings_embedding_hnsw`.
- **Exact/lexical**: the `federal_award` exact-match query used its index under the default planner already; the `canonical_entities` global-name lookup needed the same `enable_seqscan=off` treatment to prove usability at tiny scale, then ran as an `Index Only Scan using canonical_entities_global_exact_name_idx` in 0.056ms. Both index definitions' normalized expressions match the query shapes exactly (confirmed by reading the actual `WHERE`/`ORDER BY` clauses against the actual index expressions, not assumed).
- **CORRECTION — the `CONCURRENTLY` risk was overstated.** An earlier draft rated this High severity and prescribed a manual out-of-band index build plus `prisma migrate resolve --applied`. Measuring the real tables on live `capiro-dev` before acting showed that mitigation was unjustified:

  | Table | Live rows | Live size |
  |---|---|---|
  | `federal_award` | 164,065 | 204 MB |
  | `sam_opportunity` | 48,653 | 135 MB |
  | `congress_bill` | 45,871 | 123 MB |
  | `sec_filing` | 11,446 | 6.7 MB |
  | `clio_conversations` | 720 | 568 kB |
  | `canonical_entities` / `entity_aliases` / `entity_identifiers` | **0** | — |

  A B-tree build over 164k rows completes in seconds, so the SHARE-lock window is negligible; and these tables are written by *scheduled* sync jobs, not continuous traffic. The original assessment came from an inference that these tables were "plausibly large," which the measurement disproved. Moreover it was moot in practice: `retrieval_v2_exact_lexical_indexes` had **already been applied to live Aurora** in a prior deployment, so all 14 indexes already existed (verified present by name). The standard `prisma migrate deploy` path was used, avoiding the `migrate resolve --applied` dance — which carries its own real failure mode (recording a migration as applied when an index silently failed to build). The `CONCURRENTLY` observation remains valid as **code-quality guidance for future migrations and for provisioning a fresh large environment**, and is downgraded to Low severity accordingly.

- **pgvector version parity**: live `capiro-dev` runs pgvector **0.7.3**; the local disposable validation environment runs **0.8.6**. HNSW and `vector_cosine_ops` are supported in both (HNSW landed in 0.5.0), so this does not affect correctness — but the environments are not byte-identical and that is worth knowing before attributing any future vector behaviour difference to code.
- One pre-existing, unrelated test bug fixed in passing: `exact-lexical-indexes.contract.spec.ts` asserted a constraint name (`entity_identifiers_global_unique`) that didn't match the real one (`entity_identifiers_global_identity_unique`) — the actual uniqueness constraint was always correct; only the test's expected string had a typo. Fixed on the readiness branch, now passing (5/5).

## 6. RLS and tenant isolation — proven empirically, not just read from source

Ran real queries as the actual `capiro_app` role (not superuser) against the fully-migrated local database, with two seeded tenants:

| Check | Result |
|---|---|
| Tenant A reads own `context_packet` rows | 1 (seeded) |
| Tenant A reads Tenant B's `context_packet` rows | **0** ✓ fails closed |
| Tenant A reads own `context_embeddings` (200 seeded) | 200 |
| Tenant A reads Tenant B's `context_embeddings` | **0** ✓ fails closed |
| Tenant A reads the global-public canonical entity | 1 ✓ correctly visible |
| **No tenant GUC set at all**, reads `context_packet` | **0** ✓ fails closed |
| **No tenant GUC set at all**, reads `context_embeddings` | **0** ✓ fails closed |
| **No tenant GUC set at all**, reads the global-public canonical entity | 1 ✓ correctly still visible |

Also directly resolved a claim in the `knowledge_events_assertions` migration's own header comment that the app role "can bypass RLS": checked `pg_roles` directly — `capiro_app` has `rolbypassrls = false`, `rolsuper = false`. The actual mechanism is a session GUC (`rls_bypass()` reads `current_setting('app.bypass_rls')`), and `grep`-ing the codebase confirms it's only ever set inside `PrismaService.withSystem()`, a distinct, narrow code path from the `withTenant()` used for ordinary per-request handling. RLS is a real, independently-enforced backstop for normal requests, not merely "defense in depth" resting entirely on application code — the migration comment overstates the weakness. Documented here since it's a materially reassuring correction, not just a nitpick.

## 7. AWS infrastructure

| Component | Status |
|---|---|
| Aurora (`capiro-dev`) | Healthy, `available`, aurora-postgresql 16.11, pgvector 0.8.6, citext/pg_trgm/pgcrypto/uuid-ossp present |
| ECS cluster `capiro-dev` | 11 active services, all healthy desired=running |
| Secrets | DB credentials wired via Secrets Manager (`/capiro/dev/aurora/{master,app}`), app connections correctly use the least-privileged `app` secret, not master |
| S3 | `capiro-dev-documents`, `-tenant-assets`, `-ml-artifacts`, `-system-logs`, `-config`, `-cloudtrail` all present |
| CloudWatch alarms | 3 currently in ALARM are routine autoscaling "scale-in" alarms (engagement-api, web-vnext CPU below threshold) — benign. Knowledge-Plane-relevant alarms (entity-resolution CPU/mem, `meriv2-context-persistence`) are all OK |
| Redis | **Not provisioned** (checked ElastiCache replication groups, cache clusters, and serverless caches — all empty) and **no code reference found** (`REDIS_URL`/`ioredis` grep returned zero files). Listed in the program architecture but not a real dependency of the current Knowledge Plane implementation — not a blocker |
| SQS | Only 2 queues exist account-wide (`capiro-change-events`, `capiro-submission-generation`), neither obviously Knowledge-Plane-specific. The account's async-job architecture runs almost entirely on EventBridge-scheduled one-off ECS Fargate tasks, not SQS consumers |
| **A second, separate live environment** | `capiro-prod-os-capiro` — its own ECS cluster, its own Aurora cluster (created 2026-06-13, running since), reachable only via `app.prodos.capiro.ai`, **not** the domain real users hit (`os.capiro.ai` is confirmed served by `capiro-dev-web-vnext`, verified via DNS + live `runtime-config.js` `releaseSha` match to a real `main` commit). Confirmed via the repo's own `docs/plans/radar-cutover-rollout.md` as an intentional, existing, "not in scope" second environment. Left untouched; flagged here as a known-issue worth someone confirming ownership/cost of, since it's real running infrastructure this audit had no mandate to change |

## 8. Live ingestion pipeline — found and fixed a real gap

The mailbox → knowledge pipeline is: `mail_messages` trigger → `knowledge_mailbox_jobs` outbox (enqueue side, confirmed working via the DB trigger) → `drain-mailbox-knowledge` script (processes the outbox: Phase 4 event durability, Phase 6 LLM extraction, Phase 7 episode projection) → `knowledge_events`/`knowledge_assertions`/episodes.

**Finding (refined after querying live)**: the pipeline is dark at **two** independent points, not one.

1. *No drain schedule existed.* The drain script exists and is correct (its own contract/consumer suite passes), but **no EventBridge rule or other scheduled trigger called it** — confirmed by checking every rule matching "drain"/"knowledge"/"mailbox" (only `capiro-dev-drain-identity-outbox`, unrelated) and confirming `capiro-dev-ingestion-orchestrator` is not a running service.
2. *Ingestion is also off at the flag.* Querying live Aurora shows `knowledge_mailbox_jobs` is **completely empty** (zero rows in any status), and the live `capiro-dev-api:158` task definition sets **no** `MAILBOX_KNOWLEDGE_*` environment variable at all. So the enqueue trigger's own gate is closed and nothing has ever been enqueued — the pipeline is not merely undrained, it is switched off upstream as well.

An earlier draft stated only the first point and characterised the pipeline as "enqueueing correctly but never drained." The live data shows that was inaccurate: nothing is being enqueued either.

**Fix applied**: created `capiro-dev-drain-mailbox-knowledge`, a new EventBridge rule (`rate(15 minutes)`), wired to the same cluster/role/network config as the working `drain-identity-outbox` precedent, container override `["drain-mailbox-knowledge"]` on the `capiro-dev-api-sync-congress` task-definition family (confirmed that family's container really is named `api-migrate`, matching the precedent exactly rather than assumed).

**Created in `DISABLED` state, deliberately.** Reasons:
- Enabling it starts real processing of live client mailbox content into `knowledge_events` (Phase 4, unconditional once the rule fires) — an append-only, largely-immutable record type (only reversible through the dedicated `rls_bypass() + app.knowledge_purge='on'` purge path).
- The separate, more consequential step — Phase 6's actual LLM-based extraction, which sends private mail text to an AI provider — is independently gated behind an explicit `MAILBOX_KNOWLEDGE_EXTRACTION_ENABLED` environment variable (by design, per the code's own comment: "so deploying extraction code cannot itself start sending private mailbox text to an AI provider"). That variable is **not set** and this checkpoint does not set it.
- Turning on live production mailbox processing is a product decision, not an infrastructure-readiness one. **Enabling this rule (and separately, setting the ingestion and extraction flags) is an explicit decision left for you.**

To actually turn live ingestion on, all three of the following are required — the drain rule alone is not sufficient:
1. Enable the ingestion flag on `capiro-dev-api` so the `mail_messages` trigger begins enqueueing (`MAILBOX_KNOWLEDGE_ENABLED`).
2. `aws events enable-rule --name capiro-dev-drain-mailbox-knowledge` so the outbox is drained.
3. Separately and only if intended, set `MAILBOX_KNOWLEDGE_EXTRACTION_ENABLED` to allow Phase 6 LLM extraction of private mail text.

No alarm exists yet for mailbox-job backlog depth; not built now since the pipeline is off at every stage — flagged as a required follow-up *before* step 2 above is taken, since an enabled drain with no backlog alarm is an unmonitored worker touching client mail.

## 9. Context layers, ContextPacket V2, enforcement, ethical walls — via 143 passing tests + direct code/DB verification

- **Five layers, exactly**: `packages/meriv2-core/src/context/layers.ts` defines `CONTEXT_LAYER_ORDER` as exactly `firm-context (A) / user-context (B) / client-context (C) / live-authoritative (D) / institutional-knowledge (E)`. `ContextLayerId` is a strict `'A'|'B'|'C'|'D'|'E'` union. No sixth layer, no Meri/Workspace-specific layer.
- **Ethical walls are real and DB-re-derived, not UI-trusted**: read `ContextSecurityScopeService.resolve()` directly — its own class comment states "Caller lists are optional upper bounds, never authorization grants," and the code re-queries `client.memoryWall`/`memoryAccessGrants` from the tenant DB every time, throwing `requested_client_scope_not_fully_authorized` if the caller claims access it doesn't actually have. Confirmed the specific regression test exists and passes: `context-resolver.service.spec.ts` → `'does not convert the UI-selected client into subject scope or authorization'`, plus siblings for fails-closed-outside-SecurityScope, ambiguous-external-entity, and portfolio-scope-respects-authorized-set.
- **ContextPacket V2 / enforcement / audit**: covered by the 143 passing tests already cited in §1 (`context-packet-v2.service.spec.ts`, `context-packet-v2-architecture.contract.spec.ts`, `context-packet-v2.migration.contract.spec.ts`, `context-plane-gateway.service.spec.ts`, `context-plane-operation-registry.spec.ts`, `context-plane-audit.service.spec.ts`, `context-plane-enforcement-architecture.contract.spec.ts`).

## 10. NVIDIA reranking

`RetrievalRerankerService` is correctness-neutral by construction: provider is `@Optional()`-injected; disabled by default (`RETRIEVAL_RERANK_ENABLED` unset); any provider failure or invalid response falls back to the original, unmodified record order with an explicit `fallbackReason`; a "candidate safety cap" avoids partially reranking a prefix. `nvidia-reranking.provider.ts` exists as a real implementation behind a factory. Confirmed **no** `RERANK`/`NVIDIA` environment variables are set on the live `capiro-dev-api` task definition — reranking, including NVIDIA, is fully dormant in production today. Nothing to fix; correctness does not depend on it, and enabling it remains a separate, canary-able decision.

## 11. Pre-existing test findings (unrelated to Phases 16-18, found while validating the wider Knowledge Plane)

Two classes of pre-existing test failures were found in `src/knowledge/` and `src/retrieval/` (330 + 5 tests, unrelated modules):

1. **CRLF checkout artifact** (`entity-identity-governance.contract.spec.ts`, `knowledge-episode-migration.contract.spec.ts`): this Windows checkout has `core.autocrlf=true`, so migration `.sql` files on disk have CRLF line endings while the tests' string literals use `\n`. Verified directly (`file` + byte count: 335 CRLF, 0 bare LF) — this is a local-environment artifact, not a repository or code defect. Verified the actual underlying behavior each test was trying to check (`capiro_app` really cannot `UPDATE entity_identity_governance_events` — confirmed via `has_table_privilege` = false) is correct. Not fixed, because there is nothing wrong to fix — the committed files almost certainly have normal LF endings; only this local clone's checkout config produced CRLF.
2. **Genuine test typo** (`src/retrieval/exact-lexical-indexes.contract.spec.ts`): expected constraint name `entity_identifiers_global_unique` didn't match the real name `entity_identifiers_global_identity_unique`. The actual constraint was always correct; only the test's string was wrong. **Fixed** on the readiness branch (now 5/5 passing).

Other, out-of-scope pre-existing failures surfaced incidentally by a broad `--testPathPattern` run (`scripts/lib/memory-phase2-*-contract.spec.ts`) belong to the older, separate "governed memory Phase 2" initiative, not this Knowledge Plane. Not investigated further — flagged only so they aren't mistaken for something this session touched.

## 12. Deployment record (Step 21) — EXECUTED 2026-08-18

Followed `scripts/deploy-dev.sh`'s documented invariant — **always migrate before rolling the API** (its header cites a real 2026-06-07 incident where rolling first made every affected query 500). Executed as discrete, individually-verified steps rather than via the script, because the script's `--build` also rebuilds `web` (out of scope) and its API roll uses `force-new-deployment`, which would have shipped nothing here (see below).

**Pre-flight checks that changed the plan:**
- `capiro-dev-api:157` pinned image **tag** `8e9ec718a…`, not `:latest`. A `force-new-deployment` would therefore have restarted the *same* image and reported success while shipping nothing — the known trap. Rolling required registering a new task-def revision.
- `capiro-dev-api-admin-migrate` connects as the Aurora **master** user (`/capiro/dev/aurora/master-*`), unlike the app-credentialed serve task. This is what makes `CREATE ROLE` in `phase8_defense_runtime_roles` viable, and is why that family — not `capiro-dev-api-migrate`, which 23 unpinned EventBridge rules read at `:LATEST` — is the correct migration vehicle.
- `main` advanced mid-session (`421373dd5` → `d14e1d161`, PRs #1041/#1042 by others). Verified those commits add **no migrations**, and re-ran the Phase 16-18 context suite at the new tip: 75/75 still green. Deployed from `main` tip rather than a stale SHA.

**Executed:**

| # | Action | Result |
|---|---|---|
| 1 | `docker buildx build --platform linux/arm64` from `main` tip, pushed to ECR as `:latest` + `:d14e1d161…` | exit 0; digest `sha256:56bf95a7451bc6b177fbcb0bd8915d53b44c0fdd9968b1912cf4336dc17b66a8`, **verified via `aws ecr describe-images`**, not docker's local output |
| 2 | Registered `capiro-dev-api-admin-migrate:23` pinned to the new digest | OK (family's existing digest-pinning convention preserved) |
| 3 | `prisma migrate deploy` via one-off Fargate task | exit 0 — `290 migrations found` → applied **`20260817233500_context_packet_retrieval_context`** → `All migrations have been successfully applied.` |
| 4 | Post-migration verification probe against live Aurora | `retrieval_context_jsonb` present; 14/14 exact-lexical indexes present; `context_embeddings_embedding_hnsw` present; pgvector 0.7.3; both defense roles present and still `NOLOGIN`/`NOBYPASSRLS`; 12/12 Knowledge Plane tables present; 7/7 expected tables `FORCE`-RLS; **`capiro_app.rolbypassrls = false` confirmed on production** |
| 5 | Registered `capiro-dev-api:158` (image `:d14e1d161…`) and `update-service` | `services-stable` exit 0 |
| 6 | Post-deploy verification | Single `PRIMARY` deployment, rollout **`COMPLETED`**, 2/2 running, 0 pending; `app.capiro.ai` HTTP 200; `os.capiro.ai` HTTP 200 |
| 7 | API log scan, 15-minute window | 3 filter matches, **all benign**: 1 was this audit's own verification probe (matched the literal word "column"); 2 were a pre-existing `DirectoryService` **WARN** about an optional, absent S3 overlay JSON. **Zero exceptions, zero Prisma errors, zero missing-column errors.** |

**Web was intentionally not rolled.** Phases 16-18 touch only `apps/api` and `packages/meriv2-core`. The web changes sitting on `main` belong to PR #1041 (another author's outreach-v3 UX work) and were not validated by this checkpoint; shipping them would have been an unrelated, unreviewed change smuggled in under a Knowledge Plane deploy.

**Rollback (single command, prior revision retained):**
```bash
aws ecs update-service --cluster capiro-dev --service capiro-dev-api --task-definition capiro-dev-api:157
```
`:157` remains registered and pins image `8e9ec718a…` (digest `sha256:947fe16…`). The only schema change applied is additive (`ADD COLUMN IF NOT EXISTS … DEFAULT '{}'::jsonb`), so `:157`'s code runs unmodified against the migrated schema — the rollback needs no down-migration.

## Known issues summary

| Issue | Severity | Blocking? | Owner/component | Recommended fix |
|---|---|---|---|---|
| 14+1 indexes built without `CONCURRENTLY` | **Low** (downgraded from High after measurement — largest table is 164k rows, and the indexes were already applied to live) | No | Retrieval V2 / meri_vnext_library migrations | Use `CONCURRENTLY` in *future* index migrations and when provisioning a fresh large environment (§5) |
| Mailbox knowledge pipeline is off at both the ingestion flag and the drain schedule | Medium (operational) | No — Phase 19 does not depend on live mailbox ingestion | Knowledge Plane mailbox ingestion | Drain rule created (disabled). Requires all 3 steps in §8, **and a backlog alarm before enabling the drain** |
| 22 historical rolled-back migration rows in the live `_prisma_migrations` ledger | Low | No — Prisma ignores rolled-back rows; `migrate status` reports up to date | DB ledger hygiene | Leave as-is; documented in §3 so future audits don't re-investigate |
| pgvector 0.7.3 live vs 0.8.6 in the validation environment | Low | No — HNSW/`vector_cosine_ops` supported in both | Environment parity | Align when convenient; know the delta before blaming code for vector differences |
| `capiro-prod-os-capiro` is a live, real-cost, unexplained-in-this-audit second environment | Medium | Non-blocking | Unknown — not this program | Someone should confirm its purpose/ownership and whether it should keep running |
| `entity_aliases` has no general unconditional `entity_id`-leading index; `knowledge_assertions.supersedes/contradicts_assertion_id` uncovered self-FK | Low-medium | Non-blocking | Knowledge Plane schema | Add covering indexes in a future migration |
| `context_packet.id` originally had no DEFAULT (later columns did) | Low | Non-blocking (no caller currently omits it) | Schema hygiene | Consider a DEFAULT for defense-in-depth |
| `canonical_entity_backfill_checkpoints` has no purge escape hatch at all | Low | Non-blocking, likely intentional | Confirm deliberate | Document the decision explicitly |
| Two same-condition triggers on `knowledge_mailbox_jobs` (extraction + episode projection) share a transaction, undercutting stated independence | Low | Non-blocking | Knowledge Plane | Worth a targeted test; not urgent |
| `20261120*` migration-timestamp clock skew | Cosmetic | Non-blocking | Dev environment tooling | Fix the sandbox clock source so future migrations sort correctly |
| Pre-existing CRLF-artifact test failures (2) | None (false positives) | Non-blocking | This checkout only | No code fix needed; consider `core.autocrlf=false`/`input` for Node/Prisma repos on Windows |
| Redis listed in architecture but not provisioned/used | Informational | Non-blocking | — | None needed unless a future phase actually requires it |

## Phase 19 gate

**READY FOR PHASE 19 — Phase 19 (Meri integration) may start.**

The gate this checkpoint was asked to answer was not "do migrations deploy" but: *can an authorized request resolve the correct subject, retrieve the appropriate real data, accurately know whether retrieval was complete, compile a governed ContextPacket with provenance, preserve tenant/client boundaries, and do so reliably in the deployed environment?* Against that standard:

- **Correct subject resolution** — verified: the resolver never converts UI-selected client state into subject scope or authorization, and fails closed on ambiguous or unauthorized subjects (§9, with the named regression test passing).
- **Appropriate real data** — verified: pgvector HNSW and all 14 exact/lexical indexes exist on live Aurora and are demonstrably usable for the real Retrieval V2 query shapes (§5).
- **Knows whether retrieval was complete** — verified: Phase 17's coverage/completeness contract is covered by passing tests, and its persistence column is live (§3, §9).
- **Governed packet with provenance** — verified: ContextPacket V2 assembly, integrity hash, and bounded persistence all covered by passing tests; Phase 18 gateway fails closed on unregistered operations, surface mismatch, tenant/actor mismatch, and expired exceptions (§9).
- **Preserves tenant/client boundaries** — verified empirically, not by reading source: cross-tenant reads return 0, missing tenant context fails closed, global-public identity stays visible, and `capiro_app.rolbypassrls = false` **on production** (§6, §12 step 4).
- **Reliably in the deployed environment** — verified: running on `capiro-dev-api:158`, 2/2 healthy, rollout `COMPLETED`, both domains HTTP 200, clean logs (§12).

The one open item — live mailbox ingestion being switched off (§8) — is deliberately **not** a Phase 19 blocker: it is a product/privacy decision about processing real client mail, and Phase 19's Meri integration consumes context through the Context Plane regardless of whether the mailbox ingestion flag is on. It should be decided on its own merits, with a backlog alarm in place first.

Two errors in earlier drafts of this document (the 8-vs-1 migration gap, and the overstated `CONCURRENTLY` severity) were found by measuring the live environment rather than trusting inference, and are recorded in place above rather than silently corrected. Both are noted here because the same failure mode — treating a local-environment measurement as if it described production — is the single easiest way for the next checkpoint to go wrong.
