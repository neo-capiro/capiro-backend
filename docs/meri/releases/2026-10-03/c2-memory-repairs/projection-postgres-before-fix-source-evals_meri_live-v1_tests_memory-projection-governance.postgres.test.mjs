import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { withOwnedApprovedMemory, TENANT, CLIENT, OTHER_CLIENT } from './approved-memory-postgres-harness.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;

async function approvedProjection(runtime, tx) {
  const binding = await runtime.create('MA510');
  const [source] = await tx.$queryRawUnsafe(`SELECT c.id, c.tenant_id AS "tenantId", c.scope,
    c.owner_user_id AS "ownerUserId", c.client_id AS "clientId", c.key, c.value, c.source,
    c.metadata_jsonb AS metadata, c.expires_at AS "expiresAt", c.created_at AS "createdAt",
    c.updated_at AS "updatedAt" FROM clio_memory c JOIN memory_items m ON m.slug='clio:' || c.id::text
    WHERE m.id=$1::uuid AND c.tenant_id=$2::uuid`, binding.physicalId, TENANT);
  assert.ok(source, 'Actual canonical approval retains its Clio projection source');
  const { clioMemoryToItem } = require(fileURLToPath(
    new URL('../../../../apps/api/src/memory/memory-clio-adapter.helpers.ts', import.meta.url),
  ));
  const item = clioMemoryToItem(source);
  assert.equal(item.governedStatus, 'active');
  return { binding, item };
}

async function authority(tx, id) {
  const [row] = await tx.$queryRawUnsafe(`SELECT status, governed_status, memory_class, memory_authority,
    source_type, source_id, source_version, source_content_hash, asserted_by_user_id, approved_by_user_id,
    approved_at, second_approved_by_user_id, second_approved_at, as_of, effective_from, valid_until,
    last_confirmed_at, review_due_at, review_state, conflict_status, conflict_group_id, controlling_item_id,
    sensitivity, retention_policy_jsonb, retention_policy_jsonb IS NULL AS retention_sql_null, legal_hold,
    instructions_allowed, revoked_at, revoked_by FROM memory_items WHERE id=$1::uuid`, id);
  return row;
}

describe('projection refresh over actual canonical services and owned PostgreSQL', { skip: !configPath }, () => {
  for (const state of ['active', 'superseded', 'revoked', 'stale', 'conflicted', 'expired']) {
    it(`preserves current ${state} authority when the Clio snapshot is still active`, async () => {
      await withOwnedApprovedMemory(configPath, async ({ runtime, tx, memoryStore }) => {
        const { binding, item } = await approvedProjection(runtime, tx);
        // Arrange later lifecycle metadata after the actual approval, leaving its old
        // Clio snapshot untouched. These fixtures do not claim user-transition/RLS proof.
        await tx.$executeRawUnsafe(`UPDATE memory_items SET status=$2, governed_status=$3,
          last_confirmed_at='2026-10-03T11:00:00Z', review_due_at='2026-10-20T11:00:00Z',
          conflict_status=$4, conflict_group_id=$5::uuid, controlling_item_id=$6::uuid,
          retention_policy_jsonb=NULL, legal_hold=$7, sensitivity='privileged' WHERE id=$1::uuid`,
          binding.physicalId, ['superseded', 'revoked'].includes(state) ? state : 'active', state,
          state === 'conflicted' ? 'open' : 'none', state === 'conflicted' ? randomUUID() : null,
          state === 'conflicted' ? binding.physicalId : null, state === 'active');
        const before = await authority(tx, binding.physicalId);
        const effectsBefore = await tx.$queryRawUnsafe(`SELECT
          (SELECT count(*)::int FROM memory_transition_audit) AS audits,
          (SELECT count(*)::int FROM memory_cleanup_outbox) AS outbox`);
        const id = await memoryStore.upsertSystem(item, {
          runId: randomUUID(), trigger: 'cron', reviewState: 'unreviewed',
        });
        assert.equal(id, binding.physicalId, 'Stable canonical identity');
        assert.deepEqual(await authority(tx, id), before, 'Projection is not governance authority');
        assert.deepEqual(await tx.$queryRawUnsafe(`SELECT
          (SELECT count(*)::int FROM memory_transition_audit) AS audits,
          (SELECT count(*)::int FROM memory_cleanup_outbox) AS outbox`), effectsBefore);
      });
    });
  }

  it('restores authority only on initial insertion and stores absent retention as SQL NULL', async () => {
    await withOwnedApprovedMemory(configPath, async ({ runtime, tx, memoryStore }) => {
      const { item } = await approvedProjection(runtime, tx);
      const projection = { ...item, slug: `clio:${randomUUID()}`, legalHold: true };
      const id = await memoryStore.upsertSystem(projection);
      const first = await authority(tx, id);
      assert.equal(first.governed_status, 'active');
      assert.equal(first.memory_authority, item.memoryAuthority);
      assert.equal(first.approved_by_user_id, item.approvedByUserId);
      assert.equal(first.legal_hold, true);
      assert.equal(first.retention_sql_null, true);
      await tx.$executeRawUnsafe(`UPDATE memory_items SET retention_policy_jsonb='{"retainDays":90}'::jsonb
        WHERE id=$1::uuid`, id);
      const governed = await authority(tx, id);
      assert.equal(await memoryStore.upsertSystem({ ...projection, legalHold: false }), id);
      assert.deepEqual(await authority(tx, id), governed, 'Repeat projection preserves later governance');
    });
  });

  it('keeps ordinary unclassified content, scope and edge refreshes working', async () => {
    await withOwnedApprovedMemory(configPath, async ({ runtime, tx, memoryStore }) => {
      const { item } = await approvedProjection(runtime, tx);
      const generic = {
        ...item, slug: `legacy:${randomUUID()}`, memoryClass: 'legacy_unclassified',
        memoryAuthority: 'legacy_unclassified', governedStatus: 'pending_review', sourceVersion: null,
        approvedByUserId: null, approvedAt: null, clientId: CLIENT,
        sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body: 'Initial [[client:first]]' }],
      };
      const id = await memoryStore.upsertSystem(generic);
      assert.equal(await memoryStore.upsertSystem({ ...generic, clientId: OTHER_CLIENT,
        sections: [{ ...generic.sections[0], body: 'Updated [[client:second]]' }] }), id);
      const [row] = await tx.$queryRawUnsafe(`SELECT client_id, sections_jsonb, memory_class, governed_status
        FROM memory_items WHERE id=$1::uuid`, id);
      assert.equal(row.client_id, OTHER_CLIENT);
      assert.equal(row.sections_jsonb[0].body, 'Updated [[client:second]]');
      assert.equal(row.memory_class, 'legacy_unclassified');
      assert.equal(row.governed_status, 'pending_review');
      assert.deepEqual(await tx.$queryRawUnsafe('SELECT dst_slug FROM memory_edges WHERE src_item_id=$1::uuid', id),
        [{ dst_slug: 'second' }]);
    });
  });
});
