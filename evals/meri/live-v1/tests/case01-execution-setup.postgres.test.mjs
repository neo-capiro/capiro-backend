import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { versionDependencies } from './case01-memory-lifecycle.postgres.test.mjs';
import {
  withOwnedApprovedMemory,
  TENANT,
  CLIENT,
  PROPOSER,
  REVIEWER,
} from './approved-memory-postgres-harness.mjs';
import {
  inspectCase01ExecutionSetup,
  executeCase01ExecutionSetup,
} from '../fixture-provisioning/case01-execution-setup.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const source = (name) =>
  require(fileURLToPath(new URL(`../../../../apps/api/src/${name}.ts`, import.meta.url)));
const config = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;

function executeScoped(deps, input, options) {
  process.env.MEMORY_GOVERNANCE_TENANTS = AUTHORIZED_TENANTS.T1.id + ',' + AUTHORIZED_TENANTS.T2.id;
  const { runWithMemoryGovernanceTenant } = source('memory/memory-governance-tenant-scope');
  return deps.tenantContext.run(input.ctx, () =>
    runWithMemoryGovernanceTenant(input.ctx.tenantId, () =>
      executeCase01ExecutionSetup(deps, input, options),
    ),
  );
}

async function prepare(h) {
  const { deps, tx, manifest, memoryStore } = h;
  const versions = await versionDependencies(deps, tx, memoryStore);
  const actual = {
    ...deps,
    ...source('memory/synthetic-candidate-withdrawal.helpers'),
    ...source('memory/synthetic-approved-memory.helpers'),
    ...versions,
    memoryVersions: versions.versions,
    memoryAuthorization: memoryStore.authz,
  };
  await tx.$executeRawUnsafe(
    "ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb DEFAULT '{}'::jsonb",
  );
  await tx.$executeRawUnsafe(
    'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
    JSON.stringify({
      unrelated: { preserve: true },
      meriFoundationFixture: { fixtureNamespace: FIXTURE_NAMESPACE },
    }),
    TENANT,
  );
  await tx.$executeRawUnsafe(
    "ALTER TABLE clients ADD COLUMN IF NOT EXISTS status text DEFAULT 'active'",
  );
  await tx.$executeRawUnsafe(
    'CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text)',
  );
  for (const [id, name] of [
    [PROPOSER, 'Pat'],
    [REVIEWER, 'Priya'],
  ])
    await tx.$executeRawUnsafe(
      'INSERT INTO users VALUES($1::uuid,$2,$3,$4,$5)',
      id,
      `unit-${name}`,
      `${FIXTURE_NAMESPACE}-${name.toLowerCase()}@example.com`,
      'Synthetic',
      name,
    );
  await tx.$executeRawUnsafe(
    `CREATE TABLE clio_conversations(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,client_id uuid,workspace_id uuid,workspace_key text DEFAULT 'workspace',title text,status text DEFAULT 'active',nanoclaw_platform_id text,nanoclaw_agent_group_id text,metadata_jsonb jsonb DEFAULT '{}',summary text,summary_up_to_message_id uuid,summary_tokens integer,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),archived_at timestamptz)`,
  );
  await tx.$executeRawUnsafe(
    'CREATE TABLE clio_messages(id uuid PRIMARY KEY,conversation_id uuid)',
  );
  const { MeriService } = source('meri/meri.service');
  const meri = Object.assign(Object.create(MeriService.prototype), { prisma: deps.prisma });
  const input = {
    schemaVersion: 1,
    target: 'capiro-dev',
    fixtureNamespace: FIXTURE_NAMESPACE,
    ctx: {
      tenantId: TENANT,
      tenantSlug: AUTHORIZED_TENANTS.T1.slug,
      userId: PROPOSER,
      role: 'standard_user',
    },
    clerkUserId: 'unit-Pat',
    reviewerUserId: REVIEWER,
    captureRunId: randomUUID(),
    previousFixtureInstanceId: randomUUID(),
    currentFixtureInstanceId: randomUUID(),
    clients: manifest.clients,
    actors: { PAT: { physicalId: PROPOSER }, PRIYA: { physicalId: REVIEWER } },
  };
  return { actual, input, createConversation: meri.createConversation.bind(meri) };
}

it(
  'actual canonical setup composes retirement, binding, restart locator and actual owned empty Meri conversation; replay and stale plans stop',
  { skip: !config },
  async () =>
    withOwnedApprovedMemory(config, async (h) => {
      const { actual, input, createConversation } = await prepare(h);
      await h.tx.$executeRawUnsafe('SAVEPOINT prior_owner');
      await h.tx.$executeRawUnsafe(
        "UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01MemoryOwner}','{}'::jsonb,true) WHERE id=$1::uuid",
        TENANT,
      );
      await assert.rejects(inspectCase01ExecutionSetup(actual, input), /EXISTING_OWNER/);
      await h.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT prior_owner');
      await h.tx.$executeRawUnsafe('RELEASE SAVEPOINT prior_owner');
      const plan = await inspectCase01ExecutionSetup(actual, input),
        journal = [];
      await assert.rejects(
        executeScoped(actual, input, {
          expectedPlanSha256: '0'.repeat(64),
          createConversation,
          journal: async (entry) => journal.push(entry),
        }),
        /STALE_PLAN/,
      );
      const receipt = await executeScoped(actual, input, {
        expectedPlanSha256: plan.planSha256,
        createConversation,
        journal: async (entry) => journal.push(entry),
      });
      assert.equal(receipt.status, 'SETUP_COMPLETE');
      assert.equal(receipt.synthesisSubmissionCount, 0);
      assert.equal(receipt.liveAcceptance, 'NOT_RUN');
      assert.equal(receipt.clientId, CLIENT);
      assert.deepEqual(Object.keys(receipt.sourceMap), ['MA1-v2']);
      assert.ok(
        journal.find((entry) => entry.stage === 'PREVIOUS_RETIRE' && entry.phase === 'VERIFIED'),
      );
      const rows = await h.tx.$queryRawUnsafe(
        'SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid',
        TENANT,
      );
      assert.deepEqual(rows[0].settings.unrelated, { preserve: true });
      assert.equal(
        rows[0].settings.meriFoundationFixture.case01ExecutionSetup.status,
        'SETUP_COMPLETE',
      );
      await assert.rejects(inspectCase01ExecutionSetup(actual, input), /EXISTING_OPERATION/);
      await assert.rejects(
        executeScoped(actual, input, {
          expectedPlanSha256: plan.planSha256,
          createConversation,
          journal: async () => {},
        }),
        /EXISTING_OPERATION/,
      );
    }),
);

it(
  'partial operation retains durable claim and refuses replay; invalid actor and wall fail before claim',
  { skip: !config },
  async () =>
    withOwnedApprovedMemory(config, async (h) => {
      const { actual, input, createConversation } = await prepare(h);
      await assert.rejects(
        inspectCase01ExecutionSetup(actual, { ...input, reviewerUserId: input.ctx.userId }),
        /SCOPE_INVALID/,
      );
      await assert.rejects(
        inspectCase01ExecutionSetup(actual, {
          ...input,
          ctx: { ...input.ctx, role: 'capiro_admin' },
        }),
        /SCOPE_INVALID/,
      );
      await h.tx.$executeRawUnsafe('UPDATE clients SET memory_wall=true WHERE id=$1::uuid', CLIENT);
      await assert.rejects(inspectCase01ExecutionSetup(actual, input), /CLIENT_WALL/);
      await h.tx.$executeRawUnsafe(
        'UPDATE clients SET memory_wall=false WHERE id=$1::uuid',
        CLIENT,
      );
      const plan = await inspectCase01ExecutionSetup(actual, input);
      await assert.rejects(
        executeScoped(actual, input, {
          expectedPlanSha256: plan.planSha256,
          createConversation,
          journal: async (entry) => {
            if (entry.stage === 'PREVIOUS_RETIRE' && entry.phase === 'INTENT')
              throw new Error('owned injected journal failure');
          },
        }),
        /owned injected/,
      );
      await assert.rejects(inspectCase01ExecutionSetup(actual, input), /EXISTING_OPERATION/);
      const rows = await h.tx.$queryRawUnsafe(
        'SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid',
        TENANT,
      );
      assert.equal(rows[0].settings.meriFoundationFixture.case01ExecutionSetup.status, 'STARTED');
      assert.equal((await h.tx.$queryRawUnsafe('SELECT id FROM clio_conversations')).length, 0);
    }),
);
