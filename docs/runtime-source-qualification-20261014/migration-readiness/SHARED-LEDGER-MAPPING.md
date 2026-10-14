# Shared public ledger mapping and read-only observation correction

Source: PR18 `9492c5226ddd3929205da711e35054fcab5cda13`, tree `52a145fc45522da00cce0e4334668a0345c2d800`. No migration/query SQL, app source or AWS configuration changes are proposed here.

**Both expected migration sets can be read from the already verified `capiro.public._prisma_migrations` ledger as observations.** The reader need not establish each service's effective DATABASE_URL before collecting those authorized metadata rows. Keep live service applicability UNKNOWN where it is unverified; do not use an absent record as pending/never-applied proof. The prior packet's service-binding prerequisite was too broad for observation-only collection. This note explicitly supersedes the service-specific URL-binding collection prerequisite in the old SQL-header comments and HISTORY-RESOLUTION instructions; their SQL bytes and deployment/rename decision safeguards remain unchanged.

## Minimal source mapping

| Component | Exact preserved source evidence | What it establishes |
| --- | --- | --- |
| Prisma datasource files | Core apps/api/prisma/schema.prisma:16-20 and Workspace apps/workspace/prisma/schema.prisma:26-29 both use env(DATABASE_URL). Neither declares a separate datasource SQL namespace. Workspace's custom generated-client output is code isolation. | Separate Prisma schemas/clients do not imply separate PostgreSQL databases, SQL schemas or migration ledgers. |
| Core ordinary serve | apps/api/scripts/entrypoint.sh:328 -> entrypoint-legacy.sh -> apps/api/scripts/entrypoint-dispatcher.inc:19-44 requires DB_* and composes DATABASE_URL with schema=public. Existing Core PrismaService supplies no datasource override. | Ordinary Core startup selects public through composition. A reader overriding startup may never see DATABASE_URL populated. Do not launch ordinary startup to inspect it. |
| Core migrate | entrypoint.sh:32-47,91-93 uses scripts/lib/pe-compose-database-url.js:22-23, which selects schema=public from DB_*; Prisma uses ./prisma/schema.prisma in app cwd. | Canonical Core migrate also targets public when using this recipe. No migrate/resolve command ran here. |
| Workspace serve/migrate | apps/workspace/scripts/entrypoint.sh:16-30 preserves a nonempty DATABASE_URL; otherwise DB_* composition selects schema=public. Existing PrismaService uses the generated client without datasource override. | Planned fallback is public. A real explicit URL override would need separate live verification; source alone does not establish deployed values. |
| Database and service references | infra/cdk/lib/data-stack.ts:80 sets databaseName=capiro. infra/cdk/bin/capiro.ts:59-72 passes data.secret/databaseName into ComputeStack. compute-stack.ts:636-645,712-719,743-749 and1246-1278 give Core and Workspace the same imported DB host/port references and databaseName. Serve uses app credential references; migrate uses master references. | The preserved CDK source intends a shared database/namespace ledger. Credential role differences are not different ledger namespaces. No secret values are read or needed. |
| Workspace standalone definitions | infra/deploy/workspace-serve-taskdef.json and workspace-migrate-taskdef.json use DB_NAME and matching host/port reference fields, without DATABASE_URL injection. | Corroborates the fallback recipe in those saved definitions; does not prove a current live task revision. |

Source pointers use the preserved CDK configuration, not a fresh deployed-state claim. Its documented drift/manual deployment history means current task definition/image bindings still need the shipping owner's own evidence before deploy/rename decisions. The reader's observed primary database and public ledger are the trusted facts supplied by shipping; this source task did not repeat them.

## Correct image paths

| Service | Runtime cwd | Schema copied by the Docker recipe |
| --- | --- | --- |
| Core | /app/apps/api | /app/apps/api/prisma/schema.prisma |
| Workspace | /app/apps/workspace | /app/apps/workspace/prisma/schema.prisma |

Core Dockerfile lines118-145 and Workspace Dockerfile lines108-121 preserve the monorepo layout. Looking only in /app/prisma, /app/schema.prisma or the image root cannot establish absence. These are selected-source recipe paths; actual image/source identity is a separate measured fact.

## Minimal reader correction; SQL stays unchanged

For the source/current-ledger situation reported by shipping:

1. Keep the existing verified primary TLS connection, readable ledger and READ ONLY wrappers. The selected ledger namespace parameter is public because discovery verified it, not because the service name is Core or Workspace.
2. Remove `service_url_binding_proven` as a prerequisite for **observational SELECT collection** on that already approved ledger. Do not remove connection/ledger/authorization/visibility checks. Use the existing Core12 and Workspace13 query bodies/expected name+checksum sets; none are changed in this packet.
3. Report `evidence_scope=observed_ledger`, `expected_source_set=Core12|Workspace13`, `ledger=capiro.public._prisma_migrations`, observation time and the original row match/status fields. Report `live_service_applicability=UNKNOWN` until verified. The ledger stores migration records, not a service-owner column; the source-set label is not proof who wrote the row or which service currently connects there.
4. Keep every attempt/checksum/suffix candidate, global unfinished/duplicate/inconsistent flags and logs-present boolean. No raw logs, URL/password values, secret fetch, migration command, permissions change or business row is required. The legitimate Core/Workspace prospect_resource_origin suffix pair remains a known cross-owner source candidate, not an automatic alias or blocker.

A positive exact-name/compatible-checksum record establishes a matching migration-history observation in the observed ledger. It does not prove physical schema/RLS or current service binding. A missing record remains absence-at-that-snapshot, not NEVER_APPLIED; visibility and all historical environments still matter. Current service-bound Core12/Workspace13 histories remain UNKNOWN until actual results and their applicability are supplied.

The only remaining source-to-live mapping check is the actual registered service/task revision's DB reference/DB_NAME selection and any explicit Workspace DATABASE_URL override, compared to the observed target. References or equality/override-presence booleans suffice; no secret value or connection string should be requested, emitted or placed in Git. That check governs deployment applicability rather than blocking the authorized metadata observation itself.

The first-chat source join and every app/schema/migration pin are preserved. No native DB query, ordinary app startup, Prisma CLI, AWS operation, resource cleanup, secret/permission change, SQL edit, main merge or deployment ran in this source task.
