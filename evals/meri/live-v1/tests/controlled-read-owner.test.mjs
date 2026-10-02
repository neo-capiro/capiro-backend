import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectControlledReadSetup,
  executeControlledReadSetup,
  qualifyControlledReadInTx,
} from '../fixture-provisioning/controlled-read-owner.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
const ctx = {
  tenantId: AUTHORIZED_TENANTS.T1.id,
  tenantSlug: AUTHORIZED_TENANTS.T1.slug,
  userId: '11111111-1111-4111-8111-111111111111',
  clerkUserId: 'user_synthetic_pat',
  role: 'standard_user',
};
const input = {
  ctx,
  caseId: '20',
  clientId: '33333333-3333-4333-8333-333333333333',
  captureRunId: '44444444-4444-4444-8444-444444444444',
};
function harness() {
  const state = {
    version: '10',
    actor: true,
    wall: true,
    grant: true,
    corrupt: false,
    updates: 0,
    settings: {
      unrelated: { retain: true },
      meriFoundationFixture: {
        fixtureNamespace: FIXTURE_NAMESPACE,
        case01MemoryOwner: { retain: true },
        captureEvidence: { caseId: '01', captureRunId: 'old' },
        captureProviderBudget: { old: true },
      },
    },
  };
  const tx = {
    $queryRawUnsafe: async (sql, ...args) => {
      if (sql.includes('FROM tenants'))
        return [
          {
            id: ctx.tenantId,
            slug: ctx.tenantSlug,
            settings: structuredClone(state.settings),
            row_version: state.version,
          },
        ];
      if (sql.includes('FROM users'))
        return state.actor
          ? [
              {
                id: ctx.userId,
                clerk_user_id: ctx.clerkUserId,
                email: FIXTURE_NAMESPACE + '-pat@example.com',
                first_name: 'Pat',
                last_name: 'Synthetic',
                role: 'standard_user',
              },
            ]
          : [];
      if (sql.includes('FROM clients'))
        return [
          {
            id: input.clientId,
            tenant_id: ctx.tenantId,
            memory_wall: state.wall,
            status: 'active',
          },
        ];
      if (sql.includes('FROM client_memory_access'))
        return state.grant ? [{ user_id: ctx.userId }] : [];
      if (sql.startsWith('UPDATE tenants')) {
        if (args[2] !== state.version) return [];
        state.updates++;
        if (sql.includes('jsonb_set'))
          state.settings.meriFoundationFixture.captureEvidence = JSON.parse(args[0]);
        else {
          if (sha256Stable(state.settings) !== sha256Stable(JSON.parse(args[3]))) return [];
          state.settings = JSON.parse(args[0]);
        }
        state.version = String(Number(state.version) + 1);
        return [
          {
            row_version: state.version,
            settings: state.corrupt ? {} : structuredClone(state.settings),
          },
        ];
      }
      throw new Error('unexpected SQL');
    },
  };
  const prisma = {
    withTenantUser: async (t, u, fn) => {
      assert.equal(t, ctx.tenantId);
      assert.equal(u, ctx.userId);
      const before = structuredClone(state);
      try {
        return await fn(tx);
      } catch (e) {
        Object.assign(state, before);
        throw e;
      }
    },
  };
  return { state, tx, prisma };
}
process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = FIXTURE_NAMESPACE;
async function install(h, patch = {}) {
  const args = { ...input, ...patch };
  const plan = await inspectControlledReadSetup(h, args);
  return executeControlledReadSetup(h, {
    ...args,
    expectedPlanSha256: plan.planSha256,
    confirmation: 'INSTALL_OWNED_CONTROLLED_READ_FIXTURE',
  });
}
for (const caseId of ['20', '72'])
  test(`${caseId} actual transactional locator seed/reset binding and fresh owner readback`, async () => {
    const h = harness();
    const result = await install(h, { caseId });
    assert.equal(result.status, 'CONTROLLED_READ_BOUND');
    assert.equal(h.state.updates, 2);
    assert.deepEqual(h.state.settings.unrelated, { retain: true });
    assert.deepEqual(h.state.settings.meriFoundationFixture.case01MemoryOwner, { retain: true });
    assert.equal(h.state.settings.meriFoundationFixture.captureProviderBudget, null);
    const proof = await qualifyControlledReadInTx(h.tx, ctx, { ...input, caseId });
    assert.equal(proof.physicalMapSha256, result.binding.physicalMapSha256);
    assert.equal(proof.currentVerifySha256, result.binding.currentVerifySha256);
    assert.equal(result.seedReceipt.sourceStorage, 'immutable_source_owned_controlled_adapter');
    assert.equal(
      result.resetReceipt.scope,
      'replace_owned_capture_binding_and_controlled_locator_only',
    );
    assert.equal(result.sharedCorpusWrites, 0);
    assert.equal(result.liveAcceptance, 'NOT_RUN');
  });
test('stale plan cannot replace another operator change', async () => {
  const h = harness();
  const plan = await inspectControlledReadSetup(h, input);
  h.state.settings.unrelated.changed = true;
  await assert.rejects(
    executeControlledReadSetup(h, {
      ...input,
      expectedPlanSha256: plan.planSha256,
      confirmation: 'INSTALL_OWNED_CONTROLLED_READ_FIXTURE',
    }),
    /STALE_PLAN/,
  );
  assert.equal(h.state.updates, 0);
});
test('readback failure rolls locator and binding replacement back together', async () => {
  const h = harness();
  h.state.corrupt = true;
  const before = structuredClone(h.state.settings);
  await assert.rejects(install(h), /READBACK_MISMATCH/);
  assert.deepEqual(h.state.settings, before);
  assert.equal(h.state.updates, 0);
});
test('revocation, altered definition and forged receipts fail fresh hydration', async () => {
  const h = harness();
  await install(h);
  h.state.grant = false;
  await assert.rejects(qualifyControlledReadInTx(h.tx, ctx, input), /CLIENT_INVALID/);
  h.state.grant = true;
  h.state.settings.meriFoundationFixture.controlledReadOwner.definitionSha256 = '0'.repeat(64);
  await assert.rejects(qualifyControlledReadInTx(h.tx, ctx, input), /LOCATOR_INVALID/);
});
test('only20/72 setup and no duplicate current run', async () => {
  const h = harness();
  await assert.rejects(install(h, { caseId: '74' }), /SCOPE_INVALID/);
  await install(h);
  await assert.rejects(install(h), /RUN_ALREADY_USED/);
});
test('owner refuses text or ready fields and missing confirmation', async () => {
  const h = harness();
  await assert.rejects(inspectControlledReadSetup(h, { ...input, ready: true }), /FIELDS/);
  await assert.rejects(
    executeControlledReadSetup(h, { ...input, confirmation: 'yes', expectedPlanSha256: 'a' }),
    /CONFIRMATION/,
  );
  assert.equal(h.state.updates, 0);
});
test('current role and namespace remain mandatory', async () => {
  const h = harness();
  h.state.actor = false;
  await assert.rejects(install(h), /ACTOR_INVALID/);
  await assert.rejects(
    inspectControlledReadSetup(h, { ...input, ctx: { ...ctx, role: 'user_admin' } }),
    /SCOPE_INVALID/,
  );
});
