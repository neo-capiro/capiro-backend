import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cleanupCase01MemoryProjectionsInTx, readCase01MemoryCorpusInTx, reconcileCase01MemoryCorpusInTx } from '../fixture-provisioning/case01-memory-owner.mjs';
import { cleanupSyntheticMemoryProjections } from '../../../../apps/api/scripts/meri-synthetic-read-budget.mjs';

/** Runs in the real owner's isolated PostgreSQL transaction after its two
 * actual seed/retirement histories and locator have been established. */
export async function exerciseCase01ProjectionCleanup({ t, deps, tx, ctx, clientId }) {
  await tx.$executeRawUnsafe('SAVEPOINT projection_cleanup_exercises');
  try {
    await tx.$executeRawUnsafe(`ALTER TABLE memory_cleanup_outbox
      ADD COLUMN attempts int NOT NULL DEFAULT 0, ADD COLUMN next_attempt_at timestamptz DEFAULT now(),
      ADD COLUMN lease_owner text, ADD COLUMN lease_expires_at timestamptz,
      ADD COLUMN started_at timestamptz, ADD COLUMN completed_at timestamptz,
      ADD COLUMN dead_lettered_at timestamptz, ADD COLUMN last_error text,
      ADD COLUMN expected_source_version timestamptz, ADD COLUMN expected_content_hash text`);
    await tx.$executeRawUnsafe(`ALTER TABLE context_embeddings ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ADD COLUMN tenant_id uuid, ADD COLUMN client_id uuid, ADD COLUMN owner_user_id uuid,
      ADD COLUMN model text NOT NULL DEFAULT 'local-test', ADD COLUMN content_hash text, ADD COLUMN embedding text`);
    const retired = await tx.$queryRawUnsafe(`SELECT id::text,status,slug,supersedes_id::text FROM memory_items
      WHERE tenant_id=$1::uuid AND status IN ('revoked','superseded') ORDER BY id`, ctx.tenantId);
    assert.equal(retired.length, 6);
    const correction = retired.find((row) => row.status === 'revoked' && row.supersedes_id);
    assert.ok(correction);
    for (const row of retired) await tx.$executeRawUnsafe(`INSERT INTO context_embeddings(tenant_id,source_type,source_id,content_hash,embedding)
      VALUES($1::uuid,'memory_item',$2,'retired-hash','[1,2]')`, ctx.tenantId, row.id);
    await tx.$executeRawUnsafe(`INSERT INTO context_embeddings(tenant_id,source_type,source_id,model,embedding)
      VALUES($1::uuid,'memory_item',$2,'second-model','[3,4]')`, ctx.tenantId, correction.id);
    const active = (await tx.$queryRawUnsafe(`SELECT id::text FROM memory_items WHERE status='active' ORDER BY id LIMIT 1`))[0].id;
    for (const [tenant, type, id] of [[ctx.tenantId, 'memory_item', active], [ctx.tenantId, 'mail', correction.id], [randomUUID(), 'memory_item', randomUUID()]]) {
      await tx.$executeRawUnsafe(`INSERT INTO context_embeddings(tenant_id,source_type,source_id,embedding)
        VALUES($1::uuid,$2,$3,'unrelated')`, tenant, type, id);
    }
    await tx.$executeRawUnsafe(`INSERT INTO memory_cleanup_outbox(tenant_id,memory_item_id,operation,idempotency_key)
      VALUES($1::uuid,$2::uuid,'index_memory_item','unrelated-forward'),($1::uuid,$3::uuid,'revoke_projections','unrelated-terminal')`, ctx.tenantId, active, randomUUID());
    await tx.$executeRawUnsafe(`UPDATE memory_items SET governed_status='active',retention_policy_jsonb='null'::jsonb
      WHERE status='superseded' OR id=$1::uuid`, active);
    const snapshot = () => tx.$queryRawUnsafe(`SELECT 'item' AS kind,id::text,xmin::text AS version,to_jsonb(m) AS body,
      retention_policy_jsonb IS NULL AS sql_null FROM memory_items m UNION ALL
      SELECT 'candidate',id::text,xmin::text,to_jsonb(c),NULL FROM memory_candidate c UNION ALL
      SELECT 'transition',id::text,xmin::text,to_jsonb(a),NULL FROM memory_transition_audit a UNION ALL
      SELECT 'audit',id::text,xmin::text,to_jsonb(l),NULL FROM audit_logs l UNION ALL
      SELECT 'job',id::text,xmin::text,to_jsonb(o),NULL FROM memory_cleanup_outbox o UNION ALL
      SELECT 'projection',id::text,xmin::text,to_jsonb(e),NULL FROM context_embeddings e UNION ALL
      SELECT 'clio',id::text,xmin::text,to_jsonb(c),NULL FROM clio_memory c ORDER BY kind,id`);
    const preview = (options = { mode: 'preview' }, actor = ctx, client = clientId) =>
      cleanupCase01MemoryProjectionsInTx(deps, tx, actor, client, options);
    const before = await snapshot();
    let planned;
    await t.test('retired vectors block strict read; cleanup preview is conditional and rolls back all bytes and versions', async () => {
      await assert.rejects(readCase01MemoryCorpusInTx(deps, tx, ctx, clientId));
      await assert.rejects(reconcileCase01MemoryCorpusInTx(deps, tx, ctx, clientId, { mode: 'preview' }));
      planned = await preview();
      assert.equal(planned.status, 'PROJECTION_CLEANUP_PREVIEW_ROLLED_BACK');
      assert.equal(planned.plan.jobs.length, 6);
      assert.equal(planned.plan.projectionCount, 7);
      assert.equal(planned.conditionalVerification.requiresMetadataReconciliation, true);
      assert.equal(planned.conditionalVerification.proof.fixtureReady, true);
      assert.equal(planned.proofIsTentative, true);
      assert.equal(planned.captureAuthority, false);
      assert.equal(planned.providerAuthority, false);
      assert.equal(planned.auditId, null);
      assert.deepEqual(await snapshot(), before);
    });
    assert.ok(planned, 'Preview must pass before execute regressions');
    const execute = { mode: 'execute', expectedPlanSha256: planned.planSha256 };
    await t.test('caller cannot select rows, change scope, self-certify readiness or execute a stale plan', async () => {
      for (const options of [{ ...execute, expectedPlanSha256: '0'.repeat(64) }, { mode: 'preview', ids: [correction.id] }, { mode: 'preview', fixtureReady: true }]) await assert.rejects(preview(options));
      await assert.rejects(preview(undefined, { ...ctx, role: 'capiro_admin' }));
      await assert.rejects(preview(undefined, { ...ctx, userId: randomUUID() }));
      await assert.rejects(preview(undefined, ctx, randomUUID()));
      assert.deepEqual(await snapshot(), before);
    });
    const mutations = [
      ['foreign terminal job key', "UPDATE memory_cleanup_outbox SET idempotency_key='forged:'||id::text WHERE operation='revoke_projections'"],
      ['competing worker lease', "UPDATE memory_cleanup_outbox SET status='running',lease_owner='competing',lease_expires_at=now()+interval '5 minutes' WHERE operation='supersede_projections'"],
      ['exhausted attempts', "UPDATE memory_cleanup_outbox SET attempts=8 WHERE operation='supersede_projections'"],
      ['delayed retry', "UPDATE memory_cleanup_outbox SET next_attempt_at=now()+interval '1 hour' WHERE operation='supersede_projections'"],
      ['wrong cleanup Clio binding', "UPDATE memory_cleanup_outbox SET clio_memory_id=gen_random_uuid() WHERE operation='supersede_projections'"],
      ['altered canonical body', "UPDATE memory_items SET sections_jsonb='[]'::jsonb WHERE status='superseded'"],
      ['altered approval history', "UPDATE memory_transition_audit SET metadata_jsonb='{}'::jsonb WHERE reason_code='revoked'"],
      ['client wall', "UPDATE clients SET memory_wall=true WHERE id='22222222-2222-4222-8222-222222222222'"],
      ['removed proposer authority', `UPDATE tenant_memberships SET status='inactive' WHERE user_id='${ctx.userId}'::uuid`],
      ['unexpected Clio source is never erased', `INSERT INTO clio_memory(id,tenant_id,key,value) SELECT clio_memory_id,tenant_id,'tampered','must survive refusal' FROM memory_cleanup_outbox WHERE operation='revoke_projections' AND clio_memory_id IS NOT NULL LIMIT 1`],
      ['same source ID in another tenant is never erased', `INSERT INTO context_embeddings(tenant_id,source_type,source_id,model) VALUES(gen_random_uuid(),'memory_item','${correction.id}','foreign')`],
    ];
    for (const [label, sql] of mutations) await t.test(label, async () => {
      await tx.$executeRawUnsafe('SAVEPOINT invalid_projection_cleanup');
      try {
        assert.ok(await tx.$executeRawUnsafe(sql));
        const tampered = await snapshot();
        await assert.rejects(preview());
        await assert.rejects(preview(execute));
        assert.deepEqual(await snapshot(), tampered, 'Failure rolls back every effect, including after conditional verification');
      } finally {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT invalid_projection_cleanup');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT invalid_projection_cleanup');
      }
    });
    await t.test('changed projection model content invalidates the exact plan', async () => {
      await tx.$executeRawUnsafe('SAVEPOINT stale_projection_plan');
      try {
        await tx.$executeRawUnsafe("UPDATE context_embeddings SET content_hash='new' WHERE source_id=$1", correction.id);
        const changed = await snapshot();
        assert.notEqual((await preview()).planSha256, planned.planSha256);
        await assert.rejects(preview(execute));
        assert.deepEqual(await snapshot(), changed);
      } finally {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT stale_projection_plan');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT stale_projection_plan');
      }
    });
    await t.test('maintenance audit failure atomically rolls back cleanup, job claims and completion', async () => {
      await tx.$executeRawUnsafe('SAVEPOINT cleanup_audit_failure');
      try {
        await tx.$executeRawUnsafe(`CREATE FUNCTION refuse_cleanup_audit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'controlled local cleanup audit failure'; END $$`);
        await tx.$executeRawUnsafe(`CREATE TRIGGER refuse_cleanup_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION refuse_cleanup_audit()`);
        await assert.rejects(preview(execute));
        assert.deepEqual(await snapshot(), before);
      } finally {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT cleanup_audit_failure');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT cleanup_audit_failure');
      }
    });
    await t.test('CLI dispatch completes only original jobs once, retains canonical history, and requires separate metadata reconciliation', async () => {
      const factory = { deps, runWithTenant: async (_ctx, work) => work() };
      const result = await cleanupSyntheticMemoryProjections(factory, { ctx, clientId, expectedPlanSha256: planned.planSha256 }, 'execute');
      assert.equal(result.status, 'PROJECTIONS_CLEANED');
      assert.equal(result.proofIsTentative, true);
      assert.ok(result.auditId);
      const settled = await snapshot();
      const protectedRows = (rows) => rows.filter((row) => ['item', 'candidate', 'transition', 'clio'].includes(row.kind) ||
        (row.kind === 'projection' && row.body.embedding === 'unrelated') || (row.kind === 'job' && row.body.idempotency_key.startsWith('unrelated')));
      assert.deepEqual(protectedRows(settled), protectedRows(before));
      const jobs = settled.filter((row) => row.kind === 'job' && planned.plan.jobs.some((job) => job.id === row.id));
      assert.equal(jobs.length, 6);
      assert.ok(jobs.every((row) => row.body.status === 'completed' && row.body.attempts === 1 && row.body.lease_owner === null && row.body.lease_expires_at === null));
      assert.equal(settled.filter((row) => row.kind === 'audit' && row.id === result.auditId).length, 1);
      await assert.rejects(preview(execute));
      await assert.rejects(readCase01MemoryCorpusInTx(deps, tx, ctx, clientId));
      const metadata = await reconcileCase01MemoryCorpusInTx(deps, tx, ctx, clientId, { mode: 'preview' });
      const repaired = await reconcileCase01MemoryCorpusInTx(deps, tx, ctx, clientId, { mode: 'execute', expectedPlanSha256: metadata.planSha256 });
      assert.equal(repaired.proof.fixtureReady, true);
      assert.equal((await readCase01MemoryCorpusInTx(deps, tx, ctx, clientId)).fixtureReady, true);
    });
  } finally {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT projection_cleanup_exercises');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT projection_cleanup_exercises');
  }
}
