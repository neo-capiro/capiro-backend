import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import request from 'supertest';
import { ApplicationAuthorityModule } from './application-authority.module.js';
import { ClerkService } from './clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { loadOwnedActiveClioConversation } from '../context/application-authority-resource.helpers.js';

/** Optional, explicit local fixture. No production URL or environment fallback.
 * The file contains {"url":"postgresql://...@127.0.0.1:PORT/TEST_DATABASE"}.
 * An absent fixture SKIPS this real-PostgreSQL gate; it never substitutes mocks. */
const LOCAL_POSTGRES_CONFIG = '/tmp/capiro-p6-postgres.json';
function localPostgresUrl(): string | null {
  if (!existsSync(LOCAL_POSTGRES_CONFIG)) return null;
  let value: unknown;
  try { value = JSON.parse(readFileSync(LOCAL_POSTGRES_CONFIG, 'utf8')); }
  catch { throw new Error('Invalid local P6 PostgreSQL fixture configuration'); }
  if (!value || typeof value !== 'object' || typeof (value as { url?: unknown }).url !== 'string') {
    throw new Error('Local P6 PostgreSQL fixture must contain a URL');
  }
  let parsed: URL;
  try { parsed = new URL((value as { url: string }).url); }
  catch { throw new Error('Invalid local P6 PostgreSQL fixture URL'); }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1' ||
      !parsed.pathname || parsed.pathname === '/') {
    throw new Error('P6 PostgreSQL fixture must use an explicit 127.0.0.1 test database');
  }
  // Prisma supports a host query parameter for Unix sockets. It must not
  // replace the validated TCP host, nor can a schema supplied by the file win.
  if (parsed.searchParams.has('host')) throw new Error('P6 PostgreSQL fixture cannot override the loopback host');
  parsed.searchParams.delete('schema');
  return parsed.toString();
}
const configuredUrl = localPostgresUrl();
const describePostgres = configuredUrl ? describe : describe.skip;

const tenantId = '10000000-0000-4000-8000-000000000001';
const actorId = '10000000-0000-4000-8000-000000000002';
const membershipId = '10000000-0000-4000-8000-000000000003';
const clientId = '10000000-0000-4000-8000-000000000004';
const conversationId = '10000000-0000-4000-8000-000000000005';
const clientGrantId = '10000000-0000-4000-8000-000000000006';
const portfolioId = '10000000-0000-4000-8000-000000000007';
const portfolioGrantId = '10000000-0000-4000-8000-000000000008';
const portfolioConversationId = '10000000-0000-4000-8000-000000000009';
const clerkUserId = 'user_p6_local_postgres';
const context: TenantContext = { tenantId, tenantSlug: 'p6-local', userId: actorId, clerkUserId, role: 'standard_user' };
const currentInput = { conversationId, clientId };

/** Use the installed Prisma engine to derive the exact current columns,
 * enum names/defaults and constraints. Execute only this leaf's tables in an
 * isolated random schema: no migration files or application schema are changed. */
function fixtureStatements(): string[] {
  const apiRoot = resolve(__dirname, '../..');
  const sql = execFileSync(resolve(apiRoot, 'node_modules/.bin/prisma'), [
    'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script',
  ], { cwd: apiRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const tables = new Set(['tenants', 'users', 'tenant_memberships', 'clients', 'client_memory_access',
    'clio_conversations', 'research_portfolios', 'research_portfolio_grants', 'research_portfolio_client_links']);
  const enumNames = new Set(Prisma.dmmf.datamodel.models
    .filter((model) => tables.has(model.dbName ?? model.name))
    .flatMap((model) => model.fields.filter((field) => field.kind === 'enum').map((field) => field.type)));
  const enums = new Set(Prisma.dmmf.datamodel.enums
    .filter((entry) => enumNames.has(entry.name)).map((entry) => entry.dbName ?? entry.name));
  const statements = sql.split(/;\s*(?:\n|$)/).map((statement) => statement.trim()).filter((statement) => {
    const table = statement.match(/CREATE TABLE "([^"]+)"/);
    if (table) return tables.has(table[1]!);
    const enumeration = statement.match(/CREATE TYPE "([^"]+)"/);
    if (enumeration) return enums.has(enumeration[1]!);
    const index = statement.match(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([^"]+)"/);
    if (index) return tables.has(index[1]!);
    const foreignKey = statement.match(/ALTER TABLE "([^"]+)" ADD CONSTRAINT[^;]+REFERENCES "([^"]+)"/);
    return Boolean(foreignKey && tables.has(foreignKey[1]!) && tables.has(foreignKey[2]!));
  });
  const created = statements.filter((statement) => /CREATE TABLE /.test(statement));
  if (created.length !== tables.size) throw new Error('Incomplete P6 PostgreSQL fixture schema');
  return statements;
}

describePostgres('current authority on real local PostgreSQL (requires /tmp/capiro-p6-postgres.json)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let app: INestApplication;
  const schema = `p6_current_${randomBytes(8).toString('hex')}`;
  const queries: string[] = [];
  const scopeFacts = { kind: 'research_portfolio', researchPortfolioId: portfolioId,
    researchPortfolioName: 'Local PostgreSQL portfolio', researchPortfolioRevision: 1 };
  const scope = { ...scopeFacts, scopeVersion: createHash('sha256').update(JSON.stringify(scopeFacts)).digest('hex') };
  const session = { id: 'sess_p6_local_postgres', userId: clerkUserId, status: 'active', createdAt: 1,
    expireAt: Date.now() + 600_000, abandonAt: Date.now() + 600_000, expiresAtMs: Date.now() + 300_000, actor: null };
  const online = jest.fn(async () => session);

  beforeAll(async () => {
    if (!configuredUrl) throw new Error('P6 PostgreSQL fixture was not configured');
    admin = new PrismaClient({ datasourceUrl: configuredUrl });
    await admin.$connect();
    await admin.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public');
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const statements = fixtureStatements();
    await admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    }, { timeout: 30_000 });
    const scopedUrl = new URL(configuredUrl);
    scopedUrl.searchParams.set('schema', schema);
    prisma = new PrismaService({ datasourceUrl: scopedUrl.toString(), log: [{ emit: 'event', level: 'query' }] });
    // Passive driver events only: no Prisma method, transaction or delegate is replaced.
    (prisma as unknown as { $on(event: 'query', callback: (event: Prisma.QueryEvent) => void): void })
      .$on('query', (event) => queries.push(event.query));
    await prisma.$connect();
    await prisma.tenant.create({ data: { id: tenantId, slug: context.tenantSlug, name: 'Local P6 test',
      status: 'active', clerkOrgId: 'org_p6_local_postgres' } });
    await prisma.user.create({ data: { id: actorId, clerkUserId, email: 'p6-postgres@example.invalid' } });
    await prisma.tenantMembership.create({ data: { id: membershipId, tenantId, userId: actorId,
      role: 'standard_user', status: 'active' } });
    await prisma.client.create({ data: { id: clientId, tenantId, name: 'Local walled client', memoryWall: true } });
    await prisma.clientMemoryAccess.create({ data: { id: clientGrantId, tenantId, clientId, userId: actorId } });
    await prisma.clioConversation.create({ data: { id: conversationId, tenantId, userId: actorId, clientId,
      title: 'Local client authority' } });
    await prisma.researchPortfolio.create({ data: { id: portfolioId, tenantId, ownerUserId: actorId,
      name: scopeFacts.researchPortfolioName } });
    await prisma.researchPortfolioGrant.create({ data: { id: portfolioGrantId, tenantId, portfolioId,
      principalUserId: actorId, role: 'viewer', grantedByUserId: actorId } });
    await prisma.clioConversation.create({ data: { id: portfolioConversationId, tenantId, userId: actorId,
      clientId: null, title: 'Local research portfolio authority', metadata: { researchPortfolioScope: scope } } });
    const clerk = {
      verifySessionToken: async () => ({ sub: clerkUserId, sid: session.id, iss: 'https://clerk.app.capiro.ai',
        exp: Math.floor(Date.now() / 1000) + 300, capiro_tenant_id: tenantId,
        capiro_tenant_slug: context.tenantSlug, org_id: 'org_p6_local_postgres' }),
      assertActiveApplicationAuthoritySession: online,
    };
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ApplicationAuthorityModule],
    }).overrideProvider(PrismaService).useValue(prisma).overrideProvider(ClerkService).useValue(clerk).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    const middleware = module.get(TenantContextMiddleware);
    app.use((req: any, res: any, next: (error?: unknown) => void) => {
      void middleware.use(req, res, next).catch(next);
    });
    await app.init();
  }, 60_000);

  beforeEach(async () => {
    await prisma.tenantMembership.update({ where: { id: membershipId }, data: { status: 'active' } });
    await prisma.clientMemoryAccess.upsert({ where: { id: clientGrantId }, update: {},
      create: { id: clientGrantId, tenantId, clientId, userId: actorId } });
    await prisma.researchPortfolioGrant.upsert({ where: { id: portfolioGrantId }, update: {},
      create: { id: portfolioGrantId, tenantId, portfolioId, principalUserId: actorId, role: 'viewer', grantedByUserId: actorId } });
    queries.length = 0;
    online.mockReset();
    online.mockImplementation(async () => session);
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    if (admin) {
      try { await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.$disconnect(); }
    }
  });

  function post(path: string, body: object) {
    return request(app.getHttpServer()).post(`/api/clio/application-authority/${path}`)
      .set('Authorization', 'Bearer synthetic-local-fixture').send(body);
  }

  function assertReadOnlySnapshot(terminal: 'COMMIT' | 'ROLLBACK' = 'COMMIT') {
    const readOnlyIndex = queries.findIndex((sql) => /^SET TRANSACTION READ ONLY$/i.test(sql.trim()));
    expect(readOnlyIndex).toBeGreaterThan(0);
    expect(queries.filter((sql) => /^SET TRANSACTION READ ONLY$/i.test(sql.trim()))).toHaveLength(1);
    const start = queries.slice(0, readOnlyIndex).map((sql) => sql.trim().toUpperCase()).lastIndexOf('BEGIN');
    const end = queries.findIndex((sql, index) => index > readOnlyIndex && sql.trim().toUpperCase() === terminal);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(readOnlyIndex);
    const snapshot = queries.slice(start, end + 1);
    expect(snapshot).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    // Prisma's BEGIN and isolation setup precede the interactive callback.
    // READ ONLY must be that callback's first statement, before its GUC/read.
    expect(snapshot.filter((sql) => !/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION ISOLATION LEVEL)/i.test(sql.trim()))[0])
      .toBe('SET TRANSACTION READ ONLY');
    expect(queries[readOnlyIndex + 1]).toContain("set_config('app.bypass_rls', 'on', true)");
    expect(snapshot.some((sql) => /\bFOR SHARE\b|\b(?:INSERT|UPDATE|DELETE)\s/i.test(sql))).toBe(false);
    expect(snapshot.filter((sql) => /^BEGIN$/i.test(sql.trim()))).toHaveLength(1);
  }

  it('serves current200 over HTTP with exactly the three original route revisions', async () => {
    const identity = await post('identity', {}).expect(200);
    const membership = await post('membership', {}).expect(200);
    const contextReceipt = await post('context', { ...currentInput, identitySha256: 'a'.repeat(64) }).expect(200);
    queries.length = 0; online.mockClear();
    const current = await post('current', currentInput).expect(200);
    expect(current.body).toMatchObject({ principal: identity.body.principal, identityRevision: identity.body.identityRevision,
      membershipRevision: membership.body.membershipRevision, permissions: membership.body.permissions,
      clientIds: membership.body.clientIds, role: membership.body.role, contextRevision: contextReceipt.body.contextRevision,
      conversationId, selectedClientId: clientId });
    expect(current.headers['cache-control']).toBe('no-store');
    expect(online).toHaveBeenCalledTimes(1);
    assertReadOnlySnapshot();
  });

  it('observes a real ethical-wall grant deletion on the next current HTTP check', async () => {
    await post('current', currentInput).expect(200);
    await prisma.clientMemoryAccess.delete({ where: { id: clientGrantId } });
    const response = await post('current', currentInput).expect(403);
    expect(response.body.message).toBe('Application authority unavailable');
  });

  it('authorizes the clientless RP through the real helper on a repeatable-read READ ONLY transaction without locks', async () => {
    const result = await prisma.withSystem(async (tx) => {
      const state = await tx.$queryRaw<Array<{ isolation: string; readOnly: string }>>`
        SELECT current_setting('transaction_isolation') AS isolation,
               current_setting('transaction_read_only') AS "readOnly"`;
      const conversation = await loadOwnedActiveClioConversation(prisma, context, portfolioConversationId, tx);
      return { state, conversation };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, readOnly: true });
    expect(result.state).toEqual([{ isolation: 'repeatable read', readOnly: 'on' }]);
    expect(result.conversation).toMatchObject({ id: portfolioConversationId, clientId: null,
      metadata: { researchPortfolioScope: scope } });
    assertReadOnlySnapshot();
    // A PostgreSQL 25006 error would reject the operation above; success here
    // proves that no forbidden row-lock statement was hidden by a fake driver.
  });

  it('keeps all three real row locks for the unchanged legacy RP helper call', async () => {
    const conversation = await loadOwnedActiveClioConversation(prisma, context, portfolioConversationId);
    expect(conversation.id).toBe(portfolioConversationId);
    const locks = queries.filter((sql) => /\bFOR SHARE\b/i.test(sql));
    expect(locks).toHaveLength(3);
    expect(locks[0]).toContain('FROM tenant_memberships');
    expect(locks[1]).toContain('FROM research_portfolios');
    expect(locks[2]).toContain('FROM research_portfolio_grants');
    expect(queries.some((sql) => /^SET TRANSACTION READ ONLY$/i.test(sql.trim()))).toBe(false);
  });

  it.each(['grant', 'membership'])('still refuses a revoked RP %s inside the real read-only snapshot', async (kind) => {
    if (kind === 'grant') await prisma.researchPortfolioGrant.delete({ where: { id: portfolioGrantId } });
    else await prisma.tenantMembership.update({ where: { id: membershipId }, data: { status: 'removed' } });
    queries.length = 0;
    await expect(prisma.withSystem((tx) => loadOwnedActiveClioConversation(prisma, context, portfolioConversationId, tx),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, readOnly: true }))
      .rejects.toMatchObject({ status: kind === 'grant' ? 404 : 403 });
    expect(queries.some((sql) => /\bFOR SHARE\b/i.test(sql))).toBe(false);
  });

  it('refuses a genuinely clientless RP current request as403 just as context, using a real read-only snapshot', async () => {
    const input = { conversationId: portfolioConversationId, clientId };
    const response = await post('current', input).expect(403);
    expect(response.body.message).toBe('Application authority unavailable');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(online).toHaveBeenCalledTimes(1);
    assertReadOnlySnapshot('ROLLBACK');
    expect(queries.some((sql) => /\bFOR SHARE\b/i.test(sql))).toBe(false);
    const oldContext = await post('context', { ...input, identitySha256: 'a'.repeat(64) }).expect(403);
    expect(oldContext.body.message).toBe(response.body.message);
  });

  it.each(['grant', 'membership'])('refuses revoked RP %s through the real current HTTP path as403', async (kind) => {
    if (kind === 'grant') await prisma.researchPortfolioGrant.delete({ where: { id: portfolioGrantId } });
    else {
      // Revoke after middleware authentication but before current's snapshot:
      // the fake Clerk observation is the only substituted external boundary.
      online.mockImplementationOnce(async () => {
        await prisma.tenantMembership.update({ where: { id: membershipId }, data: { status: 'removed' } });
        return session;
      });
    }
    const response = await post('current', { conversationId: portfolioConversationId, clientId }).expect(403);
    expect(response.body.message).toBe('Application authority unavailable');
    expect(queries.some((sql) => /\bFOR SHARE\b/i.test(sql))).toBe(false);
  });

  it('refuses null client selectors as400 on current and context even for an authorized RP', async () => {
    await post('current', { conversationId: portfolioConversationId, clientId: null }).expect(400);
    await post('current', { conversationId, clientId: null }).expect(400);
    await post('context', { conversationId: portfolioConversationId, clientId: null, identitySha256: 'a'.repeat(64) }).expect(400);
    expect(online).not.toHaveBeenCalled();
    expect(queries.some((sql) => /^SET TRANSACTION READ ONLY$/i.test(sql.trim()))).toBe(false);
  });
});
