# Public usable embedding coverage index: release notes

This additive index accelerates public, current-model, nonzero-vector coverage
counts. It changes no records, grants, RLS policies, embedding jobs or deadlines.
The SQL must run outside a transaction, under an existing authorized table owner.
Do not change the migration SQL/checksum to work around a failed build.

## Known preview recovery prerequisite

Earlier concurrent CREATE/REINDEX attempts left these two index structures
invalid in the existing preview database:

- `context_embeddings_public_usable_coverage_idx`
- `context_embeddings_public_usable_coverage_idx_ccnew`

No successful application of this migration was recorded there. These are
historical observations, not a substitute for a fresh read of the release target.
This PR does not perform recovery or apply the migration.

`CREATE INDEX CONCURRENTLY IF NOT EXISTS` can return successfully while skipping
an invalid same-name index. Therefore an exit code of zero is NOT acceptance.
Coordinate the database window with the release owner before proceeding. If
invalid or different same-name structures remain, stop and use the separately
reviewed exact-target recovery procedure; do not blindly retry, drop unrelated
indexes, kill sessions, mark the migration applied or edit the ledger.

## Read-only preflight

Verify the intended database, authenticated role, snapshot and release ownership
through the existing release process. Inspect the table owner and index state:

```sql
SELECT current_database(), current_user;
SELECT pg_get_userbyid(relowner) AS table_owner
FROM pg_class WHERE oid = 'public.context_embeddings'::regclass;

SELECT n.nspname AS schema_name, c.relname AS index_name,
       i.indisvalid, i.indisready, pg_get_indexdef(c.oid) AS definition
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE i.indrelid = 'public.context_embeddings'::regclass
  AND c.relname IN ('context_embeddings_public_usable_coverage_idx',
                   'context_embeddings_public_usable_coverage_idx_ccnew');

SELECT pid, command, phase
FROM pg_stat_progress_create_index
WHERE relid = 'public.context_embeddings'::regclass;
```

No active build at one instant is not a maintenance-window acknowledgment.
Existing old transactions/snapshots can delay a concurrent build. Do not cancel
readers without separately verified ownership and exact query identity.

## Application and acceptance

1. Resolve only verified failed structures, if present, through the release
   owner's reviewed recovery. This is separate from migration application.
2. Apply this exact migration through the existing controlled migration owner,
   outside `BEGIN`/`COMMIT`, with the approved source artifact and target.
3. Reread the index and require `indisvalid = true`, `indisready = true`, and the
   exact key, INCLUDE columns and public/nonzero predicate in `migration.sql`.
   A different definition is drift, even if it is valid.
4. Verify the migration owner's successful ledger state/checksum separately.
   A valid standalone index does not prove the migration was recorded.
5. Ship the paired Core and Meri fixes, then rerun the original authenticated
   search cases, source/tool audits and citation checks.

The index does not fetch DIBBS documents, backfill SBIR topics, prove query
relevance or turn corpus-wide coverage into filtered-population coverage.
