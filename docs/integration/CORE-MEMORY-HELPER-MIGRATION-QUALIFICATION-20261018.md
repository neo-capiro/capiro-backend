# Held memory helper migration: local qualification and collision inventory

**Source rehearsal only, 2026-10-18.** The held migration is
`apps/api/prisma/migrations/20281018100000_meri_memory_eligibility_helper/migration.sql`
on `codex/core-memory-signed-source-20261018` at
`57ec94db9fcc12ca503f47546bea2e80ea5306f7`. Its source SHA-256 is
`387ef6d75f940fd996fed0106415ed2f88bd6112005e1054df9d15c73133a171`.
The SQL changes the existing `meri_read_tokens` table only: eight nullable
parent/page/callback hash columns, one distinct `memory_eligibility` kind, a
parent foreign key, closed helper checks and unique indexes for the original
`(run_id, call_key)` and parent JTI. It has local `lock_timeout = '5s'` and
`statement_timeout = '30s'`. It contains no `GRANT`, new table, slot-counter
change, admission-view change or ordinary `tool_tokens` ceiling change.

## Collision and order inventory

I scanned the migration directory at the tips of 33 local and fetched remote
Git refs using `git for-each-ref` and `git ls-tree` for prefixes `2028101809`
and `2028101810`. The `100000` directory appeared only on the held signed
source branch; no other directory with that prefix appeared in those refs.
The Core integration ledger reserves this exact name. The integrated Stage 1
tree at `8712e508808757bf1cc36097bb7eedbf1184a1c2` contains
`20281018090000_clio_meri_memory_submissions_content_free` and does **not**
contain `100000`. A future inclusion in Prisma's migrations directory would
put `100000` after `090000`; keep it out until the preceding migration has
been qualified and applied. This scan cannot prove what migration names or
checksums a target database has already recorded in `_prisma_migrations`, nor
what an unfetched branch may contain.

## Disposable PostgreSQL 16.15 result

In a fresh isolated localhost cluster on port 55493, I installed the exact
Core `20281018060000_meri_read_delegation` migration, seeded a synthetic
delegation, one slot and a consumed ordinary tool token, then applied the
exact held `100000` SQL. The local cluster had synthetic `rls_bypass()` and
`current_tenant_id()` helpers and a `capiro_app NOLOGIN` role so the original
`060000` grant block exercised its existing SELECT, INSERT and
`consumed_at` UPDATE privileges. This was not a target database or its
production role configuration.

The helper migration committed without error. With `SET ROLE capiro_app`
and a tenant-scoped RLS setting, a helper INSERT, SELECT and one-use
`consumed_at` UPDATE succeeded. `body_sha256` UPDATE and DELETE were denied;
another tenant saw zero token rows. The original tool row remained and the
slot constraint definition still read `tool_tokens BETWEEN 0 AND 1`. Wrong helper target,
missing parent and a second helper for the same slot/parent all failed under
the new checks or unique indexes. The final local table held exactly the
seeded tool row and one helper row, with both helper indexes present. The
isolated server was stopped with `pg_ctl -m fast -w stop`, its process exited,
port 55493 stopped responding, and only its verified workspace data directory
was removed. No live SQL, AWS call, production grant or credential change
occurred.

## Deployment hold

This exercise does not qualify target schema, role inheritance, current RLS
functions, token-row volume, concurrent DDL locks, migration ledger state,
Meri's installed signed wire or runtime readback. Before including `100000`
in a deployment tree, read the named target's `_prisma_migrations` and exact
`meri_read_tokens` catalog/ACL/RLS, confirm `060000` and the preceding staged
`090000` state, rehearse the actual target shape and role in a disposable
clone, and reserve a bounded DDL window. The signed memory HTTP owner remains
hard disabled before mint and consume until these and the independent runtime
authority gates are met.
