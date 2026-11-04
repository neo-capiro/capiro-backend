import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import request from 'supertest';
import { ClientFilesController, ClientFilesService } from './client-files.controller.js';

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
