import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  ImpactRepository,
  emptyImpact,
  presentImpactRow,
  safeSourceUrl,
} from './impact.repository.js';

const tenant = '10000000-0000-4000-8000-000000000001',
  other = '10000000-0000-4000-8000-000000000002';
const actor = '20000000-0000-4000-8000-000000000001';
const open = '30000000-0000-4000-8000-000000000001',
  wall = '30000000-0000-4000-8000-000000000002',
  foreign = '30000000-0000-4000-8000-000000000003';
const ctx = {
  tenantId: tenant,
  userId: actor,
  clerkUserId: 'synthetic-actor',
  tenantSlug: 'fixture',
  role: 'standard_user',
} as TenantContext;
let db: PGlite, tx: Prisma.TransactionClient;
const repo = new ImpactRepository();

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE tenants(id uuid PRIMARY KEY,status text DEFAULT 'active');
    CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text);
    CREATE TABLE tenant_memberships(tenant_id uuid,user_id uuid,role text,status text DEFAULT 'active');
    CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,name text,status text DEFAULT 'active',memory_wall boolean DEFAULT false,
      account_owner_version int DEFAULT 0,account_owner_user_id uuid,UNIQUE(tenant_id,id));
    CREATE TABLE client_memory_access(tenant_id uuid,client_id uuid,user_id uuid);
    CREATE TABLE tracked_bill(tenant_id uuid,client_id uuid,bill_id text,created_at timestamptz,note text,updated_at timestamptz);
    CREATE TABLE intel_tracked_bill(tenant_id text,client_id text,bill_id text,tracked_at timestamptz,note text,
      analyst_note text,position text,priority text,updated_at timestamptz);
    CREATE TABLE intel_feature_flag(tenant_id text,feature text,enabled boolean);
    CREATE TABLE congress_bill(id text,title text,status text,latest_action_text text,latest_action_date date,url text);
    CREATE TABLE state_bill(id text,title text,state text,status text,latest_action_text text,latest_action_date date,url text,state_url text);
    CREATE TABLE congress_bill_action(bill_id text,date date,text text);
    CREATE TABLE state_bill_action(bill_key text,date date,text text);
    CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('app.current_tenant')::uuid $$;
    CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql AS $$ SELECT current_setting('app.current_user')::uuid $$;
    CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE ROLE capiro_app;
    INSERT INTO tenants(id) VALUES('${tenant}'),('${other}');
    INSERT INTO users VALUES('${actor}','synthetic-actor');
    INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES('${tenant}','${actor}','standard_user');
    INSERT INTO clients(id,tenant_id,name,memory_wall) VALUES('${open}','${tenant}','Open client',false),('${wall}','${tenant}','Walled client',true),('${foreign}','${other}','Foreign client',false);
    INSERT INTO tracked_bill(tenant_id,client_id,bill_id,created_at,note) VALUES('${tenant}','${open}','119-hr-1','2026-11-01T00:00:00.123456Z','manual'),
      ('${tenant}','${open}','119-hr-2','2026-11-01T00:00:00.123456Z',null),
      ('${tenant}','${wall}','119-hr-3','2026-11-02T00:00:00Z','private'),
      ('${other}','${foreign}','119-hr-4','2026-11-03T00:00:00Z','foreign');
    INSERT INTO congress_bill(id,title,status) VALUES('119-hr-1','Public bill','introduced'),('119-hr-2','Second bill','committee'),('119-hr-3','Private association','passed_chamber');
    SELECT set_config('app.current_tenant','${tenant}',false),set_config('app.current_user','${actor}',false);
  `);
  await db.exec(
    readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20290110080000_legiwatch_client_impact/migration.sql',
      ),
      'utf8',
    ),
  );
  const query = async (sql: string, ...values: unknown[]) => (await db.query(sql, values)).rows;
  tx = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
      (await db.query(sql, values)).affectedRows ?? 0,
    $queryRaw: async (sql: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
      if ('text' in sql) return query(sql.text, ...sql.values);
      return query(
        Array.from(sql)
          .map((part, i) => part + (i < values.length ? `$${i + 1}` : ''))
          .join(''),
        ...values,
      );
    },
    tenantMembership: {
      findFirst: async () =>
        (
          await query(
            `SELECT m.role FROM tenant_memberships m JOIN users u ON u.id=m.user_id
      JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND t.status='active' AND u.clerk_user_id=$3`,
            tenant,
            actor,
            ctx.clerkUserId,
          )
        )[0] ?? null,
    },
  } as unknown as Prisma.TransactionClient;
});
afterEach(async () => {
  await db.close();
});

it('filters tenant and wall before names, counts and keyset pagination, including equal timestamps', async () => {
  const first = await repo.list(tx, ctx, { limit: 1 });
  expect(first.total).toBe(2);
  expect(first.clients).toEqual([{ id: open, name: 'Open client' }]);
  expect(first.rows.map((r) => r.billId)).toEqual(['119-hr-2']);
  expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()).t).toContain('.123456');
  const second = await repo.list(tx, ctx, { limit: 1, cursor: first.nextCursor! });
  expect(second.rows.map((r) => r.billId)).toEqual(['119-hr-1']);
  expect(second.nextCursor).toBeNull();
  await expect(repo.list(tx, ctx, { clientId: wall })).rejects.toThrow('Client not found');
  await expect(repo.list(tx, ctx, { clientId: foreign })).rejects.toThrow('Client not found');
  await expect(repo.list(tx, ctx, { cursor: first.nextCursor!, q: 'other' })).rejects.toThrow(
    'Invalid tracker cursor',
  );
});

it('honors grant revocation and current actor membership instead of cached tenant roles', async () => {
  await db.query('INSERT INTO client_memory_access VALUES($1,$2,$3)', [tenant, wall, actor]);
  expect((await repo.list(tx, ctx, {})).total).toBe(3);
  await db.query('DELETE FROM client_memory_access WHERE client_id=$1', [wall]);
  expect((await repo.list(tx, ctx, {})).total).toBe(2);
  await db.query("UPDATE tenant_memberships SET status='inactive'");
  await expect(repo.list(tx, ctx, {})).rejects.toThrow('Account owner access denied');
});

it('uses only the active tracker owner and writes its existing analyst columns', async () => {
  await db.query("INSERT INTO intel_feature_flag VALUES($1,'tracker_owner_intel',true)", [tenant]);
  await db.query(
    "INSERT INTO intel_tracked_bill(tenant_id,client_id,bill_id,tracked_at,position) VALUES($1,$2,'fl-2026-hb1',now(),'monitor')",
    [tenant, open],
  );
  const page = await repo.list(tx, ctx, {});
  expect(page.total).toBe(1);
  expect(page.rows[0]?.billId).toBe('fl-2026-hb1');
  await repo.updateContext(tx, ctx, page.rows[0]!, {
    position: 'oppose',
    priority: 'high',
    analystNote: 'Review exception',
  });
  expect(await repo.row(tx, ctx, open, 'fl-2026-hb1')).toMatchObject({
    position: 'oppose',
    priority: 'high',
    note: 'Review exception',
  });
  await repo.updateContext(tx, ctx, page.rows[0]!, { analystNote: null });
  expect(await repo.row(tx, ctx, open, 'fl-2026-hb1')).toMatchObject({
    position: 'oppose',
    priority: 'high',
    note: null,
  });
  await db.query('UPDATE intel_feature_flag SET enabled=false');
  expect((await repo.list(tx, ctx, {})).total).toBe(2);
});

it('persists Core context separately from analysis and preserves notes and stance when analysis is refreshed', async () => {
  const row = await repo.row(tx, ctx, open, '119-hr-1');
  await repo.updateContext(tx, ctx, row, {
    position: 'support',
    priority: 'low',
    analystNote: 'Saved note',
  });
  await repo.save(tx, ctx, open, '119-hr-1', {
    ...emptyImpact(),
    status: 'ready',
    inputFingerprint: 'synthetic',
  });
  expect(await repo.row(tx, ctx, open, '119-hr-1')).toMatchObject({
    position: 'support',
    priority: 'low',
    note: 'Saved note',
    analysis: { status: 'ready' },
  });
  const failed = await repo.save(tx, ctx, open, '119-hr-1', {
    ...emptyImpact(),
    status: 'unavailable',
    inputFingerprint: 'synthetic',
  });
  expect(failed.status).toBe('ready');
  await repo.updateContext(tx, ctx, row, { priority: null });
  expect(await repo.row(tx, ctx, open, '119-hr-1')).toMatchObject({
    position: 'support',
    priority: null,
  });
  await repo.updateContext(tx, ctx, row, { analystNote: null });
  expect(await repo.row(tx, ctx, open, '119-hr-1')).toMatchObject({
    position: 'support',
    note: null,
  });
  expect(
    (
      await db.query('SELECT note FROM tracked_bill WHERE client_id=$1 AND bill_id=$2', [
        open,
        '119-hr-1',
      ])
    ).rows,
  ).toEqual([{ note: null }]);
});

it.each(['unavailable', 'needs_evidence'] as const)(
  'retains the last valid assessment privately when changed evidence returns %s',
  async (status) => {
    const valid = {
      ...emptyImpact(),
      status: 'ready' as const,
      summary: 'Previously verified assessment',
      inputFingerprint: 'revision-a',
      analyzedAt: '2026-11-06T00:00:00.000Z',
    };
    await repo.save(tx, ctx, open, '119-hr-1', valid);
    const unresolved = {
      ...emptyImpact(),
      status,
      inputFingerprint: 'revision-b',
    };
    expect(await repo.save(tx, ctx, open, '119-hr-1', unresolved)).toEqual({
      ...unresolved,
      lastValidAnalysis: valid,
    });
    const retry = { ...unresolved, inputFingerprint: 'revision-c' };
    expect(await repo.save(tx, ctx, open, '119-hr-1', retry)).toEqual({
      ...retry,
      lastValidAnalysis: valid,
    });
    expect((await repo.row(tx, ctx, open, '119-hr-1')).analysis).toEqual({
      ...retry,
      lastValidAnalysis: valid,
    });
    const replacement = {
      ...valid,
      inputFingerprint: 'revision-d',
      summary: 'New verified assessment',
    };
    expect(await repo.save(tx, ctx, open, '119-hr-1', replacement)).toEqual(replacement);
  },
);

it('enforces migration RLS for direct tenant/wall reads and writes, including revoked membership', async () => {
  await repo.save(tx, ctx, open, '119-hr-1', emptyImpact());
  await db.exec(
    'GRANT SELECT ON tenants,tenant_memberships,clients,client_memory_access TO capiro_app; SET ROLE capiro_app;',
  );
  expect((await db.query('SELECT * FROM legiwatch_client_bill_analysis')).rows).toHaveLength(1);
  await expect(repo.save(tx, ctx, wall, '119-hr-3', emptyImpact())).rejects.toThrow();
  await db.exec(`SELECT set_config('app.current_tenant','${other}',false)`);
  expect((await db.query('SELECT * FROM legiwatch_client_bill_analysis')).rows).toHaveLength(0);
  await db.exec(
    `RESET ROLE; UPDATE tenant_memberships SET status='inactive'; SELECT set_config('app.current_tenant','${tenant}',false); SET ROLE capiro_app;`,
  );
  expect((await db.query('SELECT * FROM legiwatch_client_bill_analysis')).rows).toHaveLength(0);
});

it('reads federal/state actions from canonical tables and never fabricates probability or unsafe links', async () => {
  await db.exec(
    "INSERT INTO congress_bill_action VALUES('119-hr-1','2026-11-01','Introduced'); INSERT INTO state_bill_action VALUES('fl-2026-hb1','2026-11-02','Committee referral');",
  );
  expect(await repo.actions(tx, '119-hr-1')).toEqual([
    { date: '2026-11-01', text: 'Introduced', sourceUrl: null },
  ]);
  expect(await repo.actions(tx, 'fl-2026-hb1')).toEqual([
    { date: '2026-11-02', text: 'Committee referral', sourceUrl: null },
  ]);
  expect(presentImpactRow(await repo.row(tx, ctx, open, '119-hr-1'), emptyImpact())).toMatchObject({
    stage: 'introduced',
    passageProbability: null,
  });
  expect(safeSourceUrl('javascript:alert(1)')).toBeNull();
  expect(safeSourceUrl('https://user:pass@example.test')).toBeNull();
});

it('presents the public federal bill page without changing the retained provider URL', async () => {
  const providerUrl = 'https://api.congress.gov/v3/bill/119/hr/1?format=json';
  await db.query('UPDATE congress_bill SET url=$1 WHERE id=$2', [providerUrl, '119-hr-1']);
  const row = await repo.row(tx, ctx, open, '119-hr-1');
  expect(presentImpactRow(row, emptyImpact()).sourceUrl).toBe(
    'https://www.congress.gov/bill/119th-congress/house-bill/1',
  );
  expect(row.sourceUrl).toBe(providerUrl);
  const stateUrl = 'https://www.flsenate.gov/Session/Bill/2026/1';
  expect(
    presentImpactRow({ ...row, billId: 'fl-2026-sb1', sourceUrl: stateUrl }, emptyImpact())
      .sourceUrl,
  ).toBe(stateUrl);
});
