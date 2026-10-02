import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApprovedMemoryFixtureRuntime } from '../fixture-provisioning/approved-memory-runtime.mjs';
import { sha256Stable } from '../lib/stable.mjs';
import {
  withOwnedApprovedMemory,
  TENANT,
  CLIENT,
  OTHER_CLIENT,
  PROPOSER,
} from './approved-memory-postgres-harness.mjs';

const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
describe(
  'selected case01 approved sources using real canonical owners',
  { skip: !configPath },
  () => {
    it('approves exact two-client sources once, observes real canonical IDs and retires with retained history', async () => {
      await withOwnedApprovedMemory(
        configPath,
        async ({ deps, tx, manifest, memoryStore, tenantContext }) => {
          const selection = ['MA1-v2', 'MB1'];
          const runtime = createApprovedMemoryFixtureRuntime({ ...deps, sourceIds: selection });
          selection.splice(0, selection.length, 'MA3');
          const receipt = await runtime.createDataset();
          assert.equal(receipt.liveAcceptance, 'NOT_RUN');
          assert.equal(receipt.bindings.length, 2);
          assert.deepEqual(runtime.logicalIds, ['MA1-v2', 'MB1']);
          assert.equal(receipt.bindings[0].clientId, CLIENT);
          assert.equal(receipt.bindings[1].clientId, OTHER_CLIENT);
          assert.notEqual(receipt.bindings[0].physicalId, receipt.bindings[0].proposedItemId);
          assert.deepEqual(await runtime.createDataset(), receipt);
          const items = await tenantContext.run(
            { tenantId: TENANT, userId: PROPOSER, role: 'standard_user' },
            () => memoryStore.listForCurrentTenant({ clientId: CLIENT }),
          );
          assert.equal(items.length, 1);
          assert.equal(items[0].id, receipt.bindings[0].physicalId);
          assert.equal(
            items[0].sections[0].body,
            'Monthly briefs include fiscal year, budget stage, citations and action owner',
          );
          assert.equal(
            manifest.records.find((r) => r.logicalId === 'MA1-v2').availability.status,
            'unavailable',
          );
          const forged = structuredClone(receipt);
          forged.bindings[1].physicalId = forged.bindings[0].physicalId;
          forged.bindingsSha256 = sha256Stable(forged.bindings);
          await assert.rejects(runtime.retireDataset(forged), {
            code: 'APPROVED_MEMORY_RECEIPT_MISMATCH',
          });
          const retired = await runtime.retireDataset(receipt);
          assert.equal(retired.proofs.length, 2);
          assert.ok(
            retired.proofs.every(
              (proof) => proof.retained && proof.itemGovernedStatus === 'revoked',
            ),
          );
          assert.deepEqual(await runtime.retireDataset(receipt), retired);
          assert.deepEqual(
            (
              await tx.$queryRawUnsafe(`SELECT
        (SELECT count(*)::int FROM memory_candidate WHERE status='approved') AS candidates,
        (SELECT count(*)::int FROM memory_items WHERE status='revoked') AS items,
        (SELECT count(*)::int FROM memory_transition_audit WHERE to_status='revoked') AS revocations`)
            )[0],
            { candidates: 2, items: 2, revocations: 2 },
          );
          await assert.rejects(runtime.create('MA1-v2'));
        },
      );
    });

    it('honors the selected client wall and rejects changed ownership bindings before retirement', async () => {
      await withOwnedApprovedMemory(configPath, async ({ deps, tx }) => {
        const runtime = createApprovedMemoryFixtureRuntime({
          ...deps,
          sourceIds: ['MA1-v2', 'MB1'],
        });
        const binding = await runtime.create('MA1-v2');
        await tx.$executeRawUnsafe(
          'UPDATE clients SET memory_wall=true WHERE id=$1::uuid',
          OTHER_CLIENT,
        );
        await assert.rejects(runtime.create('MB1'), { code: 'APPROVED_MEMORY_CLIENT_NOT_ALLOWED' });
        assert.equal(
          (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM memory_items'))[0].n,
          1,
        );
        await assert.rejects(runtime.retire('MA1-v2', { ...binding, clientId: OTHER_CLIENT }), {
          code: 'APPROVED_MEMORY_BINDING_MISMATCH',
        });
        assert.equal(
          (
            await tx.$queryRawUnsafe(
              "SELECT count(*)::int AS n FROM memory_items WHERE status='active'",
            )
          )[0].n,
          1,
        );
        await runtime.retire('MA1-v2', binding);
      });
    });
  },
);
