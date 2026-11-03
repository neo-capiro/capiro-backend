# Tango funding on the preview clone

Ported from capirov2 `900ffb77fb7f6981628e8c9ca043e1740fd396a2` onto capiro-backend `b442ab622589d1345195b5dd246c8802b4deed08`. This document describes the source port, not a completed deployment or data transfer.

## Ownership and preserved contracts

`sync-tango-funding` is the canonical grant/notice/document observation writer. Existing `federal_grant` IDs, local `sam_opportunity` UUIDs, saved client opportunities, notes and relationships remain intact. Tango snapshots, exact government-ID links, checkpoints and sync-run records remain the existing owners. Missing enrichment does not erase richer data; dated stale observations cannot replace newer canonical content. Reconciliation records source gaps rather than inventing closures from absence.

`sync-tango-opportunity-attachments` archives originals to private, content-addressed S3 objects and extracts bounded native PDF text. Provider text retains provider provenance independently of archived bytes. URL changes invalidate obsolete archive/text bindings. `embed-funding-catalog` embeds active grants, active notices and their documents through Titan v2, 1,024 dimensions. Unicode-safe chunks are bounded to 6,000 characters and 6,000 UTF-8 bytes, with overlap; atomic publication rechecks the source and preserves earlier vectors on failure. Historical records/vectors remain stored; the scheduled run embeds the active scope only, and a one-off task with `--scope=all` embeds every pending record newest first under the same `--limit` (max 10,000 per kind) and `--max-chunks` (max 20,000) bounds. A bounded successful run is not proof that all queues are empty.

USAspending, defense budgets, DIBBS, SBIR, awards, forecasts, matching readers, Core authorization and client workflows are preserved. The SAM operator remains available only with `--match-only`; the composite defense-budget loader now selects that path explicitly. No Meri or UI implementation is imported.

## Release preparation

Release owns AWS, snapshots, the persistent clone, schedule cutover, migration and transfer. Never delete/re-clone the preview database, mutate shared live data, run test fixtures on it, or enable both old and new catalog writers. Snapshot before each forward migration. The two SQL files below are immutable copies of the deployed source:

| Migration | SHA-256 |
| --- | --- |
| `20261024010000_tango_funding_consolidation` | `003ae3c6af559ae7ffab4e822a341cab097fa94e063437223e9fd6346f3d0913` |
| `20261026184000_tango_funding_embedding_prefix` | `c3c2883a8022cac25ee7b894710ce3601ecf32da0bb24d16afd1ac40c6de9089` |

The first applied artifact is CRLF (2,480 bytes), matching the independently read dev ledger. Its source Git blob is LF (2,446 bytes, SHA-256 `8eaee769d0262160d027c6c478fe26ff4baa51b447bd2d99954ac5ea682217d7`). This port preserves the applied CRLF artifact under `-text`; never replace its ledger checksum with the Git-normalized value. The second migration creates its index concurrently; run it outside an enclosing transaction and verify the resulting index is valid before ledgering. Do not modify either SQL file to accommodate a target conflict; resolve conflicts explicitly with forward work.

Build and qualify the new exact-head `apps/api/Dockerfile.alpine-qualification` ARM64 image using the backend's existing locked graph and full probes. An earlier image qualification does not cover this port. No separate funding npm graph or x86/dev image is introduced. The Core image already includes the scripts, source modules, Prisma client and all required dependencies.

Use a dedicated ECS task from that qualified image, with runtimePlatform ARM64, non-root image user, read-only root filesystem, writable `/dev/shm`, bounded CPU/memory and the restricted entrypoint:

```
/bin/sh /app/apps/api/scripts/funding-worker/entrypoint.sh
```

The entrypoint accepts only `sync-tango-funding`, `embed-funding-catalog` and `sync-tango-opportunity-attachments`. It uses the official copied RDS CA bundle. Supply the clone's own database configuration through existing secret references; never reuse the dev DB secret merely because the source task used it. Required runtime configuration:

- `DATABASE_URL` (verified TLS) or all `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` inputs for the existing composer.
- `FUNDING_ALLOWED_DB_HOST=capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com` for every commit task. This value cannot extend the hardcoded allowed-host set.
- `TANGO_API_KEY` through its authorized secret reference for catalog ingestion; the catalog client uses the fixed `https://tango.dev` origin and retains its request budgets.
- `OPPORTUNITY_ATTACHMENT_BUCKET` and `OPPORTUNITY_ATTACHMENT_PREFIX=funding-source-documents` for the approved private clone archive. The transfer runbook owns how source archive pointers and required objects are carried forward.
- Task IAM for the existing Tango secret, approved archive prefix and Titan v2 as needed; Release verifies exact role resources and retained public-block/encryption policy.

Start with bounded dry-runs, then commit canaries and measured reads. `--help` documents the three CLIs and exit status. Catalog options include lane, page/request budgets and original-grant gaps; embedding limit is per catalog kind and max-chunks is shared. Catalog, archive and embedding sessions use distinct advisory locks. Checkpoints survive process exit, and committed embedding progress remains available. Existing forecast schedules remain owned by their existing worker; this dedicated entrypoint does not expose that separate path.

Disable only replaced clone writers before enabling the new writer. The checked-in generic schedule helper removes obsolete registrations and declares consolidated jobs disabled until Release supplies its explicit clone task/target. Do not run the source dev schedule installer or import its dev IAM/task definition. Roll back by stopping new writers and restoring the pre-cutover schedule targets; preserve additive columns and imported data.

## Removed paths and surviving verification

Seven replaced implementation/test pairs are deleted: `sync-grants`, `enrich-grant-details`, `backfill-sam-opportunity-fields`, `diag-tango-opportunity-parity`, `sync-tango-opportunity-shadow`, `sync-tango-opportunity-notices` and `sync-tango-opportunity-text`. Their package/dispatcher/schedule/tsconfig registrations are removed. Applied migrations, history tables, historical evidence documents and synthetic codemod fixtures remain intentionally.

Coverage moves to `sync-tango-funding.spec.ts`, `funding-catalog.db.spec.ts`, `funding-cli.spec.ts`, the retained attachment/gateway/store suites, native document/original-grant suites and `test-tango-funding-postgres.ts`. The PostgreSQL rehearsal checks canonical IDs, stale updates, full notices, client-linked saved records, archive races, lifecycle reconciliation, Unicode/chunk coverage, active-only selection, vector reuse, prefix isolation and atomic replacement. Run it only on a disposable PostgreSQL 16 database named `funding_test` on loopback; it truncates synthetic fixture catalogs.

The backend has no `.github` workflow tree, so the old monorepo CI was not copied. Its existing source/qualification gates remain authoritative. Run funding typecheck, affected Jest suites, index contract tests, isolated migration/rehearsal, API build/lint/typecheck, and runtime closure tests. Regenerate the production closure contract and both Prisma architecture pins with manifest/schema changes; never loosen probes. Exact-head independent review and ARM64 image/isolated-DB/exact-digest security qualification precede Release execution. Follow [the transfer runbook](../tango-clone-transfer/RUNBOOK.md) for snapshot-first data movement and identity remapping.

## DIBBS and SBIR/STTR active-source integration (SCRUM-250)

Source only: the migration, worker deployment, schedule cutover and active backfill have not been applied by this change.

### Canonical writer and storage

`sync-tango-funding --lane=dibbs` walks RFQs and RFPs with `open=true`;
`--lane=sbir` walks topics and solicitation cycles with `activity=open`.
These explicit lanes reuse the existing client, shared request budget, advisory
lock, page writer and durable checkpoints. The default eight lanes are unchanged.
There is no `--active` flag. DIBBS awards remain historical records and are not
part of active opportunity coverage.

Canonical tables remain `public.tango_dibbs_solicitation`,
`public.tango_sbir_topic` and `public.tango_sbir_solicitation` in database `capiro`
on `capiro-newstack-preview-clone`. Upserts preserve local IDs using verified
provider IDs. Topic descriptions are explicitly requested; absent text preserves
richer stored text. SBIR search exposes that description as the summary and
requires explicit open activity, an unexpired deadline and no closed raw status.
Raw lifecycle facts remain available in `source_facts`.

Checkpoints retain a separate fingerprint per endpoint and fixed page size.
They advance only after all page writes succeed. Partial runs resume the saved
cursor/window, and health continues to use `sync-tango-dibbs`/`sync-tango-sbir`
SyncRun names. The old standalone CLIs are unchanged and do **not** share this
lock. Disabling their schedules is required before the new writer starts.

### Forward migration and cutover

Snapshot the clone before applying
`20281103120000_tango_dibbs_sbir_source_integration`. It preserves existing
checkpoint types and adds exactly `dibbs_solicitation`, `sbir_topic` and
`sbir_solicitation`; adds nullable topic `description`, `embedded_content_hash`
and `embedded_at`; and permits a null cycle public number while retaining the
constraint against empty strings. It rewrites or deletes no existing rows.

Release must disable and drain these four old writers first:
`fo-dev-sync-tango-dibbs`, `fo-dev-sync-tango-sbir`,
`fo-dev-reconcile-tango-dibbs-full`, `fo-dev-reconcile-tango-sbir-full`.
The verified daily targets point at the old database, not the clone. Preserve
all four original targets and states for rollback. After snapshot, migration,
qualified ARM64 worker deployment, bounded canaries and database read-back,
retarget and enable only the two daily rules using the existing clone funding
worker's IAM role and network configuration:

- `fo-dev-sync-tango-dibbs`: `sync-tango-funding --commit --lane=dibbs --max-requests=140`, daily 00:05 UTC.
- `fo-dev-sync-tango-sbir`: `sync-tango-funding --commit --lane=sbir --max-requests=20`, daily 01:20 UTC.

The weekly full rules stay disabled. The checked-in schedule entries are managed
out of band; generic CDK deployment does not perform this cutover. Validate both
canonical reads and the app before declaring the source current. Rollback stops
the new writer and restores recorded targets; retain additive schema and data.

### Closures and embeddings

All active endpoint walks run before closure checks. Only a completed endpoint
sweep permits exact detail reads for up to 100 previously-open, unexpired rows
not refreshed since its persisted sweep epoch. These calls share the same budget.
Confirmed closed details use the normal mapper; confirmed 404s clear only the
derived flag (`is_open=NULL` or `activity='unknown'`) and observation time.
Identity mismatch, unmappable detail or quota exhaustion leaves the pass partial.
An incomplete active sweep does not reconcile its endpoint. Absence from an
active list alone never closes a row. Unknown SBIR activity is not pursuable.

The existing `embed-funding-catalog` writer includes `sbir_topic`, requiring useful
description text and active scope by default. It reuses existing chunking,
content hashes, vectors and atomic replacement. Chunks use
`source_type=funding_sbir_topic_chunk`, `sourceTable=tango_sbir_topic`, local
`parentId`, `providerTopicId`, `binding=provider_topic_id`, and the topic or
original solicitation URL. This is a provider ID, not a government crosswalk.
Only an explicit `--scope=all` requests historical topics. DIBBS and SBIR cycles
have no title-only embeddings. Original document links are retained; SBIR BAA
PDF extracted-text coverage is not claimed.
