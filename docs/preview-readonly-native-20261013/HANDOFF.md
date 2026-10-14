# Native read-only preview checkpoint

Current owner direction: [CURRENT-OWNER-FUNCTIONAL-MODE.md](CURRENT-OWNER-FUNCTIONAL-MODE.md) supersedes the historical zero-write/three-GET launch prerequisite. Normal existing frontend/API mode is the critical path; PR2/PR3 remain optional and preserved. Capacity has been restored.

The actual PR2 Prisma owner at `111f269d749cae0249c2141779bd6d7deb93f45c`, tree `719c8292fc0c9cf4e8242b8d58efb2d004ad0a1f`, passed six bounded PostgreSQL 16.15 catalog controls. All product source remains exact to that head. This evidence branch does not change or replace PR2, its frozen evidence index, production bootstrap, or protected EngagementService work.

Native acceptance in this packet covers: refusal of an existing non-owner role when its default transaction posture is writable; refusal of the existing owner/superuser even with a read-only default; actual read-only transaction mode with bypass cleared and tenant GUC set; canonical withTenant reuse of the same backend transaction with tenant/system escapes refused; transaction GUC cleanup after commit; and callback rollback/GUC cleanup. Actual query events show five transactions, each beginning user SQL with SET TRANSACTION READ ONLY after Prisma's isolation-level setup, followed by two refusal rollbacks, two commits and one synthetic rollback. Final native process exit is zero.

The target is the previously authorized local `capiro-postgres` container `3dee5d43de72a973ce75866d936064df2c747f3d02f5010050bff2587c837183`, cluster `7695590366852821031`. Existing local fixture logins only were used for maintenance catalog reads in `postgres`. The passing capiro_app role check applies to that empty maintenance catalog with a session-local read-only default: it says nothing about that role's effective permissions in any business database and does not approve it for production preview use. Session settings were reset, both native pools disconnected, and database/role/membership catalogs and container configuration remained exact. No database, table, role, grant, credential or persistent setting was created or changed. No business/customer row or provider was read.

The exact cached host engine is SHA256 `35860a5c0fb2f79e7b38c40747c4d212318d97e1910ca528b133c802716de0b8`; exact Core schema is SHA256 `215556bd82b97f0be84d7f97da7f19a5a25bace97dc54b1a550cab2039a740fb`. Both match historical native prerequisite provenance. No engine download, resolver bypass, checksum disabling or replacement occurred. Strace records only the two intended IPv4 connects to 127.0.0.1:5432, and no other native network endpoint. JavaScript fetch/network is fenced. The real canonical PrismaService source is hash-bound and transpiled solely for this probe; this is not a full image or bootstrap test.

## Historical capacity blocker and optional next slice

At the native checkpoint the PostgreSQL volume reported zero writable bytes available. The owned synthetic fixture database plan was recorded but never executed. No creation or migration was attempted on the full volume. The later owner-authorized cleanup reclaimed only completed reproducible API build outputs; approximately 131 MiB is now available, as recorded in the current compatibility packet. No PostgreSQL file or unrelated cache/volume was removed.

The historical minimum of 16 MiB, preferably 32 MiB for setup and cleanup headroom, has been restored. The fixture remains unexecuted optional work. Neo's current ordinary frontend mode does not depend on this native proof or require a production reader grant.

If resumed as a separate authorized slice, the already prepared plan creates one unpredictable, receipt-bound synthetic database in this exact container using the existing fixture owner. It projects only Tenant/User/TenantMembership/Client scalar fields, with UUID/citext/enums/arrays needed by canonical reads and exact initial canonical tenant RLS helpers/policies. This is a narrow fixture, not full migration/schema acceptance: varchar/precision constraints and the full schema's unrelated relations are not qualified. SELECT column grants go only to the existing local capiro_app role on those new fixture tables. No new role, password, global membership or existing database/grant change is needed. There is no schema operation or grant on production.

Then run the actual preview identity/controller path with synthetic Clerk verification and active-session ports, actual native transactions, existing internal member/admin fixtures and foreign-tenant fixtures. Required controls are no identity/lastSeen/audit/business writes, missing/mismatched identity, inactive membership, stale role/current revision, impersonation, replay and concurrent revocation, client same-tenant/RLS visibility, column/table/sequence unsafe-grant refusal, native DML denial, commit/rollback and connection GUC isolation. Record the owned database OID/comment/token before setup; close every consumer before dropping only that receipt-bound database without forced termination; compare unrelated catalogs/container configuration before and after. This plan/source remains unexecuted.

## Contract and dependency matrix

| Owner / slice | Relationship | Status |
| --- | --- | --- |
| private backend draft PR2 111f269 / tree719c | immutable product source under native probe | source + six catalog-native controls |
| private backend draft PR1 6efe / tree5e18 | independent receiving checkpoint | not a prerequisite |
| this evidence branch | exact-source probe, custody, proposed fixture, permission-doc correction | native catalog checkpoint only |
| optional three GET handlers and current local authority | require owned four-table fixture | capacity restored; fixture unexecuted |
| native effective role grants / tenant RLS / DML refusal | require owned business fixture | not accepted yet |
| live Clerk, dedicated reader credentials, image/bootstrap/deployment | separate coordinator/runtime-owner decision | not qualified or executed |
| protected EngagementService | no source or branch/body access | independent and unchanged |

The [Docker entrypoint/listening correction](RUNTIME-ENTRYPOINT-CORRECTION.md) confirms the emitted image path is `/app/apps/api/dist/preview-readonly/preview-main.js` and requires an explicit dumb-init/node entryPoint plus that command to bypass serve. Actual emitted-module HTTP testing confirms the denied `/api/__preview_liveness` 403 is listening-only, with zero auth/database calls and no native-readiness claim.

The [physical-column correction](RUNTIME-PERMISSIONS-CORRECTION.md) is relevant immediately to runtime permission review. In particular tenant settings is `settings_jsonb`, not `settings` in SQL. The PR2 API queries already use Prisma's correct mapping; product source requires no repair for this finding.

The first launcher returned one because an optional final cat looked for a failure file that did not exist after a successful probe. Its raw results/trace and wrapper discrepancy are retained. The instrumented final run records explicit exit zero and native statement events. No assertion or test was removed. No staging environment is assumed, and no AWS, provider, production permission, deployment, main merge or unrelated database operation occurred.
