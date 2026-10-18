import { PGlite } from '@electric-sql/pglite';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { CLIENT_STORAGE_QUOTA_BYTES, type TenantContext } from '@capiro/shared';
import request from 'supertest';
import { ClientFilesController, ClientFilesService } from './client-files.controller.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const client = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const ctx: TenantContext = {
  tenantId: tenant,
  tenantSlug: 'synthetic-storage',
  userId: actor,
  clerkUserId: 'user_synthetic_storage',
  role: 'standard_user',
};

/** Actual SQL against disposable in-memory PostgreSQL. The adapter supplies
 * Prisma's transaction surface; it does not qualify production Prisma or RLS. */
describe('client registered storage usage', () => {
  let db: PGlite;
  let service: ClientFilesService;
  let app: INestApplication;
  let requestContext: TenantContext | undefined;
  const aggregateQueries: string[] = [];
  const raw = jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
    if (sql.includes('FROM engagement_attachments')) aggregateQueries.push(sql);
    return (await db.query(sql, values)).rows;
  });
  const tx = {
    $queryRaw: raw,
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => (await db.query(sql, values)).rows,
    tenantMembership: {
      findFirst: async ({ where }: { where: {
        tenantId: string; userId: string; status: string; user: { clerkUserId: string };
      } }) => (await db.query(
        `SELECT tm.role FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
         WHERE tm.tenant_id=$1::uuid AND tm.user_id=$2::uuid AND tm.status=$3
           AND u.clerk_user_id=$4`,
        [where.tenantId, where.userId, where.status, where.user.clerkUserId],
      )).rows[0] ?? null,
    },
  };

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE users (id uuid PRIMARY KEY, clerk_user_id text NOT NULL);
      CREATE TABLE tenant_memberships (tenant_id uuid, user_id uuid, status text, role text);
      CREATE TABLE clients (id uuid, tenant_id uuid, status text DEFAULT 'active',
        memory_wall boolean DEFAULT false, account_owner_version integer DEFAULT 0,
        account_owner_user_id uuid);
      CREATE TABLE client_memory_access (tenant_id uuid, client_id uuid, user_id uuid);
      CREATE TABLE engagement_attachments (tenant_id uuid, client_id uuid, prospect_id uuid, s3_key text,
        byte_size integer, viewer_mode text DEFAULT 'all', uploaded_by_user_id uuid,
        lifecycle_status text DEFAULT 'ready', superseded_by_attachment_id uuid,
        UNIQUE(tenant_id, s3_key));
    `);
    service = new ClientFilesService({
      withTenant: async (tenantId: string, run: (transaction: typeof tx) => Promise<unknown>) => {
        expect(tenantId).toBe(tenant);
        return run(tx);
      },
    } as never);
    const module = await Test.createTestingModule({
      controllers: [ClientFilesController],
      providers: [{ provide: ClientFilesService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = requestContext;
      next();
    });
    await app.init();
  }, 30_000);

  beforeEach(async () => {
    await db.exec('TRUNCATE users, tenant_memberships, clients, client_memory_access, engagement_attachments');
    await db.query('INSERT INTO users VALUES ($1::uuid, $2)', [actor, ctx.clerkUserId]);
    await db.query('INSERT INTO tenant_memberships VALUES ($1::uuid, $2::uuid, $3, $4)',
      [tenant, actor, 'active', 'standard_user']);
    await db.query('INSERT INTO clients (id, tenant_id) VALUES ($1::uuid, $2::uuid)', [client, tenant]);
    requestContext = ctx;
    aggregateQueries.length = 0;
    raw.mockClear();
  });

  afterAll(async () => { await app?.close(); await db?.close(); });

  async function add(bytes: number | null, options: {
    tenantId?: string; clientId?: string | null; lifecycle?: string;
    private?: boolean; superseded?: boolean;
  } = {}) {
    await db.query(`INSERT INTO engagement_attachments
      (tenant_id, client_id, s3_key, byte_size, viewer_mode, uploaded_by_user_id,
       lifecycle_status, superseded_by_attachment_id)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8::uuid)`, [
      options.tenantId ?? tenant,
      options.clientId === undefined ? client : options.clientId,
      `object-${Math.random()}`,
      bytes,
      options.private ? 'restricted' : 'all',
      options.private ? other : actor,
      options.lifecycle ?? 'ready',
      options.superseded ? other : null,
    ]);
  }

  test('empty registry is zero usage with the canonical unenforced allowance', async () => {
    const result = await service.storageUsage(ctx, client);
    expect(result).toEqual({
      clientId: client, source: 'engagement_attachments', asOf: expect.any(String),
      usageBasis: 'registered_attachments', allowanceScope: 'client',
      allowanceBytes: 10 * 1024 ** 3, enforcement: 'report_only', status: 'available',
      usedBytes: 0, remainingBytes: CLIENT_STORAGE_QUOTA_BYTES, overAllowance: false,
    });
    expect(Number.isFinite(Date.parse(result.asOf))).toBe(true);
    expect(aggregateQueries).toHaveLength(1);
  });

  test('counts hidden and superseded files and every retained lifecycle, excluding other scopes', async () => {
    await add(100);
    await add(200, { private: true });
    await add(300, { superseded: true });
    for (const lifecycle of ['legacy_ready', 'quarantined', 'blocked', 'delete_pending', 'delete_failed'])
      await add(400, { lifecycle });
    await add(10000, { clientId: other });
    await add(20000, { clientId: null });
    await add(30000, { tenantId: other });
    expect(await service.storageUsage(ctx, client)).toMatchObject({
      status: 'available', usedBytes: 2600, remainingBytes: CLIENT_STORAGE_QUOTA_BYTES - 2600,
    });
    expect(aggregateQueries).toHaveLength(1);
  });

  test('pending deletion remains charged until the canonical row is removed', async () => {
    await add(512, { lifecycle: 'delete_pending' });
    expect(await service.storageUsage(ctx, client)).toMatchObject({ usedBytes: 512 });
    await db.exec('DELETE FROM engagement_attachments');
    expect(await service.storageUsage(ctx, client)).toMatchObject({ usedBytes: 0 });
  });

  test('zero bytes is known, while null or invalid sizes refuse a fabricated total', async () => {
    await add(0, { private: true });
    expect(await service.storageUsage(ctx, client)).toMatchObject({ status: 'available', usedBytes: 0 });
    for (const size of [null, -1]) {
      await db.exec('DELETE FROM engagement_attachments');
      await add(500);
      await add(size, { private: true });
      expect(await service.storageUsage(ctx, client)).toMatchObject({
        status: 'unavailable', reason: 'incomplete_size_metadata',
        usedBytes: null, remainingBytes: null, overAllowance: null,
      });
    }
  });

  test('totals above 32-bit range and the allowance are exact; remaining bytes never go negative', async () => {
    for (let i = 0; i < 10; i++) await add(1024 ** 3);
    expect(await service.storageUsage(ctx, client)).toMatchObject({
      usedBytes: CLIENT_STORAGE_QUOTA_BYTES, remainingBytes: 0, overAllowance: false,
    });
    await add(1);
    expect(await service.storageUsage(ctx, client)).toMatchObject({
      usedBytes: CLIENT_STORAGE_QUOTA_BYTES + 1, remainingBytes: 0, overAllowance: true,
      enforcement: 'report_only',
    });
  });

  test.each(['unknown', 'archived', 'wall'])('%s clients release no usage', async (kind) => {
    if (kind === 'archived') await db.exec("UPDATE clients SET status='archived'");
    if (kind === 'wall') await db.exec('UPDATE clients SET memory_wall=true');
    await expect(service.storageUsage(ctx, kind === 'unknown' ? other : client)).rejects.toMatchObject({ status: 404 });
    expect(aggregateQueries).toHaveLength(0);
  });

  test('a foreign client, malformed id and foreign Clerk identity release no usage', async () => {
    await db.query('UPDATE clients SET tenant_id=$1::uuid', [other]);
    await expect(service.storageUsage(ctx, client)).rejects.toMatchObject({ status: 404 });
    await expect(service.storageUsage(ctx, 'not-a-uuid')).rejects.toMatchObject({ status: 404 });
    await expect(service.storageUsage({ ...ctx, clerkUserId: 'user_other' }, client)).rejects.toMatchObject({ status: 403 });
    expect(aggregateQueries).toHaveLength(0);
  });

  test.each(['inactive', 'client_portal_user', 'unrecognized'])('fresh %s membership denies stale context', async (value) => {
    await db.query(value === 'inactive' ? 'UPDATE tenant_memberships SET status=$1' : 'UPDATE tenant_memberships SET role=$1', [value]);
    await expect(service.storageUsage(ctx, client)).rejects.toMatchObject({ status: 403 });
    expect(aggregateQueries).toHaveLength(0);
  });

  test('a wall grant permits aggregate access but no admin bypass exists', async () => {
    await db.exec('UPDATE clients SET memory_wall=true');
    await db.exec("UPDATE tenant_memberships SET role='user_admin'");
    await expect(service.storageUsage({ ...ctx, role: 'user_admin' }, client)).rejects.toMatchObject({ status: 404 });
    await db.query('INSERT INTO client_memory_access VALUES ($1::uuid, $2::uuid, $3::uuid)', [tenant, client, actor]);
    expect(await service.storageUsage(ctx, client)).toMatchObject({ status: 'available' });
  });

  test('refuses totals that cannot be represented exactly as JSON numbers', async () => {
    raw.mockImplementationOnce(async () => [{ version: 0, primary: null }]);
    raw.mockImplementationOnce(async () => [{ role: 'standard_user' }]);
    raw.mockImplementationOnce(async () => []);
    raw.mockImplementationOnce(async () => [{ usedBytes: '9007199254740993', incomplete: false, asOf: new Date() }]);
    expect(await service.storageUsage(ctx, client)).toMatchObject({
      status: 'unavailable', reason: 'unsafe_total', usedBytes: null, remainingBytes: null, overAllowance: null,
    });
  });

  test('HTTP route returns only the aggregate and disables caching', async () => {
    await add(20, { private: true });
    const response = await request(app.getHttpServer()).get(`/api/clients/${client}/files/storage-usage`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ status: 'available', usedBytes: 20 });
    expect(Object.keys(response.body).sort()).toEqual([
      'allowanceBytes', 'allowanceScope', 'asOf', 'clientId', 'enforcement', 'overAllowance',
      'remainingBytes', 'source', 'status', 'usageBasis', 'usedBytes',
    ]);
  });

  test('HTTP guard denies missing context and a portal role', async () => {
    requestContext = undefined;
    await request(app.getHttpServer()).get(`/api/clients/${client}/files/storage-usage`).expect(403);
    requestContext = { ...ctx, role: 'client_portal_user' };
    await request(app.getHttpServer()).get(`/api/clients/${client}/files/storage-usage`).expect(403);
    expect(aggregateQueries).toHaveLength(0);
  });
});
