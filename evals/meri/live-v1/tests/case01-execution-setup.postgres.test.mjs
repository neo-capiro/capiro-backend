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
  inspectCase01FirstApprovalRecovery,
  executeCase01FirstApprovalRecovery,
  safeCase01SetupFailure,
} from '../fixture-provisioning/case01-execution-setup.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { lifecycleSeedMemoryDefinitions } from '../fixture-provisioning/approved-memory-runtime.mjs';
import { createMemoryCandidateOwnerPort } from '../fixture-provisioning/memory-candidate-owner.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
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

async function preparePendingRecovery(h) {
  const prepared = await prepare(h), { actual, input } = prepared;
  const manifest = await buildFixtureManifest({ fixtureInstanceId: input.previousFixtureInstanceId,
    clients: input.clients, actors: input.actors, uploaderActors: { T1: 'PAT' } });
  const first = lifecycleSeedMemoryDefinitions(manifest, ['MA1-v1'])[0].candidate;
  const owner = createMemoryCandidateOwnerPort({ ...actual, actorForTenant: () => PROPOSER });
  await owner.create(first, { tenantId: TENANT, physicalId: first.physicalId,
    expectedOwnershipMarkerSha256: first.ownership.markerSha256, expectedRowVersion: null });
  const pending = await owner.read(first);
  const original = { kind: 'meri-case01-execution-setup', captureRunId: input.captureRunId,
    recipeSha256: sha256Stable(input), status: 'STARTED', liveAcceptance: 'NOT_RUN' };
  await h.tx.$executeRawUnsafe(
    "UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01ExecutionSetup}',$1::jsonb,true) WHERE id=$2::uuid",
    JSON.stringify(original), TENANT);
  const expected = { originalClaimSha256: sha256Stable(original), candidateRowVersion: pending.rowVersion };
  const run = (work) => {
    process.env.MEMORY_GOVERNANCE_TENANTS = AUTHORIZED_TENANTS.T1.id + ',' + AUTHORIZED_TENANTS.T2.id;
    const { runWithMemoryGovernanceTenant } = source('memory/memory-governance-tenant-scope');
    return actual.tenantContext.run(input.ctx, () => runWithMemoryGovernanceTenant(TENANT, work));
  };
  return { ...prepared, first, original, expected, run };
}

it('one-shot pending recovery reuses the exact candidate and keeps the original failed claim immutable',
  { skip: !config }, async () => withOwnedApprovedMemory(config, async h => {
    const p = await preparePendingRecovery(h), journal = [];
    const plan = await p.run(() => inspectCase01FirstApprovalRecovery(p.actual, p.input, p.expected));
    assert.equal(plan.candidateId, p.first.physicalId);
    const result = await p.run(() => executeCase01FirstApprovalRecovery(p.actual, p.input, p.expected,
      { expectedPlanSha256: plan.planSha256, createConversation: p.createConversation, journal: async row => journal.push(row) }));
    assert.equal(result.status, 'SETUP_COMPLETE');
    const settings = (await h.tx.$queryRawUnsafe('SELECT settings_jsonb AS s FROM tenants WHERE id=$1::uuid', TENANT))[0].s;
    assert.deepEqual(settings.meriFoundationFixture.case01ExecutionSetup, p.original);
    assert.equal(settings.meriFoundationFixture.case01ExecutionSetupRecovery.status, 'SETUP_COMPLETE');
    assert.deepEqual(settings.unrelated, { preserve: true });
    assert.equal(journal.filter(row => row.stage === 'FIRST_CANONICAL_APPROVAL' && row.phase === 'INTENT').length, 1);
    assert.equal(journal.filter(row => row.stage === 'FIRST_CANONICAL_APPROVAL' && row.phase === 'VERIFIED').length, 1);
    await assert.rejects(p.run(() => executeCase01FirstApprovalRecovery(p.actual, p.input, p.expected,
      { expectedPlanSha256: plan.planSha256, createConversation: p.createConversation, journal: async () => {} })), /RECOVERY_DOWNSTREAM_OWNER_PRESENT/);
  }));

it('pending recovery rejects stale version, source drift, original claim drift, downstream state and stale plan before new effects',
  { skip: !config }, async () => withOwnedApprovedMemory(config, async h => {
    const p = await preparePendingRecovery(h);
    const inspect = () => p.run(() => inspectCase01FirstApprovalRecovery(p.actual, p.input, p.expected));
    await assert.rejects(p.run(() => inspectCase01FirstApprovalRecovery(p.actual, p.input,
      { ...p.expected, candidateRowVersion: '0' })), /RECOVERY_NOT_FIRST_APPROVAL_PENDING/);
    const plan = await inspect();
    await assert.rejects(p.run(() => executeCase01FirstApprovalRecovery(p.actual, p.input, p.expected,
      { expectedPlanSha256: '0'.repeat(64), createConversation: p.createConversation, journal: async () => {} })), /RECOVERY_STALE_PLAN/);
    for (const sql of [
      "UPDATE memory_candidate SET payload_jsonb=jsonb_set(payload_jsonb,'{value}','\"changed\"')",
      "UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01ExecutionSetup,status}','\"CHANGED\"')",
      "UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,captureEvidence}','{}'::jsonb)",
    ]) {
      await h.tx.$executeRawUnsafe('SAVEPOINT recovery_fault');
      await h.tx.$executeRawUnsafe(sql);
      await assert.rejects(inspect());
      await h.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT recovery_fault');
      await h.tx.$executeRawUnsafe('RELEASE SAVEPOINT recovery_fault');
    }
    assert.equal((await inspect()).planSha256, plan.planSha256);
    const counts = (await h.tx.$queryRawUnsafe('SELECT (SELECT count(*)::int FROM memory_candidate) AS candidates,(SELECT count(*)::int FROM memory_items) AS items'))[0];
    assert.deepEqual(counts, { candidates: 1, items: 0 });
  }));

it('failed canonical first approval keeps its recovery claim and emits safe source-owned error codes without raw messages',
  { skip: !config }, async () => withOwnedApprovedMemory(config, async h => {
    const p = await preparePendingRecovery(h), journal = [];
    const plan = await p.run(() => inspectCase01FirstApprovalRecovery(p.actual, p.input, p.expected));
    const owner = Object.create(p.actual.memoryCandidates);
    owner.approveSyntheticFixture = async () => { const error = new Error('private query and payload NEVER_SERIALIZE');
      error.code = 'P2010'; error.meta = { code: '42501', message: 'private database context' }; throw error; };
    await assert.rejects(p.run(() => executeCase01FirstApprovalRecovery({ ...p.actual, memoryCandidates: owner }, p.input, p.expected,
      { expectedPlanSha256: plan.planSha256, createConversation: p.createConversation, journal: async row => journal.push(row) })));
    const failure = journal.find(row => row.phase === 'RECONCILIATION_REQUIRED');
    assert.deepEqual(failure.failure, { stage: 'FIRST_CANONICAL_APPROVAL', errorClass: 'Error', prismaCode: 'P2010', sqlState: '42501' });
    assert.ok(!JSON.stringify(journal).includes('private'));
    const settings = (await h.tx.$queryRawUnsafe('SELECT settings_jsonb AS s FROM tenants WHERE id=$1::uuid', TENANT))[0].s;
    assert.deepEqual(settings.meriFoundationFixture.case01ExecutionSetup, p.original);
    assert.equal(settings.meriFoundationFixture.case01ExecutionSetupRecovery.status, 'STARTED');
    assert.equal((await h.tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM memory_items'))[0].n, 0);
    assert.deepEqual(safeCase01SetupFailure({ code: 'secret', meta: { code: 'secret' }, message: 'secret' }, 'secret'),
      { stage: 'OPERATOR', errorClass: 'UnknownError', prismaCode: null, sqlState: null });
  }));

it('canonical first approval rejects candidate changes after the recovery claim and before its own row lock',
  { skip: !config }, async () => withOwnedApprovedMemory(config, async h => {
    const p = await preparePendingRecovery(h), journal = [];
    const plan = await p.run(() => inspectCase01FirstApprovalRecovery(p.actual, p.input, p.expected));
    await assert.rejects(p.run(() => executeCase01FirstApprovalRecovery(p.actual, p.input, p.expected,
      { expectedPlanSha256: plan.planSha256, createConversation: p.createConversation, journal: async row => {
        journal.push(row);
        if (row.stage === 'FIRST_CANONICAL_APPROVAL' && row.phase === 'INTENT')
          await h.tx.$executeRawUnsafe("UPDATE memory_candidate SET payload_jsonb=jsonb_set(payload_jsonb,'{value}','\"changed after claim\"') WHERE id=$1::uuid", p.first.physicalId);
      } })), /guard does not match/);
    assert.equal((await h.tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM memory_items'))[0].n, 0);
    assert.equal(journal.filter(row => row.stage === 'FIRST_CANONICAL_APPROVAL' && row.phase === 'VERIFIED').length, 0);
    assert.equal(journal.filter(row => row.stage === 'FIRST_CANONICAL_APPROVAL' && row.phase === 'RECONCILIATION_REQUIRED').length, 1);
  }));

it('ordinary reviewer needs current approve and revoke authority before plan or durable setup claim',
  { skip: !config }, async () => withOwnedApprovedMemory(config, async (h) => {
    const { actual, input, createConversation } = await prepare(h);
    await h.tx.$executeRawUnsafe(
      "UPDATE tenant_memberships SET role='standard_user' WHERE tenant_id=$1::uuid AND user_id=$2::uuid",
      TENANT, REVIEWER,
    );
    const before = (await h.tx.$queryRawUnsafe('SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid', TENANT))[0].settings;
    await assert.rejects(inspectCase01ExecutionSetup(actual, input), /REVIEWER_AUTHORITY_REQUIRED/);
    await assert.rejects(executeScoped(actual, input, {
      expectedPlanSha256: '0'.repeat(64), createConversation, journal: async () => {},
    }), /REVIEWER_AUTHORITY_REQUIRED/);
    assert.deepEqual((await h.tx.$queryRawUnsafe('SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid', TENANT))[0].settings, before);
    assert.equal((await h.tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM memory_candidate'))[0].count, 0);
    for (const client of ['ASTER', 'BLUEHAVEN']) await h.tx.$executeRawUnsafe(
      `INSERT INTO memory_access_grant(id,tenant_id,client_id,user_id,permissions,status,expires_at,reason)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,ARRAY['approve'],'active',now()+interval '1 hour','Owned local fixture qualification')`,
      randomUUID(), TENANT, input.clients[client].physicalId, REVIEWER,
    );
    await assert.rejects(inspectCase01ExecutionSetup(actual, input), /REVIEWER_AUTHORITY_REQUIRED/);
    await h.tx.$executeRawUnsafe("UPDATE memory_access_grant SET permissions=ARRAY['approve','revoke'] WHERE user_id=$1::uuid", REVIEWER);
    assert.equal((await inspectCase01ExecutionSetup(actual, input)).kind, 'meri-case01-execution-setup-plan');
    await h.tx.$executeRawUnsafe("UPDATE memory_access_grant SET expires_at=now()-interval '1 second' WHERE user_id=$1::uuid", REVIEWER);
    await assert.rejects(inspectCase01ExecutionSetup(actual, input), /REVIEWER_AUTHORITY_REQUIRED/);
    assert.deepEqual((await h.tx.$queryRawUnsafe('SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid', TENANT))[0].settings, before);
  }));

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
