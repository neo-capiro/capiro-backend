// Native first-chat transaction qualification. Nothing runs without --run and
// an exact task-owned PostgreSQL data-directory match. Use Node 24 + tsx.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const taskRoot = path.dirname(repo);
const apiRequire = createRequire(path.join(repo, 'apps/api/package.json'));
const databaseName = 'capiro_bootstrap_native_qual';
const port = '55417';

if (process.argv.length !== 3 || process.argv[2] !== '--run') {
  console.log('Usage: CORE_BOOTSTRAP_NATIVE_DATABASE_URL=<isolated loopback URL> CORE_BOOTSTRAP_NATIVE_DATA_DIR=<task-owned directory> node <tsx CLI> qualify.mjs --run');
  process.exit(process.argv.includes('--help') ? 0 : 2);
}

const rawUrl = process.env.CORE_BOOTSTRAP_NATIVE_DATABASE_URL;
const rawDataDir = process.env.CORE_BOOTSTRAP_NATIVE_DATA_DIR;
if (!rawUrl || !rawDataDir) throw new Error('Both isolated-target environment variables are required');
const parsed = new URL(rawUrl);
if (
  parsed.protocol !== 'postgresql:' ||
  parsed.hostname !== '127.0.0.1' ||
  parsed.port !== port ||
  parsed.pathname !== `/${databaseName}` ||
  parsed.username !== 'postgres' ||
  !parsed.password ||
  [...parsed.searchParams.keys()].some((key) => key !== 'sslmode') ||
  (parsed.searchParams.has('sslmode') && parsed.searchParams.get('sslmode') !== 'disable')
) {
  throw new Error('Target must be SCRAM-authenticated local 127.0.0.1:55417/capiro_bootstrap_native_qual');
}

function realLower(input) {
  return realpathSync.native(input).toLowerCase();
}
const allowedRoot = realLower(taskRoot);
const expectedDataDir = realLower(rawDataDir);
if (!expectedDataDir.startsWith(`${allowedRoot}${path.sep}`)) {
  throw new Error('The expected data directory must be inside this task workspace');
}

const { Client } = apiRequire('pg');
const admin = new Client({ connectionString: rawUrl, connectionTimeoutMillis: 3000 });
let prisma;
let checks = 0;

async function check(label, operation) {
  await operation();
  checks += 1;
  console.log(`PASS ${label}`);
}

async function expectStatus(promise, status) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.getStatus?.(), status, `expected HTTP ${status}, got ${String(error)}`);
    return;
  }
  assert.fail(`expected HTTP ${status}`);
}

async function count(sql, values = []) {
  const result = await admin.query(sql, values);
  return Number(result.rows[0].count);
}

async function bootstrapSchema() {
  const role = await admin.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') AS exists");
  assert.equal(role.rows[0].exists, false, 'this isolated cluster must have no application role');
  const existing = await admin.query(
    "SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')",
  );
  assert.equal(existing.rows[0].count, 0, 'qualification database must be empty before setup');
  const predecessor = readFileSync(path.join(here, 'predecessor.sql'), 'utf8');
  const actualMigration = readFileSync(
    path.join(repo, 'apps/api/prisma/migrations/20281016020000_clio_conversation_bootstrap_receipts/migration.sql'),
    'utf8',
  );
  await admin.query('BEGIN');
  try {
    await admin.query(predecessor);
    await admin.query(actualMigration);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

async function seed() {
  const ids = Object.fromEntries(
    ['tenant', 'otherTenant', 'actor', 'otherActor', 'client', 'otherClient', 'foreignClient'].map((key) => [key, randomUUID()]),
  );
  await admin.query(
    'INSERT INTO tenants(id,slug,name) VALUES ($1,$2,$3),($4,$5,$6)',
    [ids.tenant, 'qualification-tenant', 'Qualification Tenant', ids.otherTenant, 'qualification-other', 'Other Tenant'],
  );
  await admin.query(
    'INSERT INTO users(id,clerk_user_id,email) VALUES ($1,$2,$3),($4,$5,$6)',
    [ids.actor, 'qual-actor', 'actor@example.test', ids.otherActor, 'qual-other-actor', 'other@example.test'],
  );
  await admin.query(
    'INSERT INTO clients(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9)',
    [ids.client, ids.tenant, 'Visible', ids.otherClient, ids.tenant, 'Other Visible', ids.foreignClient, ids.otherTenant, 'Foreign'],
  );
  return ids;
}

function serviceWith(prismaSource, MeriService) {
  // The operation uses only prisma; all its SQL still flows through the real
  // PrismaService. This bypasses unrelated AI / tool constructor dependencies.
  return Object.assign(Object.create(MeriService.prototype), { prisma: prismaSource });
}

async function runChecks(MeriService, ids) {
  const ctx = (tenantId = ids.tenant, userId = ids.actor) => ({ tenantId, userId });
  const input = (requestId = randomUUID(), clientId = ids.client) => ({ schemaVersion: 1, requestId, clientId });
  const service = serviceWith(prisma, MeriService);

  await check('create, canonical receipt, and exact replay', async () => {
    const request = input();
    const first = await service.bootstrapConversation(ctx(), request);
    assert.deepEqual(first, {
      schemaVersion: 1,
      requestId: request.requestId,
      conversationId: first.conversationId,
      tenantId: ids.tenant,
      actorId: ids.actor,
      clientId: ids.client,
    });
    assert.equal(await count('SELECT count(*) FROM clio_conversation_bootstrap_receipts WHERE request_id=$1', [request.requestId]), 1);
    assert.deepEqual(await service.bootstrapConversation(ctx(), request), first);
    await expectStatus(service.bootstrapConversation(ctx(), { ...request, clientId: ids.otherClient }), 409);
  });

  await check('native parallel same-key replay leaves one conversation', async () => {
    const request = input();
    const before = await count('SELECT count(*) FROM clio_conversations');
    const results = await Promise.all(Array.from({ length: 3 }, () => service.bootstrapConversation(ctx(), request)));
    assert.equal(new Set(results.map((receipt) => receipt.conversationId)).size, 1);
    assert.equal(await count('SELECT count(*) FROM clio_conversations') - before, 1);
    assert.equal(await count('SELECT count(*) FROM clio_conversation_bootstrap_receipts WHERE request_id=$1', [request.requestId]), 1);
  });

  await check('committed competing winner rolls back a losing conversation', async () => {
    const request = input();
    const winnerId = randomUUID();
    const before = await count('SELECT count(*) FROM clio_conversations');
    let firstReadReturned = false;
    const interleaved = {
      withTenant: async (...args) => {
        const result = await prisma.withTenant(...args);
        if (!firstReadReturned) {
          firstReadReturned = true;
          assert.equal(result, null);
          await admin.query(
            'INSERT INTO clio_conversations(id,tenant_id,user_id,client_id,title) VALUES ($1,$2,$3,$4,$5)',
            [winnerId, ids.tenant, ids.actor, ids.client, 'Committed rival'],
          );
          await admin.query(
            'INSERT INTO clio_conversation_bootstrap_receipts(tenant_id,actor_user_id,request_id,client_id,conversation_id) VALUES ($1,$2,$3,$4,$5)',
            [ids.tenant, ids.actor, request.requestId, ids.client, winnerId],
          );
        }
        return result;
      },
    };
    const result = await serviceWith(interleaved, MeriService).bootstrapConversation(ctx(), request);
    assert.equal(result.conversationId, winnerId);
    assert.equal(await count('SELECT count(*) FROM clio_conversations') - before, 1);
    assert.equal(await count('SELECT count(*) FROM clio_conversation_bootstrap_receipts WHERE request_id=$1', [request.requestId]), 1);
  });

  await check('current conversation state and immutable deleted receipt', async () => {
    const archivedRequest = input();
    const archived = await service.bootstrapConversation(ctx(), archivedRequest);
    await admin.query("UPDATE clio_conversations SET status='archived',archived_at=now() WHERE id=$1", [archived.conversationId]);
    await expectStatus(service.bootstrapConversation(ctx(), archivedRequest), 409);

    const movedRequest = input();
    const moved = await service.bootstrapConversation(ctx(), movedRequest);
    await admin.query('UPDATE clio_conversations SET client_id=$2 WHERE id=$1', [moved.conversationId, ids.otherClient]);
    await expectStatus(service.bootstrapConversation(ctx(), movedRequest), 409);

    const deletedRequest = input();
    const deleted = await service.bootstrapConversation(ctx(), deletedRequest);
    await admin.query('DELETE FROM clio_conversations WHERE id=$1', [deleted.conversationId]);
    const poisoned = await admin.query('SELECT conversation_id FROM clio_conversation_bootstrap_receipts WHERE request_id=$1', [deletedRequest.requestId]);
    assert.equal(poisoned.rows[0].conversation_id, null);
    await expectStatus(service.bootstrapConversation(ctx(), deletedRequest), 409);
    await assert.rejects(
      admin.query('UPDATE clio_conversation_bootstrap_receipts SET client_id=$2 WHERE request_id=$1', [deletedRequest.requestId, ids.otherClient]),
      (error) => error?.code === '23514',
    );
  });

  await check('client archive and ethical-wall grant revocation block replay', async () => {
    const archivedClientRequest = input();
    await service.bootstrapConversation(ctx(), archivedClientRequest);
    await admin.query("UPDATE clients SET status='archived' WHERE id=$1", [ids.client]);
    await expectStatus(service.bootstrapConversation(ctx(), archivedClientRequest), 404);
    await expectStatus(service.bootstrapConversation(ctx(), input()), 404);
    await admin.query("UPDATE clients SET status='active',memory_wall=true WHERE id=$1", [ids.client]);
    await expectStatus(service.bootstrapConversation(ctx(), input()), 404);
    await admin.query('INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES ($1,$2,$3)', [ids.tenant, ids.client, ids.actor]);
    const walledRequest = input();
    const walled = await service.bootstrapConversation(ctx(), walledRequest);
    assert.equal((await service.bootstrapConversation(ctx(), walledRequest)).conversationId, walled.conversationId);
    await admin.query('DELETE FROM client_memory_access WHERE client_id=$1 AND user_id=$2', [ids.client, ids.actor]);
    await expectStatus(service.bootstrapConversation(ctx(), walledRequest), 404);
  });

  await check('tenant, actor, and foreign-client separation', async () => {
    await admin.query('UPDATE clients SET memory_wall=false WHERE id=$1', [ids.client]);
    const requestId = randomUUID();
    const first = await service.bootstrapConversation(ctx(), input(requestId));
    const otherActor = await service.bootstrapConversation(ctx(ids.tenant, ids.otherActor), input(requestId));
    const otherTenant = await service.bootstrapConversation(ctx(ids.otherTenant), input(requestId, ids.foreignClient));
    assert.equal(new Set([first.conversationId, otherActor.conversationId, otherTenant.conversationId]).size, 3);
    await expectStatus(service.bootstrapConversation(ctx(), input(randomUUID(), ids.foreignClient)), 404);
  });
}

try {
  await admin.connect();
  const dataDir = await admin.query('SHOW data_directory');
  assert.equal(realLower(dataDir.rows[0].data_directory), expectedDataDir, 'connected server data directory differs from exact task-owned target');
  const version = await admin.query('SHOW server_version');
  assert.match(version.rows[0].server_version, /^16\.15(?:\b|$)/, 'expected installed PostgreSQL 16.15');
  await bootstrapSchema();
  const ids = await seed();
  const [prismaModule, meriModule] = await Promise.all([
    import('../../apps/api/src/prisma/prisma.service.ts'),
    import('../../apps/api/src/meri/meri.service.ts'),
  ]);
  const PrismaService = prismaModule.PrismaService ?? prismaModule.default?.PrismaService;
  const MeriService = meriModule.MeriService ?? meriModule.default?.MeriService;
  assert.equal(typeof PrismaService, 'function');
  assert.equal(typeof MeriService, 'function');
  prisma = new PrismaService({ datasources: { db: { url: rawUrl } } });
  await prisma.$connect();
  await runChecks(MeriService, ids);
  console.log(`Native qualification passed ${checks} focused checks on exact task-owned PostgreSQL 16.15`);
} finally {
  await prisma?.$disconnect();
  await admin.end().catch(() => undefined);
}
