import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import request from 'supertest';
import { ClientFilesController, ClientFilesService } from './client-files.controller.js';
import { BIZDEV_STAGES, LEGACY_PROSPECT_STAGES } from '../business-development/prospect-stages.js';
import {
  fixture as nativeFixture, id as nativeId, tenant as nativeTenant, client as nativeClient,
  actor as nativeActor, outsider as nativeOutsider, foreign as nativeForeign,
  first as nativeFirst, second as nativeSecond, ctx as nativeCtx,
} from '../../test/a2-postgres/fixture.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const client = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const ctx = {
  tenantId: tenant,
  userId: actor,
  clerkUserId: 'synthetic-folders',
  role: 'standard_user',
} as TenantContext;

describe('durable client file folders', () => {
  let db: PGlite;
  let service: ClientFilesService;
  let app: INestApplication;
  const raw = async (parts: any, ...values: unknown[]) => {
    const sql = Array.isArray(parts)
      ? parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '')
      : parts.text;
    return (await db.query(sql, Array.isArray(parts) ? values : parts.values)).rows;
  };
  const tx = {
    $queryRaw: raw,
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
      (await db.query(sql, values)).rows,
    tenantMembership: {
      findFirst: async () =>
        (await db.query("SELECT role FROM tenant_memberships WHERE status='active'")).rows[0] ??
        null,
    },
    clientFileFolder: {
      createMany: async ({ data }: any) => {
        for (const row of data)
          await db.query(
            'INSERT INTO client_file_folders (tenant_id,client_id,name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [row.tenantId, row.clientId, row.name],
          );
      },
      findMany: async ({ where }: any) =>
        (
          await db.query(
            'SELECT name FROM client_file_folders WHERE tenant_id=$1 AND client_id=$2',
            [where.tenantId, where.clientId],
          )
        ).rows,
    },
    engagementAttachment: {
      groupBy: async ({ where }: any) => {
        expect(where.prospectId).toBeNull();
        expect(where.supersededByAttachmentId).toBeNull();
        expect(where.OR).toEqual([
          { viewerMode: 'all' },
          { viewerMode: 'restricted', viewerUserIds: { has: actor } },
          { uploadedByUserId: actor },
        ]);
        return (
          await db.query<{ folder: string | null; count: number }>(
            `SELECT folder,COUNT(*)::int AS count FROM engagement_attachments
          WHERE tenant_id=$1 AND client_id=$2 AND prospect_id IS NULL AND superseded_by_attachment_id IS NULL
          AND (viewer_mode='all' OR uploaded_by_user_id=$3 OR $3=ANY(viewer_user_ids)) GROUP BY folder`,
            [where.tenantId, where.clientId, actor],
          )
        ).rows.map((row) => ({ folder: row.folder, _count: { _all: row.count } }));
      },
    },
  };
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE users (id uuid PRIMARY KEY, clerk_user_id text);
      CREATE TABLE tenants (id uuid PRIMARY KEY,status text);
      CREATE TABLE tenant_memberships (tenant_id uuid,user_id uuid,status text,role text);
      CREATE TABLE clients (id uuid,tenant_id uuid,status text DEFAULT 'active',memory_wall boolean DEFAULT false,
        account_owner_version int DEFAULT 0,account_owner_user_id uuid,UNIQUE(tenant_id,id));
      CREATE TABLE client_memory_access (tenant_id uuid,client_id uuid,user_id uuid);
      CREATE TABLE engagement_attachments (tenant_id uuid,client_id uuid,folder text,prospect_id uuid,
        superseded_by_attachment_id uuid,viewer_mode text DEFAULT 'all',viewer_user_ids uuid[] DEFAULT '{}',uploaded_by_user_id uuid);
      CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS 'SELECT false';
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    `);
    await db.exec(
      readFileSync(
        join(__dirname, '../../prisma/migrations/20281104020000_client_file_folders/migration.sql'),
        'utf8',
      ),
    );
    service = new ClientFilesService({
      withTenant: async (_tenant: string, run: any) => run(tx),
    } as never);
    const module = await Test.createTestingModule({
      controllers: [ClientFilesController],
      providers: [{ provide: ClientFilesService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.use((req: any, _res: unknown, next: () => void) => {
      req.tenantContext = ctx;
      next();
    });
    await app.init();
  }, 30_000);
  beforeEach(async () => {
    await db.exec(
      'TRUNCATE users,tenants,tenant_memberships,clients,client_memory_access,engagement_attachments CASCADE',
    );
    await db.query('INSERT INTO users VALUES ($1,$2)', [actor, ctx.clerkUserId]);
    await db.query("INSERT INTO tenants VALUES ($1,'active')", [tenant]);
    await db.query("INSERT INTO tenant_memberships VALUES ($1,$2,'active','standard_user')", [
      tenant,
      actor,
    ]);
    await db.query('INSERT INTO clients (tenant_id,id) VALUES ($1,$2),($1,$3),($3,$2)', [
      tenant,
      client,
      other,
    ]);
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  test('creates an empty folder without a file, safely repeats it, and merges visible file counts', async () => {
    const url = `/clients/${client}/files/folders`;
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post(url)
        .send({ folder: ' Hearings ' })
        .expect(200, { folder: 'Hearings' });
    await service.createFolder(ctx, other, { folder: 'Other client' });
    await db.query(
      'INSERT INTO engagement_attachments (tenant_id,client_id,folder,viewer_mode,uploaded_by_user_id) VALUES ($1,$2,$3,$4,$5),($1,$2,$6,$7,$8)',
      [tenant, client, 'Hearings', 'all', actor, 'Private', 'restricted', other],
    );
    await db.query('INSERT INTO client_file_folders (tenant_id,client_id,name) VALUES ($1,$2,$3)', [
      other,
      client,
      'Foreign tenant',
    ]);
    await service.createFolder(ctx, client, { folder: 'Empty' });
    const response = await request(app.getHttpServer()).get(url).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual([
      { folder: 'Empty', count: 0 },
      { folder: 'Hearings', count: 1 },
    ]);
    expect(
      (
        await db.query('SELECT * FROM client_file_folders WHERE tenant_id=$1 AND client_id=$2', [
          tenant,
          client,
        ])
      ).rows,
    ).toHaveLength(2);
  });
  test.each(['', ' ', 'x'.repeat(121), null])(
    'rejects invalid folder names before persistence',
    async (folder) => {
      await request(app.getHttpServer())
        .post(`/clients/${client}/files/folders`)
        .send({ folder })
        .expect(400);
      expect((await db.query('SELECT * FROM client_file_folders')).rows).toHaveLength(0);
    },
  );
  test.each(['archived', 'wall', 'revoked'])(
    'current %s authority blocks listing and creation',
    async (kind) => {
      if (kind === 'archived')
        await db.query("UPDATE clients SET status='archived' WHERE tenant_id=$1 AND id=$2", [
          tenant,
          client,
        ]);
      if (kind === 'wall')
        await db.query('UPDATE clients SET memory_wall=true WHERE tenant_id=$1 AND id=$2', [
          tenant,
          client,
        ]);
      if (kind === 'revoked') await db.exec("UPDATE tenant_memberships SET status='inactive'");
      const status = kind === 'revoked' ? 403 : 404;
      await request(app.getHttpServer()).get(`/clients/${client}/files/folders`).expect(status);
      await request(app.getHttpServer())
        .post(`/clients/${client}/files/folders`)
        .send({ folder: 'Hidden' })
        .expect(status);
      expect((await db.query('SELECT * FROM client_file_folders')).rows).toHaveLength(0);
    },
  );
  test('database rejects a cross-tenant client reference and blank persisted names', async () => {
    await expect(
      db.query('INSERT INTO client_file_folders (tenant_id,client_id,name) VALUES ($1,$2,$3)', [
        other,
        other,
        'No matching client',
      ]),
    ).rejects.toThrow();
    await expect(
      db.query('INSERT INTO client_file_folders (tenant_id,client_id,name) VALUES ($1,$2,$3)', [
        tenant,
        client,
        '  ',
      ]),
    ).rejects.toThrow();
  });
});

// The Release-owned PG16 facility supplies an empty wave2_a2_* database. Keep
// the existing A2 URL/role/schema guards; never fall back to DATABASE_URL.
(process.env.A2_PG_FIXTURE === '1' ? describe : describe.skip)('Portfolio migrations on ordinary PostgreSQL', () => {
  let h: Awaited<ReturnType<typeof nativeFixture>> | undefined;
  let service: ClientFilesService;
  let beforeMigration: unknown;
  let afterMigration: unknown;
  const readMigration = (name: string) =>
    readFileSync(join(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8');
  const closeConnections = async () => {
    const owned = h;
    h = undefined;
    await owned?.close();
  };
  const snapshot = async () => {
    const tables = ['business_development_prospects', 'business_development_prospect_activity', 'clients', 'engagement_attachments'];
    const rows: Record<string, unknown> = {};
    for (const table of tables) {
      // Closed fixture-owned identifiers, never user input.
      rows[table] = (await h!.sql(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows;
    }
    return {
      rows,
      columns: (await h!.sql(`SELECT table_name,column_name,column_default,is_nullable,data_type
        FROM information_schema.columns WHERE table_schema='a2_files' AND table_name=ANY($1::text[])
        ORDER BY table_name,column_name`, [tables])).rows,
      constraints: (await h!.sql(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition
        FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='a2_files' AND c.relname=ANY($1::text[])
          AND k.conname<>'business_development_prospects_stage_check' ORDER BY c.relname,k.conname`, [tables])).rows,
      indexes: (await h!.sql(`SELECT tablename,indexname,indexdef FROM pg_indexes
        WHERE schemaname='a2_files' AND tablename=ANY($1::text[]) ORDER BY tablename,indexname`, [tables])).rows,
      policies: (await h!.sql(`SELECT tablename,policyname,cmd,qual,with_check FROM pg_policies
        WHERE schemaname='a2_files' AND tablename=ANY($1::text[]) ORDER BY tablename,policyname`, [tables])).rows,
      rls: (await h!.sql(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='a2_files' AND c.relname=ANY($1::text[])
        ORDER BY c.relname`, [tables])).rows,
    };
  };
  beforeAll(async () => {
    try {
      h = await nativeFixture('files');
      await h.sql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
        CREATE TABLE canonical_entities (id uuid PRIMARY KEY);
        ALTER TABLE engagement_attachments ADD COLUMN superseded_by_attachment_id uuid;`);
      await h.sql(readMigration('20280924010000_business_development_phase1'));
      await h.reset();
      for (const [index, stage] of LEGACY_PROSPECT_STAGES.entries()) {
        await h.sql(`INSERT INTO business_development_prospects
          (id,tenant_id,display_name,stage,owner_user_id,linked_client_id,converted_at,watch_requested)
          VALUES($1,$2,'Existing prospect',$3,$4,$5,$6,true)`,
        [nativeId(4000 + index), nativeTenant, stage, nativeActor,
          index === 0 ? nativeClient : null, index === 0 ? '2026-10-01T00:00:00Z' : null]);
        await h.sql(`INSERT INTO business_development_prospect_activity
          (id,tenant_id,prospect_id,actor_user_id,kind,body,before_jsonb,after_jsonb)
          VALUES($1,$2,$3,$4,'stage','Existing history',$5::jsonb,$6::jsonb)`,
        [nativeId(4100 + index), nativeTenant, nativeId(4000 + index), nativeActor,
          JSON.stringify({ stage: 'researching' }), JSON.stringify({ stage })]);
      }
      beforeMigration = await snapshot();
      // Execute the exact forward files once; no rewritten SQL or schema push.
      await h.sql(readMigration('20281104010000_portfolio_prospect_stages'));
      await h.sql(readMigration('20281104020000_client_file_folders'));
      afterMigration = await snapshot();
      service = new ClientFilesService(h.prisma);
    } catch (error) {
      await closeConnections().catch(() => undefined);
      throw error;
    }
  }, 60_000);
  beforeEach(async () => { await h!.reset(); });
  // Connection cleanup only. Release owns the disposable DB/container lifetime.
  afterAll(closeConnections);

  const appQuery = <T = Record<string, unknown>>(tenantId: string | null, sql: string, values: unknown[] = []) =>
    h!.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls','off',true),
        set_config('app.current_tenant',${tenantId ?? ''},true), set_config('statement_timeout','6000',true)`;
      return tx.$queryRawUnsafe<T[]>(sql, ...values);
    }, { timeout: 6000 });
  const folderCount = async () => (await h!.sql('SELECT count(*)::int AS count FROM client_file_folders')).rows[0].count;

  it('preserves existing prospect rows, history, defaults and invariants while accepting all fourteen stages', async () => {
    expect(afterMigration).toEqual(beforeMigration);
    expect(BIZDEV_STAGES).toHaveLength(14);
    for (const [index, stage] of BIZDEV_STAGES.entries()) {
      expect(await appQuery(nativeTenant, `INSERT INTO business_development_prospects(id,tenant_id,display_name,stage)
        VALUES($1::uuid,$2::uuid,'New prospect',$3) RETURNING stage`, [nativeId(4200 + index), nativeTenant, stage]))
        .toEqual([{ stage }]);
    }
    expect(await appQuery(nativeTenant, `INSERT INTO business_development_prospects(id,tenant_id,display_name)
      VALUES($1::uuid,$2::uuid,'Legacy default') RETURNING stage`, [nativeId(4300), nativeTenant]))
      .toEqual([{ stage: 'researching' }]);
    await expect(appQuery(nativeTenant, `INSERT INTO business_development_prospects(id,tenant_id,display_name,stage)
      VALUES($1::uuid,$2::uuid,'Invalid','unknown') RETURNING id`, [nativeId(4301), nativeTenant]))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
    expect((await h!.sql('SELECT count(*)::int AS count FROM business_development_prospect_activity')).rows)
      .toEqual([{ count: 0 }]);
  }, 15_000);

  it('uses a distinct ordinary app role with forced RLS, bypass off and the actual migration grants', async () => {
    expect(await h!.prisma.withTenant(nativeTenant, tx => tx.$queryRawUnsafe(`SELECT
      current_user::text AS role,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolinherit,
      c.relowner<>r.oid AS distinct_owner,c.relrowsecurity,c.relforcerowsecurity,
      current_setting('app.current_tenant') AS tenant,current_setting('app.bypass_rls') AS bypass,
      rls_bypass() AS effective_bypass,
      has_table_privilege(current_user,c.oid,'SELECT') AS can_select,
      has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
      has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
      has_table_privilege(current_user,c.oid,'DELETE') AS can_delete,
      (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='client_file_folders'::regclass`)))
      .toEqual([{ role: 'capiro_app', rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false,
        rolinherit: false, distinct_owner: true, relrowsecurity: true, relforcerowsecurity: true,
        tenant: nativeTenant, bypass: 'off', effective_bypass: false,
        can_select: true, can_insert: true, can_update: false, can_delete: false, memberships: 0 }]);
    const policies = (await h!.sql(`SELECT policyname,cmd,qual,with_check FROM pg_policies
      WHERE schemaname='a2_files' AND tablename='client_file_folders'`)).rows;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ policyname: 'client_file_folders_isolation', cmd: 'ALL' });
    expect(policies[0].qual).toContain('current_tenant_id()');
    expect(policies[0].qual).toContain('rls_bypass()');
    expect(policies[0].with_check).toBe(policies[0].qual);
  }, 15_000);

  it('enforces same-tenant reads and inserts and rejects foreign or missing tenant writes', async () => {
    await h!.sql('INSERT INTO clients(id,tenant_id) VALUES($1,$2)', [nativeId(4400), nativeForeign]);
    await h!.sql('INSERT INTO client_file_folders(tenant_id,client_id,name) VALUES($1,$2,$3)',
      [nativeForeign, nativeId(4400), 'Foreign']);
    expect(await appQuery(nativeTenant, `INSERT INTO client_file_folders(tenant_id,client_id,name)
      VALUES($1::uuid,$2::uuid,'Visible') RETURNING name`, [nativeTenant, nativeClient])).toEqual([{ name: 'Visible' }]);
    expect(await appQuery(nativeTenant, 'SELECT name FROM client_file_folders')).toEqual([{ name: 'Visible' }]);
    expect(await appQuery(null, 'SELECT name FROM client_file_folders')).toEqual([]);
    for (const [scope, rowTenant, rowClient] of [
      [nativeTenant, nativeForeign, nativeId(4400)], [null, nativeTenant, nativeClient],
    ] as const) {
      await expect(appQuery(scope, `INSERT INTO client_file_folders(tenant_id,client_id,name)
        VALUES($1::uuid,$2::uuid,'Forbidden') RETURNING name`, [rowTenant, rowClient]))
        .rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
    }
    expect(await folderCount()).toBe(2);
  }, 15_000);

  it('enforces the composite FK, exact-name uniqueness, trimmed 120-character names and scoped cascade', async () => {
    const anotherClient = nativeId(4500), foreignClient = nativeId(4501);
    await h!.sql('INSERT INTO clients(id,tenant_id) VALUES($1,$2),($3,$4)',
      [anotherClient, nativeTenant, foreignClient, nativeForeign]);
    const insert = (name: string, selected = nativeClient) => appQuery(nativeTenant,
      'INSERT INTO client_file_folders(tenant_id,client_id,name) VALUES($1::uuid,$2::uuid,$3) RETURNING name',
      [nativeTenant, selected, name]);
    await expect(insert('Wrong tenant/client pair', foreignClient))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23503' } });
    await insert('Exact');
    await expect(insert('Exact')).rejects.toMatchObject({ code: 'P2010', meta: { code: '23505' } });
    await insert('Exact', anotherClient);
    await h!.sql('INSERT INTO client_file_folders(tenant_id,client_id,name) VALUES($1,$2,$3)',
      [nativeForeign, foreignClient, 'Exact']);
    for (const name of ['', ' ', ' Leading', 'Trailing ']) {
      await expect(insert(name)).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
    }
    await insert('x'.repeat(120));
    await expect(insert('x'.repeat(121))).rejects.toMatchObject({ code: 'P2010', meta: { code: '22001' } });
    await h!.sql('DELETE FROM clients WHERE id=$1', [anotherClient]);
    expect(await appQuery(nativeTenant, 'SELECT name FROM client_file_folders ORDER BY name'))
      .toEqual([{ name: 'Exact' }, { name: 'x'.repeat(120) }]);
    expect(await folderCount()).toBe(3); // The other tenant's folder survives.
  }, 15_000);

  it('uses real Prisma to create empty folders idempotently and count only visible files for the selected client', async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await service.createFolder(nativeCtx, nativeClient, { folder: ' Empty ' })).toEqual({ folder: 'Empty' });
    }
    await h!.sql('INSERT INTO clients(id,tenant_id) VALUES($1,$2)', [nativeId(4600), nativeTenant]);
    await service.createFolder(nativeCtx, nativeId(4600), { folder: 'Other client' });
    await h!.sql("UPDATE engagement_attachments SET folder='Visible' WHERE id=$1", [nativeFirst]);
    await h!.sql("UPDATE engagement_attachments SET folder='Hidden',viewer_mode='restricted',uploaded_by_user_id=$2 WHERE id=$1",
      [nativeSecond, nativeOutsider]);
    expect(await service.folders(nativeCtx, nativeClient)).toEqual([
      { folder: 'Empty', count: 0 }, { folder: 'Visible', count: 1 },
    ]);
    expect(await folderCount()).toBe(2);
  }, 15_000);

  it('rechecks actual membership, archive, wall and client authority before folder reads and writes', async () => {
    for (const condition of ['revoked', 'archived', 'wall', 'foreign-client', 'missing-client']) {
      await h!.reset();
      let selectedClient = nativeClient;
      if (condition === 'revoked') await h!.sql("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [nativeActor]);
      if (condition === 'archived') await h!.sql("UPDATE clients SET status='archived' WHERE id=$1", [nativeClient]);
      if (condition === 'wall') await h!.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [nativeClient]);
      if (condition === 'foreign-client') {
        selectedClient = nativeId(4700);
        await h!.sql('INSERT INTO clients(id,tenant_id) VALUES($1,$2)', [selectedClient, nativeForeign]);
      }
      if (condition === 'missing-client') selectedClient = nativeId(4701);
      const status = condition === 'revoked' ? 403 : 404;
      await expect(service.folders(nativeCtx, selectedClient)).rejects.toMatchObject({ status });
      await expect(service.createFolder(nativeCtx, selectedClient, { folder: 'Denied' })).rejects.toMatchObject({ status });
      expect(await folderCount()).toBe(0);
    }
  }, 15_000);
});
