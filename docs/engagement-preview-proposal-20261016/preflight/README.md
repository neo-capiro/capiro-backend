# Read-only Engagement role/ACL preflight proposal

This is inactive proposal source for a future, separately authorized catalog read. No SQL in this directory has been executed against a database. The saved qualification is **65 synthetic assessor checks plus 22 static SQL checks, 87/87 passed on Node v24.19.0**; the report records the actual Node version and source hashes. Static checks are lexical checks, not PostgreSQL parsing or execution.

The sealed implementation and its historical evidence remain separate. These files introduce no migration, role/grant change, application route, connection runner, target URL, credentials, provider operation or activation.

## Files and consumption

- [role-acl-snapshot.sql](role-acl-snapshot.sql) contains a four-statement envelope: read-only repeatable-read BEGIN; SET LOCAL search_path = pg_catalog, pg_temp; one catalog SELECT; ROLLBACK.
- [assess-role-acl.cjs](assess-role-acl.cjs) exports the pure offline function **assess(snapshot, independentlyApprovedDatabaseName)**. It returns PASS, UNSAFE or UNKNOWN; only **qualified === true** is the narrow positive result.
- [assess-role-acl.test.cjs](assess-role-acl.test.cjs) supplies synthetic catalog facts and negative controls.
- [sql-source.test.cjs](sql-source.test.cjs) checks the source envelope and collection bindings.
- [run-offline.cjs](run-offline.cjs) reads local source files, executes the pure tests and saves [offline-node-results.json](offline-node-results.json). It imports no database or network driver. Run it from this directory with **node run-offline.cjs**.
- [offline-v8-results.json](offline-v8-results.json) retains the historical 62-case pure V8 run before the search-path revision; it does not qualify current bytes. The Node receipt is the final offline qualification.

A future authorized collector must execute the BEGIN, SET LOCAL search_path, catalog SELECT and ROLLBACK separately, in that order, on the **same connection**. The exact transaction-local path must be established **before parsing, preparing or binding the SELECT**; do not reuse a statement parsed earlier under an untrusted path. It changes no persistent setting and is restored when the transaction ends. Bind **$1** only to the SELECT as the independently approved expected database **name**. Do not interpolate SQL or pass a URL. Always roll back/close on error. Reject a query error, unsupported server, absent/extra result, non-object JSON, truncated output or mismatched expected database. This package intentionally provides no collector or automatic connection.

Retain the approved endpoint identity, source hashes, bound database name, raw unedited JSON, observation time and assessor result together. A database name alone does not authenticate the correct cluster. Operator review must bind the independently authorized endpoint to that snapshot. No target endpoint or product database was contacted here.

The snapshot reports searchPath through pg_catalog.current_setting. The assessor requires the exact canonical value **pg_catalog, pg_temp**; missing metadata, public/untrusted-first paths, or catalog-only paths with implicit temporary-type lookup yield UNKNOWN. Explicit pg_temp after pg_catalog prevents the temporary schema from being implicitly searched before built-in type names.

The assessor expects **trusted, coherent output of the reviewed collector query**. Its cardinalities and graph/ACL cross-checks catch incomplete, duplicate, malformed and contradictory facts. They cannot establish authenticity or completeness after coordinated offline edits to both facts and their counters. It is not a signature or an adversarial attestation format.

## Exact assertions

The relation set is exactly public.engagement_plans, public.engagement_plan_waves, public.engagement_plan_command_receipts, and public.engagement_plan_revisions. Each must resolve to one permanent ordinary table owned by the actual capiro_master role OID, with ENABLE and FORCE RLS flags. Missing tables, including a target before migration, yield UNKNOWN. No future restricted ACL is inferred from source or default grants.

All visible pg_roles rows and pg_auth_members rows are retained, including the PG16 per-membership inherit_option, set_option, admin_option and grantor. The query does not select password fields. The result binds every role to every one of the four tables with a complete seven-privilege effective/grantable vector, any-column UPDATE and inherited owner authority. The assessor requires that complete matrix, all app-to-role MEMBER/USAGE/SET rows, exact identities and unique keys. Native role inquiries must agree with the independently traversed per-membership graph. Membership cycles, missing fields/roles, bad booleans, unexplained ACL contradictions and unknown PostgreSQL majors fail closed.

For the current app role and every role it can SET to, reject SUPERUSER, BYPASSRLS, CREATEROLE, any inherited owner/regrant authority, and effective or grantable DELETE/TRUNCATE on all four tables. Also reject effective, grantable or any-column UPDATE on receipts/revisions. Forbidden direct-app and PUBLIC table/column grants are checked independently. SELECT/INSERT are required for all four app table contexts; UPDATE is additionally required on plans/waves. REFERENCES and TRIGGER facts are reported, not removed or certified by this proposal.

A SET-able context's inherited privileges are assessed too: app-to-parent SET TRUE followed by parent-to-owner/privileged-role INHERIT TRUE is covered. The rolinherit flag alone does not override PG16's explicit membership options. Standard special role attributes are evaluated on actual execution contexts; ordinary INHERIT membership does not itself confer those attributes.

Any reachable ADMIN OPTION edge returns UNKNOWN, conservatively requiring separate authority review. ADMIN can permit self-regrant with SET/INHERIT even when those options are currently false. This avoids claiming that ordinary object-privilege inheritance and ADMIN authority are identical. No unsafe ADMIN profile is accepted.

Reachable rds_superuser is rejected even when ordinary role flags are false, because the frozen owner evidence records an Aurora exemption under inherited privileges. Reachable rdsadmin is conservatively unqualified as provider-admin authority; this proposal does not assert identical internal provider behavior. Provider/version semantics outside the reviewed PostgreSQL16 model still require separate review.

## Defaults, timing and limits

Owner global and public-schema table default ACLs are recorded as future-object facts. Their absence does not prove that an existing object has restricted grants, and broad defaults do not alone fail already-correct current four-table ACLs. The current relation ACLs and effective role paths decide that bounded observation.

The frozen default grants include arwdDxt, including DELETE and TRUNCATE. A later blanket GRANT ALL ON ALL TABLES can reintroduce those privileges. Repeat the authorized preflight **after every relevant migration, membership/owner change or blanket grant, and immediately before any separately approved activation**. A passing observation is point-in-time evidence, never a durable guarantee or an authorization to activate.

The result is a necessary four-table role/ACL precondition. It does not certify migration deployment, complete provider/database security, arbitrary functions/triggers/DDL, tenant row visibility, permissions on parent cleanup tables, application authorization or the approved permitted-client fence. Parent tenant/client cleanup remains a separate existing contract. No product/preview route should consume PASS as an authorization grant.

## Verified sources

Primary PostgreSQL16 documentation was read on 2026-10-16:

- [Search path](https://www.postgresql.org/docs/16/runtime-config-client.html#GUC-SEARCH-PATH), [schema lookup](https://www.postgresql.org/docs/16/ddl-schemas.html#DDL-SCHEMAS-PATH) and [operator resolution](https://www.postgresql.org/docs/16/typeconv-oper.html) explain why function qualification alone is insufficient: unqualified types/operators also depend on lookup order. An unlisted temporary schema precedes catalog type lookup. [SET LOCAL](https://www.postgresql.org/docs/16/sql-set.html) confines the chosen path to this transaction.
- [Read-only transactions](https://www.postgresql.org/docs/16/sql-set-transaction.html) prohibit database-changing commands while allowing catalog reads. The query uses repeatable read for one coherent observation.
- [Privilege inquiry functions](https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-INFO-ACCESS-TABLE) distinguish MEMBER, immediately available USAGE and possible SET; they also expose grant-option and column-privilege inquiries.
- [Role membership](https://www.postgresql.org/docs/16/role-membership.html) and [SET ROLE](https://www.postgresql.org/docs/16/sql-set-role.html) define separate per-edge inheritance and SET paths. Standard special role attributes require the corresponding execution context.
- [pg_auth_members](https://www.postgresql.org/docs/16/catalog-pg-auth-members.html) defines the three membership options. [Role attributes](https://www.postgresql.org/docs/16/role-attributes.html) documents ADMIN self-regrant as a way to acquire currently disabled SET/INHERIT membership.
- [Ownership and privileges](https://www.postgresql.org/docs/16/ddl-priv.html) explains inherited owner authority and the owner's implicit grant options even after ordinary privileges are revoked.
- [Default privileges](https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html) affect future objects and distinguish global from schema defaults.

Frozen repository evidence is historical source, **not an observation of current product posture**:

- [Owner default ALL grant](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/scripts/legiwatch-phase7-upgrade.mjs#L61).
- [Hardening runbook and blanket-grant ordering](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/scripts/sql/2026-07-19-rls-role-hardening.sql#L60): removes app-to-master membership and grants the reverse membership for administrative impersonation.
- [Corrected Aurora root cause and grant audit](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/docs/plans/2026-07-19-capiro-app-rls-bypass-remediation.md#L50): inherited rds_superuser can defeat the ordinary role-flag assumption; the documented full table default ACL is separate from role membership.

No outstanding database action is pending from this lane. Native SQL validation and every target read remain unexecuted; a future target read requires separate authorization.
