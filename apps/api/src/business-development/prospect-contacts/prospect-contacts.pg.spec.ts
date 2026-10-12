import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PGlite as PGliteEngine } from '@electric-sql/pglite' with {
  'resolution-mode': 'import',
};
import { ValidationPipe, type ExecutionContext, type Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ProspectContactsController } from './prospect-contacts.controller.js';
import { ProspectContactsService } from './prospect-contacts.service.js';
import {
  CreateProspectContactDto,
  ProspectContactIdParams,
  RemoveProspectContactDto,
  UpdateProspectContactDto,
} from './prospect-contacts.dto.js';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const prospectA = '33333333-3333-4333-8333-333333333333';
const prospectB = '44444444-4444-4444-8444-444444444444';
const actor = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const ctx: TenantContext = {
  tenantId: tenantA,
  tenantSlug: 'synthetic-a',
  userId: actor,
  clerkUserId: 'synthetic',
  role: 'standard_user',
};
const input = {
  name: 'Priya Nair',
  title: 'VP Government Affairs',
  email: 'priya@example.test',
  phone: null,
  notes: 'Synthetic source: 2026-10-11',
  requestId,
};
const sql = readFileSync(
  resolve(__dirname, '../../../../../docs/portfolio-prospect-contacts/UNALLOCATED-proposal.sql'),
  'utf8',
);
const { PGlite } = require('@electric-sql/pglite') as { PGlite: new () => PGliteEngine };

describe('Prospect contacts: actual service SQL on ephemeral PostgreSQL', () => {
  let db: PGliteEngine;
  let service: ProspectContactsService;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE capiro_app;
      CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.current_tenant',true),'')::uuid $$;
      CREATE TABLE tenants(id uuid PRIMARY KEY);
      CREATE TABLE business_development_prospects(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),status text NOT NULL DEFAULT 'active',linked_client_id uuid,converted_at timestamptz,UNIQUE(tenant_id,id));
      GRANT SELECT ON business_development_prospects TO capiro_app;`);
    await db.query('INSERT INTO tenants VALUES($1),($2)', [tenantA, tenantB]);
    await db.query(
      'INSERT INTO business_development_prospects(id,tenant_id) VALUES($1,$2),($3,$4)',
      [prospectA, tenantA, prospectB, tenantB],
    );
    await db.exec(sql);
    // Test adapter executes the production tagged/parameterized SQL inside a real transaction.
    // PGlite returns timestamp strings; Prisma's PostgreSQL adapter returns Date values.
    const prisma = {
      withTenant: async <T>(tenantId: string, fn: (tx: unknown) => Promise<T>) =>
        db.transaction(async (transaction) => {
          await transaction.query("SELECT set_config('app.current_tenant',$1,true)", [tenantId]);
          return fn({
            $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
              const statement = strings.reduce(
                (text, part, index) => text + (index ? `$${index}` : '') + part,
                '',
              );
              const result = await transaction.query<Record<string, unknown>>(statement, values);
              return result.rows.map((row) =>
                Object.fromEntries(
                  Object.entries(row).map(([key, value]) => [
                    key,
                    key.endsWith('_at') && typeof value === 'string' ? new Date(value) : value,
                  ]),
                ),
              );
            },
          });
        }),
    };
    service = new ProspectContactsService(prisma as unknown as PrismaService);
  }, 60000);
  afterAll(async () => {
    await db?.close();
  });
  afterEach(async () => {
    await db.exec('RESET ROLE');
  });

  test('proposal is LF exact, additive and tenant-safe through composite FK', async () => {
    expect(sql).not.toContain('\r');
    expect(
      (await db.query('SELECT count(*)::int AS n FROM business_development_prospects')).rows,
    ).toEqual([{ n: 2 }]);
    await expect(
      db.query(
        `INSERT INTO business_development_prospect_contacts(tenant_id,prospect_id,request_id,create_hash,name,created_by_user_id,updated_by_user_id)
      VALUES($1,$2,gen_random_uuid(),repeat('a',64),'wrong tenant',$3,$3)`,
        [tenantA, prospectB, actor],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
  test('persists create, recovers identical retry and rejects changed replay without duplicate', async () => {
    const first = await service.create(ctx, prospectA, input);
    const replay = await service.create(ctx, prospectA, input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      prospectId: prospectA,
      name: 'Priya Nair',
      version: 1,
      requestId,
    });
    expect((await service.list(ctx, prospectA)).contacts).toEqual([first]);
    await expect(
      service.create(ctx, prospectA, { ...input, name: 'Changed retry' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await db.query('SELECT count(*)::int AS n FROM business_development_prospect_contacts'))
        .rows,
    ).toEqual([{ n: 1 }]);
  });
  test('cross-tenant prospect IDs and contact IDs fail404 even with owner DB connection', async () => {
    const contact = (await service.list(ctx, prospectA)).contacts[0];
    if (!contact) throw new Error('Expected the persisted contact fixture.');
    await expect(service.list(ctx, prospectB)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.create(ctx, prospectB, { ...input, requestId: prospectB }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.update({ ...ctx, tenantId: tenantB }, prospectB, contact.id, {
        ...input,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.remove({ ...ctx, tenantId: tenantB }, prospectB, contact.id, 1),
    ).rejects.toMatchObject({ status: 404 });
  });
  test('real update uses CAS, preserves winner on stale write and soft-removes explicitly', async () => {
    const contact = (await service.list(ctx, prospectA)).contacts[0];
    if (!contact) throw new Error('Expected the persisted contact fixture.');
    const updated = await service.update(ctx, prospectA, contact.id, {
      ...input,
      title: 'Updated title',
      email: null,
      expectedVersion: 1,
    });
    expect(updated).toMatchObject({
      id: contact.id,
      title: 'Updated title',
      email: null,
      version: 2,
    });
    await expect(
      service.update(ctx, prospectA, contact.id, {
        ...input,
        title: 'Stale overwrite',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(service.remove(ctx, prospectA, contact.id, 1)).rejects.toMatchObject({
      status: 409,
    });
    expect((await service.list(ctx, prospectA)).contacts[0]).toEqual(updated);
    expect(await service.remove(ctx, prospectA, contact.id, 2)).toEqual({
      id: contact.id,
      prospectId: prospectA,
      removed: true,
      version: 3,
    });
    expect((await service.list(ctx, prospectA)).contacts).toEqual([]);
    expect(
      (
        await db.query(
          'SELECT version,removed_at IS NOT NULL AS removed FROM business_development_prospect_contacts WHERE id=$1',
          [contact.id],
        )
      ).rows,
    ).toEqual([{ version: 3, removed: true }]);
    await expect(service.create(ctx, prospectA, input)).rejects.toMatchObject({ status: 409 });
  });
  test('dismissed and converted prospects stay readable but reject every write', async () => {
    for (const lifecycle of [
      "status='dismissed'",
      `status='active',linked_client_id='${prospectB}',converted_at=now()`,
    ]) {
      await db.exec(
        `UPDATE business_development_prospects SET ${lifecycle} WHERE id='${prospectA}'`,
      );
      expect((await service.list(ctx, prospectA)).readOnly).toBe(true);
      await expect(
        service.create(ctx, prospectA, { ...input, requestId: prospectA }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.update(ctx, prospectA, requestId, { ...input, expectedVersion: 1 }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(service.remove(ctx, prospectA, requestId, 1)).rejects.toMatchObject({
        status: 409,
      });
    }
    await db.query(
      "UPDATE business_development_prospects SET status='active',linked_client_id=null,converted_at=null WHERE id=$1",
      [prospectA],
    );
  });
  test('pagination covers all51 rows once with stable ID keyset', async () => {
    await db.query(
      `INSERT INTO business_development_prospect_contacts(tenant_id,prospect_id,request_id,create_hash,name,created_by_user_id,updated_by_user_id)
      SELECT $1::uuid,$2::uuid,gen_random_uuid(),repeat('b',64),'Contact '||n,$3::uuid,$3::uuid FROM generate_series(1,51) n`,
      [tenantA, prospectA, actor],
    );
    const first = await service.list(ctx, prospectA);
    expect(first.contacts).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(ctx, prospectA, first.nextCursor!);
    expect(second.contacts).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.contacts, ...second.contacts].map((contact) => contact.id)).size).toBe(
      51,
    );
  });
  test('database RLS denies another tenant direct reads and inserts as application role', async () => {
    await db.exec(
      `SET ROLE capiro_app; SELECT set_config('app.current_tenant','${tenantB}',false);`,
    );
    expect((await db.query('SELECT id FROM business_development_prospect_contacts')).rows).toEqual(
      [],
    );
    await expect(
      db.query(
        `INSERT INTO business_development_prospect_contacts(tenant_id,prospect_id,request_id,create_hash,name,created_by_user_id,updated_by_user_id)
      VALUES($1,$2,gen_random_uuid(),repeat('c',64),'denied',$3,$3)`,
        [tenantA, prospectA, actor],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  test('service role floor fails closed for missing identity, unknown and viewer roles', async () => {
    for (const changed of [{ userId: '' }, { role: 'unknown' }, { role: 'client_portal_user' }])
      await expect(
        service.list({ ...ctx, ...changed } as TenantContext, prospectA),
      ).rejects.toMatchObject({ status: 403 });
  });
  test('untrusted contact text remains a bound value and cannot execute SQL', async () => {
    const name = "Robert'); DROP TABLE tenants; --";
    const saved = await service.create(ctx, prospectA, { ...input, name, requestId: prospectB });
    expect(saved.name).toBe(name);
    expect((await db.query('SELECT count(*)::int AS n FROM tenants')).rows).toEqual([{ n: 2 }]);
  });
});

describe('actual Nest validation and canonical RolesGuard', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const validate = (body: unknown, metatype: Type<unknown>) =>
    pipe.transform(body, { type: 'body', metatype });
  test('validates fields and versions without implicit coercion; normalizes empty optional text', async () => {
    await expect(
      validate({ ...input, name: '  Name  ', title: ' ' }, CreateProspectContactDto),
    ).resolves.toMatchObject({ name: 'Name', title: null });
    for (const bad of [
      { ...input, name: ' ' },
      { ...input, email: 'invalid' },
      { ...input, notes: 'x'.repeat(4001) },
      { ...input, requestId: 'bad' },
      { ...input, tenantId: tenantB },
    ])
      await expect(validate(bad, CreateProspectContactDto)).rejects.toMatchObject({ status: 400 });
    const update = {
      name: input.name,
      title: input.title,
      email: input.email,
      phone: null,
      notes: input.notes,
    };
    await expect(
      validate({ ...update, expectedVersion: 1 }, UpdateProspectContactDto),
    ).resolves.toHaveProperty('expectedVersion', 1);
    for (const expectedVersion of [0, -1, 1.5, '1'])
      await expect(
        validate({ ...update, expectedVersion }, UpdateProspectContactDto),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      validate({ expectedVersion: 1 }, RemoveProspectContactDto),
    ).resolves.toHaveProperty('expectedVersion', 1);
    await expect(
      pipe.transform(
        { prospectId: prospectA, contactId: 'bad' },
        { type: 'param', metatype: ProspectContactIdParams },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  test('every controller route uses the standard-user role floor and BD feature guard', () => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);
    for (const name of ['list', 'create', 'update', 'remove'] as const) {
      const context = (tenantContext?: TenantContext) =>
        ({
          getHandler: () => ProspectContactsController.prototype[name],
          getClass: () => ProspectContactsController,
          switchToHttp: () => ({ getRequest: () => ({ tenantContext }) }),
        }) as unknown as ExecutionContext;
      expect(guard.canActivate(context(ctx))).toBe(true);
      expect(() => guard.canActivate(context())).toThrow();
      expect(() => guard.canActivate(context({ ...ctx, role: 'client_portal_user' }))).toThrow();
      expect(guard.canActivate(context({ ...ctx, role: 'user_admin' }))).toBe(true);
      expect(guard.canActivate(context({ ...ctx, role: 'capiro_admin' }))).toBe(true);
      expect(() =>
        guard.canActivate(context({ ...ctx, role: 'unknown' } as unknown as TenantContext)),
      ).toThrow();
      const guards = Reflect.getMetadata('__guards__', ProspectContactsController) as Function[];
      expect(guards.map((item) => item.name)).toEqual([
        'RolesGuard',
        'BusinessDevelopmentFlagGuard',
      ]);
    }
  });
});
