# Bounded A2 PostgreSQL16 source gate

**Source prepared, not executed by lane A. Root owns execution in one disposable local Docker PostgreSQL16 instance.** No external database or ambient DATABASE_URL fallback is permitted. Use a fresh database named `wave2_a2_<suffix>`, loopback published only, with synthetic bootstrap credentials. Do not use either production or development data.

The fixture validates the explicit `A2_PG_FIXTURE=1` switch, a query-free `postgresql:` URL with loopback host and dedicated database prefix, actual database name, PostgreSQL major version 16, bootstrap role, absence of unrelated tables, absence of the target fixture schema, and the unprivileged application-role fingerprint **before schema mutations**. Existing privileged/inheriting capiro_app roles refuse. The role is test-only LOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOBYPASSRLS with fixed synthetic password; LOGIN is necessary for the real Prisma connection. No production role is changed. The generated Prisma client receives an explicit datasource URL for that role/schema; it never relies on ambient DATABASE_URL. Schemas remain for inspection; a repeat invocation refuses rather than deleting existing work. Root removes the disposable container after evidence capture.

From this branch in a root-owned isolated checkout with dependencies and a client generated from its **full schema**, run:

```powershell
$env:A2_PG_FIXTURE = '1'
$env:A2_PG_URL = 'postgresql://<synthetic-bootstrap-user>:<synthetic-password>@127.0.0.1:<isolated-port>/wave2_a2_source'
node apps/api/node_modules/jest/bin/jest.js --config apps/api/test/a2-postgres/jest.config.cjs --runInBand
```

Do not generate into lane A's shared dependency junction. No package, lockfile or production configuration edit is needed. This config does not load the ordinary Jest worker database bootstrap or `.env` setup. The fixture does not contact providers. Statement/idle timeouts and Jest bounds prevent indefinite waits; race checks inspect real `pg_stat_activity` Lock waits rather than relying on timing sleeps as proof.

## Actual production paths exercised

The tests instantiate the actual `PrismaService`, `AdminBroadcastsService` and `ClientFileBatchService`. No service, Prisma model, current-member, wall or SQL adapter mocks are used. Client batches call actual `requireOwnerClient` and the shared `clientMemoryAllowed`; tenant query extensions and raw row/advisory locks run on PostgreSQL. Separate bootstrap connections hold only deliberate competing test transactions.

- Five ST20 cases cover current recipient read, concurrent duplicate first timestamp, foreign/nontargeted/removed refusal, archive before ack, ack before archive, and membership revocation during a lock wait. Acknowledged row count changes only after a committed explicit ack.
- Nine PF16 cases cover exact aggregate receipt/replay, repeat migration preserving data, stale/denied/missing/hearing all-or-none refusal, second-file database failure rollback, concurrent same-key replay/digest conflict, file ACL mutation while blocked, membership/client-wall revocation while blocked, all row ACL revision writers/no-op revision protection, current-access receipt recovery, forced RLS/immutable grants/composite FK and integer overflow.
- `20260914120000_admin_broadcasts/migration.sql` is applied exactly once (historical nonrepeatable migration).
- `20281023040000_client_file_batch_move/migration.sql` is applied exactly twice during setup, and again after a committed batch in its dedicated repeatability test. This new migration is written to be repeatable; existing receipt/data must survive.

## Historical prerequisite subset

`prerequisites.sql` is a minimal test schema, **not** a substitute production migration. It contains the exact queried column types/keys for users/tenant_memberships (tenant_role, membership_status), tenant/client identities, client owner version, ethical-wall hard-delete grants, and attachment metadata. Unused application columns and unrelated domains are omitted. Sources:

- Identity core schema: `schema.prisma` User/TenantMembership/Client and original identity/tenancy migrations; active status and exact Clerk ID retained.
- `20260503020000_engagement_manager_core`: attachment UUID/tenant/client/uploader columns; unused meeting/mail/storage relationships are omitted from the fixture.
- `20260719220000_client_memory_walls`: client memory_wall and client_memory_access relation. No invented grant status/expiry.
- `20260729035000_legiwatch_recap_provenance_and_intro`: source_entity_type.
- `20261120030000_attachment_folder`: nullable varchar(120) folder label.
- `20261223010000_client_file_viewer_access`: viewer_mode constrained all/restricted, text[] viewer_user_ids.
- `20281012020000_client_ordered_owners`: account_owner_version plus existing account_owner_user_id.
- `20281012030000_prospect_resource_origin`: prospect_id remains an explicit deny boundary.
- Client composite tenant/id uniqueness needed by the new receipt FK.

The minimal roles use forced tenant RLS with `rls_bypass()` false, making database isolation an additional negative control rather than depending on the historical application-owner bypass. Full historical migration-chain compatibility, generated Prisma full API build, application DI/routes, production role topology and provider behavior remain separate root gates. Hearing-backed documents remain deliberately unsupported by this batch command; passing the denial control does not complete that capability.

## Capacity and existing-client conversion extension

`admissions.pg.spec.ts` adds nine prepared cases in its own `a2_admissions` schema. Root must generate Prisma from the complete final schema; these cases are not yet executed by lane A. Actual `ClientsService`, `FirmOnboardingService`, `BusinessDevelopmentService`, the capacity helper and conversion receipt helper run on the real Prisma connection. Only unused import-time collaborator modules and provider/indexing ports are inert synthetic substitutes; there are no model/SQL/capacity/authorization mocks. No provider requests run.

The cases cover last-slot ordinary create versus conversion and two different prospects, CSV versus LDA, restore versus create/duplicate restore/archive release, fresh policy after a billing-row lock wait, enforcement off/comped/trial floor/foreign restoration, actual mapping/audit rollback, simultaneous exact receipt replay, stale version/current wall/foreign receipt refusal, and receipt-insertion rollback. The first race holds the real capacity advisory lock and requires both actual callers to be observed waiting before release. Existing fourteen ST20/PF16 assertions remain unchanged.

`capacity-prerequisites.sql` extends the fixture's historical subset with the scalar columns queried/returned by actual Prisma Client, ClientIntelMapping, Prospect/Activity, AuditLog and LdaClient models. It includes the existing prospect/client uniqueness constraints, forced tenant RLS, plain historical actor UUIDs and current Business Development feature setting. Canonical entity and LDA filing tables contain only the columns queried by these cases; unrelated identity validation and history are not qualified. Nullable contact email uses text because email collation is outside these cases. No production migration is replaced by this subset. Reserved `20281023050000_prospect_conversion_receipts` is applied twice; no deployed schema is altered.

Root qualification already obtained: original fourteen ST20/PF16 cases passed at `d64f6a9d99e9bb393599626d84ae0bd1109e8672`, with zero skips/errors. That result does not cover the new admission cases or full historical migration compatibility.

Root subsequently qualified all 23 existing cases at `fb1b31a8a6085f15d5d588e1cf1733f0d8dabc75`, with zero skips/runtime errors. Evidence: `/opt/codex-gates/runs/20261023T160954Z-core-a2-fb1b31a8`.

## PF07 manual-association inventory extension

`associations.pg.spec.ts` adds seven prepared cases in `a2_associations`; lane A has not executed them. Actual `ObjectiveOperationalService`, Prisma transactions, current Objective destination authority, Strategy/Planner resource readers, cursor signer, SQL store and unlink/receipt commit owners run without mocks. The tests cover real parameterized LIMIT/OFFSET (including the legacy NULL limit), stable two-page/one-row/100-row bounds, current Planner ACL omission without hidden metadata, tenant/member/Clerk/client-wall/feature checks, cursor invalidation after canonical unlink and Objective revision changes, actor/limit binding, and membership revocation during a real row-lock wait. The mutation race blocks canonical unlink at its state row after it acquired the association gate, observes the subsequent cursor read waiting on the shared gate, then requires the read to reject the stale cursor after commit.

`objective-prerequisites.sql` adds only queried scalar subsets of the existing tenant settings/status, Strategy enum/table and Planner project/task tables. Exact existing types, JSON ACL inputs, owner Clerk IDs and tenant RLS are retained. The fixture then applies production migrations `20281011010000_client_objectives`, `20281015010000_client_objective_work_intents`, `20281015020000_client_objective_canonical_plans` and `20281015030000_client_objective_operational_links`, unchanged. These historical migrations are **nonrepeatable**: setup asserts each second application refuses with a duplicate-object error inside a rolled-back transaction. Explicit test-only migration-owner default DML grants reproduce the historical prerequisite before each production migration narrows permissions; they do not establish actual deployed role inheritance or default privileges.

The new tests use Strategy, Planner projects and an ordinary task. Outreach/Calendar SQL owners, budget contexts, full historical schema/build/route composition, deployed roles and browser acceptance remain separate gates. Running this config now discovers 30 total cases; the previous 23-case result does not qualify these seven.
