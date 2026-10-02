import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  withOwnedApprovedMemory,
  TENANT,
  PROPOSER,
  REVIEWER,
  CLIENT,
} from './approved-memory-postgres-harness.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
import {
  inspectPendingMemorySetup,
  executePendingMemorySetup,
} from '../fixture-provisioning/memory-pending-execution.mjs';
import { sha256Stable } from '../lib/stable.mjs';

const config = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const source = (name) =>
  require(fileURLToPath(new URL(`../../../../apps/api/src/memory/${name}.ts`, import.meta.url)));

async function prepare(h) {
  process.env.MEMORY_CLIENT_REVIEW = 'enforce';
  await h.tx.$executeRawUnsafe(
    "ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb DEFAULT '{}'::jsonb",
  );
  await h.tx.$executeRawUnsafe(
    'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
    JSON.stringify({ meriFoundationFixture: { fixtureNamespace: FIXTURE_NAMESPACE } }),
    TENANT,
  );
  await h.tx.$executeRawUnsafe(
    'CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text)',
  );
  for (const [id, name] of [
    [PROPOSER, 'Pat'],
    [REVIEWER, 'Priya'],
  ])
    await h.tx.$executeRawUnsafe(
      'INSERT INTO users VALUES($1::uuid,$2,$3,$4,$5)',
      id,
      `user_${name}`,
      `${FIXTURE_NAMESPACE}-${name.toLowerCase()}@example.com`,
      'Synthetic',
      name,
    );
  const recipe = {
    schemaVersion: 1,
    target: 'capiro-dev',
    fixtureNamespace: FIXTURE_NAMESPACE,
    caseId: '14',
    ctx: {
      tenantId: TENANT,
      tenantSlug: AUTHORIZED_TENANTS.T1.slug,
      userId: PROPOSER,
      role: 'standard_user',
    },
    clerkUserId: 'user_Pat',
    fixtureInstanceId: randomUUID(),
    clients: h.manifest.clients,
    actors: {
      PAT: { tenantId: 'T1', physicalId: PROPOSER },
      PRIYA: { tenantId: 'T1', physicalId: REVIEWER },
    },
  };
  const plan = await inspectPendingMemorySetup(h.deps, recipe);
  const receipt = await executePendingMemorySetup(h.deps, recipe, {
    expectedPlanSha256: plan.planSha256,
    journal: async () => {},
  });
  const { MemoryAuthorizationService } = source('memory-authorization.service');
  const { readCase14FixtureEvidenceInTx } = source('case14-fixture-evidence');
  const authorization = new MemoryAuthorizationService(h.deps.prisma);
  const ctx = {
    tenantId: TENANT,
    tenantSlug: AUTHORIZED_TENANTS.T1.slug,
    userId: REVIEWER,
    role: 'user_admin',
    clerkUserId: 'user_Priya',
  };
  const candidateId = receipt.records[0].physicalId;
  const read = (context = ctx, id = candidateId) =>
    readCase14FixtureEvidenceInTx(h.tx, context, authorization, id);
  return { recipe, ctx, candidateId, read };
}

it(
  'case14 owner rehydrates pending and real canonical approval from current rows and exact transition audit',
  { skip: !config },
  async () => {
    await withOwnedApprovedMemory(config, async (h) => {
      const { ctx, candidateId, read } = await prepare(h);
      const pending = await read();
      assert.equal(pending.state, 'pending');
      assert.equal(pending.item, null);
      assert.equal(pending.text, 'Synthetic Aster candidate for approval');
      const approved = await h.memoryCandidates.approve(TENANT, candidateId, REVIEWER, ctx);
      const evidence = await read();
      assert.equal(evidence.state, 'approved');
      assert.equal(evidence.item.clioMemoryId, approved.memoryId);
      assert.equal(evidence.item.sourceVersion, `candidate:${candidateId}`);
      assert.equal(evidence.decision.actorUserId, REVIEWER);
      assert.equal(evidence.setupReceiptSha256, pending.setupReceiptSha256);
      assert.notEqual(evidence.currentVerifySha256, pending.currentVerifySha256);
      assert.deepEqual(await read(), evidence);
      await h.tx.$executeRawUnsafe(
        "UPDATE memory_transition_audit SET metadata_jsonb=metadata_jsonb-'memoryItemId' WHERE id=$1::uuid",
        evidence.decision.transitionAuditId,
      );
      await assert.rejects(read(), /CURRENT_CANONICAL_OWNER_REQUIRED/);
    });
  },
);

it(
  'case14 pending owner rejects altered current membership, identity, wall and source payload',
  { skip: !config },
  async () => {
    await withOwnedApprovedMemory(config, async (h) => {
      const { ctx, candidateId, read } = await prepare(h);
      assert.equal(await read({ ...ctx, role: 'standard_user' }), null);
      assert.equal(await read({ ...ctx, tenantId: AUTHORIZED_TENANTS.T2.id }), null);
      assert.equal(await read(ctx, randomUUID()), null);
      await assert.rejects(
        read({ ...ctx, clerkUserId: 'user_forged' }),
        /CURRENT_CANONICAL_OWNER_REQUIRED/,
      );
      await h.tx.$executeRawUnsafe(
        "UPDATE tenant_memberships SET status='inactive' WHERE user_id=$1::uuid",
        REVIEWER,
      );
      await assert.rejects(read(), /CURRENT_CANONICAL_OWNER_REQUIRED/);
      await h.tx.$executeRawUnsafe(
        "UPDATE tenant_memberships SET status='active',role='standard_user' WHERE user_id=$1::uuid",
        REVIEWER,
      );
      await assert.rejects(read(), /CURRENT_CANONICAL_OWNER_REQUIRED/);
      await h.tx.$executeRawUnsafe(
        "UPDATE tenant_memberships SET role='user_admin' WHERE user_id=$1::uuid",
        REVIEWER,
      );
      await h.tx.$executeRawUnsafe('UPDATE clients SET memory_wall=true WHERE id=$1::uuid', CLIENT);
      await assert.rejects(read());
      await h.tx.$executeRawUnsafe(
        'UPDATE clients SET memory_wall=false WHERE id=$1::uuid',
        CLIENT,
      );
      await h.tx.$executeRawUnsafe(
        "UPDATE memory_candidate SET payload_jsonb=jsonb_set(payload_jsonb,'{value}','\"tampered\"'::jsonb) WHERE id=$1::uuid",
        candidateId,
      );
      await assert.rejects(read());
    });
  },
);

it(
  'case14 approved owner refuses revoked, version-altered and foreign approved source state',
  { skip: !config },
  async () => {
    await withOwnedApprovedMemory(config, async (h) => {
      const { ctx, candidateId, read } = await prepare(h);
      await h.memoryCandidates.approve(TENANT, candidateId, REVIEWER, ctx);
      const evidence = await read();
      for (const sql of [
        "UPDATE memory_items SET source_version='wrong' WHERE id=$1::uuid",
        "UPDATE memory_items SET status='revoked',governed_status='revoked' WHERE id=$1::uuid",
        "UPDATE memory_items SET tenant_id='52e91176-08f0-4d89-9633-bc212f5bdbbf'::uuid WHERE id=$1::uuid",
      ]) {
        await h.tx.$executeRawUnsafe('SAVEPOINT case14_negative');
        await h.tx.$executeRawUnsafe(sql, evidence.item.id);
        await assert.rejects(read());
        await h.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT case14_negative');
      }
    });
  },
);

it(
  'case14 binding preserves canonical approval, requires current owner/CAS and invalidates old provider qualification',
  { skip: !config },
  async () => {
    await withOwnedApprovedMemory(config, async (h) => {
      const { ctx, candidateId, read } = await prepare(h);
      const { MemoryAuthorizationService } = source('memory-authorization.service');
      const {
        inspectCase14RecallBindingInTx: plan,
        installCase14RecallBindingInTx: install,
        qualifyCase14RecallInTx: qualify,
      } = source('case14-fixture-evidence');
      const authorization = new MemoryAuthorizationService(h.deps.prisma),
        scope = { caseId: '14', clientId: CLIENT, captureRunId: randomUUID() };
      await assert.rejects(plan(h.tx, ctx, authorization, scope));
      await h.memoryCandidates.approve(TENANT, candidateId, REVIEWER, ctx);
      const before = await read(),
        expected = await plan(h.tx, ctx, authorization, scope);
      await assert.rejects(
        install(h.tx, ctx, authorization, {
          ...scope,
          confirmation: 'BIND_EXISTING_CASE14_CANONICAL_APPROVAL',
          expectedPlanSha256: '0'.repeat(64),
        }),
      );
      const receipt = await install(h.tx, ctx, authorization, {
        ...scope,
        confirmation: 'BIND_EXISTING_CASE14_CANONICAL_APPROVAL',
        expectedPlanSha256: expected.planSha256,
      });
      assert.equal(receipt.status, 'CASE14_RECALL_BOUND');
      assert.equal(receipt.approvalDecisions, 0);
      assert.deepEqual(await read(), before);
      const proof = await qualify(h.tx, ctx, authorization, scope);
      assert.equal(proof.sourceMap['MEM-PROPOSAL-14'].physicalId, before.item.id);
      assert.equal(proof.sourceMap['MEM-PROPOSAL-14'].version, before.item.sourceVersion);
      assert.equal(
        proof.currentVerify.canonicalOwner.decision.transitionAuditId,
        before.decision.transitionAuditId,
      );
      assert.equal(
        (
          await h.tx.$queryRawUnsafe('SELECT settings_jsonb FROM tenants WHERE id=$1::uuid', TENANT)
        )[0].settings_jsonb.meriFoundationFixture.captureProviderBudget,
        null,
      );
      await assert.rejects(
        install(h.tx, ctx, authorization, {
          ...scope,
          confirmation: 'BIND_EXISTING_CASE14_CANONICAL_APPROVAL',
          expectedPlanSha256: (await plan(h.tx, ctx, authorization, scope)).planSha256,
        }),
      );
      await h.tx.$executeRawUnsafe(
        "UPDATE memory_items SET governed_status='revoked' WHERE id=$1::uuid",
        before.item.id,
      );
      await assert.rejects(qualify(h.tx, ctx, authorization, scope));
    });
  },
);

it(
  'case14 provider installation re-reads the actual approved source and preserves the distinct rate/ledger qualification',
  { skip: !config },
  async () => {
    await withOwnedApprovedMemory(config, async (h) => {
      const { ctx, candidateId } = await prepare(h);
      await h.memoryCandidates.approve(TENANT, candidateId, REVIEWER, ctx);
      const { MemoryAuthorizationService } = source('memory-authorization.service');
      const authorization = new MemoryAuthorizationService(h.deps.prisma);
      const { inspectCase14RecallBindingInTx: plan, installCase14RecallBindingInTx: bind } =
        source('case14-fixture-evidence');
      const scope = { caseId: '14', clientId: CLIENT, captureRunId: randomUUID() };
      const bp = await plan(h.tx, ctx, authorization, scope);
      const bound = await bind(h.tx, ctx, authorization, {
        ...scope,
        expectedPlanSha256: bp.planSha256,
        confirmation: 'BIND_EXISTING_CASE14_CANONICAL_APPROVAL',
      });
      const {
        inspectCaptureProviderBudgetInstallation,
        installCaptureProviderBudgetQualification,
      } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/api/src/meri/meri-capture-provider-budget-install.ts',
            import.meta.url,
          ),
        ),
      );
      const inspected = await inspectCaptureProviderBudgetInstallation(h.deps, {
        ctx,
        clientId: CLIENT,
      });
      assert.equal(inspected.caseId, '14');
      assert.equal(inspected.currentVerifySha256, bound.binding.currentVerifySha256);
      const expiry = new Date(Date.now() + 3600000).toISOString(),
        rate = {
          kind: 'openai_responses',
          provider: 'test-only',
          model: 'owned-unit',
          inputMicrosPerMillion: 1000000,
          outputMicrosPerMillion: 2000000,
        };
      const rateEvidence = {
        kind: 'meri-capture-reviewed-provider-rates',
        version: 1,
        priceKind: 'qualified_text_token_upper_bound',
        observedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: expiry,
        maxTokens: 2000,
        rates: [rate],
        sources: [
          {
            kind: rate.kind,
            provider: rate.provider,
            model: rate.model,
            url: 'https://example.com/owned-unit-prices',
            unitContract: 'Local test rates only; never live.',
          },
        ],
      };
      const qualification = {
        version: 1,
        caseId: '14',
        captureRunId: scope.captureRunId,
        currentVerifySha256: inspected.currentVerifySha256,
        rateEvidenceSha256: sha256Stable(rateEvidence),
        rateEvidenceExpiresAt: expiry,
        priceKind: rateEvidence.priceKind,
        maxAttempts: 3,
        maxTokens: 2000,
        maxCostMicros: 3000000,
        rates: [rate],
      };
      const input = {
        ctx,
        clientId: CLIENT,
        qualification,
        rateEvidence,
        expectedCurrentVerifySha256: inspected.currentVerifySha256,
        expectedCaptureBindingSha256: inspected.captureBindingSha256,
        expectedPriorQualificationSha256: inspected.priorQualificationSha256,
        expectedTenantRowVersion: inspected.tenantRowVersion,
      };
      const receipt = await installCaptureProviderBudgetQualification(h.deps, input);
      assert.equal(receipt.qualificationSha256, sha256Stable(qualification));
      await assert.rejects(
        installCaptureProviderBudgetQualification(h.deps, input),
        /compare_and_swap/,
      );
      await h.tx.$executeRawUnsafe(
        'UPDATE memory_candidate SET approved_by_user_id=$1::uuid WHERE id=$2::uuid',
        PROPOSER,
        candidateId,
      );
      await assert.rejects(
        inspectCaptureProviderBudgetInstallation(h.deps, { ctx, clientId: CLIENT }),
      );
    });
  },
);
