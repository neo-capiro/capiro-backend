import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Pool } from 'pg';
import type { TenantContext } from '@capiro/shared';
import type { DirectoryService } from '../../directory/directory.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { lockEngagementReportTargets } from '../report-targets.js';
import { EngagementPlansService } from './engagement-plans.service.js';

export const FIXTURE_URL =
  'postgresql://codex_engagement@127.0.0.1:60009/engagement_plan_acceptance?connection_limit=5';
export const FIXTURE_DATABASE = 'engagement_plan_acceptance';
// Filled only after the migration owner confirms the final candidate bytes.
export const APPROVED_MIGRATION_SHA256 =
  '39dbfaea3f38f9eb553460e05365ffd79d3686c7d24934f7e6b7fabfe70e538f';
const OWNER = 'engagement-plans.postgres.spec.ts';
export const ids = {
  tenant: '10000000-0000-4000-8000-000000000001',
  foreignTenant: '10000000-0000-4000-8000-000000000002',
  user: '20000000-0000-4000-8000-000000000001',
  foreignUser: '20000000-0000-4000-8000-000000000002',
  client: '30000000-0000-4000-8000-0000000000a1',
  otherClient: '30000000-0000-4000-8000-0000000000a2',
  walledClient: '30000000-0000-4000-8000-0000000000b1',
  archivedClient: '30000000-0000-4000-8000-0000000000b2',
  foreignClient: '30000000-0000-4000-8000-0000000000b3',
  directory: '50000000-0000-4000-8000-000000000001',
};
export const ctx: TenantContext = {
  tenantId: ids.tenant,
  tenantSlug: 'disposable-plan-test',
  userId: ids.user,
  clerkUserId: 'user_disposable_plan_actor',
  role: 'standard_user',
};
export const foreignCtx: TenantContext = {
  tenantId: ids.foreignTenant,
  tenantSlug: 'disposable-foreign-test',
  userId: ids.foreignUser,
  clerkUserId: 'user_disposable_foreign_actor',
  role: 'standard_user',
};

export function assertFixtureUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '60009' ||
    url.pathname !== `/${FIXTURE_DATABASE}` ||
    url.username !== 'codex_engagement' ||
    url.password ||
    url.searchParams.get('connection_limit') !== '5'
  ) {
    throw new Error('Refusing database activity outside the reserved disposable plan fixture');
  }
}

const CORE_DDL = `
CREATE TABLE tenants(id uuid PRIMARY KEY,status text NOT NULL DEFAULT 'active',slug text,name text);
CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text UNIQUE NOT NULL);
CREATE TABLE tenant_memberships(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
 user_id uuid NOT NULL,role text NOT NULL,status text NOT NULL DEFAULT 'active',UNIQUE(tenant_id,user_id));
CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,name text NOT NULL,
 status text NOT NULL DEFAULT 'active',memory_wall boolean NOT NULL DEFAULT false,UNIQUE(tenant_id,id));
CREATE TABLE client_memory_access(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
 client_id uuid NOT NULL,user_id uuid NOT NULL,granted_by uuid,created_at timestamptz DEFAULT now(),UNIQUE(tenant_id,client_id,user_id));
CREATE TABLE engagement_report_target_offices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
 client_id uuid,scope_key text NOT NULL,office_key text NOT NULL,member_principal text NOT NULL,
 committee text,staffer text,building text,lead_owner text,prep_status text NOT NULL DEFAULT 'auto',
 outreach_status text NOT NULL DEFAULT 'auto',submission_status text NOT NULL DEFAULT 'auto',source text NOT NULL DEFAULT 'manual',
 first_report_year integer NOT NULL DEFAULT 2026,display_overrides text[] NOT NULL DEFAULT '{}',archived_at timestamptz,
 created_by_user_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,scope_key,office_key),UNIQUE(id,tenant_id));
CREATE TABLE engagement_report_target_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
 target_id uuid NOT NULL,report_year integer NOT NULL,prep_status text NOT NULL DEFAULT 'auto',
 outreach_status text NOT NULL DEFAULT 'auto',submission_status text NOT NULL DEFAULT 'auto',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(target_id,report_year),
 FOREIGN KEY(target_id,tenant_id) REFERENCES engagement_report_target_offices(id,tenant_id) ON DELETE CASCADE);
CREATE TABLE client_objectives(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid NOT NULL,
 version integer NOT NULL,deleted_at timestamptz);
CREATE TABLE client_objective_revisions(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid NOT NULL,
 objective_id uuid NOT NULL,version integer NOT NULL);
CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT NULLIF(current_setting('app.current_tenant',true),'')::uuid $$;
CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(current_setting('app.rls_bypass',true),'')='on' $$;
`;

export class PlanPostgresFixture {
  readonly pool: Pool;
  readonly a: PrismaService;
  readonly b: PrismaService;
  readonly service: EngagementPlansService;
  readonly otherService: EngagementPlansService;
  readonly queries: string[] = [];
  readonly directory = {
    getMemberContextById: async () => ({
      id: ids.directory,
      fullName: 'Synthetic office',
      committees: [],
      staff: [],
      officeLocation: null,
    }),
  } as unknown as DirectoryService;

  constructor() {
    assertFixtureUrl(FIXTURE_URL);
    // Deliberate process-local test configuration; never read an ambient URL.
    process.env.DATABASE_URL = FIXTURE_URL;
    this.pool = new Pool({ connectionString: FIXTURE_URL, max: 4 });
    const options = {
      datasources: { db: { url: FIXTURE_URL } },
      log: [{ emit: 'event' as const, level: 'query' as const }],
    };
    this.a = new PrismaService(options);
    this.b = new PrismaService(options);
    for (const prisma of [this.a, this.b]) {
      const observe = prisma.$on.bind(prisma) as unknown as (
        name: 'query',
        listener: (event: { query: string }) => void,
      ) => void;
      observe('query', (event) => this.queries.push(event.query));
    }
    this.service = new EngagementPlansService(this.a);
    this.otherService = new EngagementPlansService(this.b);
  }

  async assertDatabase(): Promise<void> {
    assertFixtureUrl(FIXTURE_URL);
    const { rows } = await this.pool.query<{
      name: string;
      host: string;
      port: number;
      actor: string;
    }>(
      'SELECT current_database() AS name,host(inet_server_addr()) AS host,inet_server_port() AS port,current_user AS actor',
    );
    if (
      rows[0]?.name !== FIXTURE_DATABASE ||
      rows[0].host !== '127.0.0.1' ||
      rows[0].port !== 60009 ||
      rows[0].actor !== 'codex_engagement'
    )
      throw new Error('Disposable database identity did not match the reserved fixture');
  }

  async initialize(): Promise<void> {
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../../prisma/migrations/20281015040000_engagement_plans/migration.sql',
      ),
      'utf8',
    );
    const hash = createHash('sha256').update(migration).digest('hex');
    if (hash !== APPROVED_MIGRATION_SHA256)
      throw new Error(`Migration candidate awaits exact owner approval: ${hash}`);
    await this.assertDatabase();
    const { rows } = await this.pool.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    if (rows.length) {
      const guard = rows.some((row) => row.name === 'codex_plan_fixture_guard');
      if (!guard)
        throw new Error('Reserved database is not an empty or previously owned plan fixture');
      const owner = await this.pool.query<{ owner: string; migration_sha256: string }>(
        'SELECT owner,migration_sha256 FROM codex_plan_fixture_guard',
      );
      if (
        owner.rows.length !== 1 ||
        owner.rows[0]?.owner !== OWNER ||
        owner.rows[0].migration_sha256 !== hash
      )
        throw new Error('Fixture owner/migration sentinel mismatch');
    } else {
      const connection = await this.pool.connect();
      await connection.query('BEGIN');
      try {
        await connection.query(CORE_DDL);
        await connection.query(migration);
        await connection.query(
          'CREATE TABLE codex_plan_fixture_guard(owner text PRIMARY KEY,migration_sha256 text NOT NULL)',
        );
        await connection.query(
          'INSERT INTO codex_plan_fixture_guard(owner,migration_sha256) VALUES($1,$2)',
          [OWNER, hash],
        );
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }
    await Promise.all([this.a.$connect(), this.b.$connect()]);
  }

  async reset(): Promise<void> {
    await this.assertDatabase();
    await this.pool
      .query(`DROP TRIGGER IF EXISTS codex_fail_plan_revision ON engagement_plan_revisions;
      DROP FUNCTION IF EXISTS codex_fail_plan_revision();
      TRUNCATE engagement_plan_revisions,engagement_plan_command_receipts,engagement_plan_waves,engagement_plans,
       engagement_report_target_overrides,engagement_report_target_offices,client_objective_revisions,client_objectives,
       client_memory_access,tenant_memberships,clients,users,tenants CASCADE`);
    await this.pool.query("INSERT INTO tenants(id,status) VALUES($1,'active'),($2,'active')", [
      ids.tenant,
      ids.foreignTenant,
    ]);
    await this.pool.query('INSERT INTO users(id,clerk_user_id) VALUES($1,$2),($3,$4)', [
      ids.user,
      ctx.clerkUserId,
      ids.foreignUser,
      foreignCtx.clerkUserId,
    ]);
    await this.pool.query(
      `INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'standard_user','active'),($3,$4,'standard_user','active')`,
      [ids.tenant, ids.user, ids.foreignTenant, ids.foreignUser],
    );
    await this.pool.query(
      `INSERT INTO clients(id,tenant_id,name,status,memory_wall) VALUES
      ($1,$6,'Synthetic client A','active',false),($2,$6,'Synthetic client B','active',false),
      ($3,$6,'Synthetic walled client','active',true),($4,$6,'Synthetic archived client','archived',false),
      ($5,$7,'Synthetic foreign client','active',false)`,
      [
        ids.client,
        ids.otherClient,
        ids.walledClient,
        ids.archivedClient,
        ids.foreignClient,
        ids.tenant,
        ids.foreignTenant,
      ],
    );
    this.queries.length = 0;
  }

  async target(clientId = ids.client, officeKey = `manual:${randomUUID()}`) {
    const targetId = randomUUID();
    await this.pool.query(
      `INSERT INTO engagement_report_target_offices(id,tenant_id,client_id,scope_key,office_key,member_principal,created_by_user_id)
      VALUES($1,$2,$3::uuid,$3::text,$4,'Synthetic office',$5)`,
      [targetId, ids.tenant, clientId, officeKey, ids.user],
    );
    return { targetId, officeKey };
  }

  async holdClient(clientId = ids.client) {
    const connection = await this.pool.connect();
    await connection.query('BEGIN');
    await connection.query('SELECT id FROM clients WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      ids.tenant,
      clientId,
    ]);
    const { rows } = await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return {
      connection,
      pid: rows[0]!.pid,
      release: async () => {
        await connection.query('COMMIT');
        connection.release();
      },
    };
  }

  async holdTargets() {
    let ready!: (pid: number) => void;
    let reject!: (error: unknown) => void;
    let unlock!: () => void;
    const readyPromise = new Promise<number>((resolve, fail) => {
      ready = resolve;
      reject = fail;
    });
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const pending = this.b.withTenant(
      ids.tenant,
      async (tx) => {
        await lockEngagementReportTargets(tx, ids.tenant);
        const rows = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
          'SELECT pg_backend_pid() AS pid',
        );
        ready(rows[0]!.pid);
        await released;
      },
      { timeoutMs: 20000 },
    );
    void pending.catch(reject);
    const pid = await readyPromise;
    return {
      pid,
      release: async () => {
        unlock();
        await pending;
      },
    };
  }

  async waitForLocks(fragment: string, minimum = 1, blockerPid?: number) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const { rows } = await this.pool.query<{ pid: number; query: string; blockers: number[] }>(
        `SELECT pid,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
         WHERE datname=$1 AND wait_event_type='Lock' AND pid<>pg_backend_pid()`,
        [FIXTURE_DATABASE],
      );
      const matching = rows.filter((row) => row.query.includes(fragment));
      if (
        matching.length >= minimum &&
        (blockerPid === undefined || matching.some((row) => row.blockers.includes(blockerPid)))
      )
        return matching;
      await setImmediate();
    }
    throw new Error(`Expected ${minimum} real PostgreSQL lock waiter(s) on ${fragment}`);
  }

  async close(): Promise<void> {
    await Promise.all([this.a.$disconnect(), this.b.$disconnect()]);
    await this.pool.end();
  }
}

export async function outcome<T>(
  pending: Promise<T>,
): Promise<{ value: T; error?: never } | { value?: never; error: unknown }> {
  try {
    return { value: await pending };
  } catch (error) {
    return { error };
  }
}
