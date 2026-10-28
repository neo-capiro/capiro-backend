# Public funding transfer into the existing preview clone

This is an operator procedure for the release owner in the reserved preview window. Source is capiro-dev; destination is the **existing** capiro-newstack-preview-clone. Never delete, re-clone, truncate or restore over either database. No Meri, UI, tenant, customer, saved-opportunity or client-workflow data is imported.

## Scope and identity

| Table | Source rows and identity |
| --- | --- |
| `federal_grant` | All public grants; government opportunity ID is retained. |
| `sam_opportunity` | All public notices; exact verified 32-hex government notice ID after lowercasing and removing hyphens. Existing target local IDs win. No title/solicitation fuzzy matching. |
| `tango_opportunity_notice` | Public notice history by `tango_notice_id`; remap local SAM pointer. |
| `opportunity_attachment` | All public catalog attachments; remapped parent and URL, or same SAM parent and provider attachment ID. Only the canonical SAM file endpoint's empty `?&token=` alias is normalized. Multiple candidates or conflicting identities refuse the entire transfer. |
| `opportunity_document_text` | Native/provider extracted text by mapped attachment and extraction method; preserve target row IDs and exact archived-byte hash binding. |
| `tango_resource_snapshot` | Only `grant`, `notice`, `opportunity`; resource type, external ID and content SHA are the natural key. Union observation history and select one freshest active head, preserving target IDs/content. Renumber the merged local history sequence so its active head owns the highest version and the existing writer can continue monotonically. |
| `tango_resource_link` | Only public grant/SAM links to the three funding resource types, `exact_identifier`, with no reviewer, review timestamp or review notes. Existing target decisions win. |
| `context_embeddings` | Only `funding_grant_chunk`, `funding_notice_chunk`, `funding_attachment_chunk`, with **tenant, client and owner all NULL**. Map parent source ID, attachment SAM pointer and `parentId`; preserve target vector IDs on natural-key collisions. |

The consolidated writer has no procurement-forecast lane. Its separate forecast writer and data remain in place; forecast, award, contractor, SBIR and DIBBS tables are excluded. Operational checkpoints/runs are deliberately excluded: reconciliation cursors contain source-local IDs, target-only records need their own traversal, and run errors/stats may contain unrelated context. Existing target checkpoints/runs are untouched. Use the target's own checkpoint/fresh-crawl policy after the transfer; never copy a source reconciliation cursor.

The operator uses psycopg 3, PostgreSQL streaming COPY, temporary candidate tables and the existing funding mapper's `searchText`, `hash` and `stable` functions. There is no new persistent ledger, staging schema, queue, dependency or provider request. Every COPY has a full transport checksum. Memory is bounded to a protocol block or one document's text/chunk metadata, rather than the full catalog or vector set.

Canonical fields use provider freshness, with observed time only when provider time is absent. Missing/blank source enrichment does not erase richer target data; nested JSON provenance is merged by key. Explicit newer lifecycle nulls use the canonical provider payload evidence. Archived bytes and extracted-text observations remain coherent groups. A changed URL never inherits an old archive as if it were the new document.

Vectors retain their recorded v1/v2/v3 chunker. Their content hashes, dimensions, public scope, parent references and original geometry are checked. Complete current sets are verified against normalized source text and receive a marker built from their actual metadata and recorded chunker. Historical/stale sets are retained with no falsely current marker. Target-only vectors are preserved. A source body that conflicts with the retained newer/richer target body is reported, not used to replace the target's vectors. A source current set can replace a stale target set atomically, including obsolete trailing chunks.

## Prerequisites

For the separately authorized metadata-only preflight, use the release owner's already established `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, TLS and credential environment; do not print or put those values on the command line. From the API workspace:

```sh
psql -X --no-password --set=ON_ERROR_STOP=1 --file=scripts/qualification/tango-clone-preflight.sql
```

This SQL performs a bounded `BEGIN READ ONLY` inventory of the two expected migration records, eight tables' columns/types, constraints, indexes/validity, RLS policies, approximate statistics and privilege booleans. Missing additive migration records/columns/indexes are valid preflight observations. It reads no catalog/client records, creates no TEMP objects and takes no writer/advisory locks. It does not authorize the later staging dry-run or commit.

1. Obtain the release owner's existing shared-window reservation; stop live acceptance for the window. The preparation dry-run also needs this window: it acquires locks and creates TEMP tables. It is not a read-only cloud audit.
2. Read both actual migration ledgers and constraints with an authorized operator. Verify source/target schema and every migration needed by this bounded change. Snapshot the clone **before each immutable forward migration**, wait for availability, and retain the snapshot identifier privately in ordinary release evidence. Do not replay unrelated pending migrations.
3. Apply the immutable SQL artifacts ported from source commit `900ffb77fb7f6981628e8c9ca043e1740fd396a2` and pinned to the freshly verified source ledger, then mark the exact successful migration with Prisma. `20261024010000_tango_funding_consolidation` is transactional; `20261026184000_tango_funding_embedding_prefix` runs **outside** a transaction. Verify the concurrent index's definition, valid and ready flags; `IF NOT EXISTS` alone is not proof.
4. Snapshot again before the data merge. The last migration snapshot may cover the merge only if that migration has just been applied and the release owner has verified that no intervening data writes occurred. Never treat a failed/incomplete snapshot as protection.
5. Disable and drain source and target catalog, archive and embedding writers, including any legacy/uncooperative jobs; save prior schedule/task state for rollback. Source is read-only repeatable-read for the transfer. The operator requires the three existing advisory locks on both endpoints and locks the eight target catalog tables against concurrent writes. Those locks do not replace operational writer quiescence.
6. The role must support `rls_bypass()` so all protected rows can be compared. Use owner-only connection input, environment credentials and the RDS CA; trace/logging must be off. The CLI pins the exact source and destination hostnames and database `capiro`, requires TLS `verify-full`, and rejects host lists. No credentials are read from AWS by this script.
7. Use the qualified Node 24 API workspace with its frozen `tsx`/mapper dependencies and Python with psycopg 3. Reserve enough database temporary storage for source and target public catalogs/vectors and sufficient transaction/WAL headroom. Statements are capped at 30 minutes; lock waits at 5 seconds. A timeout rolls the transaction back; it is not permission to weaken checks.

Migration byte checksums (SHA-256):

| Migration | Exact source Git blob (LF) | Existing Windows checkout bytes |
| --- | --- | --- |
| `20261024010000_tango_funding_consolidation` | `8eaee769d0262160d027c6c478fe26ff4baa51b447bd2d99954ac5ea682217d7` | `003ae3c6af559ae7ffab4e822a341cab097fa94e063437223e9fd6346f3d0913` (CRLF) |
| `20261026184000_tango_funding_embedding_prefix` | `c3c2883a8022cac25ee7b894710ce3601ecf32da0bb24d16afd1ac40c6de9089` | same |

The release owner's fresh source ledger read confirmed **`003ae3c6…` (CRLF)** for consolidation and **`c3c2883a…`** for the prefix index. The backend consolidation artifact is committed as those exact CRLF bytes with a `-text` attribute. Apply/register those pinned artifacts. The LF Git blob is listed only to explain the historical byte discrepancy; it is not an alternative execution artifact. Do not relabel its hash as the applied artifact or edit either immutable migration.

## Execute and verify

Private config has exactly `source` and `target`, each containing `host`, `port` (5432), `dbname` (`capiro`), `user`, `password_env` (a `TANGO_TRANSFER_*` variable name), and `sslrootcert`. Hosts are pinned in the operator:

- `capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com`
- `capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com`

From the qualified API workspace, with the private input already supplied by the release owner:

```sh
python3 scripts/qualification/tango-clone-transfer.py --config /owner-only/transfer.json --window-approved --writers-paused --snapshot-verified
# Review aggregate candidate counts, conflicts and retained stale/current-vector coverage.
python3 scripts/qualification/tango-clone-transfer.py --config /owner-only/transfer.json --window-approved --writers-paused --snapshot-verified --commit
```

No `--commit` means no public-table mutations: candidate tables are checked then rolled back. Commit publishes the complete validated candidate in one transaction. A failed run is replayed from the beginning against a fresh consistent source snapshot; natural-key mapping makes replay idempotent. No partial chunk set, copied cursor or half-published mapping survives a failed transaction.

The receipt contains counts, content/transport checksums and booleans only. It compares server-side protected-row digests for clients, saved opportunities, matches, bookmarks, nexus, requirement/review/workflow rows, catalog FK dependants and private embeddings before/after. IDs and private rows never leave PostgreSQL for this check. Natural ID conflicts, schema differences and broken reference chains refuse publication. Exit codes: 0 success, 2 configuration/safety refusal, 1 operational failure with raw diagnostics suppressed.

The S3 manifest is an aggregate count, byte total, distinct-object count and SHA-256 over referenced bucket/key/version/hash rows. Existing private content-addressed originals stay in their original bucket; no file bytes are downloaded or copied. Before retrieval acceptance, the release owner verifies the target task role's scoped `s3:GetObject`/`s3:GetObjectVersion` for existing originals and `s3:PutObject` for continued archival under the approved **funding-source-documents/** prefix, plus checksum-valid representative reads. The inspected source objects use AES256; they do not require an inferred KMS grant. Do not broaden access to tenant-document prefixes.

After commit, independently verify aggregate table/identity/reference counts, archived hash bindings, actual read access to originals, saved-record relationships and representative text/vector retrieval. Do not call deferred or stale documents complete. Resume exactly one target catalog writer and the existing derived workers in the approved target configuration. Source writers may resume only under the release owner's chosen cutover policy; never enable duplicate source schedules against the same database. Record which database is now the active ingestion owner.

## Isolated checks and rollback

```sh
python3 scripts/qualification/tango-clone-transfer.test.py -v
python3 scripts/qualification/tango-clone-transfer.test.py --database-config /owner-only/synthetic-transfer.json --api-dir "$PWD" -v
```

The second command requires root-allocated, empty, migrated loopback databases named `tango_transfer_source_test` and `tango_transfer_target_test`. It inserts synthetic records only and leaves them for inspection. It never resets, truncates or migrates an existing database. Root owns their eventual disposal. Pure checks alone do not establish PostgreSQL correctness or live completion.

Before commit, rollback is transaction rollback/connection closure. After commit, rollback is operational: disable/drain new target workers and retain both databases and original archives. Use the pre-merge snapshot only in a **separate recovery cluster** for targeted comparison/repair if required. Never overwrite the clone, restore an entire database on top of it, delete copied catalog rows blindly, or remove additive columns. Existing saved/client IDs and relationships must survive recovery too.
