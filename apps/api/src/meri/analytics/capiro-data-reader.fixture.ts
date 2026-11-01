import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client } from 'pg';

/**
 * Disposable database fixture for the query_capiro_data reader-role proofs.
 *
 * It needs a throwaway PostgreSQL 16 database the caller owns (superuser or
 * the migration owner), named by CAPIRO_DATA_TEST_DATABASE_URL, for example
 * the repo's docker-compose Postgres or a cluster made with initdb. In that
 * database it:
 *
 *   1. drops everything a previous run created (schemas, tables, the four
 *      reader/owner roles and what they own) — never point it at shared data;
 *   2. creates the base tables the published projections read, exactly as
 *      `prisma migrate diff --from-empty --to-schema-datamodel` emits them
 *      from the current schema.prisma, plus the canonical tenant RLS helper
 *      functions and `tenant_id = current_tenant_id()` policies that the
 *      applied migrations put on those tables (the full 500-migration chain
 *      cannot replay here: it needs pgvector);
 *   3. replays the actual role, grant and projection migrations unmodified
 *      (only `GRANT CONNECT ON DATABASE capiro` is renamed to the test
 *      database), so the roles, grants, security-barrier views, comments and
 *      search_path under test are the ones production has;
 *   4. gives the two login reader roles test passwords and loads synthetic
 *      rows for two tenants so cross-tenant visibility can be observed.
 *
 * Nothing here is used outside tests.
 */
export const READER_MIGRATIONS = [
  '20280210010000_meri_analytics_ro_role',
  '20281024160000_public_sql_analytics_read_grants',
  '20281024170000_private_sql_client_projections',
  '20281027100000_private_saved_business_policies',
  '20281027101000_private_saved_business_projections',
  '20281101010000_capiro_data_published_surface',
] as const;

/** Base tables the published projections read (private sources, identity and public ingestion). */
const BASE_TABLES = [
  'users',
  'tenants',
  'tenant_memberships',
  'clients',
  'client_memory_access',
  'client_objectives',
  'client_activity',
  'client_ordered_owners',
  'client_team_members',
  'client_targets',
  'client_people',
  'engagement_contacts',
  'engagement_tasks',
  'action_recommendation',
  'tracked_bill',
  'engagement_campaigns',
  'engagement_campaign_recipients',
  'congress_bill',
  'congress_bill_subject',
  'congress_bill_cosponsor',
  'congress_member',
  'program_element',
  'program_element_project',
  'program_element_budget_position',
  'program_element_project_budget_position',
] as const;
/** Tenant tables whose isolation policy the applied migrations already define (the saved-business migration adds three more). */
const TENANT_POLICY_TABLES = [
  'tenant_memberships',
  'clients',
  'client_memory_access',
  'client_objectives',
  'client_activity',
  'client_ordered_owners',
  'client_team_members',
  'client_targets',
  'engagement_contacts',
  'engagement_tasks',
  'action_recommendation',
  'tracked_bill',
] as const;
const ROLES = ['capiro_analytics_ro', 'capiro_private_query_ro', 'capiro_private_projection_owner', 'capiro_public_projection_owner'] as const;

export const READER_TEST_PASSWORD = 'capiro-data-reader-test';
const apiRoot = path.resolve(__dirname, '..', '..', '..');
const resolveModule = createRequire(__filename);

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const FIXTURE = Object.freeze({
  tenantA: id(1),
  tenantB: id(2),
  actorA: id(11),
  actorB: id(12),
  clientA1: id(21),
  clientA2Walled: id(22),
  clientB1: id(23),
  objectiveA1: id(31),
  objectiveA2: id(32),
  objectiveB1: id(33),
});

function baseSchemaSql(): string {
  const cli = path.join(path.dirname(resolveModule.resolve('prisma/package.json')), 'build', 'index.js');
  const script = execFileSync(
    process.execPath,
    [cli, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', path.join(apiRoot, 'prisma', 'schema.prisma'), '--script'],
    { cwd: apiRoot, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' } },
  );
  const enums = [...script.matchAll(/CREATE TYPE "\w+" AS ENUM \([^)]*\);/g)].map((m) => m[0]);
  const tables = [...script.matchAll(/CREATE TABLE "(\w+)" \([\s\S]*?\n\);/g)]
    .filter((m) => (BASE_TABLES as readonly string[]).includes(m[1]!))
    .map((m) => m[0]);
  if (tables.length !== BASE_TABLES.length) throw new Error(`fixture: expected ${BASE_TABLES.length} base tables in the Prisma diff, found ${tables.length}`);
  return [...enums, ...tables].join('\n');
}

const RLS_SQL = `
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
DECLARE v_raw TEXT := current_setting('app.current_tenant', true);
BEGIN
  IF v_raw IS NULL OR v_raw = '' THEN RETURN NULL; END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END; $$ LANGUAGE plpgsql STABLE;
CREATE OR REPLACE FUNCTION rls_bypass() RETURNS BOOLEAN AS $$
BEGIN RETURN current_setting('app.bypass_rls', true) = 'on'; END; $$ LANGUAGE plpgsql STABLE;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_isolation ON tenants USING (rls_bypass() OR id = current_tenant_id()) WITH CHECK (rls_bypass() OR id = current_tenant_id());
${TENANT_POLICY_TABLES.map(
  (table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_isolation ON ${table} USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());`,
).join('\n')}
`;

function rowsSql(): string {
  const f = FIXTURE;
  return `
INSERT INTO users (id, clerk_user_id, email, first_name, last_name, updated_at) VALUES
  ('${f.actorA}', 'user_a', 'actor-a@example.test', 'Ada', 'Alpha', now()),
  ('${f.actorB}', 'user_b', 'actor-b@example.test', 'Bob', 'Beta', now());
INSERT INTO tenants (id, name, slug, status, updated_at) VALUES
  ('${f.tenantA}', 'Tenant A', 'tenant-a', 'active', now()),
  ('${f.tenantB}', 'Tenant B', 'tenant-b', 'active', now());
INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, updated_at) VALUES
  ('${id(41)}', '${f.tenantA}', '${f.actorA}', 'standard_user', 'active', now()),
  ('${id(42)}', '${f.tenantB}', '${f.actorB}', 'standard_user', 'active', now());
INSERT INTO clients (id, tenant_id, name, status, memory_wall, updated_at) VALUES
  ('${f.clientA1}', '${f.tenantA}', 'Client A1', 'active', false, now()),
  ('${f.clientA2Walled}', '${f.tenantA}', 'Client A2 walled', 'active', true, now()),
  ('${f.clientB1}', '${f.tenantB}', 'Client B1', 'active', false, now());
INSERT INTO client_objectives (id, tenant_id, client_id, client_request_id, create_request_hash, outcome, status, created_by_user_id, updated_at) VALUES
  ('${f.objectiveA1}', '${f.tenantA}', '${f.clientA1}', '${id(51)}', repeat('a', 64), 'Objective A1', 'draft', '${f.actorA}', now()),
  ('${f.objectiveA2}', '${f.tenantA}', '${f.clientA2Walled}', '${id(52)}', repeat('b', 64), 'Objective A2', 'draft', '${f.actorA}', now()),
  ('${f.objectiveB1}', '${f.tenantB}', '${f.clientB1}', '${id(53)}', repeat('c', 64), 'Objective B1', 'draft', '${f.actorB}', now());
INSERT INTO client_people (id, tenant_id, client_id, name, placement_source, review_required, updated_at) VALUES
  ('${id(61)}', '${f.tenantA}', '${f.clientA1}', 'Person A1', 'manual', false, now()),
  ('${id(62)}', '${f.tenantB}', '${f.clientB1}', 'Person B1', 'manual', false, now());
INSERT INTO congress_bill (id, congress, bill_type, bill_number, title, status, introduced_date, sponsor_bioguide_id, update_date, last_synced_at) VALUES
  ('119-hr-1', 119, 'hr', '1', 'Drone Act', 'introduced', '2025-01-03', 'A000001', '2025-01-04T01:02:03.123456Z', '2025-01-05T00:00:00Z'),
  ('119-s-2', 119, 's', '2', 'Energy Act', 'enacted', '2025-02-03', 'B000002', NULL, '2025-02-05T00:00:00Z'),
  ('118-hr-3', 118, 'hr', '3', 'Old Act', NULL, NULL, NULL, NULL, '2024-01-01T00:00:00Z');
INSERT INTO congress_bill_subject (id, bill_id, name) VALUES ('s1', '119-hr-1', 'Drones'), ('s2', '119-hr-1', 'Defense'), ('s3', '119-s-2', 'Energy');
INSERT INTO congress_member (bioguide_id, first_name, last_name, full_name, party, state, chamber, is_current, last_synced_at) VALUES
  ('A000001', 'Ann', 'Able', 'Ann Able', 'D', 'CA', 'House', true, now()), ('B000002', 'Ben', 'Baker', 'Ben Baker', 'R', 'TX', 'Senate', true, now());
INSERT INTO congress_bill_cosponsor (id, bill_id, bioguide_id, full_name, is_original, withdrawn_date, last_synced_at) VALUES
  ('${id(65)}', '119-hr-1', 'B000002', 'Ben Baker', true, NULL, now()), ('${id(66)}', '119-s-2', 'A000001', 'Ann Able', false, '2025-03-01', now());
INSERT INTO program_element (pe_code, title, source, service, appropriation_type, last_synced_at, retired_at) VALUES
  ('0601101A', 'Research Alpha', 'fixture', 'Army', 'RDT&E', now(), NULL),
  ('0601102N', 'Research Navy', 'fixture', 'Navy', 'RDT&E', now(), NULL),
  ('0601199X', 'Retired PE', 'fixture', 'Army', 'RDT&E', now(), now());
INSERT INTO program_element_project (id, pe_code, project_code, title, mission, source, last_synced_at, updated_at) VALUES
  ('${id(71)}', '0601101A', 'P1', 'Project One', 'drone swarms', 'fixture', now(), now()),
  ('${id(72)}', '0601101A', 'P2', 'Project Two', 'sensors', 'fixture', now(), now());
INSERT INTO program_element_budget_position (id, pe_code, position_cycle, asserted_fy, amount, value_kind) VALUES
  ('${id(81)}', '0601101A', 'pb_fy2026', 2026, 12.50, 'total'),
  ('${id(82)}', '0601101A', 'pb_fy2026', 2027, 13.25, 'total'),
  ('${id(83)}', '0601102N', 'pb_fy2026', 2026, 123456789012.34, 'total');
INSERT INTO program_element_project_budget_position (id, pe_code, project_code, position_cycle, asserted_fy, amount, value_kind) VALUES
  ('${id(91)}', '0601101A', 'P1', 'pb_fy2026', 2026, 7.00, 'total');
`;
}

export interface ReaderFixture {
  adminUrl: string;
  database: string;
  readerUrl(role: 'capiro_analytics_ro' | 'capiro_private_query_ro'): string;
  /** Points ANALYTICS_DB_* and PRIVATE_QUERY_DB_* at this database so the real services can be exercised. */
  bindServiceEnv(): void;
}

function connect(url: string): Client {
  return new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
}

/** Builds the disposable schema, replays the reader migrations and loads rows. Idempotent; drops previous state first. */
export async function prepareReaderFixture(adminUrl: string): Promise<ReaderFixture> {
  const parsed = new URL(adminUrl);
  const database = parsed.pathname.replace(/^\//, '');
  const admin = connect(adminUrl);
  await admin.connect();
  try {
    await admin.query('DROP SCHEMA IF EXISTS meri_private CASCADE');
    await admin.query('DROP SCHEMA IF EXISTS meri_public CASCADE');
    for (const table of ['meri_analytics_query_log', ...BASE_TABLES]) await admin.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    for (const role of ROLES) {
      const exists = await admin.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount) {
        await admin.query(`DROP OWNED BY ${role} CASCADE`);
        await admin.query(`DROP ROLE ${role}`);
      }
    }
    await admin.query('DROP FUNCTION IF EXISTS current_tenant_id() CASCADE');
    await admin.query('DROP FUNCTION IF EXISTS rls_bypass() CASCADE');
    const types = await admin.query<{ typname: string }>("SELECT typname FROM pg_catalog.pg_type WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace");
    for (const row of types.rows) await admin.query(`DROP TYPE IF EXISTS "${row.typname}" CASCADE`);
    await admin.query('CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query(baseSchemaSql());
    await admin.query(RLS_SQL);
    for (const name of READER_MIGRATIONS) {
      const sql = readFileSync(path.join(apiRoot, 'prisma', 'migrations', name, 'migration.sql'), 'utf8').replace(
        /ON DATABASE capiro\b/g,
        `ON DATABASE "${database}"`,
      );
      await admin.query(sql);
    }
    for (const role of ['capiro_analytics_ro', 'capiro_private_query_ro']) await admin.query(`ALTER ROLE ${role} PASSWORD '${READER_TEST_PASSWORD}'`);
    await admin.query(rowsSql());
  } finally {
    await admin.end();
  }
  const readerUrl = (role: string) => {
    const url = new URL(adminUrl);
    url.username = role;
    url.password = READER_TEST_PASSWORD;
    return url.toString();
  };
  return {
    adminUrl,
    database,
    readerUrl,
    bindServiceEnv() {
      for (const [prefix, user] of [
        ['ANALYTICS_DB', 'capiro_analytics_ro'],
        ['PRIVATE_QUERY_DB', 'capiro_private_query_ro'],
      ] as const) {
        process.env[`${prefix}_HOST`] = parsed.hostname;
        process.env[`${prefix}_PORT`] = parsed.port || '5432';
        process.env[`${prefix}_USER`] = user;
        process.env[`${prefix}_PASSWORD`] = READER_TEST_PASSWORD;
        process.env[`${prefix}_NAME`] = database;
        process.env[`${prefix}_SSLMODE`] = 'disable';
      }
    },
  };
}

/** Runs one statement as a login role in a fresh session configured like the reader transport. */
export async function asRole(
  url: string,
  options: { searchPath: string; context?: Record<string, string>; statementTimeoutMs?: number },
  sql: string,
  values: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[] } | { code: string; message: string }> {
  const client = connect(url);
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL search_path = "${options.searchPath}"`);
    await client.query(`SET LOCAL statement_timeout = '${options.statementTimeoutMs ?? 8000}ms'`);
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    if (options.context) {
      await client.query("SET LOCAL app.bypass_rls = 'off'");
      for (const [key, value] of Object.entries(options.context)) await client.query('SELECT pg_catalog.set_config($1, $2, true)', [key, value]);
    }
    const result = await client.query({ text: sql, values, queryMode: 'extended' } as never);
    await client.query('COMMIT');
    return { rows: (result as { rows: Record<string, unknown>[] }).rows };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const failure = error as { code?: string; message?: string };
    return { code: failure.code ?? 'NONE', message: failure.message ?? String(error) };
  } finally {
    await client.end();
  }
}
