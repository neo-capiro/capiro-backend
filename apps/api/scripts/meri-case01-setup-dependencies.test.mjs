import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createCase01SetupDependencies } from './meri-case01-setup-dependencies.mjs';
import {
  withOwnedApprovedMemory,
  PROPOSER,
  CLIENT,
} from '../../../evals/meri/live-v1/tests/approved-memory-postgres-harness.mjs';

const require = createRequire(import.meta.url);
const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const source = (name) => require(resolve(apiRoot, 'src', `${name}.ts`));
const T1 = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
const T2 = '52e91176-08f0-4d89-9633-bc212f5bdbbf';
const env = {
  MERI_SYNTHETIC_FIXTURE_NAMESPACE: 'meri-foundation-20260928',
  MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
  MEMORY_GOVERNANCE_CENTER: 'enforce',
  MEMORY_GOVERNANCE_ENFORCE: 'enforce',
  MEMORY_CLIENT_REVIEW: 'enforce',
  MEMORY_GOVERNANCE_TENANTS: `${T1},${T2}`,
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/never_connect',
};
const oldEnv = new Map();
let restoreResolver,
  PrismaService,
  oldInit,
  oldDestroy,
  connects = 0,
  disconnects = 0;
before(() => {
  for (const [key, value] of Object.entries(env)) {
    oldEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  require('ts-node').register({
    project: resolve(apiRoot, 'tsconfig.json'),
    transpileOnly: true,
    experimentalResolver: true,
  });
  // Test-only source mapping for the same fixed compiled paths emitted by Nest.
  // No production loader/environment override exists in the factory.
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (
      parent?.filename ===
        fileURLToPath(new URL('./meri-case01-setup-dependencies.mjs', import.meta.url)) &&
      request.startsWith('../dist/')
    )
      request = resolve(apiRoot, 'src', request.slice('../dist/'.length).replace(/\.js$/u, '.ts'));
    return original.call(this, request, parent, ...rest);
  };
  restoreResolver = () => {
    Module._resolveFilename = original;
  };
  ({ PrismaService } = source('prisma/prisma.service'));
  oldInit = PrismaService.prototype.onModuleInit;
  oldDestroy = PrismaService.prototype.onModuleDestroy;
  // Constructor-only test: no database, provider or credential access occurs.
  PrismaService.prototype.onModuleInit = async function () {
    connects++;
  };
  PrismaService.prototype.onModuleDestroy = async function () {
    disconnects++;
    await this.$disconnect();
  };
});
after(() => {
  PrismaService.prototype.onModuleInit = oldInit;
  PrismaService.prototype.onModuleDestroy = oldDestroy;
  restoreResolver();
  for (const [key, value] of oldEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('refuses namespace/cohort/flags before constructing any Prisma context', async () => {
  const before = connects;
  await assert.rejects(createCase01SetupDependencies({ prisma: {} }), /ARGUMENTS_FORBIDDEN/);
  for (const [key, value] of [
    ['MERI_SYNTHETIC_FIXTURE_NAMESPACE', 'other'],
    ['MEMORY_GOVERNANCE_ENFORCE', 'off'],
    ['MEMORY_GOVERNANCE_TENANTS', 'all'],
    ['MEMORY_GOVERNANCE_TENANTS', T1],
    ['MEMORY_GOVERNANCE_TENANTS', `${T1},${T2},${T1}`],
    ['DATABASE_URL', 'https://example.invalid'],
  ]) {
    process.env[key] = value;
    await assert.rejects(createCase01SetupDependencies(), /CASE01_SETUP_/);
    process.env[key] = env[key];
  }
  assert.equal(connects, before);
});

it('constructs actual production memory aliases with one shared real projector/outbox graph and closes once', async () => {
  const before = disconnects;
  const app = await createCase01SetupDependencies();
  const d = app.deps;
  assert.ok(d.prisma instanceof PrismaService);
  assert.ok(
    d.memoryCandidates instanceof
      source('memory/settings-aware-memory-candidate.service').SettingsAwareMemoryCandidateService,
  );
  assert.ok(
    d.memoryStore instanceof
      source('memory/lineage-aware-memory-store.service').LineageAwareMemoryStoreService,
  );
  assert.ok(
    d.memoryVersions instanceof
      source('memory/immutable-memory-version.service').ImmutableMemoryVersionService,
  );
  assert.ok(
    d.memoryAuthorization instanceof
      source('memory/memory-authorization.service').MemoryAuthorizationService,
  );
  const ingest = d.memoryCandidates.memoryIngest;
  assert.equal(d.memoryIngest, ingest);
  assert.equal(
    d.canonicalProjectionSnapshot,
    source('memory/strict-memory-projector.service').canonicalProjectionSnapshot,
  );
  const outbox = d.memoryCandidates.cleanupOutbox;
  assert.ok(
    ingest instanceof source('memory/governed-memory-ingest.service').GovernedMemoryIngestService,
  );
  assert.ok(
    outbox instanceof
      source('memory/exact-memory-cleanup-outbox.service').ExactMemoryCleanupOutboxService,
  );
  assert.equal(ingest.store, d.memoryStore);
  assert.equal(ingest.strictProjector.store, d.memoryStore);
  assert.equal(outbox.ingest, ingest);
  assert.equal(d.memoryStore.cleanupOutbox, outbox);
  assert.equal(d.memoryVersions.cleanupOutbox, outbox);
  assert.equal(d.memoryCandidates.authorization, d.memoryAuthorization);
  assert.equal(d.clientMemoryAllowed, source('memory/memory-wall.helpers').clientMemoryAllowed);
  assert.equal(
    d.readSyntheticCorrectionInTx,
    source('memory/synthetic-memory-version.helpers').readSyntheticCorrectionInTx,
  );
  await Promise.all([app.close(), app.close()]);
  assert.equal(disconnects, before + 1);
  await assert.rejects(app.createConversation({}, {}), /CLOSED/);
});

it('calls the real conversation owner on the current-actor transaction and refuses foreign/extra scope', async () => {
  const app = await createCase01SetupDependencies();
  const ctx = {
    tenantId: T1,
    tenantSlug: env.MERI_SYNTHETIC_FIXTURE_NAMESPACE + '-t1',
    userId: '44444444-4444-4444-8444-444444444444',
    clerkUserId: 'user_synthetic',
    role: 'standard_user',
  };
  const args = {
    clientId: '11111111-1111-4111-8111-111111111111',
    title: 'meri-foundation-20260928 case01 55555555-5555-4555-8555-555555555555',
  };
  const events = [];
  let actor = true,
    wall = true;
  const tx = {
    $queryRaw: async (sql) => {
      events.push(sql.join('?').includes('tenant_memberships') ? 'actor' : 'client');
      return actor ? [{ id: ctx.userId }] : [];
    },
    $queryRawUnsafe: async () => [{ allowed: wall }],
    client: {
      findFirst: async () => {
        events.push('product-client');
        return { id: args.clientId };
      },
    },
    user: {
      findUnique: async () => {
        events.push('product-profile');
        return { email: 'synthetic@example.invalid' };
      },
    },
    clioConversation: {
      create: async ({ data }) => {
        events.push('product-create');
        return { id: '55555555-5555-4555-8555-555555555555', ...data };
      },
    },
  };
  app.deps.prisma.withTenantUser = async (tenant, user, fn) => {
    assert.equal(tenant, T1);
    assert.equal(user, ctx.userId);
    assert.equal(app.deps.tenantContext.require().userId, ctx.userId);
    return fn(tx);
  };
  try {
    for (const [badCtx, badArgs] of [
      [{ ...ctx, role: 'user_admin' }, args],
      [{ ...ctx, tenantId: T2, tenantSlug: 'meri-foundation-20260928-t2' }, args],
      [{ ...ctx, tenantSlug: 'customer' }, args],
      [ctx, { ...args, prospectId: 'extra' }],
      [ctx, { ...args, title: 'unowned title' }],
    ])
      await assert.rejects(app.createConversation(badCtx, badArgs), /SCOPE_INVALID/);
    assert.deepEqual(events, []);
    actor = false;
    await assert.rejects(app.createConversation(ctx, args), /CURRENT_ACTOR/);
    actor = true;
    wall = false;
    await assert.rejects(app.createConversation(ctx, args), /CURRENT_CLIENT/);
    wall = true;
    events.length = 0;
    const result = await app.createConversation(ctx, args);
    assert.deepEqual(events, [
      'actor',
      'client',
      'product-client',
      'product-profile',
      'product-create',
    ]);
    assert.equal(result.clientId, args.clientId);
    assert.equal(result.userId, ctx.userId);
    assert.equal('metadata' in result, false, 'return no copied personal profile');
    app.deps.prisma.withTenantUser = async (_tenant, _user, fn) => fn(tx);
    const scope = source('memory/memory-governance-tenant-scope');
    assert.equal(scope.memoryGovernanceSelectedForCurrentTenant(), false);
    await app.runWithTenant(ctx, async () => {
      assert.equal(scope.currentMemoryGovernanceTenant(), T1);
      assert.equal(scope.memoryGovernanceSelectedForCurrentTenant(), true);
      assert.equal(app.deps.tenantContext.require().userId, ctx.userId);
    });
    assert.equal(scope.currentMemoryGovernanceTenant(), null);
    actor = false;
    let called = false;
    await assert.rejects(
      app.runWithTenant(ctx, () => {
        called = true;
      }),
      /CURRENT_ACTOR/,
    );
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

it(
  'uses actual owned PostgreSQL for factory actor scope and product conversation creation',
  {
    skip: !process.env.MERI_APPROVED_MEMORY_PG_CONFIG,
  },
  async () => {
    const app = await createCase01SetupDependencies();
    try {
      await withOwnedApprovedMemory(
        process.env.MERI_APPROVED_MEMORY_PG_CONFIG,
        async ({ tx, deps }) => {
          // The existing harness owns and rolls back this entire schema. This test
          // adds only the exact tables/columns needed by real conversation creation.
          await tx.$executeRawUnsafe(
            `CREATE TABLE users(id uuid PRIMARY KEY, clerk_user_id text, email text, first_name text, last_name text)`,
          );
          await tx.$executeRawUnsafe(`CREATE TABLE clio_conversations(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
      client_id uuid, workspace_id uuid, workspace_key text DEFAULT 'workspace', title text NOT NULL,
      status text DEFAULT 'active', nanoclaw_platform_id text, nanoclaw_agent_group_id text,
      metadata_jsonb jsonb DEFAULT '{}', summary text, summary_up_to_message_id uuid, summary_tokens integer,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), archived_at timestamptz)`);
          await tx.$executeRawUnsafe(
            'INSERT INTO users(id,clerk_user_id,email) VALUES ($1::uuid,$2,$3)',
            PROPOSER,
            'user_case01_owned',
            'case01-owned@example.invalid',
          );
          process.env.MEMORY_GOVERNANCE_TENANTS = `${T1},${T2}`;
          process.env.MEMORY_CLIENT_REVIEW = 'enforce';
          // Same real service graph, but all scoped work uses the marked owned
          // rollback transaction. No test projector is supplied to this factory.
          app.deps.prisma.withTenantUser = deps.prisma.withTenantUser;
          const recipe = {
            ctx: {
              tenantId: T1,
              tenantSlug: 'meri-foundation-20260928-t1',
              userId: PROPOSER,
              role: 'standard_user',
            },
            clerkUserId: 'user_case01_owned',
          };
          const actor = { ...recipe.ctx, clerkUserId: recipe.clerkUserId };
          const input = {
            clientId: CLIENT,
            title: 'meri-foundation-20260928 case01 55555555-5555-4555-8555-555555555555',
          };
          try {
            const result = await app.runWithTenant(actor, () =>
              app.createConversation(actor, input),
            );
            const rows = await tx.$queryRawUnsafe(
              'SELECT id::text,tenant_id::text,user_id::text,client_id::text,title FROM clio_conversations',
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0].id, result.id);
            assert.equal(rows[0].tenant_id, T1);
            assert.equal(rows[0].user_id, PROPOSER);
            assert.equal(rows[0].client_id, CLIENT);
            assert.equal(rows[0].title, input.title);
            await assert.rejects(
              app.runWithTenant({ ...actor, clerkUserId: 'user_foreign' }, () =>
                app.createConversation(actor, input),
              ),
              /CURRENT_ACTOR/,
            );
            await tx.$executeRawUnsafe(
              "UPDATE tenant_memberships SET status='revoked' WHERE tenant_id=$1::uuid AND user_id=$2::uuid",
              T1,
              PROPOSER,
            );
            await assert.rejects(
              app.runWithTenant(actor, () => app.createConversation(actor, input)),
              /CURRENT_ACTOR/,
            );
            assert.equal(
              (await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM clio_conversations'))[0]
                .count,
              1,
            );
          } finally {
            await app.close();
          }
        },
      );
    } finally {
      await app.close();
    }
  },
);
