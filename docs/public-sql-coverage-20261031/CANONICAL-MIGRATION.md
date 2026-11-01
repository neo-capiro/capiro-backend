# Canonical migration integration

This successor places the already accepted DB package in Prisma migration discovery. It changes no SQL semantics, registry, compiler, schema, runtime policy, credentials or applied history. The earlier README describes the source preparation stage; this document records the subsequent canonical source integration.

The sole DB owner assigned `20281031160000_public_sql_hearing_projections` after `20281031150000_defproc_qualified_sam_actions_v2` and confirmed no other canonical integration writer. Fresh actual Core main `6e3ab531b5d5ac46059123b3411cbd145037e96d` (tree `65eda0de5a960bdd61f1dad58af9d8659e1cda47`) contains Lane 6 and the accepted public registry through PR333, with no assigned-name collision. This is source ordering, not a statement about the current database ledger or permission to apply.

## Exact accepted inputs

- Canonical path: `apps/api/prisma/migrations/20281031160000_public_sql_hearing_projections/migration.sql`.
- Accepted `forward.sql`: 17761 bytes, SHA256 `62afa66c7bacd1a3d1ade46802cdda07b89157ab2fa2b122d2b0766c6aa9dede`.
- Sealed DB package manifest: SHA256 `1077c29cd9f57c563dbfca7490827f9cc74649b1afe3af45eb6e8a6d509bd4a6`.
- Four-view matrix: SHA256 `a9fefe48b79cc55d3c49f636e4cb459fac49639c12255a23c5a4b223b697a00d`.
- Original accepted registry: PR332 head `6a62c00341bb4fcb8e7e7b6b68fd8a4fc2e26091`, tree `e706a780792db8826a5b5c8bc73424b9715d9678`; subsequently merged through PR333.
- DB local handback: `PUBLIC-SQL-PROJECTIONS-DB-LOCAL-HANDBACK-20261031.txt`, package `work/public-sql-projections-20261031` in the sole DB owner's workspace. Its `INTEGRATION-PLAN.txt` SHA256 is `f479cc37f70038c4bf62b8576f6f196e4bc66085c5f5c52e3d7b2f4b3ce24364`.
- Independent acceptance: Root's `PUBLIC-SQL332-DB-INDEPENDENT-REVIEW-20261031.txt`, SCOPED ACCEPT of exact source and DB package; 106 source tests and eleven isolated PostgreSQL groups independently passed. Those results are reused, not rerun or newly claimed here.

The SQL is copied byte for byte, including its historical proposal comment and final whitespace. An exact-path `.gitattributes` rule disables text normalization so Windows checkout cannot change its checksum. No comment, identifier, privilege, predicate or transaction text is rewritten. The source test pins bytes, canonical discovery/order, attributes and the four-view matrix. It does not execute SQL or duplicate DB qualification.

## Catalog and release boundary

The canonical migration catalog delta is exactly one added `migration.sql`; every predecessor blob remains unchanged. Existing repository discovery (`pe-phase-9-migration-discovery.mjs`) finds this migration at its assigned name. No parallel catalog, migration runner, package script or release pipeline is introduced. The handback contains complete before/after Git catalog pins and the computed delta.

The frozen e023/528 image and single Lane 6 live operation remain unchanged and take priority. This commit is preparation for a later compatible Core15 cohort after the coordinated Meri449/schema and actual capiro-data policy support. Adding a migration to source discovery does not allocate its execution. Do not apply it through the frozen image or infer readiness from the timestamp.

Before any later application, existing DB/Release owners must bind the new image/source catalog, fresh actual pending set and ledger, intended target, role/schema/ACL checks, snapshot and explicit allocation. Preserve the accepted fail-closed collision, raw-rights, ownership/RLS, type/nullability and identity checks. A conflict returns to the DB owner; never reconcile it by modifying accepted SQL or silently changing existing privileges.

## Rollback references

The accepted DB `INTEGRATION-PLAN.txt`, “Preconditions and forward behavior” and “Rollout after independent approval and explicit live allocation,” owns rollback behavior. The migration is one bounded transaction; on failure, roll back/close and report without retries or destructive resets. Successful additive views can remain during an application-code rollback. There is no inverse/drop migration in this package. Removing views, changing roles/grants or handling ledger anomalies requires a separately reviewed forward change under DB custody. Do not delete/re-clone the persistent clone, edit an applied migration, falsify its checksum, or widen raw-table access to restore availability.

No live database, cloud, build, provider, model or DDL action was performed for this integration. The new successor still requires independent review and appropriate later image/catalog qualification.
