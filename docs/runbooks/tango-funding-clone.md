# Tango funding on the preview clone

Ported from capirov2 `900ffb77fb7f6981628e8c9ca043e1740fd396a2` onto capiro-backend `b442ab622589d1345195b5dd246c8802b4deed08`. This document describes the source port, not a completed deployment or data transfer.

## Ownership and preserved contracts

`sync-tango-funding` is the canonical grant/notice/document observation writer. Existing `federal_grant` IDs, local `sam_opportunity` UUIDs, saved client opportunities, notes and relationships remain intact. Tango snapshots, exact government-ID links, checkpoints and sync-run records remain the existing owners. Missing enrichment does not erase richer data; dated stale observations cannot replace newer canonical content. Reconciliation records source gaps rather than inventing closures from absence.

`sync-tango-opportunity-attachments` archives originals to private, content-addressed S3 objects and extracts bounded native PDF text. Provider text retains provider provenance independently of archived bytes. URL changes invalidate obsolete archive/text bindings. `embed-funding-catalog` embeds active grants, active notices and their documents through Titan v2, 1,024 dimensions. Unicode-safe chunks are bounded to 6,000 characters and 6,000 UTF-8 bytes, with overlap; atomic publication rechecks the source and preserves earlier vectors on failure. Historical records/vectors remain stored. A bounded successful run is not proof that all queues are empty.

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
