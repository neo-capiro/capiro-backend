import 'reflect-metadata';
import { Global, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClientTargetsController } from './client-targets.controller.js';
import { ClientTargetsService } from './client-targets.service.js';
import { DirectoryService } from '../directory/directory.service.js';
import { RepresentationResolverService } from './representation-resolver.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClerkService } from '../auth/clerk.service.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';

const T = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333', TARGET = '44444444-4444-4444-8444-444444444444';
const O = '55555555-5555-4555-8555-555555555555', R = '66666666-6666-4666-8666-666666666666';
const route = '/api/clients/:clientId/targets/:targetId/objective-destination';
const query = { clientId: C, objectiveId: O, objectiveVersion: '3' };

/** Actual existing controller/service, native tenant middleware/private provenance and RolesGuard.
 * DB and Clerk IO ports only are inert. Core registration is separately source-pinned;
 * this narrow owner HTTP fixture does not boot the whole ClientsModule/Core graph. */
async function fixture(role = 'standard_user') {
  const user = { id: U, clerkUserId: 'user_native' };
  const tenant = { id: T, slug: 'tenant', status: 'active', clerkOrgId: 'org_native' };
  const membership = { id: 'native_membership', tenantId: T, userId: U, status: 'active', role, tenant, updatedAt: new Date(2) };
  const session = { id: 'native_session', userId: user.clerkUserId, status: 'active', createdAt: 1,
    expireAt: Date.now() + 100000, abandonAt: Date.now() + 90000, expiresAtMs: Date.now() + 60000, actor: null };
  const authTx = {
    user: { findUnique: async () => user, findFirst: async ({ where }: any) => where.id === user.id && where.clerkUserId === user.clerkUserId ? user : null, update: async () => user },
    tenantMembership: { findMany: async () => [membership], findFirst: async () => membership },
    impersonationSession: { findFirst: async () => null },
  };
  const sql: string[] = [];
  const prisma = {
    withSystem: async (fn: any) => fn(authTx),
    withTenantUser: async (tenantId: string, userId: string, fn: any) => {
      expect([tenantId, userId]).toEqual([T, U]);
      return fn({ $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?'); sql.push(text);
        if (text.includes('FROM tenants')) return membership.status === 'active' && user.clerkUserId === values[2] && tenant.status === 'active'
          ? [{ userId: U, memoryWall: false }] : [];
        if (text.includes('FROM client_objectives')) return [{ version: 3 }];
        if (text.includes('FROM client_objective_revisions')) return [{ id: R }];
        if (text.includes('FROM client_targets')) return values[2] === TARGET
          ? [{ id: TARGET, clientId: C, sourceDirectory: 'staff', memberId: 'staff-123' }] : [];
        throw new Error('Unexpected SQL in native owner HTTP fixture');
      } });
    },
  };
  const clerk = {
    verifySessionToken: async () => ({ sub: user.clerkUserId, sid: session.id, iss: 'issuer', exp: Math.floor(Date.now() / 1000) + 100,
      capiro_tenant_id: tenant.id, capiro_tenant_slug: tenant.slug, org_id: tenant.clerkOrgId }),
    assertActiveApplicationAuthoritySession: async () => session,
  };
  const external = {
    getAllContacts: () => { throw new Error('Saved target must not access Directory/provider enrichment'); },
    getStaffDetail: () => { throw new Error('Saved target must not access Directory/provider enrichment'); },
  };
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }, { provide: ClerkService, useValue: clerk }], exports: [PrismaService, ClerkService] })
  class InertIoPorts {}
  @Module({ controllers: [ClientTargetsController], providers: [ClientTargetsService,
    { provide: DirectoryService, useValue: external }, { provide: RepresentationResolverService, useValue: external }] })
  class ExistingTargetOwnerFixture {}
  const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), InertIoPorts, TenantModule, ExistingTargetOwnerFixture] }).compile();
  const app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  await app.init();
  const middleware = new TenantContextMiddleware(clerk as any, prisma as any, module.get(TenantContextStore));
  async function invoke(q: Record<string, unknown> = query, pathClient = C, pathTarget = TARGET, bearer = true, beforeRoute = () => {}) {
    const url = `/api/clients/${pathClient}/targets/${pathTarget}/objective-destination`;
    const headers = bearer ? { authorization: 'Bearer synthetic' } : {};
    const req: any = { method: 'GET', path: url, originalUrl: url, url, headers, query: q,
      params: { clientId: pathClient, targetId: pathTarget }, hostname: 'localhost', header: (key: string) => (headers as Record<string, string>)[key] };
    const res: any = { statusCode: 200, headersSent: false, headers: {}, body: undefined,
      setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; return this; },
      set(key: string, value: string) { return this.setHeader(key, value); }, getHeader(key: string) { return this.headers[key.toLowerCase()]; },
      status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { return this.send(value); },
      send(value: unknown) { this.body = value; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
    try { await middleware.use(req, res, () => {}); }
    catch (error) { res.status((error as any).getStatus()).json((error as any).getResponse()); return res; }
    beforeRoute();
    const layer = app.getHttpAdapter().getInstance()._router.stack.find((entry: any) => entry.route?.path === route && entry.route.methods.get);
    expect(layer).toBeDefined(); await layer.route.stack[0].handle(req, res, () => {}); return res;
  }
  return { app, invoke, sql, membership, user };
}

describe('Directory Objective existing owner registration and native synthetic HTTP', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  afterEach(async () => { if (f) await f.app.close(); });

  it('retains actual Core/ClientsModule registration of this existing controller and provider', () => {
    const clients = readFileSync(resolve(__dirname, 'clients.module.ts'), 'utf8');
    const app = readFileSync(resolve(__dirname, '../app.module.ts'), 'utf8');
    expect(clients).toMatch(/controllers:\s*\[[\s\S]*?\bClientTargetsController\b/);
    expect(clients).toMatch(/providers:\s*\[[\s\S]*?\bClientTargetsService\b/);
    expect(app).toMatch(/imports:\s*\[[\s\S]*?\bClientsModule\b/);
  });

  it('registers the real owner route with ordinary login/context/guard, strict query and no-store receipt', async () => {
    f = await fixture(); const result = await f.invoke();
    expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({ destination: { kind: 'directory_target', resourceId: TARGET, clientId: C, objectiveId: O, objectiveVersion: 3, objectiveRevisionId: R },
      target: { id: TARGET, clientId: C, sourceDirectory: 'staff', memberId: 'staff-123' } });
    expect(f.sql[0]).toContain('FOR SHARE OF t,m,u,c'); expect(f.sql.at(-1)).toContain('FROM client_targets');
  });

  it.each([{ ...query, actor: U }, { ...query, objectiveRevisionId: R }, { ...query, clientId: [C] },
    { ...query, objectiveVersion: ['3', '4'] }, { ...query, objectiveVersion: '0' }, { clientId: C, objectiveId: O }])(
    'rejects unsupported, repeated or missing query fields %p before business SQL', async (q) => {
      f = await fixture(); expect((await f.invoke(q)).statusCode).toBe(400); expect(f.sql).toEqual([]);
    },
  );

  it.each([['not-uuid', TARGET], [C, 'member-123'], ['77777777-7777-4777-8777-777777777777', TARGET]])(
    'refuses malformed/mismatched path %s/%s before business SQL', async (clientId, targetId) => {
      f = await fixture(); expect((await f.invoke(query, clientId, targetId)).statusCode).toBe(400); expect(f.sql).toEqual([]);
    },
  );

  it('preserves ordinary bearer and role refusals without new reader/login rules', async () => {
    f = await fixture('client_portal_user');
    expect((await f.invoke(query, C, TARGET, false)).statusCode).toBe(401);
    expect((await f.invoke()).statusCode).toBe(403); expect(f.sql).toEqual([]);
  });

  it('rechecks actual current membership after native login before issuing a bound receipt', async () => {
    f = await fixture();
    expect((await f.invoke(query, C, TARGET, true, () => { f.membership.status = 'removed'; })).statusCode).toBe(404);
    expect(f.sql).toHaveLength(1);
  });
});
