import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approvedMemoryDefinitions,
  createApprovedMemoryFixtureRuntime,
} from '../fixture-provisioning/approved-memory-runtime.mjs';
import { AUTHORIZED_TENANTS } from '../fixture-provisioning/contract.mjs';
import { sha256Stable } from '../lib/stable.mjs';
import {
  withOwnedApprovedMemory,
  TENANT,
  CLIENT,
  OTHER_CLIENT,
  PROPOSER,
  REVIEWER,
} from './approved-memory-postgres-harness.mjs';

// Never read DATABASE_URL. Config stays in-process and every schema rolls back.
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
describe(
  'approved-memory runtime over actual canonical services and owned PostgreSQL',
  { skip: !configPath },
  () => {
    it('creates MA510 before 509 approved distractors and binds actual items, retrying without duplicates', async () => {
      await withOwnedApprovedMemory(
        configPath,
        async ({ runtime, tx, manifest, projectionCalls, memoryStore, tenantContext }) => {
          const receipt = await runtime.createDataset();
          assert.equal(receipt.bindings.length, 510);
          assert.equal(receipt.liveAcceptance, 'NOT_RUN');
          assert.equal(new Set(receipt.bindings.map((row) => row.physicalId)).size, 510);
          const binding = receipt.bindings[0];
          assert.equal(binding.logicalId, 'MA510');
          assert.notEqual(binding.physicalId, binding.proposedItemId);
          assert.deepEqual(await runtime.create('MA510'), binding);
          const rows = await tx.$queryRawUnsafe(
            `SELECT id::text,sections_jsonb,
        row_number() OVER (ORDER BY created_at DESC,id) AS ordinal
        FROM memory_items WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND status='active'`,
            TENANT,
            CLIENT,
          );
          assert.equal(rows.length, 510);
          const target = rows.find((row) => row.id === binding.physicalId);
          assert.equal(Number(target.ordinal), 510);
          assert.equal(target.sections_jsonb[0].body, 'autonomous maritime demo');
          const items = await tenantContext.run(
            { tenantId: TENANT, userId: PROPOSER, role: 'standard_user' },
            () => memoryStore.listForCurrentTenant({ clientId: CLIENT }),
          );
          assert.equal(items.length, 510);
          assert.equal(
            items.find((item) => item.id === binding.physicalId)?.sections[0].body,
            'autonomous maritime demo',
          );
          const counts = await tx.$queryRawUnsafe(`SELECT
        (SELECT count(*)::int FROM memory_candidate WHERE status='approved') AS candidates,
        (SELECT count(*)::int FROM memory_cleanup_outbox WHERE operation='index_memory_item') AS outbox,
        (SELECT count(*)::int FROM memory_transition_audit WHERE to_status='active') AS approvals`);
          assert.deepEqual(counts[0], { candidates: 510, outbox: 510, approvals: 510 });
          assert.equal(projectionCalls.length, 510);
          assert.equal(
            manifest.records.find((row) => row.logicalId === 'MA510').availability.status,
            'unavailable',
          );
          const forged = structuredClone(receipt);
          forged.bindings[1].physicalId = forged.bindings[0].physicalId;
          forged.bindingsSha256 = sha256Stable(forged.bindings);
          await assert.rejects(runtime.retireDataset(forged), {
            code: 'APPROVED_MEMORY_RECEIPT_MISMATCH',
          });
          assert.equal(
            (
              await tx.$queryRawUnsafe(
                `SELECT count(*)::int AS n FROM memory_items WHERE status='revoked'`,
              )
            )[0].n,
            0,
          );
          const retired = await runtime.retireDataset(receipt);
          assert.equal(retired.proofs.length, 510);
          assert.ok(
            retired.proofs.every(
              (proof) => proof.retained && proof.itemGovernedStatus === 'revoked',
            ),
          );
          assert.deepEqual(
            (
              await tx.$queryRawUnsafe(`SELECT
        (SELECT count(*)::int FROM memory_candidate WHERE status='approved') AS candidates,
        (SELECT count(*)::int FROM memory_items WHERE status='revoked') AS items,
        (SELECT count(*)::int FROM memory_cleanup_outbox WHERE operation='revoke_projections') AS outbox,
        (SELECT count(*)::int FROM memory_transition_audit WHERE to_status='revoked') AS revocations`)
            )[0],
            { candidates: 510, items: 510, outbox: 510, revocations: 510 },
          );
        },
      );
    });

    it('rejects current unauthorized actors and client walls without promoting pending memory', async () => {
      await withOwnedApprovedMemory(configPath, async ({ runtime, deps, tx }) => {
        const ordinary = createApprovedMemoryFixtureRuntime({
          ...deps,
          reviewerForTenant: () => PROPOSER,
        });
        await assert.rejects(ordinary.create('MA510'), /denied|administrator/i);
        assert.equal(await runtime.inspect('MA510'), null);
        assert.equal(
          (await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM memory_items`))[0].n,
          0,
        );
        const wrongActor = createApprovedMemoryFixtureRuntime({
          ...deps,
          reviewerForTenant: () => AUTHORIZED_TENANTS.T2.id,
        });
        await assert.rejects(wrongActor.create('MA510'), {
          code: 'APPROVED_MEMORY_REVIEWER_UNAVAILABLE',
        });
        await tx.$executeRawUnsafe(
          `UPDATE tenant_memberships SET status='inactive' WHERE user_id=$1::uuid`,
          REVIEWER,
        );
        await assert.rejects(runtime.create('MA510'), {
          code: 'APPROVED_MEMORY_REVIEWER_UNAVAILABLE',
        });
        await tx.$executeRawUnsafe(
          `UPDATE tenant_memberships SET status='active' WHERE user_id=$1::uuid`,
          REVIEWER,
        );
        await tx.$executeRawUnsafe(`UPDATE clients SET memory_wall=true WHERE id=$1::uuid`, CLIENT);
        await assert.rejects(runtime.create('MA510'), {
          code: 'APPROVED_MEMORY_CLIENT_NOT_ALLOWED',
        });
        await tx.$executeRawUnsafe(
          `UPDATE clients SET memory_wall=false WHERE id=$1::uuid`,
          CLIENT,
        );
        const approved = await runtime.create('MA510');
        await assert.rejects(
          runtime.retire('MA510', { ...approved, tenantId: AUTHORIZED_TENANTS.T2.id }),
          { code: 'APPROVED_MEMORY_BINDING_MISMATCH' },
        );
        await assert.rejects(runtime.retire('MA510', { ...approved, clientId: OTHER_CLIENT }), {
          code: 'APPROVED_MEMORY_BINDING_MISMATCH',
        });
        await assert.rejects(
          runtime.retire('MA510', { ...approved, itemRowVersion: '0' }),
          /guard does not match/i,
        );
        assert.deepEqual(await runtime.inspect('MA510'), approved);
      });
    });

    it('retains canonical approval, revocation and cleanup evidence and rejects replay after retirement', async () => {
      await withOwnedApprovedMemory(
        configPath,
        async ({ runtime, tx, memoryStore, tenantContext }) => {
          const approved = await runtime.create('MA510');
          const proof = await runtime.retire('MA510', approved);
          assert.equal(proof.retained, true);
          assert.equal(proof.approvedItemId, approved.physicalId);
          assert.equal(proof.itemStatus, 'revoked');
          assert.equal(proof.itemGovernedStatus, 'revoked');
          assert.ok(proof.transitionAuditId && proof.cleanupIntentId);
          assert.deepEqual(await runtime.retire('MA510', approved), proof);
          assert.deepEqual(await runtime.inspectRetirement('MA510', approved), proof);
          assert.equal(
            (
              await tx.$queryRawUnsafe(
                'SELECT status FROM memory_candidate WHERE id=$1::uuid',
                approved.candidateId,
              )
            )[0].status,
            'approved',
          );
          assert.equal(
            (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM clio_memory'))[0].n,
            0,
          );
          const items = await tenantContext.run(
            { tenantId: TENANT, userId: PROPOSER, role: 'standard_user' },
            () => memoryStore.listForCurrentTenant({ clientId: CLIENT }),
          );
          assert.equal(items.length, 0);
          await assert.rejects(runtime.inspect('MA510'), /guard does not match/i);
          await assert.rejects(runtime.create('MA510'), /guard does not match/i);
          assert.equal(
            (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM memory_items'))[0].n,
            1,
          );
        },
      );
    });

    it('rolls back canonical activation when its audit fails and retries the owned pending proposal', async () => {
      await withOwnedApprovedMemory(configPath, async ({ runtime, tx }) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE memory_transition_audit ADD CONSTRAINT injected_audit_failure CHECK (to_status <> 'active')`,
        );
        await assert.rejects(runtime.create('MA510'));
        assert.equal(await runtime.inspect('MA510'), null);
        assert.deepEqual(
          (
            await tx.$queryRawUnsafe(`SELECT
        (SELECT count(*)::int FROM memory_items) AS items,
        (SELECT count(*)::int FROM clio_memory) AS projections,
        (SELECT count(*)::int FROM memory_cleanup_outbox) AS outbox`)
          )[0],
          { items: 0, projections: 0, outbox: 0 },
        );
        assert.equal(
          (await tx.$queryRawUnsafe('SELECT status FROM memory_candidate'))[0].status,
          'pending',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE memory_transition_audit DROP CONSTRAINT injected_audit_failure',
        );
        assert.equal((await runtime.create('MA510')).lifecycle, 'approved');
      });
    });

    it('rejects changed candidate content and stale version at the locked approval boundary', async () => {
      await withOwnedApprovedMemory(
        configPath,
        async ({ runtime, tx, memoryCandidates, manifest }) => {
          const approve = memoryCandidates.approveSyntheticFixture.bind(memoryCandidates);
          memoryCandidates.approveSyntheticFixture = async (...args) => {
            await tx.$executeRawUnsafe(
              `UPDATE memory_candidate SET payload_jsonb=jsonb_set(payload_jsonb,'{value}','"changed after inspect"') WHERE id=$1::uuid`,
              args[1],
            );
            return approve(...args);
          };
          await assert.rejects(runtime.create('MA510'), /guard does not match/i);
          assert.equal(
            (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM memory_items'))[0].n,
            0,
          );
          const candidate = approvedMemoryDefinitions(manifest)[0].candidate;
          assert.equal(
            (
              await tx.$queryRawUnsafe(
                'SELECT status FROM memory_candidate WHERE id=$1::uuid',
                candidate.physicalId,
              )
            )[0].status,
            'pending',
          );
          await assert.rejects(runtime.create('MA510'), {
            code: 'APPROVED_MEMORY_PENDING_MISMATCH',
          });
          memoryCandidates.approveSyntheticFixture = (...args) =>
            approve(...args.slice(0, 4), { ...args[4], expectedRowVersion: '0' });
          await assert.rejects(runtime.create('MA510-DISTRACTOR-0001'), /guard does not match/i);
          memoryCandidates.approveSyntheticFixture = async (...args) => {
            await tx.$executeRawUnsafe(
              `UPDATE memory_candidate SET source_kind='explicit_user' WHERE id=$1::uuid`,
              args[1],
            );
            return approve(...args);
          };
          await assert.rejects(runtime.create('MA510-DISTRACTOR-0002'), /guard does not match/i);
        },
      );
    });

    it('rechecks reviewer membership in the approval transaction and preserves an uncertain commit for retry', async () => {
      await withOwnedApprovedMemory(
        configPath,
        async ({ runtime, tx, memoryCandidates, memoryStore }) => {
          const approve = memoryCandidates.approveSyntheticFixture.bind(memoryCandidates);
          memoryCandidates.approveSyntheticFixture = async (...args) => {
            await tx.$executeRawUnsafe(
              `UPDATE tenant_memberships SET status='inactive' WHERE user_id=$1::uuid`,
              REVIEWER,
            );
            return approve(...args);
          };
          await assert.rejects(runtime.create('MA510'), /not a current member/i);
          assert.equal(
            (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM memory_items'))[0].n,
            0,
          );
          await tx.$executeRawUnsafe(
            `UPDATE tenant_memberships SET status='active' WHERE user_id=$1::uuid`,
            REVIEWER,
          );
          memoryCandidates.approveSyntheticFixture = approve;
          const inspect = memoryStore.inspectSyntheticFixture.bind(memoryStore);
          memoryStore.inspectSyntheticFixture = async () => {
            throw new Error('Injected post-commit read failure');
          };
          await assert.rejects(
            runtime.create('MA510'),
            (error) => error.unknownCommit === true && /Injected/.test(error.message),
          );
          memoryStore.inspectSyntheticFixture = inspect;
          assert.equal((await runtime.create('MA510')).lifecycle, 'approved');
          assert.equal(
            (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM memory_items'))[0].n,
            1,
          );
          const approved = await runtime.inspect('MA510');
          const inspectRetirement = memoryStore.inspectSyntheticFixtureRetirement.bind(memoryStore);
          memoryStore.inspectSyntheticFixtureRetirement = async () => {
            throw new Error('Injected retirement read failure');
          };
          await assert.rejects(
            runtime.retire('MA510', approved),
            (error) => error.unknownCommit === true && /Injected/.test(error.message),
          );
          memoryStore.inspectSyntheticFixtureRetirement = inspectRetirement;
          const retired = await runtime.retire('MA510', approved);
          assert.equal(retired.itemGovernedStatus, 'revoked');
          assert.equal(
            (
              await tx.$queryRawUnsafe(
                `SELECT count(*)::int AS n FROM memory_transition_audit WHERE to_status='revoked'`,
              )
            )[0].n,
            1,
          );
          assert.equal(
            (
              await tx.$queryRawUnsafe(
                `SELECT count(*)::int AS n FROM memory_transition_audit WHERE to_status='active'`,
              )
            )[0].n,
            1,
          );
        },
      );
    });
  },
);
