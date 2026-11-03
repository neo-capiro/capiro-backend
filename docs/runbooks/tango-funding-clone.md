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

Source only. Nothing below has been applied, scheduled or deployed.

### What changed in source

- `sync-tango-dibbs` and `sync-tango-sbir` now own a durable walk position in `tango_sync_checkpoint`. A page is checkpointed only after every mapped write on it succeeded; quota stops, page caps and write failures retain the cursor and the window, so the next run replays the interrupted page rather than restarting at page 1. The filter fingerprint includes endpoint, batch size and window mode, so RFQ and RFP (one table) and topic and solicitation (two tables, possibly overlapping provider keys) never share a cursor.
- Both walks gained an explicit active mode: `--active` sends the provider's own documented lifecycle filter — `open=true` on DIBBS RFQ/RFP, `activity=open` on SBIR topics and solicitations — instead of inferring activity from an issue/publication date. Active mode excludes DIBBS awards (historical award facts, not opportunity coverage) and does not require an award walk to report completeness.
- The SBIR topic list now requests an explicit field shape including `description`; the provider's default projection omits it, so mapping alone would store null while looking correct. `tango_sbir_topic.description` is additive and nullable, and an absent description never overwrites stored text.
- Both standalone CLIs take the existing `capiro:tango-funding` advisory lock, so there is no lock-free writer path to these tables.

### Forward migration (author only — not applied)

`20281103120000_tango_dibbs_sbir_source_integration`: widens only `tango_sync_checkpoint_resource_type_chk` with `dibbs_solicitation`, `dibbs_award`, `sbir_topic`, `sbir_solicitation` (all existing values preserved), and adds nullable `tango_sbir_topic.description`. Snapshot the clone, then apply; both changes are additive and safe to leave in place on rollback.

### Schedule cutover (Release owns; not performed here)

`--lane=dibbs` and `--lane=sbir` ARE the active-only lanes: the lane sends the provider's own `open` filter. There is no separate `--active` flag on `sync-tango-funding`; a command using it is rejected.

Retarget the two existing daily rule IDs to the qualified dedicated clone funding worker, keeping their IDs and crons, and using the existing funding-worker IAM role and network configuration with command overrides — not the old `capiro-dev-api-sync-jobs` task, which still points at the pre-clone database:

- `fo-dev-sync-tango-dibbs` → `sync-tango-funding --commit --lane=dibbs --max-requests=140` (daily 00:05 UTC)
- `fo-dev-sync-tango-sbir` → `sync-tango-funding --commit --lane=sbir --max-requests=20` (daily 01:20 UTC)

Both budgets are finite and shared with the existing daily reserve; the current active catalogs are roughly 88 pages at 100 rows, so a lane may legitimately end partial and resume from its cursor the next day. `ingestion-schedule.ts` marks both entries `managedOutOfBand` so a Compute-stack deploy cannot recreate the old target.

FOUR existing out-of-band rules must be DISABLED before the qualified worker starts writing: `fo-dev-sync-tango-dibbs`, `fo-dev-sync-tango-sbir`, `fo-dev-reconcile-tango-dibbs-full`, `fo-dev-reconcile-tango-sbir-full`. The two weekly `--full` entries are removed from the schedule declaration, but deleting a declaration does not delete an out-of-band EventBridge rule — disable them explicitly. The unbounded weekly history walk is not needed for active coverage and must not alternate with the consolidated writer. The legacy `sync-tango-dibbs` / `sync-tango-sbir` scripts do NOT take the consolidated `capiro:tango-funding` advisory lock, so a leftover enabled rule is a genuine concurrent writer — not a harmless no-op. That is why disabling those four rules is a cutover requirement rather than tidiness. Do not create competing schedules. Grants and SAM schedules are unchanged.

Sequence: snapshot the preview clone → apply the forward migration → start the qualified dedicated clone funding worker with bounded dry-runs, then commit canaries → verify source health read-back → only then retarget the daily rules. Preserve the old data, existing local IDs and the pre-cutover rule targets as the rollback.

### Closure semantics and known limitations

- Partial or failed runs never close, expire or erase a row. Existing read-path date expiry is unchanged.
- On a COMPLETED DIBBS open traversal, a previously-open row not refreshed during that traversal has its derived `is_open` cleared to NULL (never false, never deleted) and stops being pursuable. The read path still renders such a row in the `closed` lifecycle bucket; the frontend stage must surface "not confirmed open" from `source_facts.providerOpen` rather than claiming closure.
- SBIR closure is NOT applied yet: `sourceBase` currently derives `active` from a null/unrecognised status and a future close date, so writing an `unknown` marker would advertise those rows as active rather than retire them. Correcting that read semantics and adding the reconciliation is the follow-up.
- Paid BAA solicitation PDFs are not exposed as extracted text by the current SBIR API; no claim is made that those documents are embedded.

### Deferred

### Active SBIR topic embeddings

`embed-funding-catalog` gained a fourth source kind, `sbir_topic`, over
`tango_sbir_topic`: body `title || agency || description`, url
`coalesce(topic_url, official_solicitation_url)`, source_type
`funding_sbir_topic_chunk`, changed column `last_synced_at`, with the same
chunker, hash, vector reuse and atomic publication as grants and notices. The
scheduled active scope requires `lower(activity) = 'open'`, an unexpired
`close_date` and a raw status that is not closed/expired/complete; historical
topics are reachable only through an explicit `--scope=all`. Metadata records
`sourceTable=tango_sbir_topic`, the source URL, and `binding=provider_topic_id`
(the provider topic id, not a government identifier). No DIBBS title-only and no
SBIR cycle title-only embeddings exist, and no claim is made that paid BAA
solicitation PDFs are embedded — the SBIR API does not expose that extracted
text, so the original source URLs are preserved.

### Closure of previously-active rows

A partial or failed sweep never closes, expires or retires anything. After an
endpoint's active walk COMPLETES, the writer re-reads the provider detail for
locally-open, not-yet-expired rows of THAT endpoint whose `last_synced_at`
precedes the sweep epoch (the persisted checkpoint window of a resumed sweep;
the current clock only for a fresh one), bounded to 100 rows and metered by the
same request budget. A confirmed 404 clears only the derived flag
(`is_open = NULL` / `activity = 'unknown'`) and bumps `last_synced_at`, keeping
ids and content; a confirmed closed detail is written through the normal mapper;
an identity mismatch or an unmappable detail writes nothing; a quota stop makes
the pass partial and the remaining rows are retried by the next bounded run.
Absence from the active list is never treated as evidence of closure.
